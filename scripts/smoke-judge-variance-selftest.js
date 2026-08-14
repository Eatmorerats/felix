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
const {
  clopperPearsonUpper, binomCdfAtMost, rollsForBound, atLeastOne, power, resolveJudgeEnv,
} = require('./smoke-judge-variance');

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
const cp = clopperPearsonUpper;
check('CP upper at 0/20 is 13.9%, not 0 — the rule-of-three neighbourhood',
  near(cp(0, 20), 0.13911), cp(0, 20).toFixed(5));
check('CP upper at 0/200 is 1.49%', near(cp(0, 200), 0.01487), cp(0, 200).toFixed(5));
check('CP upper at 0/600 is 0.498% — the number the cap argument rests on',
  near(cp(0, 600), 0.00498, 5e-5), cp(0, 600).toFixed(5));
check('it tightens monotonically with k',
  cp(0, 20) > cp(0, 50) && cp(0, 50) > cp(0, 200) && cp(0, 200) > cp(0, 600));
check('CP upper at 100/600 is 19.4%', near(cp(100, 600), 0.19374), cp(100, 600).toFixed(5));
check('and always sits above the point estimate', cp(100, 600) > 100 / 600);
// The DEFINING property, checked against the binomial directly rather than against a memorised
// constant: at the returned p, the chance of seeing this few events is exactly alpha. A bound of
// the wrong shape can match a hand-copied percentage; it cannot satisfy its own defining equation.
check('the returned bound solves P(X ≤ x; n, p) = 0.05 by definition',
  near(binomCdfAtMost(100, 600, cp(100, 600)), 0.05, 1e-6),
  binomCdfAtMost(100, 600, cp(100, 600)).toFixed(6));
check('and the zero-event closed form agrees with the general solve',
  near(binomCdfAtMost(0, 600, cp(0, 600)), 0.05, 1e-9));
// The trap the estimator swap exists to close. Wilson at zero events degenerates to ≈ z²/n =
// 3.84/n, which is LOOSER than the exact test — and the old script prescribed k from 3/p while
// grading with that, so its own prescribed k could not pass. Pinned as an inequality so nobody
// reintroduces a normal approximation and calls it exact.
check('CP at zero events is TIGHTER than the Wilson value it replaced (0.637% at k=600)',
  cp(0, 600) < 0.00637, `${(cp(0, 600) * 100).toFixed(3)}% < 0.637%`);
check('…and LOOSER than the anti-conservative one-sided-z Wilson (0.449%) — the wrong fix',
  cp(0, 600) > 0.00449, `${(cp(0, 600) * 100).toFixed(3)}% > 0.449%`);
check('atLeastOne(0.15, 10) = 80.3%', near(atLeastOne(0.15, 10), 0.80313), atLeastOne(0.15, 10).toFixed(5));
check('atLeastOne(p, 1) is p', near(atLeastOne(0.15, 1), 0.15));
check('atLeastOne(0, n) is 0', atLeastOne(0, 10) === 0);
check('atLeastOne rises with rolls', atLeastOne(0.05, 20) > atLeastOne(0.05, 10));
// The inversion that turns "cap of 10" into "per-roll rate you must be under".
const p10 = power({ capRolls: 10 });
check('a cap of 10 needs p below 0.51% if rolls are independent', near(p10.perRoll, 0.00512), p10.perRoll.toFixed(5));
check('which round-trips: 10 rolls at that rate is exactly the 5% target',
  near(atLeastOne(p10.perRoll, 10), 0.05));
check('and below 0.500% under the union bound, which assumes nothing', p10.perRollUnion === 0.005);
check('the union bar is the STRICTER of the two', p10.perRollUnion < p10.perRoll);
check('demonstrating the union bar takes 598 rolls', p10.rollsNeeded === 598, `${p10.rollsNeeded}`);
check('the independence bar takes 585', p10.rollsNeededCompound === 585, `${p10.rollsNeededCompound}`);
check('and the prescribed k is the larger, so a run at it clears BOTH',
  p10.rollsNeeded >= p10.rollsNeededCompound);
// THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. The old script prescribed k by the rule
// of three (587) and then graded with Wilson, which at 587 rolls bounds p at 0.654% — above the
// 0.512% bar it had just quoted. Prescription and grading must invert the SAME estimator, so the
// prescribed k is checked by RUNNING the estimator, and k-1 must fail.
check('a clean sweep at the prescribed k actually clears the union bar',
  cp(0, p10.rollsNeeded) <= p10.perRollUnion,
  `${(cp(0, p10.rollsNeeded) * 100).toFixed(4)}% ≤ 0.5000%`);
check('and one roll fewer does NOT — the inversion is tight, not merely safe',
  cp(0, p10.rollsNeeded - 1) > p10.perRollUnion,
  `${(cp(0, p10.rollsNeeded - 1) * 100).toFixed(4)}% > 0.5000%`);
check('same round-trip for the independence bar', cp(0, p10.rollsNeededCompound) <= p10.perRoll
  && cp(0, p10.rollsNeededCompound - 1) > p10.perRoll);
check('rollsForBound inverts CP at other rates too, and stays tight',
  [0.001, 0.01, 0.05, 0.2].every((pMax) => cp(0, rollsForBound(pMax)) <= pMax
    && cp(0, rollsForBound(pMax) - 1) > pMax));
check('a SMALLER cap tolerates a HIGHER per-roll rate', power({ capRolls: 3 }).perRoll > p10.perRoll);
check('and therefore needs fewer rolls', power({ capRolls: 3 }).rollsNeeded < p10.rollsNeeded);
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
  /Note before you do/.test(planned.out) && /below 0\.5000%/.test(planned.out) && /~598 rolls/.test(planned.out));
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
// The record's grader fields come from the judge's own bench, never from FELIX_JUDGE_FAMILY /
// FELIX_JUDGE_MODEL. The env string names what was ASKED FOR, and a declared vendor with no key is
// skipped at construction — which is how a solo openai run got recorded as a 2-vendor jury. Pinned
// here on the synthetic leg (the only one that can be exercised without spending), with the live
// bench shape pinned offline in test/run.js.
check('the grader is recorded from the judge\'s bench, not the env',
  h.family === 'synthetic' && h.model === 'self-test', `${h.family} / ${h.model}`);
check('and the record carries requested/active/skipped so a missing seat is visible',
  Array.isArray(h.seats.requested) && Array.isArray(h.seats.skipped)
  && h.seats.active.length === 1 && h.seats.active[0].family === 'synthetic');
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
// has not earned; an exact bound does not. ~3/200 is the rule-of-three sanity check.
check('but the upper bound is NOT zero', c.pUpper95 > 0.005, `≤ ${(c.pUpper95 * 100).toFixed(1)}%`);
check('and it is in the right neighbourhood of 3/k', c.pUpper95 > 0.01 && c.pUpper95 < 0.05, `${(c.pUpper95 * 100).toFixed(2)}% vs 1.50%`);
check('the report REFUSES to read zero as safety', /NOT evidence the cap can be loosened/.test(cold.out));
check('it names the k a real conclusion needs', c.powerNeeded.rollsNeeded > 400, `${c.powerNeeded.rollsNeeded} rolls`);
check('and the per-roll rate that would defend a cap of 10', c.powerNeeded.perRoll > 0 && c.powerNeeded.perRoll < 0.01);
check('the report shows BOTH bars and marks this run as failing them',
  /union bound/.test(cold.out) && /✗ FAILS/.test(cold.out));

console.log('\n[3b] …but a clean sweep at the PRESCRIBED k does license keeping the cap');
// The defect this estimator swap fixes, end to end. The old script prescribed a k (587 by the rule
// of three) and then graded it with Wilson, which that k could never satisfy — so a clean sweep at
// the k the script itself asked for still printed "10 is UNMEASURED". Prescription and grading now
// invert the same estimator, so the prescribed k passes BY CONSTRUCTION. Asserted at exactly
// `powerNeeded.rollsNeeded` rather than a hard-coded 598, so the two can never drift apart again.
const swept = run(['--self-test', '0', '--k', String(c.powerNeeded.rollsNeeded), '--json']);
const s = json(swept.out);
check('a full-power clean sweep still observes zero', s.greens === 0 && s.valid === s.k);
check('and the bound now clears the union bar', s.pUpper95 * 10 <= 0.05,
  `10 × ${(s.pUpper95 * 100).toFixed(4)}% = ${(s.pUpper95 * 1000).toFixed(3)}% ≤ 5%`);
