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

const DEFAULT_ISOLATION = {
  mode: 'none', // "none" | "docker"
  image: 'node:20', // container image for docker mode
  network: 'deny', // default per-step network policy: "allow" | "deny"
  memory: '2g',
  cpus: '2',
  pidsLimit: 512,
  tmpfsSize: '512m',
};

// Sensible per-language default images when isolation is enabled.
const IMAGE_BY_LANGUAGE = {
  node: 'node:20',
  python: 'python:3.12',
  go: 'golang:1.22',
  rust: 'rust:1',
};

/** Normalize the isolation config, filling defaults and a language-aware image. */
function resolveIsolation(config = {}) {
  const iso = { ...DEFAULT_ISOLATION, ...(config.isolation || {}) };
  if (!(config.isolation && config.isolation.image) && config.language && IMAGE_BY_LANGUAGE[config.language]) {
    iso.image = IMAGE_BY_LANGUAGE[config.language];
  }
  return iso;
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

module.exports = { resolveIsolation, wrapCommand, shquote, DEFAULT_ISOLATION, IMAGE_BY_LANGUAGE };
