/**
 * isolation.js — stronger sandbox isolation for untrusted PR commands (Phase 2).
 *
 * Tier 1 runs arbitrary install/test scripts from a PR. Phase 1 ran them
 * directly on the host with a clean env + hard timeout. Phase 2 adds an opt-in
 * container jail: each command can run inside `docker run` with no network
 * (except install), memory/CPU/pid caps, a non-root user, and a read-only root
 * filesystem with only the mounted worktree + /tmp writable.
 *
 * Default mode is "none" (host exec, unchanged) so existing repos keep working;
 * set isolation.mode = "docker" in felix.config.json to harden.
 *
 * This module only *builds* the command string — running it stays in util/exec,
 * so the wrapping logic is deterministic and unit-testable without Docker.
 */

// The only two values that mean anything. Everything else is a configuration error, not a
// default — see assertValidMode.
const MODES = ['none', 'docker'];

// Only "allow" and "deny" mean anything for the per-step network policy. Same reasoning as
// MODES: the old code treated everything-that-isn't-"allow" as deny, which is the safe
// direction, but it also silently accepted "Deny"/"none"/true and left the owner unable to
// tell a working policy from a typo'd one.
const NETWORKS = ['allow', 'deny'];

// Where the jailed process gets a writable HOME, plus the caches that do NOT derive from it.
//
// `--read-only` puts / on the read-only layer, and `-u <uid>:<gid>` names a uid with no
// /etc/passwd entry, so the container's HOME resolves to `/`. Every toolchain that caches under
// $HOME then dies — including `npm ci`, the default install command, which means docker mode
// had never once completed an install for a Node repo. Observed, not theorised: the CI probe's
// control run (scripts/probe-docker-jail.js, docker 28.0.4) fails in 884ms with
//   npm error syscall mkdir / npm error path /.npm / ENOENT ... mkdir '/.npm'
//   npm error Log files were not written ... /.npm/_logs
// Note the errno is ENOENT, not the EROFS you would predict — the read-only layer refuses the
// mkdir at `/` before any write is attempted. Same cause, different name; worth writing down
// because someone debugging this will grep for the wrong one.
//
// These point into the /tmp tmpfs that already exists rather than adding a mount, so the jail is
// not widened by a single byte: the values are fixed strings with nothing interpolated, so they
// add no injection surface either. GOPATH and CARGO_HOME are listed explicitly and are NOT
// redundant with HOME — the official `golang` and `rust` images bake `ENV GOPATH=/go` and
// `ENV CARGO_HOME=/usr/local/cargo`, both root-owned and read-only, and an image ENV beats
// HOME-derivation. The vars are inert in images that do not use them, so one fixed block covers
// all four images resolveIsolation can pick without per-language branching.
const CACHE_ENV = {
  HOME: '/tmp',
  XDG_CACHE_HOME: '/tmp/.cache', // pip, and go's GOCACHE
  npm_config_cache: '/tmp/.npm',
  GOPATH: '/tmp/go',
  CARGO_HOME: '/tmp/.cargo',
};

const DEFAULT_ISOLATION = {
  mode: 'none', // "none" | "docker"
  image: 'node:20', // container image for docker mode
  network: 'deny', // default per-step network policy: "allow" | "deny"
  memory: '2g',
  cpus: '2',
  pidsLimit: 512,
  // 1g, not the original 512m: the package caches now live in this tmpfs (see CACHE_ENV), and a
  // real `npm ci` or `go mod download` would ENOSPC a 512m one. Loud when hit, and owner-tunable.
  tmpfsSize: '1g',
};

// Every key resolveIsolation understands. An unknown key is a hard error, because the failure it
// prevents is invisible to any value check: `{"Mode":"docker"}` — wrong case on the KEY, not the
// value — survives the spread below with mode:"none" intact, so the owner reads "docker" in their
// own config and gets no jail at all.
const ISOLATION_KEYS = Object.keys(DEFAULT_ISOLATION);

// Sensible per-language default images when isolation is enabled.
const IMAGE_BY_LANGUAGE = {
  node: 'node:20',
  python: 'python:3.12',
  go: 'golang:1.22',
  rust: 'rust:1',
};

