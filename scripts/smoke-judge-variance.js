#!/usr/bin/env node
/**
 * smoke-judge-variance.js — how often does the judge give the SAME input a DIFFERENT answer?
 *
 * WHY THIS EXISTS. `judge.maxJudgeRuns` defaults to 10, and that number is arithmetic, not
 * measurement. The reasoning behind it is in verdict.js: the judge is not deterministic, so
 * re-running an unchanged diff is a resampling attack — "at a 10% per-run false-pass rate, seven
 * rolls win more often than not". Every part of that sentence is load-bearing except the 10%,
 * which nobody has ever observed. This script observes it.
 *
 * It re-rolls ONE frozen diff + spec (test/fixtures/judge-variance-case.js) k times through the
 * REAL judge, at whatever seat FELIX_JUDGE_FAMILY names, and reports how much the answer moved.
 * Both shipped providers already send `temperature: 0`, so this measures production config, not a
 * hypothetical — temp 0 bounds the sampler, it does not make a vendor's kernels deterministic.
 *
 * ── THE TRAP THIS SCRIPT IS BUILT AROUND ─────────────────────────────────────────────────────
 *
 * The tempting result is "20 rolls, zero flips, therefore the judge is deterministic, therefore
 * the cap can be loosened." That inference is wrong, and it is wrong by a wide margin. Zero events
 * in 20 trials puts the 95% upper bound on the per-roll flip rate at roughly 3/20 — about 15%.
 * At 15%, ten rolls find a false green more often than not. A null result at k=20 is not evidence
 * of safety, it is an absence of evidence, and the report says so in those words every time rather
 * than leaving the reader to remember it. See `power()` below for the k a real conclusion needs.
 *
 * ── IT SPENDS REAL MONEY, SO IT DOES NOT SPEND BY DEFAULT ────────────────────────────────────
 *
 * Every roll is a live billed call on the pay-as-you-go key. Without `--spend` this prints the
 * plan — the measured prompt size, the call count, the cost estimate — and exits having called
 * nothing. That is the default because a measurement script that bills on a typo is a bad
 * measurement script. It is not part of `npm test` and must never be.
 *
 * It publishes nothing: no verdict row, no comment, no check run. It only builds a spec and calls
 * the judge.
 *
 * ── THE SELF-TEST, AND WHY IT IS NOT OPTIONAL ────────────────────────────────────────────────
 *
 * The deliverable of this script is not the rolls, it is the ARITHMETIC over them — and that is
 * the half that can be wrong while looking right. A confidence bound with a sign error still prints
 * a confident percentage. So `--self-test <rate>` replaces the vendor with a seeded synthetic judge
 * that flips at a rate we chose, and the report must recover it. Every line of a self-test report
 * is stamped SYNTHETIC and the JSON record carries `synthetic: true`, so a rehearsal can never be
 * filed as a measurement. `scripts/smoke-judge-variance-selftest.js` drives it and asserts.
 *
 *   node scripts/smoke-judge-variance.js                    # plan + cost, spends nothing
 *   node scripts/smoke-judge-variance.js --self-test 0.15   # rehearse the maths, calls nobody
 *   node scripts/smoke-judge-variance.js --spend            # 20 rolls, real money
 *   node scripts/smoke-judge-variance.js --spend --k 600    # a result with actual power
 *   node scripts/smoke-judge-variance.js --spend --out r.json --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Same as bin/felix.js: a key dropped in felix's own .env should just work, rather than needing
// to be exported into the shell before every run.
//
// FELIX_NO_DOTENV is the hermetic escape hatch, and it exists because of a real incident. The
// self-test proves "the default spends nothing" with a control leg — strip every judge key, then
// assert `--spend` dies at seat construction. Stripping process.env is not enough once a .env
// exists on disk: dotenv reloads the key underneath the test, the control leg passes for the wrong
// reason, and the suite makes a LIVE BILLED CALL every time it runs. That happened. An explicit
// flag is used rather than relying on dotenv's no-override semantics, because the guard has to
// survive a dependency bump — it is the thing standing between `npm test` and a bill.
if (!/^(1|true|yes|on)$/i.test(process.env.FELIX_NO_DOTENV || '')) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
}

const { createJudge, buildPrompt } = require('../src/engine/judge');
const { estimateTokens, paceMs, promptBudgetTokens } = require('../src/engine/budget');
const { PROVIDERS } = require('../src/engine/providers');
const { buildSpec, criteriaCapChars } = require('../src/engine/spec');
const { compose, VERDICTS } = require('../src/engine/verdict');
/**
 * The frozen cases this script can roll, by `--case` name.
 *
 * A registry rather than a single require, because the record's `case` field is what tells a
 * future reader WHICH measuring stick a number came from. It used to be the hardcoded string
 * 'judge-variance-case' while the fixture itself was a hardcoded require — so pointing the script
 * at a different fixture (by editing one line, which is how a second case would arrive) produced a
 * record that named the wrong case. Two incomparable measurements filed under one name is the
 * quietest way to lose a measurement. The name is now derived from the same place the module is.
 */
