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

// CRAP (Change Risk Anti-Patterns) — a soft Tier 1 signal that flags changed
// functions which are both complex and under-tested. OFF by default: enabling it
// runs the test suite a second time under coverage, so the user opts in explicitly.
// `threshold` is the CRAP score above which a function is flagged (crap4j uses 30;
// Uncle Bob drives to <6). Always advisory in v1 — it never gates the verdict.
const DEFAULT_CRAP = {
  enabled: false,
  threshold: 30,
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
  DEFAULT_SKIP_GLOBS, DEFAULT_TIMEOUTS, DEFAULT_SECRETS, DEFAULT_CRAP,
};
