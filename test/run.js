/**
 * run.js — Felix unit tests. No framework, no network.
 *
 * Covers the pure/deterministic surface: config auto-detection, spec parsing,
 * the verdict decision table, the cross-family guard, secret scanning, target
 * parsing, and comment rendering. Run with `npm test`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detect, merge, validate } = require('../src/engine/config');
const { extractCriteria, buildSpec, linkedIssueNumbers } = require('../src/engine/spec');
const { compose, VERDICTS, conclusionFor } = require('../src/engine/verdict');const { assertCrossFamily, buildPrompt, createJudge, mergeChunkRulings, chunkVerdict, PROVIDERS } = require('../src/engine/judge');
const {
  estimateTokens, tokensToChars, splitDiffByFile, packChunks, planJudgeCalls, paceMs,
} = require('../src/engine/budget');
const { scanSecrets, shannonEntropy, looksLikeRealSecret } = require('../src/engine/tier1');
const { parseTarget } = require('../src/engine/github');
const { render } = require('../src/engine/comment');
const { triageFiles, triggerGate } = require('../src/engine');
const { resolveIsolation, wrapCommand } = require('../src/engine/isolation');
const { renderError } = require('../src/engine/comment');
const { computeMetrics, OUTCOMES } = require('../src/engine/calibration');
const { resolveGating, gateDecision } = require('../src/engine/gating');
const { parseRevertedPR, detectRevertedPRs } = require('../src/engine/outcomes');
const { FIXTURES, oracleJudge, truthOutcome } = require('./calibration-fixtures');
const { buildDrivePlan, interpretProbe, joinUrl, resolveDrive, interpretPageLoad } = require('../src/engine/drive');
const {
  resolveFlowOpts, normalizeStep, validateFlow, buildFlows, describeStep, interpretFlow,
  resolveValue, runFlows,
} = require('../src/engine/flows');

// Split so this very test file doesn't trip Felix's own secrets scanner on the
// literal — the value is only assembled at runtime to feed scanSecrets.
const FAKE_AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';

// Injected wherever a test drives the rate-limit retry or the multi-chunk pacing path, so
// the suite asserts the LOGIC without paying the real wall-clock delay.
const noSleep = () => Promise.resolve();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Deferred async tests — the sync `test()` above can't await a promise. Registered here and
// run after the whole sync suite completes (see the IIFE at the bottom of the file). Used by
// the judge wire-contract tests, which drive an injected fake fetch through async judge().
const asyncTests = [];
function atest(name, fn) { asyncTests.push({ name, fn }); }

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'felix-test-'));
}

console.log('config.detect');
test('detects a node repo with vitest + ci lock', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    scripts: { test: 'vitest run', build: 'tsc' }, devDependencies: { vitest: '^1' },
  }));
  fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
  const c = detect(d);
  assert.strictEqual(c.language, 'node');
  assert.match(c.commands.install, /npm ci/);
  assert.match(c.commands.test, /npm run test/);
  assert.strictEqual(c.test.framework, 'vitest');
});
test('detects node Tier 2 static signals (lint + typecheck)', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { typescript: '^5' },
  }));
  const c = detect(d);
  assert.match(c.commands.lint, /run lint/);
  assert.match(c.commands.typecheck, /tsc --noEmit/);
});
test('omits static signals when the repo has none', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
  const c = detect(d);
  assert.strictEqual(c.commands.lint, '');
  assert.strictEqual(c.commands.typecheck, '');
});
test('detects go static signal (go vet)', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'go.mod'), 'module x\n');
  const c = detect(d);
  assert.strictEqual(c.language, 'go');
  assert.match(c.commands.lint, /go vet/);
});
test('detects rust static signal (clippy)', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname = "x"\n');
  const c = detect(d);
  assert.strictEqual(c.language, 'rust');
  assert.match(c.commands.lint, /clippy/);
});
test('detects python static signals from pyproject tool sections', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'pyproject.toml'), '[tool.ruff]\n[tool.mypy]\n');
  const c = detect(d);
  assert.strictEqual(c.language, 'python');
  assert.match(c.commands.lint, /ruff check/);
  assert.match(c.commands.typecheck, /mypy/);
});
test('omits python static signals when unconfigured', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'requirements.txt'), 'pytest\n');
  const c = detect(d);
  assert.strictEqual(c.commands.lint, '');
  assert.strictEqual(c.commands.typecheck, '');
});
test('detects a python repo', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'requirements.txt'), 'pytest\n');
  const c = detect(d);
  assert.strictEqual(c.language, 'python');
  assert.match(c.commands.test, /pytest/);
});
// ─── no `||` in an auto-detected TEST command ────────────────────────────────
// `||` fires on a non-zero exit and a failing suite is exactly that, so a chained runner
// list handed real failures to whichever runner exited 0 — on a hard:true check. These
// pin the rule directly: one runner, chosen from what the repo declares, or nothing.
const writeRepo = (files) => {
  const d = tmpdir();
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return d;
};

test('a node repo with no test script runs the ONE runner it declares, never a || chain', () => {
  const c = detect(writeRepo({ 'package.json': { devDependencies: { jest: '^29' } } }));
  assert.strictEqual(c.commands.test, 'npx --no-install jest');
  assert.doesNotMatch(c.commands.test, /\|\|/, 'a failing suite must not fall through to another runner');
  assert.doesNotMatch(c.commands.testOne, /\|\|/);
});

test('the declared runner is honored, not a fixed preference order', () => {
  const mocha = detect(writeRepo({ 'package.json': { devDependencies: { mocha: '^11' } } }));
  assert.strictEqual(mocha.commands.test, 'npx --no-install mocha');
  const vitest = detect(writeRepo({ 'package.json': { devDependencies: { vitest: '^2' } } }));
  assert.strictEqual(vitest.commands.test, 'npx --no-install vitest run');
});

test('auto-detected npx commands carry --no-install (no registry fetch in the sandbox)', () => {
  // Bare `npx <pkg>` downloads and executes a package from the registry — inside the
  // sandbox running untrusted PR code. --no-install makes a missing binary exit 1 instead.
  const c = detect(writeRepo({ 'package.json': { devDependencies: { vitest: '^2' } } }));
  for (const cmd of [c.commands.test, c.commands.testOne]) {
    assert.match(cmd, /npx --no-install /, 'every auto-detected npx call must refuse to install');
  }
});

test('a node repo with neither a test script nor a known runner emits NO test command', () => {
  const c = detect(writeRepo({ 'package.json': { dependencies: { express: '^4' } } }));
  assert.strictEqual(c.commands.test, '', 'guessing a runner is what produced the false green');
  const errs = validate(c);
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /could not detect a test command/);
});

test('a repo WITH a test script still uses it — the fix must not break the normal case', () => {
  const c = detect(writeRepo({ 'package.json': { scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2' } } }));
  assert.strictEqual(c.commands.test, 'npm run test');
});

test('python: pytest only when the repo evidences it, and never chained', () => {
  const viaPyproject = detect(writeRepo({ 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-ra"\n' }));
  assert.strictEqual(viaPyproject.commands.test, 'pytest -q');
  const viaReqs = detect(writeRepo({ 'requirements.txt': 'flask==3.0.0\npytest>=8\n' }));
  assert.strictEqual(viaReqs.commands.test, 'pytest -q');
  for (const c of [viaPyproject, viaReqs]) {
    assert.doesNotMatch(c.commands.test, /\|\|/);
    assert.doesNotMatch(c.commands.test, /unittest/, 'unittest discovery exits 0 on zero tests');
  }
});

test('python with no pytest evidence emits NO test command rather than `python -m unittest`', () => {
  // Measured: `python -m unittest` discovering zero tests exits 0 (Python 3.14). As the tail
  // of a || chain that turned every genuine failure into a green hard check.
  const c = detect(writeRepo({ 'requirements.txt': 'flask==3.0.0\n' }));
  assert.strictEqual(c.commands.test, '');
  assert.strictEqual(c.commands.testOne, '');
  assert.match(validate(c)[0], /could not detect a test command/);
});

test('install commands may still chain — there `||` is two ways to do one job', () => {
  // npm ci fails on a stale lockfile and npm install is a correct recovery; if BOTH fail the
  // non-zero exit is caught as installFailed => INSUFFICIENT. Failure was never the trigger
  // for the fallback, which is what made the TEST chain unsound.
  const c = detect(writeRepo({ 'package.json': { scripts: { test: 'x' } }, 'package-lock.json': {} }));
  assert.strictEqual(c.commands.install, 'npm ci || npm install');
});

test('returns null for an unknown repo', () => {
  assert.strictEqual(detect(tmpdir()), null);
});
test('suggests an opt-in drive block for a vite app (disabled, preview startCommand)', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    scripts: { test: 'vitest run', build: 'vite build', preview: 'vite preview' },
    devDependencies: { vite: '^5', vitest: '^1' },
  }));
  const c = detect(d);
  assert.ok(c.drive, 'a vite app should get a suggested drive block');
  assert.strictEqual(c.drive.enabled, false);          // opt-in: inert until the user flips it
  assert.match(c.drive.startCommand, /preview/);
});
test('suggests a drive block for a next app (start serves the production build)', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    scripts: { test: 'jest', build: 'next build', start: 'next start' },
    dependencies: { next: '^14' },
  }));
  const c = detect(d);
  assert.ok(c.drive);
  assert.match(c.drive.startCommand, /start/);
});
test('omits a drive suggestion for a plain node lib (no web framework)', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
  const c = detect(d);
  assert.strictEqual(c.drive, undefined);
});
test('omits a drive suggestion for a vite app with no preview script', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    scripts: { test: 'vitest run', build: 'vite build' }, devDependencies: { vite: '^5' },
  }));
  assert.strictEqual(detect(d).drive, undefined);
});
test('merge composes a detected drive startCommand with a user enable flag', () => {
  const merged = merge(
    { drive: { enabled: false, startCommand: 'npm run preview -- --port 4173', port: 4173 } },
    { drive: { enabled: true, routes: ['/', '/login'] } },
  );
  assert.strictEqual(merged.drive.enabled, true);                                   // user wins
  assert.strictEqual(merged.drive.startCommand, 'npm run preview -- --port 4173');  // detected kept
  assert.deepStrictEqual(merged.drive.routes, ['/', '/login']);
});
test('merge leaves drive absent for non-web repos', () => {
  assert.strictEqual(merge({ commands: { test: 't' } }, {}).drive, undefined);
});

console.log('spec');
test('extracts criteria under an Acceptance Criteria heading', () => {
  const body = [
    'Some intro.',
    '## Acceptance Criteria',
    '- [ ] User can log in with email',
    '- [x] Password is hashed',
    '## Notes',
    '- not a criterion',
  ].join('\n');
  const c = extractCriteria(body);
  assert.deepStrictEqual(c, ['User can log in with email', 'Password is hashed']);
});
test('falls back to bare checkboxes when no heading', () => {
  const c = extractCriteria('- [ ] does the thing\nplain text\n- [x] does another');
  assert.deepStrictEqual(c, ['does the thing', 'does another']);
});
test('linkedIssueNumbers finds closes/refs', () => {
  const n = linkedIssueNumbers('Closes #12 and relates to #34');
  assert.deepStrictEqual(n.sort(), [12, 34]);
});
test('buildSpec maps criteria to changed files', () => {
  const pr = { title: 'Add login', body: '## Requirements\n- [ ] login endpoint works' };
  const files = [{ filename: 'src/login.js', status: 'modified' }];
  const spec = buildSpec(pr, [], files);
  assert.strictEqual(spec.total, 1);
  assert.strictEqual(spec.mappedCount, 1);
  assert.strictEqual(spec.hadRealSpec, true);
});
test('buildSpec marks title-only as not a real spec', () => {
  const spec = buildSpec({ title: 'fix stuff', body: 'no criteria here' }, [], []);
  assert.strictEqual(spec.hadRealSpec, false);
});

console.log('verdict.compose');
const goodTier1 = [{ name: 'install', hard: true, status: 'pass' }, { name: 'test', hard: true, status: 'pass' }];
const realSpec = { hadRealSpec: true, total: 1, mappedCount: 1, source: 'PR description' };
test('SKIPPED when only non-behavioral files', () => {
  assert.strictEqual(compose({ triage: { skipped: true } }).verdict, VERDICTS.SKIPPED);
});
test('INSUFFICIENT when install failed', () => {
  assert.strictEqual(compose({ triage: {}, installFailed: true, spec: realSpec }).verdict, VERDICTS.INSUFFICIENT);
});
test('INSUFFICIENT when no real spec', () => {
  assert.strictEqual(compose({ triage: {}, spec: { hadRealSpec: false } }).verdict, VERDICTS.INSUFFICIENT);
});
test('NOT VERIFIED on hard check fail', () => {
  const t1 = [{ name: 'test', hard: true, status: 'fail', detail: 'exit 1' }];
  const v = compose({ triage: {}, spec: realSpec, tier1: t1, tier3: { criteria: [{ text: 'x', met: true }] } });
  assert.strictEqual(v.verdict, VERDICTS.NOT_VERIFIED);
  assert.ok(v.required_to_pass.length >= 1);
});
test('NOT VERIFIED when judge marks a criterion unmet', () => {
  const v = compose({ triage: {}, spec: realSpec, tier1: goodTier1, tier3: { criteria: [{ text: 'login', met: false, reason: 'no endpoint' }] } });
  assert.strictEqual(v.verdict, VERDICTS.NOT_VERIFIED);
});
test('INSUFFICIENT when judge unavailable', () => {
  const v = compose({ triage: {}, spec: realSpec, tier1: goodTier1, tier3: null });
  assert.strictEqual(v.verdict, VERDICTS.INSUFFICIENT);
  assert.strictEqual(v.reason, 'judge not configured');
});
test('INSUFFICIENT surfaces the judge error when the call failed', () => {
  const v = compose({ triage: {}, spec: realSpec, tier1: goodTier1, tier3: null, judgeStatus: { configured: true, error: 'Judge call failed: 401 invalid api key' } });
  assert.strictEqual(v.verdict, VERDICTS.INSUFFICIENT);
  assert.strictEqual(v.reason, 'judge errored');
  assert.match(v.required_to_pass[0], /401 invalid api key/);
});
test('VERIFIED when all pass and criteria met', () => {
  const v = compose({ triage: {}, spec: realSpec, tier1: goodTier1, tier3: { criteria: [{ text: 'login', met: true }] } });
  assert.strictEqual(v.verdict, VERDICTS.VERIFIED);
});

console.log('judge.assertCrossFamily');
test('throws for anthropic family', () => {
  assert.throws(() => assertCrossFamily('anthropic', 'claude-opus-4'), /Cross-family/);
});
test('throws when model name looks like claude', () => {
  assert.throws(() => assertCrossFamily('openai', 'claude-sonnet'), /Cross-family/);
});
test('allows openai/gpt-4.1', () => {
  assert.doesNotThrow(() => assertCrossFamily('openai', 'gpt-4.1'));
});

console.log('judge — adversarial refute-first mode (R2a)');
const JUDGE_ARGS = { prTitle: 'x', criteria: [{ text: 'login works' }], diff: 'some diff', tier1: [] };
test('buildPrompt default is a plain met/unmet judgment (unchanged behavior)', () => {
  const p = buildPrompt(JUDGE_ARGS);
  assert.match(p, /independent verification judge/);
  assert.ok(!/REFUTE/.test(p), 'default prompt must not be adversarial');
  assert.ok(!/"refutation"/.test(p), 'default schema has no refutation field');
});
test('buildPrompt adversarial forces refute-first + a refutation field + bias-to-not-met', () => {
  const p = buildPrompt({ ...JUDGE_ARGS, adversarial: true });
  assert.match(p, /REFUTE/);
  assert.match(p, /strongest/i);
  assert.match(p, /"refutation"/);              // schema makes the judge commit a disproof first
  assert.match(p, /prefer met:false/i);          // default-to-not-met on ambiguity
});
test('createJudge threads adversarial but still enforces the cross-family guard, and skips without a key', () => {
  assert.throws(() => createJudge({ FELIX_JUDGE_FAMILY: 'anthropic' }, { adversarial: true }), /Cross-family/);
  assert.strictEqual(createJudge({}, { adversarial: true }), null); // no OPENAI_API_KEY → skip, not throw
});

console.log('judge — provider families (R2b: cross-vendor Gemini)');
test('openai stays the default family; skips without its key, returns a fn with it', () => {
  assert.strictEqual(createJudge({}), null);                                   // no OPENAI_API_KEY → skip
  assert.strictEqual(typeof createJudge({ OPENAI_API_KEY: 'sk' }), 'function');
});
test('gemini family skips cleanly without GEMINI_API_KEY (null, not throw)', () => {
  assert.strictEqual(createJudge({ FELIX_JUDGE_FAMILY: 'gemini' }), null);
});
test('gemini family returns a judge fn when GEMINI_API_KEY is present', () => {
  assert.strictEqual(typeof createJudge({ FELIX_JUDGE_FAMILY: 'gemini', GEMINI_API_KEY: 'g-key' }), 'function');
});
test('gemini still enforces the cross-family guard (a claude model is refused)', () => {
  assert.throws(
    () => createJudge({ FELIX_JUDGE_FAMILY: 'gemini', FELIX_JUDGE_MODEL: 'claude-3-opus', GEMINI_API_KEY: 'g-key' }),
    /Cross-family/,
  );
});
test('an unknown judge family fails loud and names the supported families', () => {
  let msg = '';
  try { createJudge({ FELIX_JUDGE_FAMILY: 'cohere' }); } catch (e) { msg = e.message; }
  assert.match(msg, /not supported/);
  assert.match(msg, /openai/);
  assert.match(msg, /gemini/);
});
test('PROVIDERS declares per-family defaults so a gemini run never inherits the gpt default', () => {
  assert.strictEqual(PROVIDERS.openai.defaultModel, 'gpt-4.1');
  assert.strictEqual(PROVIDERS.openai.apiKeyEnv, 'OPENAI_API_KEY');
  assert.strictEqual(PROVIDERS.gemini.defaultModel, 'gemini-3.6-flash');
  assert.strictEqual(PROVIDERS.gemini.apiKeyEnv, 'GEMINI_API_KEY');
});
test('no judge default is a model the API has retired (a dead default silently degrades the jury)', () => {
  // gemini-2.5-flash is still listed as "stable" in Google's docs but 404s for keys created
  // recently ("no longer available to new users"). A production run caught it live: the
  // two-vendor jury ran openai-only on every PR. A dead default doesn't fail loudly — it
  // quietly halves the jury, so pin the graveyard here.
  const RETIRED = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-3-pro-preview'];
  for (const family of Object.keys(PROVIDERS)) {
    assert.ok(
      !RETIRED.includes(PROVIDERS[family].defaultModel),
      `${family} defaults to retired model ${PROVIDERS[family].defaultModel}`,
    );
  }
});

// A fake fetch that records calls and returns a canned response — lets the async judge() path
// run entirely offline, locking each vendor's request/response wire contract (the only
// automated check of the real API shape, since there's no live key in CI).
function fakeFetch(response, { ok = true, status = 200 } = {}) {
  const impl = async (url, opts) => {
    impl.calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
    return {
      ok,
      status,
      async json() { return response; },
      async text() { return typeof response === 'string' ? response : JSON.stringify(response); },
    };
  };
  impl.calls = [];
  return impl;
}
const JUDGE_INPUT = { prTitle: 'p', criteria: [{ text: 'c' }], diff: 'd', tier1: [] };

atest('openai judge posts to chat/completions with a bearer key and parses message.content', async () => {
  const ff = fakeFetch({ choices: [{ message: { content: '{"assessment":"a","criteria":[{"text":"c","met":true}]}' } }] });
  const out = await createJudge({ OPENAI_API_KEY: 'sk-test' }, { fetchImpl: ff })(JUDGE_INPUT);
  assert.strictEqual(ff.calls.length, 1);
  assert.match(ff.calls[0].url, /api\.openai\.com\/v1\/chat\/completions/);
  assert.strictEqual(ff.calls[0].opts.headers.Authorization, 'Bearer sk-test');
  assert.strictEqual(ff.calls[0].body.model, 'gpt-4.1');                       // per-family default
  assert.deepStrictEqual(ff.calls[0].body.response_format, { type: 'json_object' });
  assert.deepStrictEqual(out, { family: 'openai', model: 'gpt-4.1', adversarial: false, assessment: 'a', criteria: [{ text: 'c', met: true }] });
});
atest('gemini judge sends the key in the x-goog-api-key header (never the URL) and parses candidates parts', async () => {
  const ff = fakeFetch({ candidates: [{ content: { parts: [{ text: '{"assessment":"g","criteria":[{"text":"c","met":false}]}' }] }, finishReason: 'STOP' }] });
  const out = await createJudge({ FELIX_JUDGE_FAMILY: 'gemini', GEMINI_API_KEY: 'g-key' }, { fetchImpl: ff })(JUDGE_INPUT);
  const call = ff.calls[0];
  // Derived from PROVIDERS rather than re-pinning the id — the exact default is asserted once,
  // above, so bumping a dead model doesn't mean chasing the same string through the suite.
  assert.strictEqual(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${PROVIDERS.gemini.defaultModel}:generateContent`);
  assert.ok(!call.url.includes('key='), 'the api key must never travel in the URL');
  assert.ok(!call.url.includes('g-key'), 'the API key must never appear in the URL');
  assert.strictEqual(call.opts.headers['x-goog-api-key'], 'g-key');
  assert.strictEqual(call.body.generationConfig.responseMimeType, 'application/json');
  assert.deepStrictEqual(out, { family: 'gemini', model: 'gemini-3.6-flash', adversarial: false, assessment: 'g', criteria: [{ text: 'c', met: false }] });
});
atest('gemini blocked/non-STOP response throws a clear finishReason error (not a JSON parse error)', async () => {
  const ff = fakeFetch({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] });
  await assert.rejects(createJudge({ FELIX_JUDGE_FAMILY: 'gemini', GEMINI_API_KEY: 'g-key' }, { fetchImpl: ff })(JUDGE_INPUT), /finishReason=SAFETY/);
});
atest('a non-ok judge HTTP response surfaces the status (both families share this path)', async () => {
  const ff = fakeFetch('rate limited', { ok: false, status: 429 });
  // noSleep: a bare 429 IS retried (the quota refills), so without it this test would sit
  // through the real 20s + 40s backoff before asserting.
  await assert.rejects(createJudge({ OPENAI_API_KEY: 'sk-test' }, { fetchImpl: ff, sleepImpl: noSleep })(JUDGE_INPUT), /Judge call failed: 429/);
});
atest('adversarial mode threads the refute-first prompt through the gemini provider (R2a × R2b)', async () => {
  const ff = fakeFetch({ candidates: [{ content: { parts: [{ text: '{"assessment":"g","criteria":[]}' }] }, finishReason: 'STOP' }] });
  await createJudge({ FELIX_JUDGE_FAMILY: 'gemini', GEMINI_API_KEY: 'g-key' }, { adversarial: true, fetchImpl: ff })(JUDGE_INPUT);
  assert.match(ff.calls[0].body.contents[0].parts[0].text, /REFUTE/);
});

console.log('tier1.scanSecrets');
test('flags a planted secret in a changed file', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'leak.js'), `const k = "${FAKE_AWS_KEY}";`);
  const r = scanSecrets({ cwd: d, files: [{ filename: 'leak.js', status: 'modified' }], secretsCfg: { allowFiles: [] } });
  assert.strictEqual(r.status, 'fail');
});
test('ignores secrets in allowFiles fixtures', () => {
  const d = tmpdir();
  fs.mkdirSync(path.join(d, 'fixtures'));
  fs.writeFileSync(path.join(d, 'fixtures', 'creds.js'), `const k = "${FAKE_AWS_KEY}";`);
  const r = scanSecrets({ cwd: d, files: [{ filename: 'fixtures/creds.js', status: 'modified' }], secretsCfg: { allowFiles: ['**/fixtures/**'] } });
  assert.strictEqual(r.status, 'pass');
});
test('masks the offending value so the finding is actionable (not "1 potential secret")', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'leak.js'), `const k = "${FAKE_AWS_KEY}";`);
  const r = scanSecrets({ cwd: d, files: [{ filename: 'leak.js', status: 'modified' }], secretsCfg: { allowFiles: [] } });
  assert.match(r.output, /AKIA…\(20 chars\)/);          // prefix + length, enough to locate
  assert.ok(!r.output.includes(FAKE_AWS_KEY), 'must not echo the full value into a public comment');
});

console.log('tier1.scanSecrets — entropy gate (the fixture false-positive class)');
// Two dictionary-word fake tokens that a naive secrets gate flags on consecutive CI
// runs. Both exist to be asserted ABSENT — neither is a credential. A secrets gate that
// fails a PR over them is crying wolf.
for (const fake of ['super-secret-token', 'tok-must-not-leak']) {
  test(`does NOT flag the fake fixture token "${fake}"`, () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, 'x.test.js'), `const inv = { token: '${fake}' };`);
    const r = scanSecrets({ cwd: d, files: [{ filename: 'x.test.js', status: 'modified' }], secretsCfg: { allowFiles: [] } });
    assert.strictEqual(r.status, 'pass', `should not fire on ${fake}: ${r.output}`);
  });
}
test('does NOT flag an obvious placeholder even if longish', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'cfg.js'), `const c = { api_key: 'your-api-key-here-please' };`);
  const r = scanSecrets({ cwd: d, files: [{ filename: 'cfg.js', status: 'modified' }], secretsCfg: { allowFiles: [] } });
  assert.strictEqual(r.status, 'pass');
});
test('STILL flags a real high-entropy secret assigned to a secret-named var', () => {
  const d = tmpdir();
  // Assembled at runtime so this literal doesn't trip Felix scanning its OWN repo.
  const real = 'aG9x' + 'Kp2Qr' + '7ZtVw' + 'L4mNc' + '8YdB' + 'j3Vs';
  assert.ok(shannonEntropy(real) >= 3.5, 'sanity: the sample must actually be high-entropy');
  fs.writeFileSync(path.join(d, 'oops.js'), `const p = { password: "${real}" };`);
  const r = scanSecrets({ cwd: d, files: [{ filename: 'oops.js', status: 'modified' }], secretsCfg: { allowFiles: [] } });
  assert.strictEqual(r.status, 'fail', 'a genuine random credential must NOT slip through');
  assert.match(r.output, /Generic secret assignment/);
});
test('shannonEntropy separates random from repetitive', () => {
  assert.ok(shannonEntropy('xxxxxxxxxxxxxxxx') < 1);
  assert.ok(shannonEntropy('aG9xKp2Qr7ZtVwL4') >= 3.5);
});
test('looksLikeRealSecret: fixtures no, credentials yes', () => {
  assert.strictEqual(looksLikeRealSecret('super-secret-token'), false);
  assert.strictEqual(looksLikeRealSecret('tok-must-not-leak'), false);
  assert.strictEqual(looksLikeRealSecret('changeme-changeme'), false);
  assert.strictEqual(looksLikeRealSecret('aG9xKp2Qr7ZtVwL4mNc8Yd'), true);
});

console.log('secrets external-scan hook (R4)');
test('scanSecrets runs as an advisory backstop when hard:false (external scanner is the gate)', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'ok.js'), 'const x = 1;');
  const r = scanSecrets({ cwd: d, files: [{ filename: 'ok.js', status: 'modified' }], secretsCfg: { allowFiles: [] }, hard: false });
  assert.strictEqual(r.hard, false);
  assert.match(r.detail, /advisory/);
});
test('scanSecrets stays hard by default (no external scanner configured)', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'ok.js'), 'const x = 1;');
  const r = scanSecrets({ cwd: d, files: [{ filename: 'ok.js', status: 'modified' }], secretsCfg: { allowFiles: [] } });
  assert.strictEqual(r.hard, true);
});
test('DEFAULT_SECRETS carries an empty externalScan (opt-in); merge preserves a user value', () => {
  assert.strictEqual(merge({}, {}).secrets.externalScan, '');
  assert.strictEqual(merge({}, { secrets: { externalScan: 'gitleaks detect --no-git' } }).secrets.externalScan, 'gitleaks detect --no-git');
});

console.log('housekeeping — version single-source + log DRY (R5)');
test('the Felix version is single-sourced from package.json (no stale hardcodes)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const ghSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'github.js'), 'utf8');
  assert.ok(!/Felix\/0\.1\b/.test(ghSrc), 'github.js must not hardcode the stale Felix/0.1 User-Agent');
  assert.match(ghSrc, /Felix\/\$\{version\}/);
  // comment.js must fall back to the real package version, not a stale 0.1.0 literal.
  const body = render({ verdict: 'VERIFIED', spec: { total: 1, mappedCount: 1, source: 'PR' }, tier1: goodTier1, tier3: null, required_to_pass: [], meta: {} });
  assert.ok(body.includes(`Felix v${pkg.version}`), `comment should stamp the real version v${pkg.version}`);
  assert.ok(!body.includes('0.1.0'), 'no stale 0.1.0 fallback in the rendered comment');
});
test('log.js single-sources the Supabase client (exactly one createClient call site)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'log.js'), 'utf8');
  const calls = (src.match(/createClient\(/g) || []).length;
  assert.strictEqual(calls, 1, 'the Supabase client should be built in exactly one place');
});

console.log('github.parseTarget');
test('parses owner/repo#123', () => {
  assert.deepStrictEqual(parseTarget('owner/repo#42'), { owner: 'owner', repo: 'repo', number: 42 });
});
test('parses a full PR url', () => {
  assert.deepStrictEqual(parseTarget('https://github.com/o/r/pull/7'), { owner: 'o', repo: 'r', number: 7 });
});
test('rejects garbage', () => {
  assert.throws(() => parseTarget('not-a-target'));
});

console.log('triage + comment');
test('triage flags an all-docs PR as skipped', () => {
  const t = triageFiles([{ filename: 'README.md' }, { filename: 'docs/x.md' }], ['**/*.md', 'docs/**']);
  assert.strictEqual(t.skipped, true);
});
test('triage keeps a code PR', () => {
  const t = triageFiles([{ filename: 'src/a.js' }, { filename: 'README.md' }], ['**/*.md']);
  assert.strictEqual(t.skipped, false);
  assert.strictEqual(t.behavioral.length, 1);
});
test('comment.render shows the verdict badge', () => {
  const body = render({ verdict: 'VERIFIED', spec: { total: 1, mappedCount: 1, source: 'PR' }, tier1: goodTier1, tier3: null, required_to_pass: [], meta: { version: '0.1.0' } });
  assert.match(body, /VERIFIED/);
  assert.match(body, /Tier 1/);
});
test('comment.render labels the judge as adversarial when that mode ran', () => {
  const tier3 = { family: 'openai', model: 'gpt-4.1', adversarial: true, assessment: 'looks solid', criteria: [{ text: 'x', met: true }] };
  const body = render({ verdict: 'VERIFIED', spec: { total: 1, mappedCount: 1, source: 'PR' }, tier1: goodTier1, tier3, required_to_pass: [], meta: { version: '1.0.0' } });
  assert.match(body, /openai\/gpt-4\.1, adversarial/);
});