check('the report says so — KEEPING the cap is licensed', /licenses KEEPING maxJudgeRuns at 10/.test(swept.out));
check('and it says KEEPING, never RAISING — the scope limit is in the output',
  /does NOT/.test(swept.out) && /license RAISING it/.test(swept.out));
check('it no longer calls a prescribed-k clean sweep unmeasured', !/is UNMEASURED/.test(swept.out));

console.log('\n[3c] a CONTESTED fixture is refused, in both directions');
// The misreading this guard exists for: point the script at a case where every criterion is
// defensibly met and it would report the judge AGREEING with a reasonable reader as a "false-green
// rate" — then its own branch prescribes cutting maxJudgeRuns from a number about nothing. The
// mirror error is quieter: a stable refusal on a contested case trips the licence line and blesses
// keeping the cap. Both are checked, because only fixing the loud one is how the quiet one ships.
const hotContested = run(['--case', 'contested', '--self-test', '0.4', '--k', '40', '--json']);
const hc = json(hotContested.out);
check('the run completed', hotContested.status === 0, `exit ${hotContested.status}`);
check('ground truth is derived, not assumed', hc.groundTruth === 'contested', hc.groundTruth);
check('and it is stated in the header', /truth\s+CONTESTED/.test(hotContested.out));
check('the false-green section REFUSES to print', /REFUSED\. This fixture cannot support/.test(hotContested.out));
check('and never calls the number a false-green rate', /That is NOT a false-green rate/.test(hotContested.out));
check('greens WERE observed, so this is a refusal and not an empty run', hc.greens > 0, `${hc.greens} of ${hc.valid}`);
check('the cap-cutting branch never fires', !/ALREADY TOO GENEROUS/.test(hotContested.out));
check('nor does the licence branch', !/licenses KEEPING/.test(hotContested.out));
check('the licence section refuses in BOTH directions', /NOTHING ABOUT THE CAP, in either direction/.test(hotContested.out));
// NULL, not renamed. A renamed percentage in the same slot gets quoted as the old one.
check('pHat is null on the record, not merely renamed', hc.pHat === null && hc.pUpper95 === null);
check('capRisk is null', hc.capRisk === null);
check('the observed rate survives under a name that says only what it is',
  hc.pVerified > 0 && hc.pVerifiedUpper95 > hc.pVerified, `pVerified = ${(hc.pVerified * 100).toFixed(1)}%`);
// The label-free half must be UNAFFECTED — the guard gates the cap argument, not the variance stats.
check('per-criterion variance still reported — the guard gates conclusions, not measurement',
  hc.perCriterion.length === 3 && hc.perCriterion.some((c) => c.flips > 0));
check('and the decisive case is untouched by any of this',
  c.groundTruth === 'decisive-unmet' && c.pHat === 0 && c.capRisk !== null);
// A clean sweep on a contested case must ALSO refuse — the quiet direction.
const coldContested = run(['--case', 'contested', '--self-test', '0', '--k', '598', '--json']);
check('a full-power CLEAN sweep on a contested case licenses nothing either',
  !/licenses KEEPING/.test(coldContested.out) && /NOTHING ABOUT THE CAP/.test(coldContested.out));
check('…even though the same k on the decisive case does license keeping',
  /licenses KEEPING/.test(swept.out));
// And the selector itself: a typo must not silently roll a different case.
const badCase = run(['--case', 'borderline']);
check('an unknown --case exits 1 rather than falling back to the default', badCase.status === 1, `exit ${badCase.status}`);
check('and names what exists', /Known cases: decisive, contested/.test(badCase.out));

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
