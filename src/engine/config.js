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

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
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

    // Prefer a real test script; otherwise try the common runners directly.
    const test = scripts.test
      ? `${pmRun(usePnpm, useYarn)} test`
      : 'npx vitest run || npx jest || npx mocha';

    const build = scripts.build ? `${pmRun(usePnpm, useYarn)} build` : '';
    const framework = detectNodeFramework(pkg);

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
        testOne: 'npx vitest run {file} || npx jest {file} || npx mocha {file}',
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
    let pyproject = '';
    if (has('pyproject.toml')) {
      try { pyproject = fs.readFileSync(path.join(repoPath, 'pyproject.toml'), 'utf8') || ''; } catch { /* best-effort */ }
    }
    const lint = (has('ruff.toml') || has('.ruff.toml') || /\[tool\.ruff/.test(pyproject)) ? 'ruff check .'
      : has('.flake8') ? 'flake8 .' : '';
    const typecheck = (has('mypy.ini') || has('.mypy.ini') || /\[tool\.mypy/.test(pyproject)) ? 'mypy .' : '';
    return {
      language: 'python',
      commands: {
        install,
        preTest: '',
        test: 'pytest -q || python -m pytest -q || python -m unittest',
        testOne: 'pytest -q {file} || python -m pytest -q {file}',
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

function validate(config) {
  const errors = [];
  if (!config.commands || !config.commands.test) {
    errors.push('commands.test is required (could not detect a test command)');
  }
  if (!config.commands || !config.commands.install) {
    errors.push('commands.install is required');
  }
  return errors;
}

/**
 * Resolve the effective config for a target repo.
 * @param {string} repoPath  absolute path to the target repo checkout
 * @returns {{config:object, source:string, detected:boolean}}
 */
function loadConfig(repoPath) {
  const configPath = path.join(repoPath, 'felix.config.json');
  const user = exists(configPath) ? readJSON(configPath) : null;
  const detected = detect(repoPath);

  if (!user && !detected) {
    throw new Error(
      `No felix.config.json at ${repoPath} and could not auto-detect the project type. ` +
      'Add a felix.config.json (see felix.config.example.json).'
    );
  }

  const config = merge(detected, user);
  const errors = validate(config);
  if (errors.length) {
    throw new Error(`Invalid Felix config:\n  - ${errors.join('\n  - ')}`);
  }

  const source = user
    ? (detected ? 'felix.config.json (+ auto-detect fallback)' : 'felix.config.json')
    : `auto-detected (${detected.language})`;

  if (!user) logger.info(`learned repo: ${source}`);
  return { config, source, detected: !user };
}

module.exports = {
  loadConfig, detect, merge, validate,
  DEFAULT_SKIP_GLOBS, DEFAULT_TIMEOUTS, DEFAULT_SECRETS,
};