console.log('isolation (Phase 2)');
test('mode none passes the command through unchanged', () => {
  const iso = resolveIsolation({});
  assert.strictEqual(iso.mode, 'none');
  assert.strictEqual(wrapCommand('npm test', { isolation: iso, cwd: '/w' }), 'npm test');
});
test('resolveIsolation picks a language image when enabled without an explicit one', () => {
  const iso = resolveIsolation({ language: 'python', isolation: { mode: 'docker' } });
  assert.strictEqual(iso.image, 'python:3.12');
});
test('an explicit image wins over the language default', () => {
  const iso = resolveIsolation({ language: 'python', isolation: { mode: 'docker', image: 'myimg:1' } });
  assert.strictEqual(iso.image, 'myimg:1');
});
test('docker mode jails the command with caps, net policy, and the mount', () => {
  const iso = resolveIsolation({ language: 'node', isolation: { mode: 'docker' } });
  const cmd = wrapCommand('npm test', { isolation: iso, cwd: '/work/dir', network: 'deny' });
  assert.match(cmd, /^docker run --rm/);
  assert.match(cmd, /--network none/);
  assert.match(cmd, /--read-only/);
  assert.match(cmd, /--pids-limit 512/);
  assert.match(cmd, /--cap-drop ALL/);
  assert.match(cmd, /--security-opt no-new-privileges/);
  assert.match(cmd, /-v '\/work\/dir':\/work/);
  assert.match(cmd, /sh -c 'npm test'/);
});
test('install gets network when requested', () => {
  const iso = resolveIsolation({ isolation: { mode: 'docker' } });
  assert.match(wrapCommand('npm ci', { isolation: iso, cwd: '/w', network: 'allow' }), /--network bridge/);
});
test('single quotes in the command are escaped safely', () => {
  const iso = resolveIsolation({ isolation: { mode: 'docker' } });
  const cmd = wrapCommand(`node -e 'process.exit(0)'`, { isolation: iso, cwd: '/w' });
  assert.ok(cmd.includes(`'\\''`), 'embedded single quotes should be escaped');
});
test('rejects flag-injection via pidsLimit / tmpfsSize', () => {
  const bad1 = resolveIsolation({ isolation: { mode: 'docker', pidsLimit: '1 --privileged' } });
  assert.throws(() => wrapCommand('npm test', { isolation: bad1, cwd: '/w' }), /pidsLimit/);
  const bad2 = resolveIsolation({ isolation: { mode: 'docker', tmpfsSize: '512m --network=host' } });
  assert.throws(() => wrapCommand('npm test', { isolation: bad2, cwd: '/w' }), /tmpfsSize/);
});

