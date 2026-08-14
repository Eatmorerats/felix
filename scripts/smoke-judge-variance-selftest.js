#!/usr/bin/env node
/**
 * smoke-judge-variance-selftest.js — prove smoke-judge-variance.js's ARITHMETIC, offline.
 *
 * The variance script's output is a set of confident-looking percentages, and percentages are the
 * easiest thing in this repo to get quietly wrong: a sign error in a Wilson bound still prints
 * something plausible, and the reader has no way to tell. So the statistics are driven against a
 * seeded judge whose flip rate WE chose, and the report has to recover it.
 *
 * The other half is the money guard. The variance script spends real money on every roll, and its
 * default must be to spend none. That is asserted by a CONTROL: with no judge key in the
 * environment, `--spend` fails at seat construction while the default exits clean — which is only
 * possible if the default returns before the judge is ever built. Without the control leg the
 * "spends nothing" assertion would pass on a script that silently did nothing at all.
 *
 * Calls no vendor. Spends nothing. Safe in CI.
 *
 *   node scripts/smoke-judge-variance-selftest.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { wilsonUpper, atLeastOne, power, resolveJudgeEnv } = require('./smoke-judge-variance');

let failures = 0;
const ok = (name, detail = '') => console.log(`  ✓ PASS  ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail) => { failures++; console.log(`  ✗ FAIL  ${name} — ${detail}`); };
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'assertion false'));

const SCRIPT = path.join(__dirname, 'smoke-judge-variance.js');

/**
 * Run the script with the judge keys stripped from the environment.
 *
 * Stripping them is what makes the control leg below mean anything, and it also stops a developer
 * who happens to have OPENAI_API_KEY exported from turning a self-test into a surprise bill.
 */