/**
 * Reject any mode that is not exactly one of MODES.
 *
 * The old gate was `iso.mode !== 'docker'` -> run it unwrapped, which made every typo a silent
 * removal of the sandbox: "Docker", " docker", "podman", true and 1 all executed on the host
 * while the owner's felix.config.json still said docker. A security control that degrades
 * quietly on malformed input is worse than one that is off, because nobody goes looking.
 *
 * Deliberately strict — no trimming, no case folding. Accepting near-misses is how a control
 * ends up with two notions of "is this docker?" that disagree (crap.js compares the raw string
 * too), and the error message says exactly what to write instead.
 *
 * Throwing is the fail-CLOSED direction, which is worth stating because it looks harsh: the
 * throw leaves runTier1, leaves run(), and bin/felix.js exits 3. The job fails and no check run
 * is created, so a Required check cannot go green. Degrading to INSUFFICIENT EVIDENCE instead
 * would map to `neutral` — which GitHub counts as PASSING.
 */
function assertValidMode(mode) {
  if (!MODES.includes(mode)) {
    throw new Error(
      `isolation.mode must be one of ${MODES.map((m) => `"${m}"`).join(' | ')} — got ${JSON.stringify(mode)}. ` +
      'Refusing to run: an unrecognized mode previously meant "no sandbox at all", silently.'
    );
  }
}

/**
 * Validate the whole isolation block, not just the mode.
 *
 * The unknown-key check is the non-obvious half and it is the reason this is a separate function:
 * a wrong-case KEY is invisible to every value check, because the misspelled key rides along in
 * the object while `mode` quietly keeps its "none" default.
 */