console.log('trigger gate + self-error (Phase 2)');
test('triggerGate flags a draft PR', () => {
  const g = triggerGate({ draft: true, head: { repo: { full_name: 'o/r', fork: false } }, base: { repo: { full_name: 'o/r' } } });
  assert.strictEqual(g.draft, true);
  assert.strictEqual(g.fork, false);
});
test('triggerGate detects a fork via the fork flag', () => {
  const g = triggerGate({ draft: false, head: { repo: { full_name: 'x/r', fork: true } }, base: { repo: { full_name: 'o/r' } } });
  assert.strictEqual(g.fork, true);
});
test('triggerGate detects a fork via differing repo names', () => {
  const g = triggerGate({ head: { repo: { full_name: 'someone/r' } }, base: { repo: { full_name: 'o/r' } } });
  assert.strictEqual(g.fork, true);
});
test('compose returns SKIPPED for a draft PR', () => {
  const v = compose({ trigger: { draft: true } });
  assert.strictEqual(v.verdict, VERDICTS.SKIPPED);
  assert.match(v.reason, /draft/i);
});
test('compose reports judge skipped on fork', () => {
  const v = compose({ triage: {}, spec: realSpec, tier1: goodTier1, tier3: null, judgeStatus: { fork: true } });
  assert.strictEqual(v.verdict, VERDICTS.INSUFFICIENT);
  assert.strictEqual(v.reason, 'judge skipped on fork');
  assert.match(v.required_to_pass[0], /fork/i);
});
test('renderError surfaces the error message without the marker', () => {
  const body = renderError({ error: new Error('boom: sandbox exploded'), meta: { version: '0.1.0' } });
  assert.match(body, /ERROR/);
  assert.match(body, /boom: sandbox exploded/);
  assert.ok(!body.includes('felix-verdict'), 'marker is added by upsertComment, not the renderer');
});
test('conclusionFor maps verdicts to check-run conclusions', () => {
  assert.strictEqual(conclusionFor('VERIFIED'), 'success');
  assert.strictEqual(conclusionFor('NOT VERIFIED'), 'failure');
  assert.strictEqual(conclusionFor('INSUFFICIENT EVIDENCE'), 'neutral');
  assert.strictEqual(conclusionFor('SKIPPED'), 'skipped');
  assert.strictEqual(conclusionFor('???'), 'neutral');
});

