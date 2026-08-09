#!/usr/bin/env node
/**
 * smoke-preflight.js — drive runPreflight() end to end over a fixture repo.
 *
 * The unit tests cover the pure decisions. They cannot cover the CALL SITES: a test that asserts
 * buildSpec's behaviour still passes if preflight stops passing it an empty title, and a test that
 * asserts judgeGuard's table still passes if preflight stops consulting it. Those are the
 * mutations that matter here, because each one is a spend or a laundering path, so this exercises
 * the real function and asserts what it actually did.
 *
 * The judge is injected. It is the one step that costs money and touches the network, so without
 * a seam the whole eligibility conjunction is unreachable from a test — which is how a clause gets
 * dropped and nobody notices.
 *
 *   node scripts/smoke-preflight.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runPreflight } = require('../src/engine/preflight');

let failures = 0;
const ok = (name, detail = '') => console.log(`  ✓ PASS  ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail) => { failures++; console.log(`  ✗ FAIL  ${name} — ${detail}`); };
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'assertion false'));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const NOOP = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(1)"';

const CRITERIA = '## Acceptance criteria\n\n- [ ] the module exports a greeting\n- [ ] the greeting is not empty\n';

/** A repo whose install/test commands are whatever the scenario needs. */
function makeRepo({ test = NOOP, install = NOOP, criteria = CRITERIA } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-smoke-pf-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'smoke@felix.invalid']);
  git(dir, ['config', 'user.name', 'Smoke']);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', private: true }, null, 2));
  fs.writeFileSync(path.join(dir, 'felix.config.json'), JSON.stringify({ commands: { install, test } }, null, 2));
  if (criteria !== null) {
    fs.mkdirSync(path.join(dir, '.felix'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.felix', 'preflight-criteria.md'), criteria);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = () => "hello";\n');
  return dir;
}

/** A judge that records every call and returns whatever ruling the scenario wants. */
function fakeJudge(ruling) {
  const calls = [];
  const factory = () => async (args) => { calls.push(args); return ruling; };
  factory.calls = calls;
  return factory;
}

const ENV = { OPENAI_API_KEY: 'smoke-' + 'not-a-real-' + 'key' }; // split: see probe-preflight-containment.js
const dirs = [];
const repo = (o) => { const d = makeRepo(o); dirs.push(d); return d; };

(async () => {
  console.log('\nsmoke-preflight — runPreflight end to end\n');

  try {
    console.log('[1] the judge is not called unless it is asked for');
    let judge = fakeJudge({ criteria: [] });
    let r = await runPreflight({ repoPath: repo(), env: ENV, deps: { createJudge: judge } });
    check('no judge call without --judge', judge.calls.length === 0, `${judge.calls.length} call(s)`);
    check('the result says so', r.judge.requested === false && r.judge.attempted === false);
    check('the verdict is INSUFFICIENT, not a free green', r.verdict === 'INSUFFICIENT EVIDENCE', `${r.verdict} (${r.cause})`);
    check('and it is TERMINAL — iterating cannot grade the criteria', r.retryable === false);

    console.log('\n[2] with --judge, a met ruling verifies');
    judge = fakeJudge({
      family: 'openai',
      model: 'smoke',
      criteria: [{ text: 'the module exports a greeting', met: true }, { text: 'the greeting is not empty', met: true }],
    });
    r = await runPreflight({ repoPath: repo(), env: ENV, judge: true, deps: { createJudge: judge } });
    check('the judge was called exactly once', judge.calls.length === 1, `${judge.calls.length} call(s)`);
    check('it was handed the real criteria', (judge.calls[0] || {}).criteria.length === 2);
    check('it was handed a real diff', /index\.js/.test((judge.calls[0] || {}).diff || ''));
    check('verdict VERIFIED', r.verdict === 'VERIFIED', `${r.verdict} (${r.cause})`);

    console.log('\n[3] an unmet criterion is NOT VERIFIED and IS retryable');
    judge = fakeJudge({
      family: 'openai',
      model: 'smoke',
      criteria: [{ text: 'the module exports a greeting', met: true }, { text: 'the greeting is not empty', met: false, reason: 'returns undefined' }],
    });
    r = await runPreflight({ repoPath: repo(), env: ENV, judge: true, deps: { createJudge: judge } });
    check('verdict NOT VERIFIED / criteria_unmet', r.verdict === 'NOT VERIFIED' && r.cause === 'criteria_unmet', `${r.verdict} (${r.cause})`);
    check('retryable — this is the loop\'s job', r.retryable === true);
    check('the unmet criterion is named', r.required_to_pass.some((s) => /returns undefined/.test(s)));

    console.log('\n[4] a broken install is retryable; the judge is never reached');
    judge = fakeJudge({ criteria: [] });
    r = await runPreflight({ repoPath: repo({ install: FAIL }), env: ENV, judge: true, deps: { createJudge: judge } });
    check('cause install_failed', r.cause === 'install_failed', `${r.verdict} (${r.cause})`);
    check('retryable', r.retryable === true);
    check('no judge spend on code that never ran', judge.calls.length === 0, `${judge.calls.length} call(s)`);

    console.log('\n[5] no criteria file is TERMINAL, and the judge is never reached');
    judge = fakeJudge({ criteria: [] });
    r = await runPreflight({ repoPath: repo({ criteria: null }), env: ENV, judge: true, deps: { createJudge: judge } });
    check('cause no_spec', r.cause === 'no_spec', `${r.verdict} (${r.cause})`);
    check('NOT retryable — a loop must never author the rubric', r.retryable === false);
    check('no judge spend with nothing to grade', judge.calls.length === 0);
    check('no fingerprint is pinned', r.fingerprint === null);
    check('a branch name did not become a spec', r.spec.hadRealSpec === false);

    console.log('\n[6] an unchanged tree is not judged twice');
    const d = repo();
    judge = fakeJudge({ family: 'openai', model: 'smoke', criteria: [{ text: 'the module exports a greeting', met: true }, { text: 'the greeting is not empty', met: true }] });
    const first = await runPreflight({ repoPath: d, env: ENV, judge: true, deps: { createJudge: judge } });
    const second = await runPreflight({ repoPath: d, env: ENV, judge: true, deps: { createJudge: judge } });
    check('the first run judged', first.judge.attempted === true);
    check('the second run did NOT', second.judge.attempted === false);
    check('exactly one judge call across both', judge.calls.length === 1, `${judge.calls.length} call(s)`);
    check('and it says why, in words', /identical to the last graded run/.test((second.judge.guard || {}).reason || ''),
      (second.judge.guard || {}).reason || '(no reason)');

    console.log('\n[7] changing the tree makes it judgeable again');
    fs.writeFileSync(path.join(d, 'index.js'), 'module.exports = () => "hello world";\n');
    const third = await runPreflight({ repoPath: d, env: ENV, judge: true, deps: { createJudge: judge } });
    check('the third run judged', third.judge.attempted === true);
    check('two judge calls in total', judge.calls.length === 2, `${judge.calls.length} call(s)`);

    console.log('\n[8] nothing was published, and no state escaped the repo');
    check('the result carries no comment or check-run handle',
      !('comment' in third) && !('checkRun' in third),
      'pre-flight has no publish path at all');
    // Scratch state must live OUTSIDE the repo. Anything pre-flight writes inside it becomes an
    // untracked file that `git add -A` folds into the NEXT snapshot — which is exactly the bug
    // this scenario caught: the tree was never byte-identical twice, so [6] could never pass.
    check('no scratch state was written into the repo',
      !fs.existsSync(path.join(d, '.felix-worktrees')),
      'writing scratch inside the repo feeds Felix\'s output back into its input');
    check('the repo has no new untracked files beyond the edit under test',
      git(d, ['ls-files', '--others', '--exclude-standard']) === 'index.js',
      git(d, ['ls-files', '--others', '--exclude-standard']).replace(/\n/g, ', '));
    check('the working tree is still dirty and uncommitted',
      git(d, ['status', '--porcelain']).includes('index.js'));
    check('HEAD is still the single base commit', git(d, ['rev-list', '--count', 'HEAD']) === '1');
  } finally {
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* windows locks */ } }
  }

  console.log(failures === 0
    ? '\nsmoke-preflight: OK — the loop contract holds end to end.\n'
    : `\nsmoke-preflight: ${failures} FAILURE(S).\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(`smoke failed: ${e.stack || e.message}`); process.exit(1); });
