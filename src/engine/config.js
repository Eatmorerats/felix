/**
 * config.js — load the per-repo Felix config, or *learn* it.
 *
 * Felix is repo-agnostic. Two ways it knows how to install/test/run a repo:
 *
 *   1. An explicit `felix.config.json` at the target repo root (authoritative).
 *   2. Auto-detection — if no config file exists, Felix inspects the repo's own
 *      manifest files (package.json, pyproject.toml, go.mod, Cargo.toml, …) and
 *      synthesizes a sensible config. This is what lets Felix be dropped onto a
 *      new repository and "learn" it with zero setup.
 *
 * Explicit config always wins; detection only fills the gaps.
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./util/logger');
const { IMAGE_BY_LANGUAGE } = require('./isolation');

const CONFIG_FILENAME = 'felix.config.json';

const DEFAULT_SKIP_GLOBS = [
  '**/*.md', 'docs/**', '**/*.txt', '**/*.json',
  '.github/**', '**/*.lock', '**/*.svg', '**/*.png',
  '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.ico', 'LICENSE',
];

const DEFAULT_TIMEOUTS = { installMs: 300000, testMs: 600000, testOneMs: 180000 };

const DEFAULT_SECRETS = {
  allowFiles: ['**/*.fixture.*', '**/fixtures/**', '**/__mocks__/**', '**/*.example*'],
  sinRequiresKeyword: true,
  // Opt-in authoritative scanner (e.g. "gitleaks detect --no-git --redact"). When set, it
  // runs as the HARD secrets gate and Felix's own changed-files scan defers to advisory —
  // Felix's built-in scan is a backstop, not an authoritative repo scanner. Empty = built-in
  // scan gates (default).
  externalScan: '',
};

// CRAP (Change Risk Anti-Patterns) — a soft Tier 1 signal that flags changed
// functions which are both complex and under-tested. OFF by default: enabling it
// runs the test suite a second time under coverage, so the user opts in explicitly.
// `threshold` is the CRAP score above which a function is flagged (crap4j uses 30;
// Uncle Bob drives to <6). Always advisory in v1 — it never gates the verdict.
const DEFAULT_CRAP = {
  enabled: false,
  threshold: 30,
};

// Opt-in dependency-direction check (deps.js). Default OFF: soft/advisory only in v1, so a
// repo that never sets deps.enabled builds no graph and its verdict is byte-identical. layers
// are optional forbidden edges (picomatch globs); node_modules is always excluded regardless.
const DEFAULT_DEPS = {
  enabled: false,
  layers: [],
  exclude: ['(^|/)node_modules/'],
  includeOnly: '',
  timeoutMs: 120000,
};

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Auto-detected TEST commands are never chained with `||`.
 *
 * `||` fires on a non-zero exit, and a failing test suite is exactly that — so
 * `npx vitest run || npx jest || npx mocha` handed a genuine failure to the next runner,
 * which typically found no tests and exited 0. `test` is hard:true, so that was a green
 * tick on the one check carrying the product's entire claim. Measured, not theorized:
 * `python -m unittest` discovering zero tests exits 0 on Python 3.14.
 *
 * So: pick the runner from what the repo actually DECLARES, run it once, and emit '' when
 * nothing is evidenced — validate() then refuses the config by name instead of inventing a
 * pass. An honest "could not detect a test command" is worth more than a fabricated ✅.
 *
 * `--no-install` is the other half of the same finding. Bare `npx <pkg>` DOWNLOADS AND
 * EXECUTES a package from the npm registry, and these commands run in the sandbox that is
 * running untrusted pull-request code — three registry installs nobody asked for. With
 * --no-install a missing binary exits 1 (verified) instead of fetching a stranger's code.
 *
 * INSTALL commands still chain, and that is fine: `npm ci || npm install` are two ways of
 * doing the SAME job, and if both fail the non-zero exit is caught as installFailed ⇒
 * INSUFFICIENT EVIDENCE. The test chain was unsound because failure was the trigger.
 */