console.log('calibration (Phase 3)');
test('computeMetrics builds the confusion matrix and rates', () => {
  const rows = [
    { verdict: 'NOT VERIFIED', outcome: 'defect' }, // TP
    { verdict: 'NOT VERIFIED', outcome: 'clean' },  // FP
    { verdict: 'VERIFIED', outcome: 'defect' },     // FN (escaped)
    { verdict: 'VERIFIED', outcome: 'clean' },      // TN
    { verdict: 'VERIFIED', outcome: 'clean' },      // TN
  ];
  const m = computeMetrics(rows);
  assert.strictEqual(m.tp, 1);
  assert.strictEqual(m.fp, 1);
  assert.strictEqual(m.fn, 1);
  assert.strictEqual(m.tn, 2);
  assert.strictEqual(m.scored, 5);
  assert.strictEqual(m.escapedDefects, 1);
  assert.ok(Math.abs(m.precision - 0.5) < 1e-9); // 1/(1+1)
  assert.ok(Math.abs(m.recall - 0.5) < 1e-9);    // 1/(1+1)
});
test('computeMetrics excludes non-decisive verdicts and unrecorded outcomes', () => {
  const rows = [
    { verdict: 'SKIPPED', outcome: 'clean' },
    { verdict: 'INSUFFICIENT EVIDENCE', outcome: 'defect' },
    { verdict: 'VERIFIED', outcome: OUTCOMES.UNKNOWN },
    { verdict: 'VERIFIED' },
    { verdict: 'VERIFIED', outcome: 'clean' }, // the only scored row
  ];
  const m = computeMetrics(rows);
  assert.strictEqual(m.scored, 1);
  assert.strictEqual(m.tn, 1);
  assert.strictEqual(m.byVerdict.SKIPPED, 1);
  assert.strictEqual(m.precision, null); // no flagged rows
});
test('computeMetrics handles an empty log', () => {
  const m = computeMetrics([]);
  assert.strictEqual(m.total, 0);
  assert.strictEqual(m.scored, 0);
  assert.strictEqual(m.precision, null);
  assert.strictEqual(m.recall, null);
});

console.log('gating (Phase 3)');
test('gating disabled is always advisory', () => {
  const d = gateDecision({ verdict: 'NOT VERIFIED', gating: resolveGating({}), labels: [] });
  assert.strictEqual(d.blocks, false);
});
test('gating blocks NOT VERIFIED by default when enabled', () => {
  const g = resolveGating({ gating: { enabled: true } });
  assert.strictEqual(gateDecision({ verdict: 'NOT VERIFIED', gating: g, labels: [] }).blocks, true);
  assert.strictEqual(gateDecision({ verdict: 'VERIFIED', gating: g, labels: [] }).blocks, false);
});
test('override label bypasses a block', () => {
  const g = resolveGating({ gating: { enabled: true } });
  const d = gateDecision({ verdict: 'NOT VERIFIED', gating: g, labels: ['felix-override'] });
  assert.strictEqual(d.blocks, false);
  assert.strictEqual(d.overridden, true);
});
test('blockOn is configurable (also block INSUFFICIENT EVIDENCE)', () => {
  const g = resolveGating({ gating: { enabled: true, blockOn: ['NOT VERIFIED', 'INSUFFICIENT EVIDENCE'] } });
  assert.strictEqual(gateDecision({ verdict: 'INSUFFICIENT EVIDENCE', gating: g, labels: [] }).blocks, true);
});

console.log('reusable action (Phase 4)');
test('action.yml wires a composite action to bin/felix.js with the judge input', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(y, /using:\s*['"]?composite/);
  assert.match(y, /bin\/felix\.js/);
  assert.match(y, /openai-api-key/);
});
test('the example workflow references the published Felix action', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', 'examples', 'felix.yml'), 'utf8');
  assert.match(y, /Eatmorerats\/felix@/);
  assert.match(y, /openai-api-key:/);
});
test('package.json exposes the felix bin', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.bin && pkg.bin.felix, 'felix bin should be declared');
});

console.log('auto-outcomes (Phase 4)');
test('parseRevertedPR pulls the PR number from a GitHub revert title', () => {
  assert.strictEqual(parseRevertedPR('Revert "feat: add widget (#42)" (#57)'), 42);
});
test('parseRevertedPR handles "Reverts #N" bodies', () => {
  assert.strictEqual(parseRevertedPR('This reverts the change.\n\nReverts #123'), 123);
});
test('parseRevertedPR ignores non-revert commits that mention a PR', () => {
  assert.strictEqual(parseRevertedPR('feat: follow-up to #99'), null);
  assert.strictEqual(parseRevertedPR('fix a bug'), null);
});
test('detectRevertedPRs dedupes across commit objects', () => {
  const commits = [
    { commit: { message: 'Revert "x (#10)" (#11)' } },
    { commit: { message: 'normal commit #10' } },
    { commit: { message: 'Reverts #10' } },
    { commit: { message: 'Revert "y" \n Reverts #20' } },
  ];
  assert.deepStrictEqual(detectRevertedPRs(commits), [10, 20]);
});

console.log('calibration fixtures (R0 ground truth)');
test('the corpus is well-formed and has known-bad cases', () => {
  assert.ok(FIXTURES.length >= 4, 'need a few fixtures');
  assert.ok(FIXTURES.filter((f) => f.label === 'bad').length >= 2, 'need known-bad fixtures so recall is measurable');
  const ids = new Set();
  for (const f of FIXTURES) {
    assert.ok(f.id && !ids.has(f.id), `unique id: ${f.id}`); ids.add(f.id);
    assert.ok(['good', 'bad'].includes(f.label), `label good|bad: ${f.id}`);
    assert.ok(Array.isArray(f.criteria) && f.criteria.length, `criteria present: ${f.id}`);
    assert.ok(typeof f.diff === 'string' && f.diff.length > 0, `diff present: ${f.id}`);
    // A good fixture must expect VERIFIED; a bad one must expect NOT VERIFIED.
    assert.strictEqual(f.expected, f.label === 'good' ? VERDICTS.VERIFIED : VERDICTS.NOT_VERIFIED, `expected matches label: ${f.id}`);
  }
});
test('each fixture composes to its expected verdict under a perfect judge', () => {
  // Proves the corpus + the compose() wiring offline: a perfect judge on a good
  // fixture yields VERIFIED, on a bad fixture yields NOT VERIFIED. The LIVE judge
  // score (does gpt-4.1 actually match the oracle?) is what `npm run calibrate` measures.
  for (const f of FIXTURES) {
    const spec = {
      hadRealSpec: true, source: 'fixture', total: f.criteria.length, mappedCount: 0,
      criteria: f.criteria.map((text) => ({ text, mappedFiles: [], mapped: false })),
    };
    const v = compose({
      triage: { skipped: false }, spec, tier1: f.tier1, tier3: oracleJudge(f),
      installFailed: false, judgeStatus: { configured: true, attempted: true, error: null, fork: false },
    });
    assert.strictEqual(v.verdict, f.expected, `${f.id}: expected ${f.expected}, got ${v.verdict}`);
  }
});
test('truthOutcome maps bad→defect and good→clean (feeds the calibration matrix)', () => {
  assert.strictEqual(truthOutcome(FIXTURES.find((f) => f.label === 'bad')), 'defect');
  assert.strictEqual(truthOutcome(FIXTURES.find((f) => f.label === 'good')), 'clean');
});

