/**
 * tier1.js — deterministic, non-LLM checks against the running PR code.
 *
 * Order: install → build/smoke → full test → targeted re-run of changed test
 * files → secrets scan. Each check yields:
 *   { name, tier:1, status:'pass'|'fail'|'skip', hard:boolean, detail, output }
 *
 * `hard` checks gate the verdict (a hard fail ⇒ NOT VERIFIED). Soft checks are
 * informational. Outputs are tailed and handed to the judge + the comment.
 */

const path = require('path');
const picomatch = require('picomatch');
const { run, tail } = require('./util/exec');
const { wrapCommand, resolveIsolation } = require('./isolation');
const { buildDrivePlan, driveApp } = require('./drive');
const { runCrapCheck } = require('./crap');
const { runDepsCheck } = require('./deps');
const { logger } = require('./util/logger');

// Vendor-specific, high-signal secret shapes. A match here has a distinctive prefix
// that essentially never occurs in prose or fixtures, so flag it unconditionally.
const STRONG_PATTERNS = [
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'OpenAI key', re: /sk-(?:proj-)?[A-Za-z0-9]{20,}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
];

// Generic `name: "value"` assignment. This one USED to cry wolf: it matched ANY 16+
// char string assigned to a var named secret/password/token/api_key — including FAKE
// test fixtures whose whole purpose is to be asserted ABSENT (e.g.
// `token: 'super-secret-token'`, `token: 'tok-must-not-leak'`). Felix's own test file
// had to string-split a fixture to dodge it, which is the tell that the detector, not
// the fixtures, is wrong.
//
// The fix: a real credential is RANDOM; a fixture is dictionary words. So the captured
// VALUE must also clear a Shannon-entropy floor (and not be an obvious placeholder)
// before it counts — the same high-entropy discriminator gitleaks / truffleHog use.
// The `g` flag + a capture group let us test every assignment's value, not just the
// first match in the file.
const GENERIC_ASSIGN_RE = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]([A-Za-z0-9/+_-]{16,})['"]/gi;

// bits/char. Random hex ≈ 3.9+, base64 ≈ 4.5+; dictionary-word fixtures land ≈ 3.3.
// 3.5 sits in the gap with margin on both sides (verified against real + fake samples).
const GENERIC_ENTROPY_MIN = 3.5;

// Obvious non-secrets that could, in principle, still clear the entropy floor. A cheap
// second gate so a value that SCREAMS placeholder is skipped regardless of entropy.
const PLACEHOLDER_RE = /example|sample|placeholder|changeme|dummy|fake|redacted|your[-_]|xxxx|foobar|not[-_]?a?[-_]?real|replace[-_]?me|\bmock|\btest|(.)\1{7,}/i;

/** Shannon entropy in bits per character. 0 for empty. */
function shannonEntropy(s) {
  if (!s) return 0;
  const freq = Object.create(null);
  for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
  let h = 0;
  for (const ch in freq) {
    const p = freq[ch] / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Does a generic-assignment VALUE look like a real credential rather than a fixture?
 * Real secrets are high-entropy random strings; placeholders and fake test tokens are
 * low-entropy dictionary words. An explicit placeholder marker vetoes regardless.
 */
function looksLikeRealSecret(value) {
  if (PLACEHOLDER_RE.test(value)) return false;
  return shannonEntropy(value) >= GENERIC_ENTROPY_MIN;
}

/**
 * Mask a matched value for the PR comment: a public comment must never echo a secret
 * that might be real, but a bare "1 potential secret(s)" made the last two failures a
 * guessing game. Prefix + length is enough to locate it without leaking it.
 */
function maskSecret(v) {
  return `${v.slice(0, 4)}…(${v.length} chars)`;
}

// Back-compat export: the vendor shapes only (the generic one now has its own gate).
const SECRET_PATTERNS = STRONG_PATTERNS;

function subst(cmd, file) {
  return cmd.replace(/\{file\}/g, file);
}

async function runCheck({ name, hard, cmd, cwd, env, timeoutMs, isolation, network }) {
  if (!cmd || !cmd.trim()) {
    return { name, tier: 1, status: 'skip', hard, detail: 'no command configured', output: '' };
  }
  const finalCmd = wrapCommand(cmd, { isolation, cwd, network });
  logger.step('T1', `${name}: ${cmd}${isolation && isolation.mode === 'docker' ? ' [docker]' : ''}`);
  const r = await run(finalCmd, { cwd, env, timeoutMs });
  const pass = r.code === 0 && !r.timedOut;
  return {
    name,
    tier: 1,
    status: pass ? 'pass' : 'fail',
    hard,
    detail: r.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${r.code} in ${r.durationMs}ms`,
    output: tail(r.combined, 4000),
  };
}

/**
 * Scan the changed files on disk for secret-looking strings.
 * `hard` gates the verdict by default; pass hard:false to run it as an ADVISORY backstop when
 * an authoritative external scanner (secrets.externalScan) is configured as the real gate.
 */
function scanSecrets({ cwd, files, secretsCfg, hard = true }) {
  const fs = require('fs');
  const allow = (secretsCfg.allowFiles || []).map((g) => picomatch(g));
  const findings = [];
  for (const f of files) {
    if (f.status === 'removed') continue;
    if (allow.some((m) => m(f.filename))) continue;
    const abs = path.join(cwd, f.filename);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }

    // Vendor shapes: any match is high-signal, flag it.
    for (const p of STRONG_PATTERNS) {
      const m = text.match(p.re);
      if (m) findings.push(`${f.filename}: ${p.name} — ${maskSecret(m[0])}`);
    }

    // Generic assignments: flag only values that actually look like credentials, so a
    // fake test token (a dictionary-word value) no longer fails CI. matchAll walks every
    // assignment in the file, not just the first.
    for (const m of text.matchAll(GENERIC_ASSIGN_RE)) {
      const value = m[1];
      if (looksLikeRealSecret(value)) {
        findings.push(`${f.filename}: Generic secret assignment — ${maskSecret(value)}`);
      }
    }
  }
  const deferred = hard ? '' : ' (advisory — external scanner is the gate)';
  return {
    name: 'secrets scan',
    tier: 1,
    status: findings.length ? 'fail' : 'pass',
    hard,
    detail: (findings.length ? `${findings.length} potential secret(s)` : 'no secrets in changed files') + deferred,
    output: findings.join('\n'),
  };
}

/** Changed test files matching the config's test filePattern. */
function changedTestFiles(files, config) {
  const pat = (config.test && config.test.filePattern) || '**/*.{test,spec}.*';
  const isTest = picomatch(pat);
  return files
    .filter((f) => f.status !== 'removed' && isTest(f.filename))
    .map((f) => f.filename);
}

async function runTier1({ cwd, env, config, files, repoPath, baseSha, headSha, filesAll }) {
  const c = config.commands || {};
  const t = config.timeouts || {};
  const isolation = resolveIsolation(config);
  // Opt-in "drive" step (R1): boot the app + probe routes. When enabled, a build
  // failure means we can't boot, so the build is promoted to a HARD gate below.
  const drivePlan = buildDrivePlan(config);
  const results = [];
  if (isolation.mode === 'docker') {
    logger.info(`isolation: docker (${isolation.image}, net-deny except install)`);
  }

  // Install is the only step allowed network access (to fetch dependencies).
  const install = await runCheck({
    name: 'install', hard: true, cmd: c.install, cwd, env,
    timeoutMs: t.installMs || 300000, isolation, network: 'allow',
  });
  results.push(install);

  // If install failed there's no point running the rest — bail with skips.
  if (install.status === 'fail') {
    logger.warn('install failed — skipping build/test (INSUFFICIENT EVIDENCE territory)');
    for (const name of ['build/smoke', 'test', 'secrets scan']) {
      results.push({ name, tier: 1, status: 'skip', hard: name === 'test', detail: 'install failed', output: '' });
    }
    return { results, installFailed: true };
  }

  if (c.preTest && c.preTest.trim()) {
    results.push(await runCheck({ name: 'preTest', hard: true, cmd: c.preTest, cwd, env, timeoutMs: t.testMs || 600000, isolation, network: 'deny' }));
  }

  const smokeExpect = (config.smoke && config.smoke.expect) || '';
  results.push(await runCheck({
    name: 'build/smoke', hard: Boolean((smokeExpect && smokeExpect.trim()) || drivePlan),
    cmd: c.smoke, cwd, env, timeoutMs: (config.smoke && config.smoke.timeoutMs) || 60000, isolation, network: 'deny',
  }));

  const testResult = await runCheck({ name: 'test', hard: true, cmd: c.test, cwd, env, timeoutMs: t.testMs || 600000, isolation, network: 'deny' });
  results.push(testResult);

  // CRAP (opt-in, soft): flag changed functions that are complex AND under-tested.
  // The enabled gate is FIRST — when off, NOTHING is pushed, so the verdict is
  // byte-identical to a build without this check. When on, it runs the suite once
  // more under coverage (c8) + measures cyclomatic complexity (escomplex) on the
  // changed functions. A failing suite makes coverage meaningless, so skip then.
  if (config.crap && config.crap.enabled) {
    if (testResult.status !== 'pass') {
      results.push({ name: 'crap', tier: 1, status: 'skip', hard: false, detail: 'crap: tests did not pass — coverage would be meaningless, not scoring', output: '' });
    } else {
      results.push(await runCrapCheck({
        cwd, env, testCmd: c.test, files,
        threshold: config.crap.threshold,
        isolationMode: isolation.mode,
        run, timeoutMs: t.testMs || 600000,
      }));
    }
  }

  // Dependency-direction check (opt-in, soft/advisory). Gate FIRST so a disabled repo
  // builds no graph and its verdict stays byte-identical — nothing is pushed here at all.
  // It cruises pristine base+head worktrees itself (not `cwd`), so no sandbox dir is passed.
  // filesAll MUST be the FULL changed-file list — no fallback to the behavioral `files`
  // subset (a filtered list would miss renames and phantom-flag; runDepsCheck SKIPs on absence).
  if (config.deps && config.deps.enabled) {
    results.push(await runDepsCheck({
      repoPath, baseSha, headSha, filesAll, config, run,
      timeoutMs: config.deps.timeoutMs || 120000,
    }));
  }

  // Drive the running app (R1, opt-in): boot it and probe declared routes. These
  // are HARD checks — a 500/404/blank boot on a declared route → NOT VERIFIED.
  if (drivePlan) {
    logger.info(`drive: booting the app and probing ${drivePlan.routes.length} route(s)`);
    const drive = await driveApp({ cwd, env, plan: drivePlan });
    results.push(...drive.results);
  }

  // Tier 2 static signals (soft) — lint + typecheck feed the judge as extra
  // evidence but never gate the verdict on their own.
  if (c.lint && c.lint.trim()) {
    results.push(await runCheck({ name: 'lint', hard: false, cmd: c.lint, cwd, env, timeoutMs: t.testMs || 600000, isolation, network: 'deny' }));
  }
  if (c.typecheck && c.typecheck.trim()) {
    results.push(await runCheck({ name: 'typecheck', hard: false, cmd: c.typecheck, cwd, env, timeoutMs: t.testMs || 600000, isolation, network: 'deny' }));
  }

  // Targeted re-run of changed test files (soft, fast signal).
  const changed = changedTestFiles(files, config);
  if (changed.length && c.testOne && c.testOne.trim()) {
    for (const file of changed.slice(0, 10)) {
      results.push(await runCheck({
        name: `testOne: ${file}`, hard: false,
        cmd: subst(c.testOne, file), cwd, env, timeoutMs: t.testOneMs || 180000, isolation, network: 'deny',
      }));
    }
  }

  // Secrets. If the repo opts into an authoritative external scanner (e.g. gitleaks), run it
  // as the HARD gate and demote Felix's built-in changed-files scan to an advisory backstop —
  // Felix defers rather than double-gating (R4). Otherwise the built-in scan is the gate.
  const secretsCfg = config.secrets || {};
  const externalScan = (secretsCfg.externalScan || '').trim();
  if (externalScan) {
    results.push(await runCheck({
      name: 'secrets scan (external)', hard: true, cmd: externalScan, cwd, env,
      timeoutMs: t.testMs || 600000, isolation, network: 'deny',
    }));
    results.push(scanSecrets({ cwd, files, secretsCfg, hard: false }));
  } else {
    results.push(scanSecrets({ cwd, files, secretsCfg }));
  }

  return { results, installFailed: false };
}

module.exports = {
  runTier1, scanSecrets, changedTestFiles, SECRET_PATTERNS,
  shannonEntropy, looksLikeRealSecret,
};