const CASES = {
  decisive: '../test/fixtures/judge-variance-case',
  // Ground truth CONTESTED. Not a measuring stick — it is the negative control the ground-truth
  // refusal is tested against, and rolling it for real bounds nothing about the cap. See its header.
  contested: '../test/fixtures/judge-variance-contested-case',
  // CANDIDATES — not frozen. Subtle-but-unmet, the class an attacker would actually submit, and
  // the gap between the two cases above. Being calibrated; see their headers and `candidate: true`.
  'subtle-path': '../test/fixtures/judge-variance-subtle-path-case',
  'subtle-cache': '../test/fixtures/judge-variance-subtle-cache-case',
};
const DEFAULT_CASE = 'decisive';

// Rough, and labelled rough wherever it is printed. Vendor pricing moves; the TOKEN counts above
// it are measured and do not. Override with FELIX_VARIANCE_USD_PER_MTOK if yours differs.
const ASSUMED_USD_PER_MTOK = 2.0; // gpt-4.1 input, checked 2026-08
// Confidence level of every bound printed below: one-sided 95%. Distinct from the 5% CEILING on
// cap risk that `power()` takes as `target` — they are numerically equal and conceptually
// unrelated, and conflating them is exactly the kind of quiet error this file is written against.
const ALPHA = 0.05;