const RUNNER_CMD = {
  vitest: 'npx --no-install vitest run',
  jest: 'npx --no-install jest',
  mocha: 'npx --no-install mocha',
  ava: 'npx --no-install ava',
};
const RUNNER_ONE = {
  vitest: 'npx --no-install vitest run {file}',
  jest: 'npx --no-install jest {file}',
  mocha: 'npx --no-install mocha {file}',
  ava: 'npx --no-install ava {file}',
};

/** Does the repo give hard evidence it actually uses pytest? */
function evidencesPytest({ pyproject, setupCfg, requirements }) {
  return /\[tool\.pytest/.test(pyproject)
    || /\[tool:pytest\]/.test(setupCfg)
    || /(^|\s|=|<|>)pytest(\s|$|[=<>!~[])/m.test(requirements)
    || /(^|\s)["']?pytest["']?\s*[=<>~]/m.test(pyproject);
}

/**
 * Inspect a repo directory and guess how to install/test/build it.
 * Returns a partial config { language, commands, test } or null if unknown.
 */
function detect(repoPath) {
  const has = (f) => exists(path.join(repoPath, f));

  // ── Node / TypeScript ────────────────────────────────────────────────
  if (has('package.json')) {
    const pkg = readJSON(path.join(repoPath, 'package.json')) || {};
    const scripts = pkg.scripts || {};
    const lockCi = has('package-lock.json') || has('npm-shrinkwrap.json');
    const useYarn = has('yarn.lock');
    const usePnpm = has('pnpm-lock.yaml');

    const install = usePnpm ? 'pnpm install --frozen-lockfile || pnpm install'
      : useYarn ? 'yarn install --frozen-lockfile || yarn install'
      : lockCi ? 'npm ci || npm install'
      : 'npm install';

    const build = scripts.build ? `${pmRun(usePnpm, useYarn)} build` : '';
    const framework = detectNodeFramework(pkg);

    // Prefer the repo's own test script. Failing that, run the ONE runner it depends on —
    // never a `||` chain (see RUNNER_CMD above). No script and no declared runner means we
    // genuinely cannot test this repo, and '' says so out loud.
    const test = scripts.test ? `${pmRun(usePnpm, useYarn)} test` : (RUNNER_CMD[framework] || '');

    // Tier 2 static signals (soft) — only when the repo clearly supports them.
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const lint = scripts.lint ? `${pmRun(usePnpm, useYarn)} lint` : '';
    const typecheck = scripts.typecheck
      ? `${pmRun(usePnpm, useYarn)} typecheck`
      : (deps.typescript || has('tsconfig.json')) ? 'npx tsc --noEmit' : '';

    const nodeConfig = {
      language: 'node',
      commands: {
        install,
        preTest: '',
        test,
        testOne: RUNNER_ONE[framework] || '',
        smoke: build ? `${build} --if-present` : '',
        lint,
        typecheck,
      },
      test: { filePattern: '**/*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}', framework },
    };
    // Pre-fill an opt-in "drive" block for recognized web frameworks (R1). Disabled by
    // default — detection can't know the app boots cleanly — so it changes nothing until
    // the user flips enabled:true. It just saves them writing the startCommand by hand.
    const drive = suggestDrive(pkg, scripts);
    if (drive) nodeConfig.drive = drive;
    return nodeConfig;
  }

  // ── Python ───────────────────────────────────────────────────────────
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    const install = has('pyproject.toml')
      ? 'pip install -e . || pip install .'
      : has('requirements.txt')
        ? 'pip install -r requirements.txt'
        : 'pip install -e .';
    // Static signals only when the repo clearly configures the tool (no noise).
    const readIf = (f) => {
      if (!has(f)) return '';
      try { return fs.readFileSync(path.join(repoPath, f), 'utf8') || ''; } catch { return ''; /* best-effort */ }
    };
    const pyproject = readIf('pyproject.toml');
    const setupCfg = readIf('setup.cfg');
    const requirements = `${readIf('requirements.txt')}\n${readIf('requirements-dev.txt')}\n${readIf('dev-requirements.txt')}`;

    // pytest ONLY when the repo evidences it, and never chained. The old
    // `pytest -q || python -m pytest -q || python -m unittest` ended in a discovery run that
    // exits 0 on finding nothing, so a genuinely failing suite reported ✅ on a hard check.
    // No evidence ⇒ '' ⇒ validate() refuses the config, which is the honest answer.
    const pytestEvidenced = evidencesPytest({ pyproject, setupCfg, requirements }) || has('pytest.ini');
    const pyTest = pytestEvidenced ? 'pytest -q' : '';
    const pyTestOne = pytestEvidenced ? 'pytest -q {file}' : '';
    const lint = (has('ruff.toml') || has('.ruff.toml') || /\[tool\.ruff/.test(pyproject)) ? 'ruff check .'
      : has('.flake8') ? 'flake8 .' : '';
    const typecheck = (has('mypy.ini') || has('.mypy.ini') || /\[tool\.mypy/.test(pyproject)) ? 'mypy .' : '';
    return {
      language: 'python',
      commands: {
        install,
        preTest: '',
        test: pyTest,
        testOne: pyTestOne,
        smoke: '',
        lint,
        typecheck,
      },
      test: { filePattern: '**/{test_*,*_test}.py', framework: 'pytest' },
    };
  }

  // ── Go ───────────────────────────────────────────────────────────────
  if (has('go.mod')) {
    return {
      language: 'go',
      commands: {
        install: 'go mod download',
        preTest: 'go build ./...',
        test: 'go test ./...',
        testOne: 'go test -run . {file}',
        smoke: 'go build ./...',
        lint: 'go vet ./...', // ships with the go toolchain
        typecheck: '',
      },
      test: { filePattern: '**/*_test.go', framework: 'go test' },
    };
  }

  // ── Rust ─────────────────────────────────────────────────────────────
  if (has('Cargo.toml')) {
    return {
      language: 'rust',
      commands: {
        install: 'cargo fetch',
        preTest: 'cargo build',
        test: 'cargo test',
        testOne: 'cargo test',
        smoke: 'cargo build',
        lint: 'cargo clippy --quiet', // clippy ships with the standard toolchain/images
        typecheck: '',
      },
      test: { filePattern: '**/*.rs', framework: 'cargo test' },
    };
  }

  return null;
}

function pmRun(usePnpm, useYarn) {
  if (usePnpm) return 'pnpm run';
  if (useYarn) return 'yarn';
  return 'npm run';
}

function detectNodeFramework(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.vitest) return 'vitest';
  if (deps.jest) return 'jest';
  if (deps.mocha) return 'mocha';
  if (deps.ava) return 'ava';
  return 'unknown';
}

/**
 * Suggest an opt-in "drive" block for web apps (R1) so a user only has to flip enabled:true.
 * Returns null for non-web repos (CLIs, libraries) so nothing is suggested there. Disabled by
 * default. The startCommand serves the PRODUCTION build that tier1's smoke/build step already
 * produced (vite → dist via `vite preview`, next → .next via `next start`), which is what
 * actually ships — so a runtime blank-screen here is the real thing, not a dev-server artifact.
 */
function suggestDrive(pkg, scripts = pkg.scripts || {}) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  let startCommand = '';
  if (deps.vite && scripts.preview) {
    startCommand = 'npm run preview -- --port 4173';
  } else if (deps.next && scripts.start) {
    startCommand = 'npm run start -- -p 4173';
  }
  if (!startCommand) return null;
  return {
    enabled: false,          // opt-in: flip to true (and set your routes) to turn driving on
    startCommand,
    url: 'http://127.0.0.1',
    port: 4173,
    routes: ['/'],
  };
}

/** Deep-ish merge: explicit (user) values override detected ones. */
function merge(detected, user) {
  const out = { ...(detected || {}), ...(user || {}) };
  out.commands = { ...((detected || {}).commands || {}), ...((user || {}).commands || {}) };
  out.test = { ...((detected || {}).test || {}), ...((user || {}).test || {}) };
  out.smoke = { ...((detected || {}).smoke || {}), ...((user || {}).smoke || {}) };
  out.secrets = { ...DEFAULT_SECRETS, ...((detected || {}).secrets || {}), ...((user || {}).secrets || {}) };
  out.crap = { ...DEFAULT_CRAP, ...((detected || {}).crap || {}), ...((user || {}).crap || {}) };
  out.deps = { ...DEFAULT_DEPS, ...((detected || {}).deps || {}), ...((user || {}).deps || {}) };
  out.timeouts = { ...DEFAULT_TIMEOUTS, ...((detected || {}).timeouts || {}), ...((user || {}).timeouts || {}) };
  out.isolation = { ...((detected || {}).isolation || {}), ...((user || {}).isolation || {}) };
  // Only materialize `drive` when one side actually has it, so non-web repos stay clean. The
  // shallow merge lets detection supply the startCommand while the user just flips enabled:true.
  if ((detected && detected.drive) || (user && user.drive)) {
    out.drive = { ...((detected || {}).drive || {}), ...((user || {}).drive || {}) };
  }
  out.skipGlobs = (user && user.skipGlobs) || (detected && detected.skipGlobs) || DEFAULT_SKIP_GLOBS;
  out.workdir = (user && user.workdir) || (detected && detected.workdir) || '.';
  return out;
}

/**
 * ── The trust boundary ───────────────────────────────────────────────────────
 *
 * `felix.config.json` is written by whoever opens the pull request. This file already knew that
 * about `drive.flows` ("SAFETY: this file is attacker-controlled") and fenced it; the fields that
 * decide the VERDICT were never fenced. One line — `"skipGlobs": ["**"]` — made every changed file
 * non-behavioral, short-circuiting the run to SKIPPED, which GitHub does not block a Required check
 * on. No code execution, works from a fork. Same shape for `gating.enabled:false`, a widened
 * `secrets.allowFiles`, or `isolation.mode:"none"`.
 *
 * So the config is split in two:
 *
 *   POLICY    — everything that shapes Felix's own judgment, enforcement or containment. Read from
 *               the BASE ref (merged, reviewed content). The head never contributes to it.
 *   MECHANICS — the three things that must describe the tree actually being run. Read from head,
 *               deliberately: a PR that adds a runner, renames a script or switches tooling has to
 *               be verified with ITS commands, not the base's stale ones.
 *
 * Base-sourcing `commands` would be theatre rather than a boundary. `commands.test` is almost never
 * a literal runner — it is `npm run test` / `pytest`, whose BODY lives in head's package.json or
 * conftest.py, which must come from head because running head's code is the entire product. An
 * attacker reproduces the bypass one level down in a diff that looks *more* innocent, while honest
 * PRs pay false blocks. What covers that class is the control-surface rule in index.js: a PR
 * touching package.json or felix.config.json is verified, never triaged away.
 *
 * The two lists are DISJOINT, and a test enforces it — the effective config is a spread of one over
 * the other, so a key in both would let spread order silently decide policy.
 */
const POLICY_KEYS = [
  'skipGlobs', 'workdir', 'gating', 'isolation', 'secrets',
  'timeouts', 'smoke', 'crap', 'deps', 'drive', 'judge',
];
const MECHANICS_KEYS = ['language', 'commands', 'test'];

/** Copy exactly `keys` from `obj`. An allowlist, never a spread — see resolvePolicy's note. */
function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/**
 * Build the policy half from the base ref's config (or from nothing at all).
 *
 * Every block is materialized from built-in defaults upward. Head is not in the lookup chain —
 * not as a fallback, not for a block that base merely omits. That last part is the subtle one:
 * implementing this as "load head's config, then patch the policy keys over the top" leaves HEAD's
 * value in place wherever base omits a block, because there is no key to overwrite it with.
 * Omission is not override, and a field-by-field test does not catch it.
 */
function resolvePolicy(baseConfig) {
  const b = baseConfig || {};
  const policy = {
    // An explicit [] at base means "skip nothing" and must survive; only absence takes the default.
    skipGlobs: Array.isArray(b.skipGlobs) ? b.skipGlobs : DEFAULT_SKIP_GLOBS,
    workdir: (typeof b.workdir === 'string' && b.workdir) ? b.workdir : '.',
    gating: { ...(b.gating || {}) },        // resolveGating() layers DEFAULT_GATING over this
    isolation: { ...(b.isolation || {}) },  // resolveIsolation() layers DEFAULT_ISOLATION
    secrets: { ...DEFAULT_SECRETS, ...(b.secrets || {}) },
    timeouts: { ...DEFAULT_TIMEOUTS, ...(b.timeouts || {}) },
    smoke: { ...(b.smoke || {}) },
    crap: { ...DEFAULT_CRAP, ...(b.crap || {}) },
    deps: { ...DEFAULT_DEPS, ...(b.deps || {}) },
    judge: { ...(b.judge || {}) },
  };

  // The jail image must not be steerable from head. resolveIsolation() picks it from
  // `config.language`, which is MECHANICS — so pin it here from the language BASE declares, and
  // only fall through to the head-detected language when base declares none. The residual is then
  // bounded: with no base language a PR can nudge the image among four pinned official images,
  // whose only effect is failing Tier 1 — which it could achieve anyway by breaking the build.
  if (!policy.isolation.image && b.language && IMAGE_BY_LANGUAGE[b.language]) {
    policy.isolation.image = IMAGE_BY_LANGUAGE[b.language];
  }

  // `drive` materializes ONLY when base declares it — note the absence of a `{}` default. Two
  // reasons. Auto-detection's suggestDrive() pre-fills a startCommand from head's package.json,
  // and `drive.url` is taken VERBATIM as a fetch origin by joinUrl() and probed with Felix's own
  // fetch, outside the Docker jail. flows.js fences `goto` to same-origin paths so a flow cannot
  // become an SSRF hop; the origin itself was never fenced.
  if (b.drive) policy.drive = { ...b.drive };
  return policy;
}

/**
 * Resolve `workdir` to a real absolute path that is genuinely inside the sandbox.
 *
 * `path.relative` rather than a string prefix test, which passes "/foo" vs "/foobar". `realpath`
 * on the target because the sandbox is a worktree of attacker content: git commits symlinks
 * (mode 120000), so a PR can replace the directory base names with a link pointing anywhere, and
 * path.resolve is string math that would wave it through. That matters most in Docker mode, where
 * wrapCommand mounts `-v <cwd>:/work` — an escaped cwd mounts an arbitrary host directory
 * read-write into the jail and defeats its entire purpose.
 *
 * Hard error, never a fallback to '.': falling back runs install at the wrong root, install fails,
 * and the verdict becomes INSUFFICIENT EVIDENCE → check conclusion `neutral` → does not block.
 * That is the attacker's win condition, so refusing loudly is the only safe answer.
 *
 * Residual (not closed, do not claim otherwise): a TOCTOU race remains. PR code runs during
 * `install` and can swap the directory for a symlink before the `test` spawn uses cwd. Handing
 * back the pre-resolved realpath closes the common case, not the race; closing it properly needs
 * an fd-based spawn Node does not offer.
 */
function resolveWorkdir(sandboxDir, workdir) {
  const wd = workdir || '.';
  if (path.isAbsolute(wd)) {
    throw new Error(`felix.config.json workdir must be relative to the repo root: "${wd}"`);
  }
  const root = fs.realpathSync(sandboxDir);
  let real;
  try {
    real = fs.realpathSync(path.resolve(root, wd));
  } catch (_) {
    throw new Error(`felix.config.json workdir "${wd}" does not exist in the PR tree.`);
  }
  const rel = path.relative(root, real);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error(`felix.config.json workdir "${wd}" escapes the sandbox.`);
  }
  return real;
}

function validate(config) {
  const errors = [];
  if (!config.commands || !config.commands.test) {
    // Reached when detection found a project it recognizes but no runner it can PROVE is
    // there. Refusing by name is the point: the alternative was guessing a chain of runners
    // and reporting whichever one exited 0. Tell them exactly what to set.
    errors.push(
      'commands.test is required (could not detect a test command) — set "commands": ' +
      '{ "test": "<your test command>" } in felix.config.json. Felix will not guess a test ' +
      'runner it cannot see, because a runner that finds no tests exits 0 and would report a ' +
      'false pass.'
    );
  }
  if (!config.commands || !config.commands.install) {
    errors.push('commands.install is required');
  }
  return errors;
}

/**
 * Parse a felix.config.json, refusing a broken one by name.
 *
 * Deliberately stricter than readJSON() above, which stays lenient because it reads THIRD-PARTY
 * manifests (package.json, pyproject.toml) where a malformed file is the repo's own problem and
 * detection should simply move on. A malformed *Felix* config is different: swallowing it means a
 * repo that believes it configured gating silently has none — the quiet lie this change exists to
 * remove. Head and base are both strict, for the same reason.
 */
function parseConfigJSON(raw, where) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${CONFIG_FILENAME} at ${where} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} at ${where} must be a JSON object.`);
  }
  return parsed;
}

/**
 * Resolve the effective config: POLICY from the base ref, MECHANICS from the PR head.
 *
 * `fetchBaseConfig` is injected rather than reached for directly, so the boundary is unit-testable
 * without a network or a git fixture. Its contract is three-valued and the third value carries the
 * safety property:
 *
 *   { present: true, raw }  — the file exists at base
 *   { present: false }      — the ref resolved, the file is genuinely absent → built-in defaults
 *   throws                  — the ref itself could not be read → REFUSE
 *
 * That last case must never fall back to head. Failing closed here costs a run; failing open hands
 * the PR the policy it is judged by, which is the whole bug.
 *
 * @param {object} opts
 * @param {string} opts.repoPath          local checkout of the PR head (mechanics + detection)
 * @param {function} opts.fetchBaseConfig async () => ({present, raw?, ref?})
 * @returns {Promise<{config:object, source:string, detected:boolean, policySource:string}>}
 */
async function loadConfig({ repoPath, fetchBaseConfig }) {
  if (typeof fetchBaseConfig !== 'function') {
    throw new Error('loadConfig requires a fetchBaseConfig() — policy must be read from the base ref.');
  }

  // ── POLICY — base ref only ──────────────────────────────────────────────
  const base = await fetchBaseConfig();
  const baseConfig = (base && base.present) ? parseConfigJSON(base.raw, 'the base ref') : null;
  const policy = resolvePolicy(baseConfig);
  const policySource = baseConfig
    ? `${CONFIG_FILENAME} @ base ${(base && base.ref) || ''}`.trim()
    : `built-in defaults (no ${CONFIG_FILENAME} at the base ref)`;

  // ── MECHANICS — PR head ─────────────────────────────────────────────────
  const configPath = path.join(repoPath, CONFIG_FILENAME);
  const user = exists(configPath) ? parseConfigJSON(fs.readFileSync(configPath, 'utf8'), repoPath) : null;
  const detected = detect(repoPath);

  if (!user && !detected) {
    throw new Error(
      `No ${CONFIG_FILENAME} at ${repoPath} and could not auto-detect the project type. ` +
      `Add a ${CONFIG_FILENAME} (see felix.config.example.json).`
    );
  }

  // Allowlist-picked, then spread over policy. Because the two key sets are provably disjoint
  // (enforced by a test), spread order cannot decide policy and no head key survives by omission.
  const mechanics = pick(merge(detected, user), MECHANICS_KEYS);
  const config = { ...policy, ...mechanics };

  const errors = validate(config);
  if (errors.length) {
    throw new Error(`Invalid Felix config:\n  - ${errors.join('\n  - ')}`);
  }

  const source = user
    ? (detected ? `${CONFIG_FILENAME} (+ auto-detect fallback)` : CONFIG_FILENAME)
    : `auto-detected (${detected.language})`;

  if (!user) logger.info(`learned repo: ${source}`);
  logger.info(`policy: ${policySource}`);
  return { config, source, detected: !user, policySource };
}

module.exports = {
  loadConfig, detect, merge, validate, resolvePolicy, resolveWorkdir, parseConfigJSON,
  POLICY_KEYS, MECHANICS_KEYS, CONFIG_FILENAME,
  DEFAULT_SKIP_GLOBS, DEFAULT_TIMEOUTS, DEFAULT_SECRETS, DEFAULT_CRAP, DEFAULT_DEPS,
};
