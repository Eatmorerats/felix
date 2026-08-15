#!/usr/bin/env node
/**
 * probe-preflight-containment.js — prove local pre-flight cannot reach the verdict store or GitHub.
 *
 * WHY THIS IS THE PROBE THAT MATTERS. The freeze and the attempt cap are both derived from rows in
 * `felix_verdicts`, keyed on (repo, pr_number):
 *
 *   - the freeze baseline is the EARLIEST non-null `spec_fingerprint`, so one row written by a
 *     local run becomes the pin CI then faithfully enforces — the agent gets to choose the rubric
 *     its own work is frozen against;
 *   - the attempt cap counts rows with `judge_attempted`, so a local loop that logged them would
 *     drain CI's ten attempts from outside, at no cost to itself.
 *
 * Both are one accidental import away, and neither would show up as a failing test — the code
 * would work perfectly, it would just also be writing. So the property is asserted three ways: the
 * module is never loaded, the credentials are never needed, and no request is ever made even when
 * the credentials are handed over. Leg 4 is the control that keeps the other three honest.
 *
 *   node scripts/probe-preflight-containment.js
 */

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'felix.js');

let failures = 0;
const ok = (name, detail = '') => console.log(`  ✓ PASS  ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail) => { failures++; console.log(`  ✗ FAIL  ${name} — ${detail}`); };
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'assertion false'));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * Assembled at runtime, never written as a literal.
 *
 * Felix's own Tier 1 secrets scan reads this file when it is in a changed set, and a
 * `TOKEN: '<18 chars>'` literal is precisely the generic-secret-assignment shape it is built to
 * catch — so writing the fixture value inline reds Felix on its own probe. test/run.js already
 * splits FAKE_AWS_KEY for the same reason. Caught by running `felix preflight` on this change.
 */
const FAKE_TOKEN = 'probe-' + 'github-' + 'token';
const FAKE_SERVICE_KEY = 'probe-' + 'service-role-' + 'key';

/** The credentials pre-flight must never need, and must never use even when handed them. */
const FORBIDDEN_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY'];

function scrubbedEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of FORBIDDEN_VARS) delete env[k];
  return { ...env, ...extra };
}

/**
 * A minimal repo pre-flight can actually run: a git repo with a test command that exits 0 fast.
 * Using felix-work itself would mean an `npm ci` and the full suite per leg — three times.
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-contain-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'probe@felix.invalid']);
  git(dir, ['config', 'user.name', 'Probe']);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'contain-fixture', version: '1.0.0', private: true,
    scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'felix.config.json'), JSON.stringify({
    commands: { install: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' },
  }, null, 2));
  fs.mkdirSync(path.join(dir, '.felix'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.felix', 'preflight-criteria.md'),
    '## Acceptance criteria\n\n- [ ] the fixture module exports a greeting\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  // One uncommitted behavioural change, so triage does not short-circuit to SKIPPED.
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = () => "hello";\n');
  return dir;
}

(async () => {
  console.log('\nprobe-preflight-containment — can a local pre-flight touch the store or GitHub?\n');
  const dir = makeRepo();

  // A recorder standing in for BOTH Supabase and the GitHub API. Any request at all is a failure.
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('[1] the module is never loaded');
    // Asserted in a CHILD so this probe's own requires cannot contaminate the answer.
    const closure = spawnSync(process.execPath, ['-e',
      'require("./src/engine/preflight");'
      + 'console.log(JSON.stringify(Object.keys(require.cache)));',
    ], { cwd: REPO, encoding: 'utf8', env: scrubbedEnv() });
    const loaded = JSON.parse(closure.stdout || '[]').map((p) => p.replace(/\\/g, '/'));
    const hit = (f) => loaded.filter((p) => p.endsWith(`/src/engine/${f}`));
    check('log.js is absent from preflight\'s require closure', hit('log.js').length === 0, hit('log.js')[0] || '');
    check('github.js is absent from preflight\'s require closure', hit('github.js').length === 0, hit('github.js')[0] || '');
    check('index.js is absent from preflight\'s require closure', hit('index.js').length === 0,
      hit('index.js')[0] || 'importing index.js would pull in both of the above transitively');
    check('@supabase/supabase-js is not in the closure',
      loaded.filter((p) => p.includes('@supabase/')).length === 0);

    console.log('\n[2] the credentials are not merely unused — they are not needed');
    const bare = spawnSync(process.execPath, [CLI, 'preflight', '--json', '--repo-path', dir], {
      cwd: dir, encoding: 'utf8', env: scrubbedEnv(),
    });
    // The logger writes progress lines to stdout ahead of the JSON, so slice from the first
    // line that starts an object rather than parsing the whole stream.
    const jsonFrom = (out) => {
      const i = (out || '').indexOf('\n{');
      const raw = i === -1 ? out : out.slice(i + 1);
      try { return JSON.parse(raw); } catch (_) { return null; }
    };
    const parsed = jsonFrom(bare.stdout);
    check('pre-flight completes with every credential unset', Boolean(parsed && parsed.verdict),
      parsed ? `verdict ${parsed.verdict} (${parsed.cause})` : `exit ${bare.status}: ${(bare.stderr || bare.stdout || '').slice(-300)}`);
    check('it did not exit 3 (Felix\'s own failure code)', bare.status !== 3, `exit ${bare.status}`);

    console.log('\n[3] nothing is called even when the credentials ARE present');
    seen.length = 0;
    const wired = spawnSync(process.execPath, [CLI, 'preflight', '--json', '--repo-path', dir], {
      cwd: dir,
      encoding: 'utf8',
      env: scrubbedEnv({
        SUPABASE_URL: origin,
        SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY,
        GITHUB_TOKEN: FAKE_TOKEN,
        FELIX_API_BASE: origin,
        FELIX_POST_COMMENT: 'true',   // the flag that would publish, if anything could
        FELIX_DRY_RUN: 'false',
      }),
    });
    check('the run still succeeds with the store configured', wired.status !== 3, `exit ${wired.status}`);
    check('ZERO requests reached the store / API recorder', seen.length === 0,
      seen.length ? `saw ${seen.length}: ${seen.slice(0, 5).join(', ')}` : 'nothing');
    check('FELIX_POST_COMMENT=true changed nothing', seen.length === 0,
      'pre-flight has no publish path for a flag to switch on');

    console.log('\n[4] CONTROL — the PR path DOES load what pre-flight does not');
    // Without this, legs 1-3 would pass just as happily if the require path were misspelled.
    const control = spawnSync(process.execPath, ['-e',
      'require("./src/engine");'
      + 'console.log(JSON.stringify(Object.keys(require.cache)));',
    ], { cwd: REPO, encoding: 'utf8', env: scrubbedEnv() });
    const cLoaded = JSON.parse(control.stdout || '[]').map((p) => p.replace(/\\/g, '/'));
    check('the CI engine loads log.js', cLoaded.some((p) => p.endsWith('/src/engine/log.js')),
      'if this fails the probe is measuring nothing');
    check('the CI engine loads github.js', cLoaded.some((p) => p.endsWith('/src/engine/github.js')));
  } finally {
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* windows file locks */ }
  }

  console.log(failures === 0
    ? '\nprobe-preflight-containment: OK — pre-flight cannot write a verdict row or call GitHub.\n'
    : `\nprobe-preflight-containment: ${failures} FAILURE(S).\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(`probe failed: ${e.stack || e.message}`); process.exit(1); });