console.log('drive (R1 — opt-in app driving)');
test('buildDrivePlan returns null when driving is disabled or has no start command', () => {
  assert.strictEqual(buildDrivePlan({}), null);
  assert.strictEqual(buildDrivePlan({ drive: { enabled: true } }), null); // no startCommand
  assert.strictEqual(buildDrivePlan({ drive: { enabled: false, startCommand: 'npm start' } }), null);
});
test('buildDrivePlan builds routes with the base url + port', () => {
  const p = buildDrivePlan({ drive: { enabled: true, startCommand: 'npm run preview', port: 4173, routes: ['/', '/login'] } });
  assert.deepStrictEqual(p.routes.map((r) => r.url), ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173/login']);
  assert.strictEqual(p.readyUrl, 'http://127.0.0.1:4173/');
});
test('joinUrl appends the port only when the base has none', () => {
  assert.strictEqual(joinUrl('http://127.0.0.1', 4173, '/x'), 'http://127.0.0.1:4173/x');
  assert.strictEqual(joinUrl('http://host:8080', 4173, '/x'), 'http://host:8080/x'); // keep existing port
  assert.strictEqual(joinUrl('http://127.0.0.1', 3000, 'nostyle'), 'http://127.0.0.1:3000/nostyle');
});
test('resolveDrive defaults an empty routes list to ["/"]', () => {
  assert.deepStrictEqual(resolveDrive({ drive: { enabled: true, routes: [] } }).routes, ['/']);
});
test('interpretProbe: <expected status passes, >=expected fails, no response is a hard fail', () => {
  const route = { path: '/', url: 'http://127.0.0.1:4173/' };
  assert.strictEqual(interpretProbe(route, { status: 200 }, 400).status, 'pass');
  assert.strictEqual(interpretProbe(route, { status: 302 }, 400).status, 'pass');
  const bad = interpretProbe(route, { status: 500 }, 400);
  assert.strictEqual(bad.status, 'fail');
  assert.strictEqual(bad.hard, true);
  const down = interpretProbe(route, { error: 'ECONNREFUSED' }, 400);
  assert.strictEqual(down.status, 'fail');
  assert.match(down.detail, /no response/);
});

console.log('drive.pageLoad (R1 slice 2 — headless render grading)');
const PL_ROUTE = { path: '/', url: 'http://127.0.0.1:4173/' };
const defaultPL = resolveDrive({}).pageLoad;
test('resolveDrive fills pageLoad defaults (disabled, blank-screen floor on, console errors ungated)', () => {
  assert.strictEqual(defaultPL.enabled, false);
  assert.strictEqual(defaultPL.failOnPageError, true);
  assert.strictEqual(defaultPL.failOnConsoleError, false);
  assert.strictEqual(defaultPL.minBodyChars, 1);
});
test('buildDrivePlan carries resolved pageLoad opts', () => {
  const p = buildDrivePlan({ drive: { enabled: true, startCommand: 'npm run preview', pageLoad: { enabled: true, requireSelector: '#app' } } });
  assert.strictEqual(p.pageLoad.enabled, true);
  assert.strictEqual(p.pageLoad.requireSelector, '#app');
  assert.strictEqual(p.pageLoad.failOnPageError, true); // default filled around the user override
});
test('interpretPageLoad: a blank screen (empty body) is a HARD fail', () => {
  const r = interpretPageLoad(PL_ROUTE, { launched: true, navigated: true, status: 200, bodyChars: 0, consoleErrors: [], pageErrors: [] }, defaultPL);
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.hard, true);
  assert.match(r.detail, /blank screen/);
});
test('interpretPageLoad: an uncaught page error is a HARD fail', () => {
  const r = interpretPageLoad(PL_ROUTE, { launched: true, navigated: true, status: 200, bodyChars: 800, consoleErrors: [], pageErrors: ['TypeError: x is not a function'] }, defaultPL);
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /uncaught page error/);
});
test('interpretPageLoad: a healthy render passes; console errors reported but not gated by default', () => {
  const r = interpretPageLoad(PL_ROUTE, { launched: true, navigated: true, status: 200, bodyChars: 1200, consoleErrors: ['favicon 404'], pageErrors: [] }, defaultPL);
  assert.strictEqual(r.status, 'pass');
  assert.match(r.detail, /not gated/);
});
test('interpretPageLoad: console errors DO gate when failOnConsoleError is set', () => {
  const opts = resolveDrive({ drive: { pageLoad: { failOnConsoleError: true } } }).pageLoad;
  const r = interpretPageLoad(PL_ROUTE, { launched: true, navigated: true, status: 200, bodyChars: 1200, consoleErrors: ['Uncaught (in promise)'], pageErrors: [] }, opts);
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /console error/);
});
test('interpretPageLoad: a missing required selector is a HARD fail', () => {
  const opts = resolveDrive({ drive: { pageLoad: { requireSelector: '#root .app' } } }).pageLoad;
  const r = interpretPageLoad(PL_ROUTE, { launched: true, navigated: true, status: 200, bodyChars: 5, consoleErrors: [], pageErrors: [], selectorFound: false }, opts);
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /selector/);
});
test('interpretPageLoad: a navigation failure is a HARD fail', () => {
  const r = interpretPageLoad(PL_ROUTE, { launched: true, navigated: false, navError: 'net::ERR_CONNECTION_REFUSED', consoleErrors: [], pageErrors: [] }, defaultPL);
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /did not load/);
});
test('interpretPageLoad: browser unavailable is a SOFT skip, never a hard fail (missing dev tool ≠ NOT VERIFIED)', () => {
  const r = interpretPageLoad(PL_ROUTE, { launched: false, launchError: 'Playwright not installed' }, defaultPL);
  assert.strictEqual(r.status, 'skip');
  assert.strictEqual(r.hard, false);
  assert.match(r.detail, /Playwright not installed/);
});
test('interpretPageLoad: minBodyChars=0 disables the blank-screen floor (canvas/image apps)', () => {
  const opts = resolveDrive({ drive: { pageLoad: { minBodyChars: 0 } } }).pageLoad;
  const r = interpretPageLoad(PL_ROUTE, { launched: true, navigated: true, status: 200, bodyChars: 0, consoleErrors: [], pageErrors: [] }, opts);
  assert.strictEqual(r.status, 'pass');
});

// ─── R1(B) — interaction flows ───────────────────────────────────────────────
console.log('drive.flows (R1B — interaction smoke)');
const defaultFO = resolveFlowOpts({});
const FLOW_ORIGIN = { origin: 'http://127.0.0.1', port: 4173 };

test('normalizeStep rejects a step with no known verb, and with two verbs at once', () => {
  assert.match(normalizeStep({ tap: '#x' }, 0).error, /no known verb/);
  assert.match(normalizeStep({ click: '#a', fill: '#b' }, 0).error, /2 verbs/);
  assert.match(normalizeStep('click me', 0).error, /expected an object/);
});
test('normalizeStep rejects an empty or non-string verb argument', () => {
  assert.match(normalizeStep({ click: '' }, 0).error, /non-empty string/);
  assert.match(normalizeStep({ click: 42 }, 0).error, /non-empty string/);
});
test('SECURITY: goto is same-origin only — absolute URLs and schemes are rejected', () => {
  assert.match(normalizeStep({ goto: 'https://evil.example.com/x' }, 0).error, /same-origin path/);
  assert.match(normalizeStep({ goto: '//evil.example.com/x' }, 0).error, /same-origin path/);
  assert.match(normalizeStep({ goto: 'javascript:alert(1)' }, 0).error, /same-origin path/);
  assert.match(normalizeStep({ goto: 'login' }, 0).error, /must start with/);
  assert.strictEqual(normalizeStep({ goto: '/login' }, 0).ok, true);
});
test('SECURITY: valueEnv is fenced to FELIX_FLOW_* so a PR cannot type a real secret into a page', () => {
  assert.match(normalizeStep({ fill: '#p', valueEnv: 'OPENAI_API_KEY' }, 0).error, /FELIX_FLOW_/);
  assert.match(normalizeStep({ fill: '#p', valueEnv: 'GITHUB_TOKEN' }, 0).error, /FELIX_FLOW_/);
  const ok = normalizeStep({ fill: '#p', valueEnv: 'FELIX_FLOW_PASSWORD' }, 0);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.step.valueEnv, 'FELIX_FLOW_PASSWORD');
});
test('normalizeStep validates waitMs as a non-negative number', () => {
  assert.match(normalizeStep({ waitMs: -1 }, 0).error, /non-negative/);
  assert.match(normalizeStep({ waitMs: 'soon' }, 0).error, /non-negative/);
  assert.strictEqual(normalizeStep({ waitMs: 500 }, 0).step.waitMs, 500);
});
test('SECURITY: describeStep redacts typed values but keeps assertions readable', () => {
  const fill = normalizeStep({ fill: '#password', value: 'hunter2' }, 0).step;
  assert.strictEqual(describeStep(fill), 'fill #password ***');
  assert.ok(!describeStep(fill).includes('hunter2'), 'the typed value must never be echoed');
  const expect = normalizeStep({ expectText: 'Invalid credentials' }, 0).step;
  assert.match(describeStep(expect), /Invalid credentials/);
});
test('validateFlow rejects a flow with no steps, a bad path, or a bad step', () => {
  assert.match(validateFlow({ name: 'x', steps: [] }, 0, FLOW_ORIGIN).invalid, /no steps/);
  assert.match(validateFlow({ name: 'x', path: 'login', steps: [{ click: '#a' }] }, 0, FLOW_ORIGIN).invalid, /must start with/);
  assert.match(validateFlow({ name: 'x', steps: [{ click: '#a' }, { nope: 1 }] }, 0, FLOW_ORIGIN).invalid, /step 2/);
});
test('validateFlow builds the start url and carries origin/port for mid-flow goto', () => {
  const f = validateFlow({ name: 'login', path: '/login', steps: [{ click: '#go' }] }, 0, FLOW_ORIGIN);
  assert.strictEqual(f.url, 'http://127.0.0.1:4173/login');
  assert.strictEqual(f.origin, 'http://127.0.0.1');
  assert.strictEqual(f.port, 4173);
  assert.strictEqual(f.steps.length, 1);
});
test('validateFlow defaults an unnamed flow to a positional name and path to /', () => {
  const f = validateFlow({ steps: [{ click: '#a' }] }, 2, FLOW_ORIGIN);
  assert.strictEqual(f.name, 'flow 3');
  assert.strictEqual(f.path, '/');
});
test('buildFlows returns [] when none are declared, and one plan per declared flow', () => {
  assert.deepStrictEqual(buildFlows(resolveDrive({})), []);
  const d = resolveDrive({ drive: { flows: [{ name: 'a', steps: [{ click: '#a' }] }, { name: 'b', steps: [{ click: '#b' }] }] } });
  assert.strictEqual(buildFlows(d).length, 2);
});
test('buildDrivePlan carries validated flows + resolved flow options', () => {
  const p = buildDrivePlan({
    drive: {
      enabled: true, startCommand: 'npm run preview',
      flows: [{ name: 'login', path: '/login', steps: [{ click: '#go' }] }],
      flowOpts: { stepTimeoutMs: 3000 },
    },
  });
  assert.strictEqual(p.flows.length, 1);
  assert.strictEqual(p.flows[0].url, 'http://127.0.0.1:4173/login');
  assert.strictEqual(p.flowOpts.stepTimeoutMs, 3000);
  assert.strictEqual(p.flowOpts.failOnPageError, true); // default filled around the override
});
test('resolveValue reads a fenced env var and errors clearly when it is unset', () => {
  const step = normalizeStep({ fill: '#p', valueEnv: 'FELIX_FLOW_PW' }, 0).step;
  assert.strictEqual(resolveValue(step, { FELIX_FLOW_PW: 's3cret' }).value, 's3cret');
  assert.match(resolveValue(step, {}).error, /not set/);
  assert.strictEqual(resolveValue(normalizeStep({ fill: '#p', value: 'plain' }, 0).step, {}).value, 'plain');
});