function parseArgs(argv) {
  const a = { k: 20, spend: false, json: false, out: null, selfTest: null, case: DEFAULT_CASE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case') a.case = String(argv[++i] || '').trim();
    else if (argv[i] === '--spend') a.spend = true;
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--k') a.k = Number(argv[++i]);
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--self-test') a.selfTest = Number(argv[++i]);
    else if (argv[i] === '--self-test-error-every') a.errorEvery = Number(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') a.help = true;
  }
  if (!(a.k > 0)) a.k = 20;
  if (!(a.selfTest >= 0 && a.selfTest <= 1)) a.selfTest = null;
  if (!(a.errorEvery > 1)) a.errorEvery = 0;
  return a;
}

/**
 * Resolve `--case` to a frozen fixture, or die naming what exists.
 *
 * Deliberately NOT tolerant of an unknown name. Silently falling back to the default would run the
 * decisive case while the operator believed they were rolling a different one, and the record would
 * agree with the script rather than with the operator — a wrong measurement that looks right is the
 * one outcome this whole file is arranged against.
 */
function loadCase(name) {
  if (!Object.prototype.hasOwnProperty.call(CASES, name)) {
    console.error(`unknown --case "${name}". Known cases: ${Object.keys(CASES).join(', ')}.`);
    process.exit(1);
  }
  return { name, module: CASES[name], data: require(CASES[name]) };
}

/**
 * A seeded synthetic judge for `--self-test`. Deterministic on purpose: a rehearsal whose numbers
 * move between runs cannot be asserted, and an assertion is the entire point of having one.
 *
 * It rules the fixture's `unmet` criterion MET with probability `rate` — i.e. it manufactures a
 * false green at exactly that rate — and rules everything as the fixture's `expected` labels say
 * otherwise. So the report's recovered `pHat` should converge on `rate`.
 */
function syntheticJudge(rate, criteria, CASE, { errorEvery = 0 } = {}) {
  let s = 0x2545f491; // fixed seed; xorshift32
  let roll = 0;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
  // `seats` mirrors what createJudge exposes, so the report reads the bench off the judge it was
  // handed and never branches on which kind it is. A synthetic run has no vendor, and saying that
  // in the same shape is what keeps a rehearsal from ever being labelled with a real seat.
  const fn = async () => {
    roll += 1;
    // A vendor that fails is not a vendor that voted. Exercised on demand so the "errors are
    // excluded from every rate" claim is a tested one rather than a comment.
    if (errorEvery && roll % errorEvery === 0) throw new Error('synthetic vendor failure');
    // Two INDEPENDENT draws, so both statistics under test are exercised: the verdict-level
    // false-green rate, and a per-criterion flip rate on the arguable one. Drawn before the map
    // so every criterion in a roll sees the same outcome.
    const green = next() < rate;
    const arguableFlips = next() < rate;
    return {
      family: 'synthetic',
      model: 'self-test',
      assessment: 'SYNTHETIC — no vendor was called.',
      criteria: criteria.map((c) => {
        const text = typeof c === 'string' ? c : c.text;
        const label = CASE.expected[text];
        // On a green roll EVERY criterion comes back met — that is what a false green is.
        const met = green ? true
          : label === 'unmet' ? false
          : label === 'arguable' ? !arguableFlips
          : true;
        // SCHEMA DRIFT, on purpose, on rolls that are NOT green. A truncated or schema-drifting
        // completion returns things like the STRING "false", which is truthy. verdict.js counts a
        // criterion met only on a literal `true` for exactly this reason, and the report's own
        // tally has to hold the same line — otherwise a drifting model manufactures false greens
        // this script would then report as judge variance. Every 7th roll carries one.
        if (!green && roll % 7 === 0 && label === 'unmet') {
          return { text, met: 'false', reason: 'synthetic: schema drift — a truthy non-boolean' };
        }
        return { text, met, reason: met ? 'synthetic' : 'synthetic: withheld by the rehearsal' };
      }),
    };
  };
  return Object.defineProperty(fn, 'seats', {
    value: Object.freeze({
      requested: Object.freeze(['synthetic']),
      active: Object.freeze([Object.freeze({ family: 'synthetic', model: 'self-test' })]),
      skipped: Object.freeze([]),
    }),
    enumerable: true,
  });
}

/**
 * P(X ≤ x) for X ~ Binomial(n, p). Summed in logs so the n=600 binomial coefficients cannot
 * overflow on the way to a probability that fits comfortably in a double.
 */
function binomCdfAtMost(x, n, p) {
  if (p <= 0) return 1;
  if (p >= 1) return x >= n ? 1 : 0;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let logC = 0; // log C(n,0) = 0, then stepped multiplicatively
  let sum = 0;
  for (let i = 0; i <= x; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    sum += Math.exp(logC + i * lp + (n - i) * lq);
  }
  return Math.min(1, sum);
}

/**
 * EXACT (Clopper-Pearson) one-sided upper bound on a proportion: the largest p for which observing
 * this few events would still not be surprising at level `alpha`. Solves `P(X ≤ x; n, p) = alpha`.
 *
 * Why exact rather than Wilson — and this file used to get it wrong, which is the whole reason the
 * comment is this long. Wilson is a normal APPROXIMATION, and at zero events it degenerates to
 * ≈ z²/n = 3.84/n, materially looser than the exact binomial test warrants (0.64% at k=600 where
 * the exact answer is 0.50%). That looseness is not "conservative and therefore harmless": the
 * script also PRESCRIBES a k, and it prescribed one by the rule of three (3/p) while GRADING with
 * Wilson (3.84/p). It told you to run 587 rolls to clear a bar that needs 748 — a k that could not
 * pass the test the same script would then apply. Both halves now invert the SAME estimator, so a
 * prescribed k passes by construction. See `rollsForBound`.
 *
 * Do NOT "fix" the old version by dropping Wilson's z to the one-sided 1.6449. At zero events that
 * goes ANTI-conservative — 0.449% at k=600, TIGHTER than the exact test allows — which is the one
 * direction a safety bound must never err in. The estimator was the defect, not the z.
 */
function clopperPearsonUpper(events, n, alpha = ALPHA) {
  if (!n) return 1;
  if (events >= n) return 1;
  // At zero events the general solve collapses to a closed form: P(X ≤ 0) = (1-p)^n = alpha.
  // Kept explicit because it is the case every conclusion in this file actually rests on, and a
  // bisection that quietly lost a bit of precision there would move a published number.
  if (events === 0) return 1 - alpha ** (1 / n);
  // The CDF is monotonically DECREASING in p, so bisect: too much mass at `mid` means p is too low.
  let lo = events / n;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdfAtMost(events, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return hi;
}

/** P(at least one green in `rolls` independent draws at rate `p`). */
const atLeastOne = (p, rolls) => 1 - (1 - p) ** rolls;

/**
 * Smallest k for which a CLEAN SWEEP (zero events in k) bounds the rate at or below `pMax`.
 *
 * This is `clopperPearsonUpper(0, k) ≤ pMax` inverted — the same estimator the report grades with,
 * which is the entire point. At zero events that is `1 - alpha^(1/k) ≤ pMax`, i.e.
 * `k ≥ ln(alpha) / ln(1 - pMax)`. Asserted against the general estimator in the self-test rather
 * than trusted: an inversion that has drifted from its estimator is precisely the old bug.
 */
function rollsForBound(pMax, alpha = ALPHA) {
  if (pMax <= 0) return Infinity;
  if (pMax >= 1) return 1;
  return Math.ceil(Math.log(alpha) / Math.log(1 - pMax));
}

/**
 * How many rolls would it take to actually justify the cap?
 *
 * A cap of N rolls is defensible if the chance of ANY false green across all N stays under
 * `target`. There are two honest ways to say that, and they need different k:
 *
 *   compounding  1-(1-p)^N ≤ target  →  p ≤ 1-(1-target)^(1/N)  = 0.5116% at N=10. ASSUMES the
 *                rolls are independent draws. Tighter, and the assumption is not free.
 *   union bound  N·p ≤ target        →  p ≤ target/N            = 0.5000% at N=10. Assumes NOTHING
 *                about independence, so it survives correlated rolls. Slightly more k.
 *
 * `rollsNeeded` is the union-bound k — the larger of the two, so a run at the prescribed k clears
 * BOTH readings and the weaker assumption is the one being leaned on. Both are returned because a
 * report that quotes one bar and grades against the other is how this went wrong the first time.
 */
function power({ capRolls, target = 0.05 }) {
  const perRoll = 1 - (1 - target) ** (1 / capRolls);
  const perRollUnion = target / capRolls;
  return {
    perRoll,
    perRollUnion,
    rollsNeededCompound: rollsForBound(perRoll),
    rollsNeeded: rollsForBound(perRollUnion),
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
// The cap argument turns on a comparison between two numbers that BOTH round to "0.5%" — the
// measured 0.498% bound and the 0.500% bar it has to clear. One decimal there prints a tautology.
// Four, not three: at three, `10 × 0.4997%` prints as "10 × 0.500% = 4.997%" and the reader is
// invited to think the arithmetic is wrong.
const pctFine = (x) => `${(x * 100).toFixed(4)}%`;

/**
 * Pick which wallet this run spends from, and say so when it is the wrong one.
 *
 * A full-power run is ~600 billed calls in one sitting. Charging that to the key CI grades pull
 * requests with means one measurement can exhaust the budget every future PR depends on — the same
 * failure `OPENAI_API_KEY_PREFLIGHT` exists to prevent for the local loop, arriving by a different
 * door. So for each seated family the search order is:
 *
 *   <KEY>_VARIANCE   a key for exactly this, ideally with a hard $5 cap at the vendor
 *   <KEY>_PREFLIGHT  the local-spend key that already exists for the same reason
 *   <KEY>            CI's key — used, because refusing would be worse, but never quietly
 *
 * Returns the env the judge is built from, plus a warning when it fell all the way through. The
 * vendor-side limit is the only cap this script cannot code around, and that is the recommendation.
 */
function resolveJudgeEnv(env, families) {
  const out = { ...env };
  const warnings = [];
  for (const family of families) {
    const provider = PROVIDERS[family];
    if (!provider) continue;
    const base = provider.apiKeyEnv;
    if (env[`${base}_VARIANCE`]) out[base] = env[`${base}_VARIANCE`];
    else if (env[`${base}_PREFLIGHT`]) out[base] = env[`${base}_PREFLIGHT`];
    else if (env[base]) {
      warnings.push(
        `⚠️ SHARED KEY — this run spends the same ${base} CI grades pull requests with. Set `
        + `${base}_VARIANCE to a key with a hard limit at the vendor; that is the only real cap.`
      );
    }
  }
  return { judgeEnv: out, warnings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;

  const { name: caseName, module: caseModule, data: CASE } = loadCase(args.case);

  const spec = buildSpec({ title: CASE.prTitle, body: CASE.criteriaBody }, [], [], {
    maxCriteriaChars: criteriaCapChars(promptBudgetTokens(env, PROVIDERS)),
  });
  if (!spec.hadRealSpec || !spec.criteria.length) {
    console.error('the fixture produced no criteria — buildSpec or the fixture has drifted.');
    process.exit(1);
  }

  // ── GROUND TRUTH, DERIVED — the guard on what this run is allowed to conclude ─────────────
  //
  // Everything below the per-criterion table is an argument about a SAFETY CAP, and it only holds
  // if a VERIFIED roll is WRONG. That is a property of the fixture, not of the arithmetic: on a
  // case whose criteria are all defensibly met, a VERIFIED roll is a correct call, and counting
  // those as "false greens" would manufacture a cap change out of the judge agreeing with a
  // reasonable reader. Both directions of that misreading are live in this script's own branches —
  // a high rate trips "10 is ALREADY TOO GENEROUS" and prescribes cutting the cap; a zero rate
  // trips the licence line and blesses keeping it. Neither knew anything about ground truth.
  //
  // So it is derived, from the fixture's own `expected` labels, and a contested case is REFUSED
  // rather than renamed: a renamed number still gets quoted, a section that never prints cannot be.
  // This is a deliberate softening of the fixture doctrine that "nothing branches on expected" —
  // that doctrine protects the VARIANCE statistics, which stay label-free. The licence prose was
  // already asserting a ground truth in English; checking it is strictly better than asserting it.
  const labels = spec.criteria.map((c) => CASE.expected[typeof c === 'string' ? c : c.text]);
  if (labels.some((l) => !l)) {
    console.error('a criterion has no `expected` label — the fixture and buildSpec have drifted apart.');
    process.exit(1);
  }
  const groundTruth = labels.includes('unmet') ? 'decisive-unmet' : 'contested';

  const input = { prTitle: CASE.prTitle, criteria: spec.criteria, diff: CASE.diff, tier1: CASE.tier1 };
  const promptChars = buildPrompt({ ...input, maxPromptTokens: promptBudgetTokens(env, PROVIDERS) }).length;
  const promptTokens = estimateTokens(buildPrompt({ ...input, maxPromptTokens: promptBudgetTokens(env, PROVIDERS) }));
  const family = env.FELIX_JUDGE_FAMILY || 'openai';
  const usdPerMTok = Number(env.FELIX_VARIANCE_USD_PER_MTOK) > 0
    ? Number(env.FELIX_VARIANCE_USD_PER_MTOK) : ASSUMED_USD_PER_MTOK;
  const estUsd = (promptTokens * args.k * usdPerMTok) / 1e6;

  const synthetic = args.selfTest !== null;
  const TAG = synthetic ? '[SYNTHETIC] ' : '';

  console.log('\nsmoke-judge-variance — re-roll one frozen case and measure the spread\n');
  if (synthetic) {
    console.log('  ══ SELF-TEST. No vendor is called and NOTHING here is a measurement. ══');
    console.log(`  ══ A seeded judge flips at ${pct(args.selfTest)}; the report must recover it. ══\n`);
  }
  console.log(`  case        ${caseName}  ·  ${path.relative(process.cwd(), require.resolve(caseModule))}`);
  console.log(`  criteria    ${spec.criteria.length}  ·  fingerprint ${(spec.fingerprint || '').slice(0, 12)}`);
  // A candidate is a fixture still being SHAPED to find the judge's flip point, so a number from
  // one is a calibration reading, not a measurement — and the difference is invisible once the
  // number is in a commit message. Said on every run, and stamped in the record.
  if (CASE.candidate) {
    console.log('  ⚠️ CANDIDATE — this fixture is NOT frozen. Numbers from it are CALIBRATION, not');
    console.log('     a measurement: the diff may still be reshaped to find the judge\'s flip point.');
    console.log('     Freeze it (drop `candidate: true`) before any run you intend to cite.');
  }
  console.log(`  truth       ${groundTruth === 'decisive-unmet'
    ? 'DECISIVE — at least one criterion no careful reader calls met, so a VERIFIED roll is a FALSE green'
    : 'CONTESTED — no criterion is labelled unmet, so a VERIFIED roll is a DEFENSIBLE call, not a false green'}`);
  console.log(`  prompt      ~${promptTokens} tokens (${promptChars} chars), measured`);
  // REQUESTED, not graded. This line prints before the judge is built, and a declared family with
  // no key never becomes a seat — so it cannot yet honestly name the grader. The bench as built is
  // printed below, after construction, and that is the one the scope line and the record use.
  console.log(`  seat(s)     ${synthetic ? 'synthetic/self-test · seeded, no vendor' : `${family} (requested)  ·  temperature 0 (both shipped providers)`}`);
  console.log(`  rolls       ${args.k}`);
  console.log(`  cost        ${synthetic ? '$0.00 — nothing is called' : `~$${estUsd.toFixed(2)} input-side, ROUGH — at $${usdPerMTok}/Mtok, output not counted`}\n`);

  const need = power({ capRolls: 10 });
  if (!args.spend && !synthetic) {
    console.log('  Nothing was called. Re-run with --spend to actually roll.\n');
    console.log(`  Note before you do: to defend a cap of 10 you need the per-roll false-green rate`);
    console.log(`  below ${pctFine(need.perRollUnion)} (union bound; ${pctFine(need.perRoll)} if you are willing to assume the rolls`);
    console.log(`  are independent), and demonstrating that with zero observed flips takes`);
    console.log(`  ~${need.rollsNeeded} rolls (~$${((promptTokens * need.rollsNeeded * usdPerMTok) / 1e6).toFixed(2)}). At k=${args.k} a clean sweep proves much less than it looks like.\n`);
    process.exit(0);
  }

  const { judgeEnv, warnings: walletWarnings } = resolveJudgeEnv(
    env, family.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean)
  );
  for (const w of walletWarnings) console.log(`  ${w}\n`);
  const judge = synthetic
    ? syntheticJudge(args.selfTest, spec.criteria, CASE, { errorEvery: args.errorEvery })
    : createJudge(judgeEnv);
  if (!judge) {
    console.error(`no judge seat is keyed for family "${family}" — set the provider's API key.`);
    process.exit(1);
  }

  // Everything downstream that names the grader reads THIS, never `family`. See judge.js `bench`.
  const bench = judge.seats;
  const graders = bench.active.map((s) => s.family);
  if (!synthetic) {
    console.log(`  graded by   ${graders.join(',')}  ·  ${graders.length === 1 ? 'SOLO seat' : `${graders.length}-vendor jury`}`);
    for (const s of bench.skipped) {
      console.log(`  ⚠️ SEAT SKIPPED — ${s.family} was requested but ${s.reason}. It did not grade anything.`);
    }
    console.log('');
  }

  // Paced against a seat that EXISTS. Taking the first requested family paces a solo openai run
  // against gemini's ceiling the moment gemini is declared and unkeyed.
  const provider = PROVIDERS[graders[0]] || PROVIDERS.openai;
  const rolls = [];
  for (let i = 0; i < args.k; i++) {
    // Paced against the seat's per-minute ceiling, sequentially, using the same helper production
    // uses. k parallel calls would 429 on any real prompt and turn a measurement into a retry test.
    if (i > 0 && !synthetic) {
      // Both ceilings, same helper production uses. `rpm` is unset for both shipped families
      // (measured 2026-08-14 as not binding — see paceMs), so this is the tokens term today and
      // picks up the requests term for free on a key that sets FELIX_JUDGE_RPM.
      const rpm = Number(env.FELIX_JUDGE_RPM) > 0 ? Number(env.FELIX_JUDGE_RPM) : provider.rpm;
      await new Promise((r) => setTimeout(r, paceMs(promptTokens, provider.tpm, rpm)));
    }
    try {
      const tier3 = await judge(input);
      const v = compose({
        triage: { skipped: false },
        spec,
        tier1: CASE.tier1,
        tier3,
        installFailed: false,
        judgeStatus: { configured: true },
        trigger: { draft: false, fork: false },
      });
      const rulings = {};
      for (const c of tier3.criteria || []) rulings[c.text] = c.met === true;
      // The PROSE the judge wrote, digested. Rulings alone cannot tell the two explanations of a
      // clean sweep apart: a genuinely tiny flip rate, and temperature 0 having collapsed the
      // effective sample size to ~1. Both print "0 flips in 600". If every roll returns the same
      // BYTES, the binomial arithmetic below is fiction — it replayed one computation k times and
      // the confidence bound is unearned. A digest, not the text: 600 assessments would bloat the
      // record, and all that is needed is a distinct-count.
      const textDigest = crypto.createHash('sha1').update(
        [tier3.assessment || '', ...(tier3.criteria || []).map((c) => c.reason || '')].join(' ')
      ).digest('hex').slice(0, 12);
      rolls.push({ ok: true, verdict: v.verdict, cause: v.cause, rulings, textDigest });
      // Per-roll lines are the useful trace on a real run; on a 600-roll rehearsal they are noise.
      if (args.k <= 30) {
        process.stdout.write(`  ${TAG}roll ${String(i + 1).padStart(3)}  ${v.verdict === VERDICTS.VERIFIED ? '✅ VERIFIED' : `❌ ${v.verdict}`}\n`);
      }
    } catch (e) {
      // A failed call is not a vote. Recorded and excluded from every rate below, because folding
      // an error into "did not return VERIFIED" would understate the false-green rate.
      rolls.push({ ok: false, error: e.message });
      process.stdout.write(`  roll ${String(i + 1).padStart(3)}  ⚠️ ERROR — ${e.message.slice(0, 80)}\n`);
    }
  }

  const valid = rolls.filter((r) => r.ok);
  const errors = rolls.length - valid.length;

  // ── per criterion ────────────────────────────────────────────────────────────────────────
  const perCriterion = spec.criteria.map((c) => {
    const text = typeof c === 'string' ? c : c.text;
    const votes = valid.map((r) => r.rulings[text]).filter((v) => v !== undefined);
    const met = votes.filter(Boolean).length;
    const modal = met >= votes.length - met;
    const flips = modal ? votes.length - met : met;
    return {
      text,
      expected: CASE.expected[text] || 'unlabelled',
      votes: votes.length,
      met,
      unmet: votes.length - met,
      flips,
      flipRate: votes.length ? flips / votes.length : 0,
      flipRateUpper95: clopperPearsonUpper(flips, votes.length),
    };
  });

  // ── the number that decides the cap ──────────────────────────────────────────────────────
  // The fixture contains a criterion no careful reader calls met. A roll that returns VERIFIED
  // therefore IS the false green a resampling attack is fishing for — no interpretation needed.
  const greens = valid.filter((r) => r.verdict === VERDICTS.VERIFIED).length;
  const contested = groundTruth === 'contested';
  const pHat = valid.length ? greens / valid.length : 0;
  const pUpper = clopperPearsonUpper(greens, valid.length);

  console.log('\n' + '─'.repeat(78));
  console.log(`${TAG}Per-criterion stability   (${valid.length} valid roll(s), ${errors} error(s))`);
  console.log('─'.repeat(78));
  for (const c of perCriterion) {
    const label = c.flips === 0 ? '✓ stable  ' : '✗ UNSTABLE';
    console.log(`  ${label} ${c.met}/${c.votes} met  · flips ${c.flips} (${pct(c.flipRate)}, ≤${pct(c.flipRateUpper95)} at 95%)`);
    console.log(`             [${c.expected}] ${c.text}`);
  }

  console.log('\n' + '─'.repeat(78));
  if (contested) {
    // THE REFUSAL, and it is a refusal rather than a rename on purpose: a renamed percentage in
    // the same slot on the same page gets quoted as the old one inside a month. A section that
    // does not print cannot be quoted at all.
    console.log(`${TAG}Verdict-level rate — REFUSED. This fixture cannot support a cap conclusion.`);
    console.log('─'.repeat(78));
    console.log(`  VERIFIED on ${greens} of ${valid.length} roll(s). That is NOT a false-green rate.`);
    console.log('');
    console.log('  No criterion here is labelled `unmet`, so this fixture\'s ground truth is CONTESTED —');
    console.log('  a VERIFIED ruling is a defensible call, not the event maxJudgeRuns exists to bound.');
    console.log('  Counting these as false greens would manufacture a cap change out of the judge');
    console.log('  agreeing with a reasonable reader. The mirror error is just as wrong: a stable');
    console.log('  REFUSAL on a contested case licenses keeping the cap no more than it licenses');
    console.log('  cutting it. Neither number is about the attack.');
    console.log('');
    console.log('  The cap argument needs a fixture with at least one DECISIVELY UNMET criterion.');
    console.log('  What this run does tell you is in the per-criterion table above — how far the');
    console.log('  judge moves on identical input. That statistic is label-free and it stands.');
  } else {
    console.log(`${TAG}Verdict-level false-green rate — the number the cap depends on`);
    console.log('─'.repeat(78));
    if (synthetic) console.log(`  REHEARSAL. The seeded judge was set to ${pct(args.selfTest)}; anything below is arithmetic, not evidence.`);
    console.log(`  VERIFIED on ${greens} of ${valid.length} roll(s) of a case a reviewer calls NOT VERIFIED.`);
    console.log(`  point estimate p = ${pct(pHat)}   ·   exact (Clopper-Pearson) one-sided 95% bound p ≤ ${pctFine(pUpper)}`);
    console.log('');
    console.log('  Chance of at least one false green, if an attacker just re-rolls:');
    for (const n of [1, 3, 5, 10, 20]) {
      console.log(`    ${String(n).padStart(2)} roll(s):  ${pct(atLeastOne(pHat, n)).padStart(6)} at the point estimate `
        + `·  up to ${pct(atLeastOne(pUpper, n))} at the upper bound`);
    }
  }

  console.log('\n' + '─'.repeat(78));
  console.log(`${TAG}What this does and does not license`);
  console.log('─'.repeat(78));
  if (synthetic) console.log('  NOTHING. This was a rehearsal of the arithmetic. Re-run with --spend for a measurement.');
  if (contested) {
    console.log('  NOTHING ABOUT THE CAP, in either direction. Ground truth here is contested, so');
    console.log('  neither a green nor a refusal is evidence about a resampling attack. Use a');
    console.log('  decisively-unmet fixture for that; use this one to watch the judge move.');
  } else if (greens === 0) {
    // Both bars, and the run must clear the WEAKER-ASSUMPTION one to count. The union bound
    // (10·p ≤ 5%) assumes nothing about independence between rolls; the compounding form does.
    const clearsUnion = pUpper * 10 <= 0.05;
    const clearsCompound = atLeastOne(pUpper, 10) <= 0.05;
    console.log(`  Zero events at k=${valid.length} still allows a per-roll rate as high as ${pctFine(pUpper)}.`);
    console.log(`  Against a 5% ceiling across a cap of 10:`);
    console.log(`    union bound   10 × ${pctFine(pUpper)} = ${pctFine(pUpper * 10)}  ${clearsUnion ? '✓ CLEARS' : '✗ FAILS'} the 5% ceiling  (assumes nothing)`);
    console.log(`    compounding   1-(1-p)^10 = ${pctFine(atLeastOne(pUpper, 10))}  ${clearsCompound ? '✓ CLEARS' : '✗ FAILS'} the 5% ceiling  (assumes independence)`);
    if (clearsUnion && clearsCompound) {
      console.log(`  So this run licenses KEEPING maxJudgeRuns at 10. Read that narrowly: it does NOT`);
      console.log(`  license RAISING it, and it is one case against one seat on one day.`);
    } else {
      console.log(`  ZERO false greens in ${valid.length} rolls is NOT evidence the cap can be loosened.`);
      console.log(`  To defend a cap of 10 you need p below ${pctFine(need.perRollUnion)} — that takes ~${need.rollsNeeded} rolls.`);
      console.log(`  Until then the honest position is: 10 is UNMEASURED, and leaving it is the safe error.`);
    }
  } else if (atLeastOne(pHat, 10) > 0.5) {
    console.log(`  10 is ALREADY TOO GENEROUS. At the observed ${pct(pHat)}, ten rolls win ${pct(atLeastOne(pHat, 10))}`);
    console.log('  of the time — the cap is not a bound on the attack, it is a budget for it.');
    console.log(`  For a 5% ceiling across the whole cap, maxJudgeRuns must drop to `
      + `${Math.max(1, Math.floor(Math.log(0.95) / Math.log(1 - pHat)))}.`);
  } else {
    console.log(`  A non-zero rate was observed (${pct(pHat)}). The cap is doing real work; whether 10 is`);
    console.log(`  the right number is now an arithmetic question rather than a guess:`);
    console.log(`  at this rate ten rolls carry a ${pct(atLeastOne(pHat, 10))} chance of a false green.`);
  }
  console.log('');
  // Name the seat that was actually measured. The old wording said the result "bounds nothing
  // about … a jury" unconditionally, which is simply false when the seat IS a jury — and a report
  // whose scope note is wrong is worse than one with no scope note.
  // From the bench as BUILT, not from FELIX_JUDGE_FAMILY: the env string names what was asked
  // for, and an unkeyed vendor is silently absent from the vote.
  const seatDesc = synthetic ? 'a synthetic seat'
    : graders.length > 1 ? `a ${graders.length}-vendor JURY (${graders.join(',')}), merged by unanimity`
    : `a single ${graders[0]} seat`;
  console.log(`  Scope: ONE case, one day, measured against ${seatDesc}.`);
  console.log('  It bounds nothing about a different diff, an adversarial prompt, or a different');
  console.log('  seat configuration — a solo seat is a weaker grader than a unanimity jury, so a');
  console.log('  number measured on one does not transfer to the other. It publishes nothing.');
  console.log('─'.repeat(78) + '\n');

  const record = {
    // First key, and never omitted when false: a rehearsal filed as a measurement is the one way
    // this script can do real damage.
    synthetic, syntheticRate: synthetic ? args.selfTest : null,
    // Two fields on purpose. `case` is the fixture's MODULE basename and is what the two
    // 2026-08 records already carry, so a new record stays comparable with them; `caseName` is
    // the `--case` selector, which is a friendlier handle and could be renamed without
    // silently making old and new numbers look like the same measuring stick.
    // `family` and `model` are the seats that GRADED, read off the judge — not FELIX_JUDGE_FAMILY
    // and FELIX_JUDGE_MODEL, which say what was asked for and go on saying it when a vendor is
    // skipped for a missing key. `seats` carries requested/active/skipped so a record can show the
    // mismatch instead of hiding it. Records written before 2026-08-14 carry the env string here,
    // and `calib-subtle-path.json` was corrected by hand (`seatNote`).
    case: path.basename(require.resolve(caseModule), '.js'), caseName, fingerprint: spec.fingerprint,
    family: graders.join(','),
    model: bench.active.map((s) => s.model).join(',') || null,
    seats: bench, k: args.k, valid: valid.length, errors,
    promptTokens, greens, groundTruth, candidate: CASE.candidate === true,
    // On a contested fixture the false-green fields are NULL, not merely renamed. A reader (or a
    // script) that reaches for `pHat` on a contested record gets nothing rather than a number that
    // means something else — the same reasoning as the printed refusal. The observed rate is still
    // recorded, under a name that says only what it is.
    pHat: contested ? null : pHat,
    pUpper95: contested ? null : pUpper,
    pVerified: contested ? pHat : null,
    pVerifiedUpper95: contested ? pUpper : null,
    capRisk: contested ? null
      : { rolls10: atLeastOne(pHat, 10), rolls10Upper95: atLeastOne(pUpper, 10), rolls10UnionUpper95: pUpper * 10 },
    powerNeeded: need, perCriterion, rolls,
  };
  if (args.json) console.log(JSON.stringify(record, null, 2));
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(record, null, 2));
    console.log(`  wrote ${args.out}\n`);
  }

  // Exit 0 whatever the number is. This MEASURES; it does not pass or fail, and a red exit on a
  // high variance figure would make an honest measurement look like a broken build.
  process.exit(0);
}

// The statistics are the deliverable, so they are exported and pinned against KNOWN VALUES in
// smoke-judge-variance-selftest.js rather than inferred through the report's prose. Inferring them
// is how a bound that is merely the wrong shape survives: every ordering assertion still holds
// while the printed percentage is wrong.
module.exports = { clopperPearsonUpper, binomCdfAtMost, rollsForBound, atLeastOne, power, resolveJudgeEnv };

if (require.main === module) {
  main().catch((e) => {
    console.error(`smoke-judge-variance failed: ${e.stack || e.message}`);
    process.exit(1);
  });
}
