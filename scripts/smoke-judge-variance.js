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
 * the half that can be wrong while looking right. A Wilson bound with a sign error still prints a
 * confident percentage. So `--self-test <rate>` replaces the vendor with a seeded synthetic judge
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
const CASE = require('../test/fixtures/judge-variance-case');

// Rough, and labelled rough wherever it is printed. Vendor pricing moves; the TOKEN counts above
// it are measured and do not. Override with FELIX_VARIANCE_USD_PER_MTOK if yours differs.
const ASSUMED_USD_PER_MTOK = 2.0; // gpt-4.1 input, checked 2026-08
const Z95 = 1.959963985;

function parseArgs(argv) {
  const a = { k: 20, spend: false, json: false, out: null, selfTest: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--spend') a.spend = true;
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
 * A seeded synthetic judge for `--self-test`. Deterministic on purpose: a rehearsal whose numbers
 * move between runs cannot be asserted, and an assertion is the entire point of having one.
 *
 * It rules the fixture's `unmet` criterion MET with probability `rate` — i.e. it manufactures a
 * false green at exactly that rate — and rules everything as the fixture's `expected` labels say
 * otherwise. So the report's recovered `pHat` should converge on `rate`.
 */
function syntheticJudge(rate, criteria, { errorEvery = 0 } = {}) {
  let s = 0x2545f491; // fixed seed; xorshift32
  let roll = 0;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
  return async () => {
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
}

/**
 * Wilson score upper bound on a proportion — correct at zero events, where the naive
 * `flips/k ± z·sqrt(p(1-p)/k)` collapses to 0 ± 0 and reports certainty it has not earned.
 */
function wilsonUpper(events, n) {
  if (!n) return 1;
  const p = events / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, centre + half);
}

/** P(at least one green in `rolls` independent draws at rate `p`). */
const atLeastOne = (p, rolls) => 1 - (1 - p) ** rolls;

/**
 * How many rolls would it take to actually justify the cap?
 *
 * A cap of N rolls is defensible if the chance of ANY false green across all N stays under
 * `target`. Invert that for the per-roll rate, then invert the rule of three (0 events in k trials
 * bounds p at ~3/k, 95%) for the k that would demonstrate it.
 */
function power({ capRolls, target = 0.05 }) {
  const perRoll = 1 - (1 - target) ** (1 / capRolls);
  return { perRoll, rollsNeeded: Math.ceil(3 / perRoll) };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

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

  const spec = buildSpec({ title: CASE.prTitle, body: CASE.criteriaBody }, [], [], {
    maxCriteriaChars: criteriaCapChars(promptBudgetTokens(env, PROVIDERS)),
  });
  if (!spec.hadRealSpec || !spec.criteria.length) {
    console.error('the fixture produced no criteria — buildSpec or the fixture has drifted.');
    process.exit(1);
  }

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
  console.log(`  case        ${path.relative(process.cwd(), require.resolve('../test/fixtures/judge-variance-case'))}`);
  console.log(`  criteria    ${spec.criteria.length}  ·  fingerprint ${(spec.fingerprint || '').slice(0, 12)}`);
  console.log(`  prompt      ~${promptTokens} tokens (${promptChars} chars), measured`);
  console.log(`  seat(s)     ${synthetic ? 'synthetic/self-test · seeded, no vendor' : `${family}  ·  temperature 0 (both shipped providers)`}`);
  console.log(`  rolls       ${args.k}`);
  console.log(`  cost        ${synthetic ? '$0.00 — nothing is called' : `~$${estUsd.toFixed(2)} input-side, ROUGH — at $${usdPerMTok}/Mtok, output not counted`}\n`);

  const need = power({ capRolls: 10 });
  if (!args.spend && !synthetic) {
    console.log('  Nothing was called. Re-run with --spend to actually roll.\n');
    console.log(`  Note before you do: to defend a cap of 10 you need the per-roll false-green rate`);
    console.log(`  below ${pct(need.perRoll)}, and demonstrating that with zero observed flips takes`);
    console.log(`  ~${need.rollsNeeded} rolls (~$${((promptTokens * need.rollsNeeded * usdPerMTok) / 1e6).toFixed(2)}). At k=${args.k} a clean sweep proves much less than it looks like.\n`);
    process.exit(0);
  }

  const { judgeEnv, warnings: walletWarnings } = resolveJudgeEnv(
    env, family.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean)
  );
  for (const w of walletWarnings) console.log(`  ${w}\n`);
  const judge = synthetic
    ? syntheticJudge(args.selfTest, spec.criteria, { errorEvery: args.errorEvery })
    : createJudge(judgeEnv);
  if (!judge) {
    console.error(`no judge seat is keyed for family "${family}" — set the provider's API key.`);
    process.exit(1);
  }

  const provider = PROVIDERS[family.split(',')[0].trim()] || PROVIDERS.openai;
  const rolls = [];
  for (let i = 0; i < args.k; i++) {
    // Paced against the seat's per-minute ceiling, sequentially, using the same helper production
    // uses. k parallel calls would 429 on any real prompt and turn a measurement into a retry test.
    if (i > 0 && !synthetic) await new Promise((r) => setTimeout(r, paceMs(promptTokens, provider.tpm)));
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
      flipRateUpper95: wilsonUpper(flips, votes.length),
    };
  });

  // ── the number that decides the cap ──────────────────────────────────────────────────────
  // The fixture contains a criterion no careful reader calls met. A roll that returns VERIFIED
  // therefore IS the false green a resampling attack is fishing for — no interpretation needed.
  const greens = valid.filter((r) => r.verdict === VERDICTS.VERIFIED).length;
  const pHat = valid.length ? greens / valid.length : 0;
  const pUpper = wilsonUpper(greens, valid.length);

  console.log('\n' + '─'.repeat(78));
  console.log(`${TAG}Per-criterion stability   (${valid.length} valid roll(s), ${errors} error(s))`);
  console.log('─'.repeat(78));
  for (const c of perCriterion) {
    const label = c.flips === 0 ? '✓ stable  ' : '✗ UNSTABLE';
    console.log(`  ${label} ${c.met}/${c.votes} met  · flips ${c.flips} (${pct(c.flipRate)}, ≤${pct(c.flipRateUpper95)} at 95%)`);
    console.log(`             [${c.expected}] ${c.text}`);
  }

  console.log('\n' + '─'.repeat(78));
  console.log(`${TAG}Verdict-level false-green rate — the number the cap depends on`);
  console.log('─'.repeat(78));
  if (synthetic) console.log(`  REHEARSAL. The seeded judge was set to ${pct(args.selfTest)}; anything below is arithmetic, not evidence.`);
  console.log(`  VERIFIED on ${greens} of ${valid.length} roll(s) of a case a reviewer calls NOT VERIFIED.`);
  console.log(`  point estimate p = ${pct(pHat)}   ·   95% upper bound p ≤ ${pct(pUpper)}`);
  console.log('');
  console.log('  Chance of at least one false green, if an attacker just re-rolls:');
  for (const n of [1, 3, 5, 10, 20]) {
    console.log(`    ${String(n).padStart(2)} roll(s):  ${pct(atLeastOne(pHat, n)).padStart(6)} at the point estimate `
      + `·  up to ${pct(atLeastOne(pUpper, n))} at the upper bound`);
  }

  console.log('\n' + '─'.repeat(78));
  console.log(`${TAG}What this does and does not license`);
  console.log('─'.repeat(78));
  if (synthetic) console.log('  NOTHING. This was a rehearsal of the arithmetic. Re-run with --spend for a measurement.');
  if (greens === 0) {
    console.log(`  ZERO false greens in ${valid.length} rolls is NOT evidence the cap can be loosened.`);
    console.log(`  Zero events at this k still allows a per-roll rate as high as ${pct(pUpper)}, and at`);
    console.log(`  that rate ten rolls find a green ${pct(atLeastOne(pUpper, 10))} of the time.`);
    console.log(`  To defend a cap of 10 you need p below ${pct(need.perRoll)} — that takes ~${need.rollsNeeded} rolls.`);
    console.log(`  Until then the honest position is: 10 is UNMEASURED, and leaving it is the safe error.`);
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
  const seatDesc = synthetic ? 'a synthetic seat'
    : family.includes(',') ? `a ${family.split(',').length}-vendor JURY (${family}), merged by unanimity`
    : `a single ${family} seat`;
  console.log(`  Scope: ONE case, one day, measured against ${seatDesc}.`);
  console.log('  It bounds nothing about a different diff, an adversarial prompt, or a different');
  console.log('  seat configuration — a solo seat is a weaker grader than a unanimity jury, so a');
  console.log('  number measured on one does not transfer to the other. It publishes nothing.');
  console.log('─'.repeat(78) + '\n');

  const record = {
    // First key, and never omitted when false: a rehearsal filed as a measurement is the one way
    // this script can do real damage.
    synthetic, syntheticRate: synthetic ? args.selfTest : null,
    case: 'judge-variance-case', fingerprint: spec.fingerprint, family: synthetic ? 'synthetic' : family,
    model: synthetic ? 'self-test' : (env.FELIX_JUDGE_MODEL || null), k: args.k, valid: valid.length, errors,
    promptTokens, greens, pHat, pUpper95: pUpper,
    capRisk: { rolls10: atLeastOne(pHat, 10), rolls10Upper95: atLeastOne(pUpper, 10) },
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
module.exports = { wilsonUpper, atLeastOne, power, resolveJudgeEnv };

if (require.main === module) {
  main().catch((e) => {
    console.error(`smoke-judge-variance failed: ${e.stack || e.message}`);
    process.exit(1);
  });
}