const OK_FLOW = validateFlow({ name: 'login works', path: '/login', steps: [
  { fill: '#password', value: 'hunter2' }, { click: '#go' }, { expectText: 'Welcome' },
] }, 0, FLOW_ORIGIN);

test('interpretFlow: a malformed flow is a HARD fail, never a silent skip', () => {
  const bad = validateFlow({ name: 'typo', steps: [{ clickk: '#a' }] }, 0, FLOW_ORIGIN);
  const r = interpretFlow(bad, { launched: true }, defaultFO);
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.hard, true);
  assert.match(r.detail, /invalid flow/);
});
test('interpretFlow: browser unavailable is a SOFT skip (missing dev tool ≠ NOT VERIFIED)', () => {
  const r = interpretFlow(OK_FLOW, { launched: false, launchError: 'Playwright not installed' }, defaultFO);
  assert.strictEqual(r.status, 'skip');
  assert.strictEqual(r.hard, false);
});
test('interpretFlow: a failed step names which step broke and redacts the typed value', () => {
  const r = interpretFlow(OK_FLOW, { launched: true, failedStep: 0, error: 'selector not found', completed: 0, pageErrors: [] }, defaultFO);
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.hard, true);
  assert.match(r.detail, /step 1\/3/);
  assert.match(r.detail, /fill #password \*\*\*/);
  assert.ok(!r.detail.includes('hunter2'), 'the typed value must never reach the PR comment');
});
test('interpretFlow: a failed assertion reports the expectation that did not hold', () => {
  const r = interpretFlow(OK_FLOW, { launched: true, failedStep: 2, error: 'page text does not contain "Welcome"', completed: 2, pageErrors: [] }, defaultFO);
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /step 3\/3/);
  assert.match(r.detail, /Welcome/);
});
test('interpretFlow: a blown flow budget is a HARD fail naming the stuck step', () => {
  const r = interpretFlow(OK_FLOW, { launched: true, timedOut: true, completed: 1, pageErrors: [] }, defaultFO);
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /timed out/);
  assert.match(r.detail, /step 2\/3/);
});
test('interpretFlow: steps all passed but the page threw → HARD fail (a real user-visible crash)', () => {
  const r = interpretFlow(OK_FLOW, { launched: true, completed: 3, pageErrors: ['TypeError: x is not a function'] }, defaultFO);
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /page threw/);
});
test('interpretFlow: a clean run passes and reports the step count', () => {
  const r = interpretFlow(OK_FLOW, { launched: true, completed: 3, pageErrors: [] }, defaultFO);
  assert.strictEqual(r.status, 'pass');
  assert.match(r.detail, /3 step\(s\) passed/);
});
test('interpretFlow: page errors are ungated when failOnPageError is off', () => {
  const opts = resolveFlowOpts({ flowOpts: { failOnPageError: false } });
  const r = interpretFlow(OK_FLOW, { launched: true, completed: 3, pageErrors: ['noisy'] }, opts);
  assert.strictEqual(r.status, 'pass');
});

atest('runFlows without a browser: valid flows SKIP softly but malformed ones still fail loud', async () => {
  const flows = [OK_FLOW, validateFlow({ name: 'typo', steps: [{ clickk: '#a' }] }, 1, FLOW_ORIGIN)];
  const rs = await runFlows({ browser: null, skipReason: 'Playwright not installed', flows, opts: defaultFO, env: {} });
  assert.strictEqual(rs.length, 2);
  assert.strictEqual(rs[0].status, 'skip');
  assert.strictEqual(rs[0].hard, false);
  assert.strictEqual(rs[1].status, 'fail');   // a broken definition is the PR's bug, not infra's
  assert.strictEqual(rs[1].hard, true);
});
atest('runFlows is a no-op when no flows are declared', async () => {
  assert.deepStrictEqual(await runFlows({ browser: null, flows: [], opts: defaultFO, env: {} }), []);
});

// ─── R2b slice 2 — two-vendor jury ───────────────────────────────────────────
// Routes by vendor URL so a single jury run can hand each seat its own canned
// response (or its own failure), which is what these merge rules need to exercise.
function juryFetch(routes) {
  const impl = async (url, opts) => {
    impl.calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
    const r = routes[url.includes('openai.com') ? 'openai' : 'gemini'] || {};
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      async json() { return r.body; },
      async text() { return typeof r.body === 'string' ? r.body : JSON.stringify(r.body); },
    };
  };
  impl.calls = [];
  return impl;
}
const oai = (json) => ({ body: { choices: [{ message: { content: JSON.stringify(json) } }] } });
const gem = (json) => ({ body: { candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP' }] } });
const JURY_ENV = { FELIX_JUDGE_FAMILY: 'openai,gemini', OPENAI_API_KEY: 'sk', GEMINI_API_KEY: 'g' };
const JURY_INPUT = { prTitle: 'p', criteria: [{ text: 'c' }], diff: 'd', tier1: [] };

test('jury collapses a duplicate family — the same vendor twice is not an independent jury', () => {
  assert.strictEqual(typeof createJudge({ FELIX_JUDGE_FAMILY: 'openai,openai', OPENAI_API_KEY: 'sk' }), 'function');
});

test('jury rejects a single ambiguous model override (a gpt id is meaningless to Gemini)', () => {
  assert.throws(() => createJudge({ ...JURY_ENV, FELIX_JUDGE_MODEL: 'gpt-4.1' }), /ambiguous for a 2-vendor jury/);
});

test('jury requires one model per seat when models are listed', () => {
  assert.throws(() => createJudge({ ...JURY_ENV, FELIX_JUDGE_MODEL: 'a,b,c' }), /lists 3 model\(s\) but .* seats 2/);
});

test('cross-family guard applies to EVERY seat, not just the first', () => {
  assert.throws(() => createJudge({ FELIX_JUDGE_FAMILY: 'openai,anthropic', OPENAI_API_KEY: 'sk' }), /Cross-family/);
});

test('jury with no keys at all is skipped (null), not an error', () => {
  assert.strictEqual(createJudge({ FELIX_JUDGE_FAMILY: 'openai,gemini' }), null);
});

atest('jury calls BOTH vendors and marks a criterion met only when both agree', async () => {
  const ff = juryFetch({
    openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'ok' }] }),
    gemini: gem({ assessment: 'b', criteria: [{ text: 'c', met: true, reason: 'ok too' }] }),
  });
  const out = await createJudge(JURY_ENV, { fetchImpl: ff })(JURY_INPUT);
  assert.strictEqual(ff.calls.length, 2);                          // both seats voted
  assert.strictEqual(out.family, 'openai+gemini');
  assert.strictEqual(out.model, 'gpt-4.1+gemini-3.6-flash');       // per-family defaults
  assert.strictEqual(out.criteria[0].met, true);
  assert.strictEqual(out.degraded, false);
  assert.strictEqual(out.splits, 0);
  assert.match(out.criteria[0].reason, /unanimous/);
});

atest('ONE dissent blocks the criterion and names the objector', async () => {
  const ff = juryFetch({
    openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'looks fine' }] }),
    gemini: gem({ assessment: 'b', criteria: [{ text: 'c', met: false, reason: 'no test covers it' }] }),
  });
  const out = await createJudge(JURY_ENV, { fetchImpl: ff })(JURY_INPUT);
  assert.strictEqual(out.criteria[0].met, false);                  // unanimity required
  assert.strictEqual(out.splits, 1);
  assert.match(out.criteria[0].reason, /gemini says NOT met: no test covers it/);
  assert.match(out.criteria[0].reason, /openai say met/);
});

atest('a judge that never ruled on a criterion counts as NOT met (silence is not a pass)', async () => {
  const ff = juryFetch({
    openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'ok' }] }),
    gemini: gem({ assessment: 'b', criteria: [] }),                // ruled on nothing
  });
  const out = await createJudge(JURY_ENV, { fetchImpl: ff })(JURY_INPUT);
  assert.strictEqual(out.criteria[0].met, false);
  assert.match(out.criteria[0].reason, /gemini returned no ruling/);
});

atest('one vendor failing degrades the jury but still returns a verdict — flagged, never silent', async () => {
  const ff = juryFetch({
    openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'ok' }] }),
    gemini: { ok: false, status: 429, body: 'rate limited' },
  });
  const out = await createJudge(JURY_ENV, { fetchImpl: ff, sleepImpl: noSleep })(JURY_INPUT);
  assert.strictEqual(out.degraded, true);
  assert.strictEqual(out.family, 'openai');                        // only the surviving voter
  assert.deepStrictEqual(out.failures.map((f) => f.family), ['gemini']);
  assert.match(out.assessment, /DEGRADED/);
  assert.strictEqual(out.criteria[0].met, true);
});

