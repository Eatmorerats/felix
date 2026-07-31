/**
 * crap-live.js — END-TO-END proof of the CRAP check against the real toolchain.
 *
 * Not a mock. This builds a throwaway fixture repo, runs the ACTUAL test suite
 * under the ACTUAL c8 coverage instrumentation, measures complexity with the
 * ACTUAL escomplex, and runs the real `runCrapCheck` — then checks the three
 * falsifiable acceptance criteria from the PR:
 *
 *   1. An UNCOVERED complex function (comp 7) is flagged with score 56 > 30.
 *   2. The SAME function fully COVERED scores 7 (== its complexity) and is NOT flagged.
 *   3. Disabled (default) ⇒ no coverage run, and the check contributes no row.
 *
 * Run with `npm run test:crap`. Prints the real Tier 1 row it produces.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run } = require('../src/engine/util/exec');
const { runCrapCheck, analyzeFileParsed, DEFAULT_CRAP_THRESHOLD } = require('../src/engine/crap');
const { runTier1 } = require('../src/engine/tier1');
const { merge } = require('../src/engine/config');

// Fable's fixture: 6 decision points ⇒ cyclomatic 7. Chosen so a ±1 parser
// disagreement still flags decisively (comp 6→42, 8→72), never landing on the
// comp-5→exactly-30 boundary.
const RISK_SCORE_SRC = `function riskScore(n) {
  if (n < 0)  return 'invalid';
  if (n < 10) return 'low';
  if (n < 20) return 'mild';
  if (n < 40) return 'moderate';
  if (n < 60) return 'high';
  if (n < 80) return 'severe';
  return 'critical';
}
module.exports = { riskScore };
`;

// A whole-file-add patch so every line of riskScore.js reads as "changed".
function wholeFileAddPatch(src) {
  const lines = src.replace(/\n$/, '').split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n');
}

function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-crap-fixture-'));
  fs.writeFileSync(path.join(dir, 'riskScore.js'), RISK_SCORE_SRC);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'crap-fixture', version: '1.0.0' }));
  return dir;
}

const FILES = [{ filename: 'riskScore.js', status: 'added', patch: wholeFileAddPatch(RISK_SCORE_SRC) }];

let passed = 0;
let failed = 0;
function check(name, fn) {
  return fn().then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
}

(async () => {
  console.log('crap-live — real c8 + escomplex + runCrapCheck\n');

  // ── Independent complexity check: does REAL escomplex agree comp(riskScore) === 7? ──
  await check('escomplex measures riskScore cyclomatic complexity == 7', async () => {
    const escomplex = require('typhonjs-escomplex');
    const report = escomplex.analyzeModule(RISK_SCORE_SRC);
    const m = report.methods.find((x) => x.name === 'riskScore');
    assert.ok(m, 'escomplex found the riskScore method');
    assert.strictEqual(m.cyclomatic, 7, `expected cyclomatic 7, got ${m.cyclomatic}`);
  });

  // ── CRITERION 1: uncovered complex function is flagged, score 56 > 30 ──
  const dir1 = mkFixture();
  fs.writeFileSync(path.join(dir1, 'runner.js'),
    "const { riskScore } = require('./riskScore.js'); void riskScore; /* imported, never called */\n");
  let row1;
  await check('CRITERION 1 — uncovered comp-7 function flagged with CRAP 56', async () => {
    row1 = await runCrapCheck({
      cwd: dir1, env: process.env, testCmd: 'node runner.js', files: FILES,
      threshold: DEFAULT_CRAP_THRESHOLD, isolationMode: 'none', run, timeoutMs: 120000,
    });
    assert.strictEqual(row1.status, 'fail', `expected soft-fail (flagged), got ${row1.status}: ${row1.detail}`);
    assert.strictEqual(row1.hard, false, 'crap must be SOFT — never gates the verdict');
    assert.match(row1.output, /FLAG .*riskScore/, 'a FLAG row names riskScore');
    assert.match(row1.output, /CRAP 56\b/, `expected CRAP 56 in output:\n${row1.output}`);
    assert.match(row1.detail, /over CRAP 30/, 'detail states it crossed the threshold');
  });

  // ── CRITERION 2: same function fully covered scores 7 (== complexity), not flagged ──
  const dir2 = mkFixture();
  fs.writeFileSync(path.join(dir2, 'runner.js'),
    "const { riskScore } = require('./riskScore.js');\n" +
    "for (const n of [-1, 5, 15, 30, 50, 70, 90]) riskScore(n); // every branch\n");
  let row2;
  await check('CRITERION 2 — fully-covered function scores 7 (== comp) and is NOT flagged', async () => {
    row2 = await runCrapCheck({
      cwd: dir2, env: process.env, testCmd: 'node runner.js', files: FILES,
      threshold: DEFAULT_CRAP_THRESHOLD, isolationMode: 'none', run, timeoutMs: 120000,
    });
    assert.strictEqual(row2.status, 'pass', `expected pass (nothing flagged), got ${row2.status}: ${row2.detail}`);
    assert.match(row2.output, /ok +.*riskScore/, 'an ok row names riskScore');
    // The statement COUNT is an Istanbul detail (not fixed); the SCORE is what matters.
    assert.match(row2.output, /cov 100% \(\d+\/\d+ stmts\), CRAP 7\b/, `expected full coverage + CRAP 7:\n${row2.output}`);
  });

  // ── CRITERION 2 (exact numbers, independent path): analyzeFileParsed on REAL coverage ──
  await check('CRITERION 2 exact — real coverage feeds fusion to score === complexity', async () => {
    // Re-run coverage directly to read the raw Istanbul data and score it with the
    // pure fusion, proving the integration end-to-end with strict-equality numbers.
    const escomplex = require('typhonjs-escomplex');
    const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-crap-cov-'));
    const c8PkgPath = require.resolve('c8/package.json');
    const bin = require(c8PkgPath).bin;
    const c8Bin = path.join(path.dirname(c8PkgPath), typeof bin === 'string' ? bin : bin.c8);
    const cmd = ['node', '"' + c8Bin + '"', '--reporter=json', '--report-dir="' + covDir + '"', '--all=false', '--', 'node runner.js'].join(' ');
    const rr = await run(cmd, { cwd: dir2, env: process.env, timeoutMs: 120000 });
    assert.strictEqual(rr.code, 0, 'coverage run exits 0');
    const covMap = JSON.parse(fs.readFileSync(path.join(covDir, 'coverage-final.json'), 'utf8'));
    const key = Object.keys(covMap).find((k) => k.replace(/\\/g, '/').endsWith('/riskScore.js'));
    assert.ok(key, 'riskScore.js present in coverage map');
    const fileCov = covMap[key];
    const report = escomplex.analyzeModule(fs.readFileSync(path.join(dir2, 'riskScore.js'), 'utf8'));
    const rows = analyzeFileParsed({
      relPath: 'riskScore.js', methods: report.methods,
      statementMap: fileCov.statementMap, s: fileCov.s,
      addedLines: new Set(Array.from({ length: 20 }, (_, i) => i + 1)), threshold: DEFAULT_CRAP_THRESHOLD,
    });
    const rs = rows.find((r) => r.name === 'riskScore');
    assert.ok(rs, 'riskScore scored');
    assert.strictEqual(rs.covered, rs.total, 'fully covered');
    assert.strictEqual(rs.score, rs.complexity, `score (${rs.score}) === complexity (${rs.complexity})`);
    assert.strictEqual(rs.flagged, false, 'not flagged');
    fs.rmSync(covDir, { recursive: true, force: true });
  });

  // ── CRITERION 3: disabled by default ⇒ runTier1 emits NO crap row (byte-identical) ──
  await check('CRITERION 3 — crap disabled by default: runTier1 produces no crap row', async () => {
    // The default merged config has crap.enabled=false. Prove the gate in runTier1
    // means no `crap` entry appears at all (not even a skip). We stub the tiny fixture
    // as a node repo with a trivially-passing suite so Tier 1 runs to completion.
    const dir = mkFixture();
    fs.writeFileSync(path.join(dir, 'runner.js'), "process.exit(0);\n");
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'crap-fixture', version: '1.0.0', scripts: { test: 'node runner.js' },
    }));
    const config = merge({
      language: 'node',
      commands: { install: 'echo skip-install', test: 'node runner.js', smoke: '', testOne: '', preTest: '', lint: '', typecheck: '' },
      test: { filePattern: '**/*.test.js' },
    }, null); // no user config ⇒ crap defaults to enabled:false
    assert.strictEqual(config.crap.enabled, false, 'default crap.enabled is false');
    const { results } = await runTier1({ cwd: dir, env: process.env, config, files: FILES });
    const crapRow = results.find((c) => c.name === 'crap');
    assert.strictEqual(crapRow, undefined, 'no crap row when disabled — the verdict is byte-identical');
  });

  console.log(`\nReal Tier 1 rows produced:`);
  if (row1) console.log(`  [criterion 1] ${row1.status.toUpperCase()} — ${row1.detail}`);
  if (row2) console.log(`  [criterion 2] ${row2.status.toUpperCase()} — ${row2.detail}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
