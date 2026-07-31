/**
 * deps-live.js — END-TO-END proof of the deps check against the real toolchain.
 *
 * Not a mock. This builds throwaway git repos with REAL commits, cruises them with
 * the ACTUAL dependency-cruiser 18.1.0, and runs the real `runDepsCheck` — then
 * checks the falsifiable acceptance criteria from the design:
 *
 *   1. A PR that adds an import creating an a→b→a cycle ⇒ a soft-FAIL deps row
 *      naming BOTH files.
 *   2. A PR with a benign change and no new cycle ⇒ a PASSING deps row.
 *   2b. A base that ALREADY has a cycle, head that keeps it (no new one) ⇒ PASS with
 *       "pre-existing ignored" — the anti-cry-wolf proof (this is the one that matters).
 *   3. Disabled by default ⇒ runTier1 emits NO deps row (verdict byte-identical).
 *
 * Run with `npm run test:deps`. Prints the real Tier 1 rows it produces. Self-cleans
 * every fixture repo (and runDepsCheck tears down its own base worktree).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run } = require('../src/engine/util/exec');
const { runDepsCheck } = require('../src/engine/deps');
const { runTier1 } = require('../src/engine/tier1');
const { merge } = require('../src/engine/config');

const fixtures = [];

async function git(cwd, cmd) {
  const r = await run(`git ${cmd}`, { cwd, timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`git ${cmd} failed (exit ${r.code}): ${r.combined}`);
  return r.stdout.trim();
}

async function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-deps-fixture-'));
  fixtures.push(dir);
  await git(dir, 'init -q');
  await git(dir, 'config user.email felix@test.local');
  await git(dir, 'config user.name FelixTest');
  await git(dir, 'config commit.gpgsign false');
  await git(dir, 'config core.autocrlf false');
  return dir;
}

async function commitAll(dir, msg) {
  await git(dir, 'add -A');
  await git(dir, `commit -q -m "${msg}"`);
  return git(dir, 'rev-parse HEAD');
}

// A merged config that turns the (default-off) deps check ON, node language.
const depsOn = () => merge({
  language: 'node',
  commands: { install: 'echo ok', test: 'echo ok' },
  deps: { enabled: true },
}, null);

let passed = 0;
let failed = 0;
function check(name, fn) {
  return fn().then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
}

(async () => {
  console.log('deps-live — real dependency-cruiser + git worktree + runDepsCheck\n');

  let row1;
  let row2;
  let row3;

  // ── CRITERION 1: a new a→b→a cycle is a soft-FAIL naming both files ──
  await check('CRITERION 1 — a new a↔b cycle is flagged (soft), detail names both files', async () => {
    const dir = await initRepo();
    fs.writeFileSync(path.join(dir, 'a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(dir, 'b.js'), 'module.exports = {};\n'); // base: a→b only, NO cycle
    const baseSha = await commitAll(dir, 'base a to b no cycle');
    fs.writeFileSync(path.join(dir, 'b.js'), "require('./a');\nmodule.exports = {};\n"); // head: adds b→a
    const headSha = await commitAll(dir, 'head b to a creates cycle');

    row1 = await runDepsCheck({
      repoPath: dir, baseSha, headSha,
      filesAll: [{ status: 'modified', filename: 'b.js' }],
      config: depsOn(), run, timeoutMs: 120000,
    });
    assert.strictEqual(row1.status, 'fail', `expected soft-fail, got ${row1.status}: ${row1.detail}`);
    assert.strictEqual(row1.hard, false, 'deps must be SOFT — never gates the verdict');
    assert.match(row1.detail, /advisory/, 'detail must label itself advisory');
    assert.match(row1.detail, /circular/, 'detail names the circular dependency');
    assert.match(row1.detail, /a\.js ↔ b\.js/, `detail must name BOTH files:\n${row1.detail}`);
    assert.match(row1.output, /FLAG cycle/, 'output carries a FLAG line');
  });

  // ── CRITERION 2: a benign change over the same base ⇒ PASS ──
  await check('CRITERION 2 — a benign change with no new cycle passes', async () => {
    const dir = await initRepo();
    fs.writeFileSync(path.join(dir, 'a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(dir, 'b.js'), 'module.exports = {};\n');
    const baseSha = await commitAll(dir, 'base a to b no cycle');
    fs.writeFileSync(path.join(dir, 'b.js'), '// benign edit, still no import of a\nmodule.exports = { ok: true };\n');
    const headSha = await commitAll(dir, 'head benign no cycle');

    row2 = await runDepsCheck({
      repoPath: dir, baseSha, headSha,
      filesAll: [{ status: 'modified', filename: 'b.js' }],
      config: depsOn(), run, timeoutMs: 120000,
    });
    assert.strictEqual(row2.status, 'pass', `expected pass, got ${row2.status}: ${row2.detail}`);
    assert.strictEqual(row2.hard, false);
  });

  // ── CRITERION 2b: a PRE-EXISTING cycle the PR keeps ⇒ PASS, "pre-existing ignored" ──
  await check('CRITERION 2b — a pre-existing cycle is NOT flagged (anti-cry-wolf)', async () => {
    const dir = await initRepo();
    fs.writeFileSync(path.join(dir, 'a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(dir, 'b.js'), "require('./a');\nmodule.exports = {};\n"); // cycle ALREADY on base
    fs.writeFileSync(path.join(dir, 'c.js'), 'module.exports = 1;\n');
    const baseSha = await commitAll(dir, 'base already has a b cycle');
    fs.writeFileSync(path.join(dir, 'c.js'), 'module.exports = 2; // benign, cycle untouched\n');
    const headSha = await commitAll(dir, 'head benign change keeps cycle');

    row3 = await runDepsCheck({
      repoPath: dir, baseSha, headSha,
      filesAll: [{ status: 'modified', filename: 'c.js' }],
      config: depsOn(), run, timeoutMs: 120000,
    });
    assert.strictEqual(row3.status, 'pass', `a pre-existing cycle must PASS, got ${row3.status}: ${row3.detail}`);
    assert.match(row3.detail, /pre-existing ignored/, `detail must credit the pre-existing cycle:\n${row3.detail}`);
  });

  // ── CRITERION 3: disabled by default ⇒ runTier1 emits NO deps row ──
  await check('CRITERION 3 — deps disabled by default: runTier1 produces no deps row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-deps-off-'));
    fixtures.push(dir);
    fs.writeFileSync(path.join(dir, 'runner.js'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'deps-fixture', version: '1.0.0', scripts: { test: 'node runner.js' },
    }));
    const config = merge({
      language: 'node',
      commands: { install: 'echo skip-install', test: 'node runner.js', smoke: '', testOne: '', preTest: '', lint: '', typecheck: '' },
      test: { filePattern: '**/*.test.js' },
    }, null); // no user config ⇒ deps defaults to enabled:false
    assert.strictEqual(config.deps.enabled, false, 'default deps.enabled is false');
    // repoPath/baseSha are threaded in the real pipeline; with deps OFF they must go unused.
    const { results } = await runTier1({
      cwd: dir, env: process.env, config, files: [{ filename: 'runner.js', status: 'added' }],
      repoPath: dir, baseSha: 'deadbeef', headSha: 'cafef00d', filesAll: [{ filename: 'runner.js', status: 'added' }],
    });
    const depsRow = results.find((c) => c.name === 'deps');
    assert.strictEqual(depsRow, undefined, 'no deps row when disabled — the verdict is byte-identical');
  });

  // ── FIX 1: head is cruised from its OWN pristine worktree, never the sandbox cwd ──
  await check('FIX 1 — head is cruised from a pristine worktree, not the working dir (no phantom)', async () => {
    const dir = await initRepo();
    fs.writeFileSync(path.join(dir, 'a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(dir, 'b.js'), 'module.exports = {};\n');
    const baseSha = await commitAll(dir, 'base a to b no cycle');
    fs.writeFileSync(path.join(dir, 'b.js'), '// benign committed edit, still no cycle\nmodule.exports = { ok: true };\n');
    const headSha = await commitAll(dir, 'head benign no cycle');
    // Now DIRTY the working tree with an UNCOMMITTED cycle. If the check cruised `cwd`
    // (the working tree) it would FLAG this; cruising the pristine head worktree it must PASS.
    fs.writeFileSync(path.join(dir, 'b.js'), "require('./a');\nmodule.exports = { ok: true };\n"); // uncommitted b→a cycle

    const row = await runDepsCheck({
      repoPath: dir, baseSha, headSha,
      filesAll: [{ status: 'modified', filename: 'b.js' }],
      config: depsOn(), run, timeoutMs: 120000,
    });
    assert.strictEqual(row.status, 'pass',
      `head must be cruised pristine (committed head has no cycle) — got ${row.status}: ${row.detail}`);
    // And both throwaway worktrees must be torn down.
    const wt = path.join(dir, '.felix-worktrees');
    const leftovers = fs.existsSync(wt) ? fs.readdirSync(wt).filter((n) => /^deps-(head|base)-/.test(n)) : [];
    assert.deepStrictEqual(leftovers, [], `deps worktrees must be removed, found: ${leftovers.join(', ')}`);
  });

  // ── ESM: a `.mjs` import cycle is detected and keyed with full membership ──
  await check('ESM — a new .mjs import cycle is detected and flagged (full-membership key)', async () => {
    const dir = await initRepo();
    fs.writeFileSync(path.join(dir, 'a.mjs'), "import './b.mjs';\n");
    fs.writeFileSync(path.join(dir, 'b.mjs'), 'export const b = 1;\n'); // base: a→b only, no cycle
    const baseSha = await commitAll(dir, 'base esm a to b no cycle');
    fs.writeFileSync(path.join(dir, 'b.mjs'), "import './a.mjs';\nexport const b = 1;\n"); // head: b→a ⇒ cycle
    const headSha = await commitAll(dir, 'head esm b to a creates cycle');

    const row = await runDepsCheck({
      repoPath: dir, baseSha, headSha,
      filesAll: [{ status: 'modified', filename: 'b.mjs' }],
      config: depsOn(), run, timeoutMs: 120000,
    });
    assert.strictEqual(row.status, 'fail', `ESM cycle must be flagged, got ${row.status}: ${row.detail}`);
    assert.match(row.detail, /a\.mjs ↔ b\.mjs/, `ESM cycle detail names both files:\n${row.detail}`);
  });

  console.log('\nReal Tier 1 rows produced:');
  if (row1) console.log(`  [criterion 1]  ${row1.status.toUpperCase()} — ${row1.detail}`);
  if (row2) console.log(`  [criterion 2]  ${row2.status.toUpperCase()} — ${row2.detail}`);
  if (row3) console.log(`  [criterion 2b] ${row3.status.toUpperCase()} — ${row3.detail}`);

  for (const d of fixtures) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