function run(args) {
  const env = { ...process.env };
  // Two layers, and BOTH are load-bearing.
  //
  // FELIX_NO_DOTENV is the one that actually holds: deleting keys from the child's environment does
  // nothing about a .env file on disk, which dotenv reloads inside the child. Without this the
  // control leg below passed for the wrong reason and this suite made a live billed call on every
  // run. That is not hypothetical — it happened the first time a real key was installed.
  env.FELIX_NO_DOTENV = '1';
  // Belt to that suspenders: strip every judge key the shell might already export, including the
  // _VARIANCE and _PREFLIGHT variants resolveJudgeEnv prefers.
  for (const base of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    delete env[base];
    delete env[`${base}_VARIANCE`];
    delete env[`${base}_PREFLIGHT`];
  }
  for (const k of ['FELIX_JUDGE_FAMILY', 'FELIX_JUDGE_MODEL']) delete env[k];
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The script prints a report and then the JSON; anchor on the column-zero brace. */
const json = (out) => JSON.parse(out.slice(out.lastIndexOf('\n{\n') + 1));

console.log('\nsmoke-judge-variance-selftest — the maths, and the money guard\n');

console.log('[0] the statistics, pinned against known values');
// Direct, not inferred through the report. A bound of the wrong SHAPE still satisfies every
// ordering assertion further down while printing a wrong percentage, so the numbers are named.
const near = (a, b, tol = 5e-4) => Math.abs(a - b) < tol;
check('Wilson upper at 0/20 is 16.1%, not 0 — the rule-of-three neighbourhood',
  near(wilsonUpper(0, 20), 0.16116), wilsonUpper(0, 20).toFixed(5));
check('Wilson upper at 0/200 is 1.9%', near(wilsonUpper(0, 200), 0.01885), wilsonUpper(0, 200).toFixed(5));
check('Wilson upper at 0/600 is 0.6%', near(wilsonUpper(0, 600), 0.00637), wilsonUpper(0, 600).toFixed(5));
check('it tightens monotonically with k',
  wilsonUpper(0, 20) > wilsonUpper(0, 50) && wilsonUpper(0, 50) > wilsonUpper(0, 200) && wilsonUpper(0, 200) > wilsonUpper(0, 600));
check('Wilson upper at 100/600 is 20.0%', near(wilsonUpper(100, 600), 0.19870), wilsonUpper(100, 600).toFixed(5));
check('and always sits above the point estimate', wilsonUpper(100, 600) > 100 / 600);
check('atLeastOne(0.15, 10) = 80.3%', near(atLeastOne(0.15, 10), 0.80313), atLeastOne(0.15, 10).toFixed(5));
check('atLeastOne(p, 1) is p', near(atLeastOne(0.15, 1), 0.15));
check('atLeastOne(0, n) is 0', atLeastOne(0, 10) === 0);
check('atLeastOne rises with rolls', atLeastOne(0.05, 20) > atLeastOne(0.05, 10));
// The inversion that turns "cap of 10" into "per-roll rate you must be under".
const p10 = power({ capRolls: 10 });
check('a cap of 10 needs p below 0.51%', near(p10.perRoll, 0.00512), p10.perRoll.toFixed(5));
check('which round-trips: 10 rolls at that rate is exactly the 5% target',
  near(atLeastOne(p10.perRoll, 10), 0.05));
check('and demonstrating it takes ~587 rolls', p10.rollsNeeded === 587, `${p10.rollsNeeded}`);
check('a SMALLER cap tolerates a HIGHER per-roll rate', power({ capRolls: 3 }).perRoll > p10.perRoll);
assert.ok(true);

console.log('\n[0b] which wallet a run spends from');
// ~600 billed calls in one sitting. Charging that to the key CI grades PRs with would let one
// measurement exhaust the budget every future PR depends on.
const dedicated = resolveJudgeEnv({ OPENAI_API_KEY: 'ci', OPENAI_API_KEY_VARIANCE: 'mine' }, ['openai']);
check('a dedicated variance key wins', dedicated.judgeEnv.OPENAI_API_KEY === 'mine');
check('and it does not warn', dedicated.warnings.length === 0);
const preflight = resolveJudgeEnv({ OPENAI_API_KEY: 'ci', OPENAI_API_KEY_PREFLIGHT: 'local' }, ['openai']);
check('the pre-flight key is the next choice', preflight.judgeEnv.OPENAI_API_KEY === 'local');
const shared = resolveJudgeEnv({ OPENAI_API_KEY: 'ci' }, ['openai']);
check("CI's key still WORKS — refusing would be worse", shared.judgeEnv.OPENAI_API_KEY === 'ci');
check('…but never quietly', shared.warnings.length === 1 && /SHARED KEY/.test(shared.warnings[0]));
check('it names the fix, not just the problem', /OPENAI_API_KEY_VARIANCE/.test(shared.warnings[0]));
check('the same rule applies per family, not just to openai',
  resolveJudgeEnv({ GEMINI_API_KEY: 'ci', GEMINI_API_KEY_VARIANCE: 'mine' }, ['gemini']).judgeEnv.GEMINI_API_KEY === 'mine');
check('an unkeyed family warns about nothing', resolveJudgeEnv({}, ['openai']).warnings.length === 0);

console.log('\n[1] the default spends NOTHING, and the control proves the money path was not reached');
const planned = run([]);
check('the default exits clean', planned.status === 0, `exit ${planned.status}`);
check('and says it called nothing', /Nothing was called/.test(planned.out));
check('it still measures the prompt and prices the run', /tokens \(\d+ chars\), measured/.test(planned.out));
check('it warns that k=20 is under-powered BEFORE any money is spent',
  /proves much less than it looks like/.test(planned.out));
check('and the plan quotes the rate and the k a real conclusion needs',
  /Note before you do/.test(planned.out) && /below 0\.5%/.test(planned.out) && /~587 rolls/.test(planned.out));
// CONTROL. Without this the assertion above passes on a script that does nothing at all: this
// proves the judge WOULD have been constructed on the spend path, and that the default returns first.
const spendNoKey = run(['--spend', '--k', '1']);
check('CONTROL — --spend with no key fails at seat construction', spendNoKey.status === 1, `exit ${spendNoKey.status}`);
check('CONTROL — and says why', /no judge seat is keyed/.test(spendNoKey.out));

console.log('\n[2] a seeded 15% flip rate is recovered by the report');
const hot = run(['--self-test', '0.15', '--k', '600', '--json']);
const h = json(hot.out);
check('the run completed', hot.status === 0, `exit ${hot.status}`);
check('it is stamped synthetic in the record', h.synthetic === true && h.syntheticRate === 0.15);
check('and stamped synthetic in the human report', /SELF-TEST\. No vendor is called/.test(hot.out));
check('the recovered rate is within sampling noise of 15%', Math.abs(h.pHat - 0.15) < 0.04, `p̂ = ${(h.pHat * 100).toFixed(1)}%`);
check('the 95% upper bound sits ABOVE the point estimate', h.pUpper95 > h.pHat, `${h.pUpper95.toFixed(3)} > ${h.pHat.toFixed(3)}`);
check('the clearly-met criteria never flipped',
  h.perCriterion.filter((c) => c.expected === 'met').every((c) => c.flips === 0));
check('the arguable criterion DID flip — the per-criterion stat is live',
  h.perCriterion.find((c) => c.expected === 'arguable').flips > 0);
check('a 10-roll cap is reported as losing at this rate', h.capRisk.rolls10 > 0.5, `${(h.capRisk.rolls10 * 100).toFixed(1)}%`);
check('and the verdict says so in words', /10 is ALREADY TOO GENEROUS/.test(hot.out));

console.log('\n[3] a seeded 0% rate does NOT license loosening the cap — the trap this script exists for');
const cold = run(['--self-test', '0', '--k', '200', '--json']);
const c = json(cold.out);
check('zero false greens observed', c.greens === 0 && c.pHat === 0);
// The whole point. A naive `p̂ ± z·√(p̂(1-p̂)/n)` collapses to 0 ± 0 here and reports certainty it
// has not earned; the Wilson bound does not. ~3/200 is the rule-of-three sanity check.
check('but the upper bound is NOT zero', c.pUpper95 > 0.005, `≤ ${(c.pUpper95 * 100).toFixed(1)}%`);
check('and it is in the right neighbourhood of 3/k', c.pUpper95 > 0.01 && c.pUpper95 < 0.05, `${(c.pUpper95 * 100).toFixed(1)}% vs 1.5%`);
check('the report REFUSES to read zero as safety', /NOT evidence the cap can be loosened/.test(cold.out));
check('it names the k a real conclusion needs', c.powerNeeded.rollsNeeded > 400, `${c.powerNeeded.rollsNeeded} rolls`);
check('and the per-roll rate that would defend a cap of 10', c.powerNeeded.perRoll > 0 && c.powerNeeded.perRoll < 0.01);

console.log('\n[4] a vendor that FAILED is not a vendor that voted');
// Folding errors into the denominator would understate the false-green rate — the one direction
// this script must never be wrong in, since the whole output is an argument about a safety cap.
const flaky = json(run(['--self-test', '0.15', '--k', '600', '--self-test-error-every', '5', '--json']).out);
check('the errored rolls were counted as errors', flaky.errors === 120, `${flaky.errors} of 600`);
check('and excluded from the vote count', flaky.valid === 480, `${flaky.valid}`);
check('valid + errors accounts for every roll', flaky.valid + flaky.errors === flaky.k);
check('the rate is still recovered from the survivors', Math.abs(flaky.pHat - 0.15) < 0.04,
  `p̂ = ${(flaky.pHat * 100).toFixed(1)}%`);

console.log('\n[5] a truthy non-boolean `met` is NOT met');
// Mirrors the load-bearing `met !== true` rule in verdict.js. The seeded judge returns the STRING
// "false" on every 7th non-green roll; counting that as met would manufacture false greens and
// this script would then report them as judge variance.
// An EXACT identity, not a threshold: the unmet criterion is met on green rolls and on nothing
// else, so its met-count must equal the green count to the unit. A `met !== false` tally counts
// the string "false" as met and the two numbers diverge by exactly the drift rate — a threshold
// loose enough to tolerate sampling noise is loose enough to let that through, and did.
const unmetRow = h.perCriterion.find((c) => c.expected === 'unmet');
check('the unmet criterion is met on green rolls and NOTHING else',
  unmetRow.met === h.greens, `${unmetRow.met} met vs ${h.greens} green`);
check('so schema drift never became a false green', Math.abs(h.pHat - 0.15) < 0.04,
  `p̂ = ${(h.pHat * 100).toFixed(1)}% — a "met !== false" tally would read ~12 points higher`);
check('and every roll is accounted for in the criterion tally', unmetRow.met + unmetRow.unmet === h.valid);

console.log('\n[6] more rolls buy a tighter bound — the power claim is not decorative');
const fewer = json(run(['--self-test', '0', '--k', '50', '--json']).out);
check('50 rolls bound p less tightly than 200', fewer.pUpper95 > c.pUpper95,
  `${(fewer.pUpper95 * 100).toFixed(1)}% vs ${(c.pUpper95 * 100).toFixed(1)}%`);
check('and 50 rolls still cannot defend a cap of 10',
  1 - (1 - fewer.pUpper95) ** 10 > 0.05, 'the upper bound still permits a likely false green');

console.log(failures === 0
  ? '\nsmoke-judge-variance-selftest: OK — the arithmetic holds and the default spends nothing.\n'
  : `\nsmoke-judge-variance-selftest: ${failures} FAILURE(S).\n`);
process.exit(failures === 0 ? 0 : 1);