function assertValidIsolation(raw, resolved) {
  const unknown = Object.keys(raw || {}).filter((k) => !ISOLATION_KEYS.includes(k));
  if (unknown.length) {
    throw new Error(
      `unknown isolation key(s): ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
      `Known keys are ${ISOLATION_KEYS.join(', ')}. Refusing to run: a misspelled key is silently ` +
      'ignored, which would leave the sandbox off while the config appears to turn it on.'
    );
  }
  assertValidMode(resolved.mode);
  if (!NETWORKS.includes(resolved.network)) {
    throw new Error(
      `isolation.network must be one of ${NETWORKS.map((n) => `"${n}"`).join(' | ')} — got ${JSON.stringify(resolved.network)}.`
    );
  }
}

/** Normalize the isolation config, filling defaults and a language-aware image. */
function resolveIsolation(config = {}) {
  const iso = { ...DEFAULT_ISOLATION, ...(config.isolation || {}) };
  assertValidIsolation(config.isolation, iso);
  if (!(config.isolation && config.isolation.image) && config.language && IMAGE_BY_LANGUAGE[config.language]) {
    iso.image = IMAGE_BY_LANGUAGE[config.language];
  }
  return iso;
}

/**
 * Refuse a config whose parts contradict each other.
 *
 * Today that is exactly one pair: docker isolation together with a drive plan. `driveApp` boots
 * the app with a plain `spawn` and never goes through `wrapCommand`, so the PR's own server runs
 * on the host, outside every cap, while the config says "jailed".
 *
 * Refusal rather than a jailed drive, and rather than a soft skip:
 *  - Jailing it needs a detached container lifecycle with orphan cleanup on every exit path
 *    (including Felix being SIGKILLed), and publishing a port forces `--network bridge`, which
 *    hands untrusted code the runtime egress the net-deny test steps deliberately withhold.
 *    It would still leave Felix's own chromium running `--no-sandbox` on the HOST against
 *    attacker-served pages. A half-jail would claim containment it does not have.
 *  - A soft skip is quality-fail-open: the owner declared those routes as hard checks, so
 *    skipping them lets PRs reach VERIFIED without checks the owner mandated, and they never
 *    find out.
 *  - Failing the drive check instead would block, but stamps "failure" on innocent PRs for a
 *    config problem, which teaches people to distrust the verdict.
 *
 * Both blocks are base-sourced (config.js), so this conflict is always owner-authored and the
 * error is attributed to the party that can actually fix it.
 */
function assertJailCoherent({ isolation, hasDrivePlan } = {}) {
  const iso = isolation || DEFAULT_ISOLATION;
  assertValidMode(iso.mode);
  if (iso.mode === 'docker' && hasDrivePlan) {
    throw new Error(
      'isolation.mode "docker" and drive are incompatible: drive boots the app with a plain spawn ' +
      'on the HOST, outside the jail, so the container would be a false assurance. Turn off one of ' +
      'the two (drive.enabled:false, or isolation.mode:"none"). A jailed drive is future work.'
    );
  }
}

/**
 * Verify docker actually works BEFORE any PR code is checked out or run.
 *
 * The point is attribution by construction. Without this, a runner that has lost docker makes
 * the wrapped command exit 127, which reads as "the PR's install failed" -> INSUFFICIENT
 * EVIDENCE -> `neutral` -> and GitHub counts neutral as PASSING a Required check. So the
 * hardening becomes the bypass, and the comment blames the wrong party. This probe runs zero
 * lines of PR code, so its failure is provably the runner's fault without parsing exit codes
 * out of untrusted output.
 *
 * `run` is injected so the whole path is testable on a box with no docker.
 *
 * Residual, accepted: a daemon that dies mid-run still surfaces as a failed check. Rare, and it
 * fails in the closed direction.
 */
async function preflightDocker({ isolation, run, timeoutMs = 15000 } = {}) {
  const iso = isolation || DEFAULT_ISOLATION;
  assertValidMode(iso.mode);
  if (iso.mode !== 'docker') return { ok: true, skipped: true };
  const r = await run('docker version --format "{{.Server.Version}}"', { timeoutMs });
  if (r.code !== 0 || r.timedOut) {
    throw new Error(
      `isolation.mode is "docker" but docker is not usable on this runner ` +
      `(${r.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${r.code}`}): ${String(r.combined || '').slice(0, 300)}. ` +
      'Refusing to run: falling back to host execution would silently drop the sandbox, and ' +
      'reporting it as a failed install would blame the pull request for a runner problem.'
    );
  }
  return { ok: true, skipped: false, version: String(r.combined || '').trim() };
}

/** Single-quote a string for safe embedding in `sh -c '...'`. */
function shquote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a shell command for the configured isolation mode.
 *
 * @param {string} command  the command to run
 * @param {object} opts
 * @param {object} opts.isolation  resolved isolation settings
 * @param {string} opts.cwd        host directory to mount as the workdir
 * @param {'allow'|'deny'} [opts.network]  per-step override of isolation.network
 * @returns {string} the command to hand to util/exec
 */
function wrapCommand(command, { isolation, cwd, network } = {}) {
  const iso = isolation || DEFAULT_ISOLATION;
  // Re-checked here and not only in resolveIsolation: this is the choke point every command
  // actually passes through, and callers can hand-build an isolation object that never went
  // through resolveIsolation. The cheap duplicate check is what makes "unjailed" unreachable.
  assertValidMode(iso.mode);
  if (iso.mode !== 'docker') return command;

  // pidsLimit and tmpfsSize are interpolated unquoted into the docker args, so
  // a crafted felix.config.json (untrusted on fork PRs) could otherwise inject
  // extra flags and defeat the jail. Validate them strictly. memory/cpus are
  // shquote'd below, so they cannot break out of their single argument.
  // Strict string match — parseInt would accept "1 --privileged" as 1.
  const rawPids = String(iso.pidsLimit).trim();
  if (!/^\d+$/.test(rawPids) || Number(rawPids) < 1) {
    throw new Error('isolation.pidsLimit must be a positive integer');
  }
  const pidsLimit = Number(rawPids);
  const tmpfsSize = String(iso.tmpfsSize);
  if (!/^\d+[kmg]$/i.test(tmpfsSize)) {
    throw new Error("isolation.tmpfsSize must match <number><k|m|g> (e.g. '512m')");
  }

  const net = (network || iso.network) === 'allow' ? 'bridge' : 'none';
  const parts = [
    'docker run --rm',
    `--network ${net}`,
    `--memory ${shquote(iso.memory)}`,
    `--cpus ${shquote(String(iso.cpus))}`,
    `--pids-limit ${pidsLimit}`,
    '--read-only',
    `--tmpfs ${shquote(`/tmp:rw,exec,size=${tmpfsSize}`)}`,
    // A writable HOME plus the caches that an image ENV would otherwise pin to a read-only path.
    // See CACHE_ENV: fixed strings, no interpolation, no new mount.
    ...Object.entries(CACHE_ENV).map(([k, v]) => `-e ${k}=${v}`),
    // Run as the host user so files written into the mount keep correct ownership.
    '-u "$(id -u):$(id -g)"',
    `-v ${shquote(cwd)}:/work`,
    '-w /work',
    '--cap-drop ALL',
    '--security-opt no-new-privileges',
    shquote(iso.image),
    `sh -c ${shquote(command)}`,
  ];
  return parts.join(' ');
}

module.exports = {
  resolveIsolation, wrapCommand, shquote, assertJailCoherent, preflightDocker,
  DEFAULT_ISOLATION, IMAGE_BY_LANGUAGE, MODES, CACHE_ENV,
};