atest('a seat with no API key degrades the jury rather than posing as a solo judge', async () => {
  const ff = juryFetch({ openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'ok' }] }) });
  const out = await createJudge({ FELIX_JUDGE_FAMILY: 'openai,gemini', OPENAI_API_KEY: 'sk' }, { fetchImpl: ff })(JURY_INPUT);
  assert.strictEqual(ff.calls.length, 1);                          // gemini never called
  assert.strictEqual(out.degraded, true);
  assert.match(out.failures[0].error, /GEMINI_API_KEY not set/);
});

atest('an empty bench (every seat fails) is a hard error, not a pass', async () => {
  const ff = juryFetch({
    openai: { ok: false, status: 500, body: 'boom' },
    gemini: { ok: false, status: 500, body: 'boom' },
  });
  await assert.rejects(createJudge(JURY_ENV, { fetchImpl: ff })(JURY_INPUT), /All 2 jury seat\(s\) failed/);
});

atest('per-seat models are honored positionally', async () => {
  const ff = juryFetch({
    openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true }] }),
    gemini: gem({ assessment: 'b', criteria: [{ text: 'c', met: true }] }),
  });
  const out = await createJudge({ ...JURY_ENV, FELIX_JUDGE_MODEL: 'gpt-4o,gemini-3-flash' }, { fetchImpl: ff })(JURY_INPUT);
  assert.strictEqual(out.model, 'gpt-4o+gemini-3-flash');
  assert.strictEqual(ff.calls.find((c) => c.url.includes('openai')).body.model, 'gpt-4o');
  assert.match(ff.calls.find((c) => c.url.includes('generativelanguage')).url, /gemini-3-flash/);
});

console.log('budget — rate-limit sizing + diff chunking (the TPM fix)');

// A diff of `files` files, each `perFile` chars, shaped like real `git diff` output so
// splitDiffByFile has genuine `diff --git` headers to cut on.
function bigDiff(files, perFile) {
  return Array.from({ length: files }, (_, i) => {
    const header = `diff --git a/src/f${i}.js b/src/f${i}.js\n@@ -1 +1 @@\n`;
    return header + `+${'x'.repeat(Math.max(0, perFile - header.length - 2))}`;
  }).join('\n');
}

test('estimateTokens/tokensToChars round-trip at the documented 4 chars per token', () => {
  assert.strictEqual(estimateTokens('x'.repeat(400)), 100);
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(tokensToChars(100), 400);
});

test('splitDiffByFile cuts on diff --git headers and loses nothing', () => {
  const d = bigDiff(3, 200);
  const units = splitDiffByFile(d);
  assert.strictEqual(units.length, 3);
  assert.deepStrictEqual(units.map((u) => u.path), ['src/f0.js', 'src/f1.js', 'src/f2.js']);
  assert.strictEqual(units.map((u) => u.text).join('\n'), d);   // reassembles byte-for-byte
});

test('packChunks fills chunks in order without exceeding the budget', () => {
  const units = splitDiffByFile(bigDiff(6, 100));
  const { chunks, omittedPaths } = packChunks(units, 250);
  assert.ok(chunks.length > 1, 'should need several chunks');
  for (const c of chunks) assert.ok(c.text.length <= 250, `chunk over budget: ${c.text.length}`);
  assert.deepStrictEqual(omittedPaths, []);
});

test('a single file bigger than one whole chunk is truncated LOUDLY, never silently', () => {
  const units = splitDiffByFile(bigDiff(1, 5000));
  const { chunks } = packChunks(units, 1000);
  assert.strictEqual(chunks.length, 1);
  assert.match(chunks[0].text, /truncated — \d+ of \d+ chars not shown/);
  assert.deepStrictEqual(chunks[0].truncatedPaths, ['src/f0.js']);   // and reported structurally
});

test('past maxChunks the extra files are reported as omitted, not quietly dropped', () => {
  const units = splitDiffByFile(bigDiff(10, 300));
  const { chunks, omittedPaths, omittedChars } = packChunks(units, 300, { maxChunks: 3 });
  assert.strictEqual(chunks.length, 3);
  assert.ok(omittedPaths.length > 0, 'omitted files must be named');
  assert.ok(omittedChars > 0, 'omitted volume must be counted');
});

test('planJudgeCalls: a diff that fits stays a single pass with 100% coverage', () => {
  const plan = planJudgeCalls({ diff: bigDiff(2, 100), overheadChars: 100, maxPromptTokens: 10000 });
  assert.strictEqual(plan.singlePass, true);
  assert.strictEqual(plan.chunks.length, 1);
  assert.strictEqual(plan.coverage.judgedChars, plan.coverage.totalChars);
});

test('planJudgeCalls budgets the WHOLE prompt — overhead counts against the diff', () => {
  const diff = bigDiff(4, 500);                        // ~2000 chars
  const budgetTokens = 1000;                           // 1000 * 0.85 * 4 = 3400 chars total
  const roomy = planJudgeCalls({ diff, overheadChars: 100, maxPromptTokens: budgetTokens });
  const cramped = planJudgeCalls({ diff, overheadChars: 3000, maxPromptTokens: budgetTokens });
  assert.strictEqual(roomy.singlePass, true);
  // Same diff, same budget — only the overhead grew, and that alone forces chunking. This is
  // the bug: the old cap sized the diff alone and ignored everything riding with it.
  assert.strictEqual(cramped.singlePass, false);
});

test('planJudgeCalls flags overBudget when the overhead alone exceeds the budget', () => {
  const plan = planJudgeCalls({ diff: 'x'.repeat(100), overheadChars: 99999, maxPromptTokens: 1000 });
  assert.strictEqual(plan.coverage.overBudget, true);
  assert.strictEqual(plan.chunks.length, 0);           // never fire a request we know will 429
});

test('paceMs converts tokens spent into a share of the per-minute window', () => {
  assert.strictEqual(paceMs(30000, 30000), 60000);     // a full minute's budget ⇒ wait a minute
  assert.strictEqual(paceMs(15000, 30000), 30000);
  assert.strictEqual(paceMs(1000, 0), 0);              // unknown tpm ⇒ don't stall
});

test('chunkVerdict reads the 3-valued verdict, and a stray boolean false means not_shown', () => {
  assert.strictEqual(chunkVerdict({ verdict: 'met' }), 'met');
  assert.strictEqual(chunkVerdict({ verdict: 'VIOLATED' }), 'violated');
  assert.strictEqual(chunkVerdict({ verdict: 'not_shown' }), 'not_shown');
  assert.strictEqual(chunkVerdict({ met: true }), 'met');
  // The load-bearing one: a chunk that just doesn't contain the file must not be read as a
  // violation, or big PRs regain the false negatives this whole change removes.
  assert.strictEqual(chunkVerdict({ met: false }), 'not_shown');
  assert.strictEqual(chunkVerdict(null), null);
});

const CHUNK_COVERAGE = {
  totalChars: 100, judgedChars: 100, chunkCount: 2,
  omittedPaths: [], omittedChars: 0, truncatedPaths: [], overBudget: false,
};
const chunkMerge = (chunkResults) => mergeChunkRulings({
  specCriteria: [{ text: 'c' }], chunkResults, coverage: CHUNK_COVERAGE,
  family: 'openai', model: 'gpt-4.1',
});

test('across chunks, evidence in ANY part carries the criterion', () => {
  const out = chunkMerge([
    { assessment: 'a', criteria: [{ text: 'c', verdict: 'not_shown' }] },
    { assessment: 'b', criteria: [{ text: 'c', verdict: 'met', reason: 'found it' }] },
  ]);
  assert.strictEqual(out.criteria[0].met, true);
  assert.match(out.criteria[0].reason, /part 2 of 2/);
});

test('one concrete violation outranks confirmation everywhere else', () => {
  const out = chunkMerge([
    { assessment: 'a', criteria: [{ text: 'c', verdict: 'met', reason: 'looks fine' }] },
    { assessment: 'b', criteria: [{ text: 'c', verdict: 'violated', reason: 'logs the key' }] },
  ]);
  assert.strictEqual(out.criteria[0].met, false);
  assert.match(out.criteria[0].reason, /violation.*logs the key/);
});

test('a criterion no chunk could see is NOT met — silence is never a pass', () => {
  const out = chunkMerge([
    { assessment: 'a', criteria: [{ text: 'c', verdict: 'not_shown' }] },
    { assessment: 'b', criteria: [{ text: 'c', verdict: 'not_shown' }] },
  ]);
  assert.strictEqual(out.criteria[0].met, false);
  assert.match(out.criteria[0].reason, /No part of the diff showed evidence/);
});

test('partial coverage is stated in the assessment, not hidden', () => {
  const out = mergeChunkRulings({
    specCriteria: [{ text: 'c' }],
    chunkResults: [{ assessment: 'a', criteria: [{ text: 'c', verdict: 'met' }] }],
    coverage: { ...CHUNK_COVERAGE, chunkCount: 1, judgedChars: 60, omittedPaths: ['src/skipped.js'], omittedChars: 40 },
    family: 'openai', model: 'gpt-4.1',
  });
  assert.match(out.assessment, /~60% of the diff/);
  assert.match(out.assessment, /PARTIAL: 1 file\(s\) not judged \(src\/skipped\.js\)/);
  assert.strictEqual(out.chunked, true);
});

// ── The regression a large real PR exposed ──────────────────────────────────────────────────
// Felix returned INSUFFICIENT EVIDENCE on a real PR with:
//   429 Request too large for gpt-4.1 … tokens per min (TPM): Limit 30000, Requested 61227
// because MAX_DIFF_CHARS was sized to the model's 1M-token CONTEXT WINDOW while the account's
// RATE limit was 30K/min. These drive the whole path with an injected fetch and no network.

// The chunked judge replies with the 3-valued schema; text is echoed so findRuling matches.
const chunkReply = (verdict) => oai({
  assessment: 'part seen', criteria: [{ text: 'c', verdict, reason: 'r' }],
});

atest('REGRESSION: a diff over the rate limit is split — no single request exceeds the budget', async () => {
  const ff = fakeFetch({ choices: [{ message: { content: JSON.stringify({ assessment: 'p', criteria: [{ text: 'c', verdict: 'met', reason: 'r' }] }) } }] });
  const budgetTokens = 1000;
  const out = await createJudge(
    { OPENAI_API_KEY: 'sk', FELIX_JUDGE_MAX_PROMPT_TOKENS: String(budgetTokens) },
    { fetchImpl: ff, sleepImpl: noSleep },
  )({ prTitle: 'p', criteria: [{ text: 'c' }], diff: bigDiff(12, 500), tier1: [] });

  assert.ok(ff.calls.length > 1, 'a too-large diff must be split into several calls');
  // The actual assertion the old code would fail: EVERY request fits the per-minute ceiling.
  // This also guards the CHUNK FRAMING overhead — the part header, the 3-valued verdict menu
  // and the global-checks paragraph are only in chunked prompts, so an overhead measured in
  // single-pass mode under-counts every one of these requests. Growing that framing is what
  // made this test fail and exposed the gap; keep the loop assertion, not just call.length.
  for (const call of ff.calls) {
    const prompt = call.body.messages[0].content;
    assert.ok(
      estimateTokens(prompt) <= budgetTokens,
      `request of ~${estimateTokens(prompt)} tokens exceeds the ${budgetTokens}-token budget`,
    );
  }
  assert.strictEqual(out.chunked, true);
  assert.strictEqual(out.criteria[0].met, true);
});

atest('each split request tells the judge which part it is seeing', async () => {
  const ff = fakeFetch({ choices: [{ message: { content: JSON.stringify({ assessment: 'p', criteria: [{ text: 'c', verdict: 'not_shown' }] }) } }] });
  await createJudge(
    { OPENAI_API_KEY: 'sk', FELIX_JUDGE_MAX_PROMPT_TOKENS: '1000' },
    { fetchImpl: ff, sleepImpl: noSleep },
  )({ prTitle: 'p', criteria: [{ text: 'c' }], diff: bigDiff(8, 500), tier1: [] });

  const total = ff.calls.length;
  ff.calls.forEach((call, i) => {
    const prompt = call.body.messages[0].content;
    assert.match(prompt, new RegExp(`PART ${i + 1} OF ${total}`));
    assert.match(prompt, /"not_shown"/);               // 3-valued schema only in chunked mode
  });
});

// ── The follow-on false negative the chunk fix left behind (caught on a re-run) ────────────────
// `build/smoke — exit 0` sat in ALL 4 prompts and the judge still answered not_shown in every
// part, because every verdict option was phrased about "this part of the diff" — and a slice of
// a diff genuinely cannot show that a build passed. all-not_shown ⇒ NOT met: a false negative on
// a criterion the deterministic check had already settled. Only the DIFF is split; the checks
// ran once over the whole PR, so the prompt has to say so.
const PASSING_BUILD = [{ name: 'build/smoke', status: 'pass', detail: 'exit 0 in 3709ms' }];
const BUILD_CRITERION = 'npm run build exits 0';

test('a chunked prompt scopes the split to the diff and the Tier 1 results to the whole PR', () => {
  const p = buildPrompt({
    prTitle: 'x', criteria: [{ text: BUILD_CRITERION }], diff: 'part 2 files',
    tier1: PASSING_BUILD, chunk: { index: 2, total: 4 },
  });
  assert.match(p, /- build\/smoke: PASS/);          // the evidence was always there …
  assert.match(p, /only the UNIFIED DIFF/);         // … what was missing: the split's real scope
  assert.match(p, /GLOBAL/);
  assert.match(p, /NEVER "not_shown"/);             // the exact answer that produced the false negative
  // and the verdict menu must no longer read as diff-only, or the paragraph above is contradicted
  assert.match(p, /"met"\s+— this part of the diff, or the global check results/);
});

test('the single-pass prompt is untouched — no chunk framing, no global-checks paragraph', () => {
  const p = buildPrompt({
    prTitle: 'x', criteria: [{ text: BUILD_CRITERION }], diff: 'd', tier1: PASSING_BUILD,
  });
  assert.doesNotMatch(p, /WHAT IS SPLIT/);
  assert.doesNotMatch(p, /PART \d+ OF/);
});

atest('REGRESSION: a criterion settled by a passing Tier 1 check survives chunking', async () => {
  // The mixture a chunked run should produce: one part rules from the global check result, the rest
  // see no bearing code and say not_shown. Under the old wording NO part ruled and it came back
  // not met. Every part must also still be SHOWN the passing check — the merge can't rescue a
  // criterion the prompt never carried evidence for.
  let n = 0;
  const impl = async (url, opts) => {
    impl.calls.push({ url, opts, body: JSON.parse(opts.body) });
    n += 1;
    const r = oai({
      assessment: 'part seen',
      criteria: [{
        text: BUILD_CRITERION,
        verdict: n === 1 ? 'met' : 'not_shown',
        reason: n === 1 ? 'build/smoke check reports exit 0 for the whole PR' : 'no bearing code here',
      }],
    });
    return { ok: true, status: 200, async json() { return r.body; }, async text() { return JSON.stringify(r.body); } };
  };
  impl.calls = [];
  const out = await createJudge(
    { OPENAI_API_KEY: 'sk', FELIX_JUDGE_MAX_PROMPT_TOKENS: '1000' },
    { fetchImpl: impl, sleepImpl: noSleep },
  )({ prTitle: 'p', criteria: [{ text: BUILD_CRITERION }], diff: bigDiff(12, 500), tier1: PASSING_BUILD });

  assert.ok(impl.calls.length > 1, 'this diff must actually chunk or the test proves nothing');
  for (const call of impl.calls) {
    const prompt = call.body.messages[0].content;
    assert.match(prompt, /- build\/smoke: PASS/, 'every part must carry the global check results');
    assert.match(prompt, /NEVER "not_shown"/, 'every part must be told the checks are not split');
  }
  assert.strictEqual(out.criteria[0].met, true, 'a passing build check must not be lost to chunking');
});

atest('an ordinary PR still makes exactly ONE call with the original boolean schema', async () => {
  const ff = fakeFetch({ choices: [{ message: { content: '{"assessment":"a","criteria":[{"text":"c","met":true}]}' } }] });
  const out = await createJudge({ OPENAI_API_KEY: 'sk' }, { fetchImpl: ff, sleepImpl: noSleep })(JUDGE_INPUT);
  assert.strictEqual(ff.calls.length, 1);
  const prompt = ff.calls[0].body.messages[0].content;
  assert.doesNotMatch(prompt, /PART 1 OF/);            // no chunk framing
  assert.doesNotMatch(prompt, /not_shown/);            // no 3-valued schema
  assert.strictEqual(out.chunked, undefined);          // unchanged result shape
});

atest('a "request too large" 429 is NOT retried — waiting cannot shrink the request', async () => {
  const ff = fakeFetch(
    'Request too large for gpt-4.1 on tokens per min (TPM): Limit 30000, Requested 61227',
    { ok: false, status: 429 },
  );
  await assert.rejects(
    createJudge({ OPENAI_API_KEY: 'sk' }, { fetchImpl: ff, sleepImpl: noSleep })(JUDGE_INPUT),
    /Request too large/,
  );
  assert.strictEqual(ff.calls.length, 1, 'a size 429 must fail fast, not burn the retry budget');
});

atest('a plain rate-limit 429 IS retried, then gives up cleanly', async () => {
  const ff = fakeFetch('Rate limit reached, please slow down', { ok: false, status: 429 });
  await assert.rejects(
    createJudge({ OPENAI_API_KEY: 'sk' }, { fetchImpl: ff, sleepImpl: noSleep })(JUDGE_INPUT),
    /Judge call failed: 429/,
  );
  assert.strictEqual(ff.calls.length, 3, 'initial attempt + 2 retries');
});

atest('a transient 503 is retried — a vendor blip must not silently halve the jury', async () => {
  // The literal Gemini response that degraded the jury to openai-only in production.
  const ff = fakeFetch(
    '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
    { ok: false, status: 503 },
  );
  await assert.rejects(
    createJudge({ OPENAI_API_KEY: 'sk' }, { fetchImpl: ff, sleepImpl: noSleep })(JUDGE_INPUT),
    /Judge call failed: 503/,
  );
  assert.strictEqual(ff.calls.length, 3, 'initial attempt + 2 retries');
});

atest('a 503 that recovers on retry returns a normal verdict, no DEGRADED', async () => {
  let n = 0;
  const impl = async (url, opts) => {
    impl.calls.push({ url, opts, body: JSON.parse(opts.body) });
    n += 1;
    if (n === 1) {
      return { ok: false, status: 503, async json() { return {}; }, async text() { return 'high demand'; } };
    }
    const body = { choices: [{ message: { content: '{"assessment":"a","criteria":[{"text":"c","met":true}]}' } }] };
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
  };
  impl.calls = [];
  const out = await createJudge({ OPENAI_API_KEY: 'sk' }, { fetchImpl: impl, sleepImpl: noSleep })(JUDGE_INPUT);
  assert.strictEqual(impl.calls.length, 2);
  assert.strictEqual(out.criteria[0].met, true);
});

atest('a 4xx that is NOT a rate limit still fails fast — a bad key is not transient', async () => {
  const ff = fakeFetch('invalid api key', { ok: false, status: 401 });
  await assert.rejects(
    createJudge({ OPENAI_API_KEY: 'sk' }, { fetchImpl: ff, sleepImpl: noSleep })(JUDGE_INPUT),
    /Judge call failed: 401/,
  );
  assert.strictEqual(ff.calls.length, 1);
});

atest('a violation found in ONE part fails the criterion for the whole PR', async () => {
  let n = 0;
  const impl = async (url, opts) => {
    impl.calls.push({ url, opts, body: JSON.parse(opts.body) });
    n += 1;
    // Every part says "met" except the third, which finds a concrete violation.
    const r = chunkReply(n === 3 ? 'violated' : 'met');
    return { ok: true, status: 200, async json() { return r.body; }, async text() { return JSON.stringify(r.body); } };
  };
  impl.calls = [];
  const out = await createJudge(
    { OPENAI_API_KEY: 'sk', FELIX_JUDGE_MAX_PROMPT_TOKENS: '1000' },
    { fetchImpl: impl, sleepImpl: noSleep },
  )({ prTitle: 'p', criteria: [{ text: 'c' }], diff: bigDiff(12, 500), tier1: [] });

  assert.ok(impl.calls.length >= 3);
  assert.strictEqual(out.criteria[0].met, false);
  assert.match(out.criteria[0].reason, /violation/);
});

atest('the two-vendor jury still requires unanimity when one seat had to chunk', async () => {
  // openai is squeezed to a tiny budget (chunks); gemini keeps a large one (single pass).
  // The jury merge must be unaffected by HOW each seat arrived at its answer.
  const ff = juryFetch({
    openai: oai({ assessment: 'o', criteria: [{ text: 'c', verdict: 'met', reason: 'ok' }] }),
    gemini: gem({ assessment: 'g', criteria: [{ text: 'c', met: false, reason: 'not convinced' }] }),
  });
  const out = await createJudge(
    { ...JURY_ENV, FELIX_JUDGE_MAX_PROMPT_TOKENS: '1200' },
    { fetchImpl: ff, sleepImpl: noSleep },
  )({ prTitle: 'p', criteria: [{ text: 'c' }], diff: bigDiff(10, 500), tier1: [] });

  assert.strictEqual(out.criteria[0].met, false, 'one dissent must still block');
  assert.match(out.criteria[0].reason, /Split verdict/);
});

// Run the deferred async tests (judge wire-contract) after the sync suite, then tally.
(async () => {
  if (asyncTests.length) console.log('judge — provider wire contract (R2b, injected fetch)');
  for (const t of asyncTests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
