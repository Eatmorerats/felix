#!/usr/bin/env node
/**
 * probe-insufficient-bypass.js — differential proof that the INSUFFICIENT EVIDENCE
 * bypass lanes actually close, and that closing them does not brick an adopter.
 *
 * INSUFFICIENT EVIDENCE maps to the `neutral` check conclusion and GitHub counts neutral
 * as PASSING. So for a repo that marks Felix Required, every cause of an insufficiency is
 * a way to merge unverified. This probe drives the real compose() / gateDecision() /
 * conclusionFor() — no stubs of the units under test — under two configurations:
 *
 *   BEFORE  the shipped default, blockOn: ["NOT VERIFIED"]
 *   AFTER   a gated repo, blockOn: [..., "INSUFFICIENT EVIDENCE"] + default exemptions
 *
 * and asserts the exact set of lanes that must change. It is built to be able to REFUTE:
 * if a lane that should close stays open, or a lane that must stay open closes, it exits
 * non-zero and says which. A probe that can only confirm is not evidence.
 *
 * What this does NOT prove: that GitHub treats `neutral` as passing. That is an external
 * fact about branch protection and wants a live Required-check experiment on a test repo.
 * This proves Felix's half — the verdict, the gate decision, and the conclusion emitted.
 *
 *   node scripts/probe-insufficient-bypass.js
 */

const { compose, conclusionFor, VERDICTS, CAUSES } = require('../src/engine/verdict');
const { resolveGating, gateDecision } = require('../src/engine/gating');

const realSpec = { hadRealSpec: true, total: 3, mappedCount: 3, source: 'PR description' };
const goodTier1 = [{ name: 'install', hard: true, status: 'pass', detail: 'exit 0' }];

// Each row is a real path through compose(), not a hand-made verdict object.
const LANES = [
  {
    id: CAUSES.INSTALL_FAILED,
    label: 'PR breaks its own install    ("preinstall": "exit 1")',
    args: { triage: {}, spec: realSpec, tier1: goodTier1, installFailed: true },
    mustCloseWhenGated: true,
  },
  {
    id: CAUSES.NO_SPEC,
    label: 'PR writes no acceptance criteria           (zero code)',
    args: { triage: {}, spec: { hadRealSpec: false }, tier1: goodTier1 },
    mustCloseWhenGated: true,
  },
  {
    id: CAUSES.FORK,
    label: 'PR opened from a fork          (judge skipped by design)',
    args: { triage: {}, spec: realSpec, tier1: goodTier1, tier3: null, judgeStatus: { fork: true } },
    mustCloseWhenGated: true,
  },
  {
    id: CAUSES.JUDGE_ERROR,
    label: 'PR induces a judge error  (body + linked-issue criteria)',
    args: {
      triage: {}, spec: realSpec, tier1: goodTier1, tier3: null,
      judgeStatus: { configured: true, error: 'Judge prompt overhead (48211 chars) alone exceeds the 30000 budget' },
    },
    mustCloseWhenGated: true,
  },
  {
    id: CAUSES.JUDGE_UNAVAILABLE_UNKNOWN,
    label: 'judge returns nothing, no reason given        (residual)',
    args: { triage: {}, spec: realSpec, tier1: goodTier1, tier3: null },
    mustCloseWhenGated: true,
  },
  {
    id: CAUSES.JUDGE_UNCONFIGURED,
    label: 'adopter never set a judge key   (NOT reachable from PR)',
    args: { triage: {}, spec: realSpec, tier1: goodTier1, tier3: null, judgeStatus: { configured: false } },
    mustCloseWhenGated: false, // must STAY open — no contributor can fix this
  },
];

const CONTROL = {
  label: 'CONTROL — a criterion genuinely unmet',
  args: {
    triage: {}, spec: realSpec, tier1: goodTier1,
    tier3: { criteria: [{ text: 'login works', met: false, reason: 'no endpoint' }] },
  },
};

// BEFORE names the legacy blockOn EXPLICITLY rather than relying on the default. The default
// now includes INSUFFICIENT EVIDENCE, so `resolveGating({enabled:true})` would resolve to the
// AFTER config and the two columns would collapse into each other — a probe that compares a
// thing to itself and reports success. It is also the config an existing adopter still has on
// disk, so this column is the real upgrade baseline, not a synthetic one.
const BEFORE = resolveGating({ gating: { enabled: true, blockOn: ['NOT VERIFIED'] } });
const AFTER = resolveGating({ gating: { enabled: true } });

function drive(args, gating) {
  const v = compose(args);
  const d = gateDecision({ verdict: v.verdict, cause: v.cause, gating, labels: [] });
  const conclusion = d.blocks ? 'failure' : d.overridden ? 'neutral' : conclusionFor(v.verdict);
  return { verdict: v.verdict, cause: v.cause, blocks: d.blocks, conclusion };
}

const mark = (r) => (r.blocks ? 'BLOCKED' : 'BYPASS ');

console.log('\nFelix — INSUFFICIENT EVIDENCE bypass, before vs after\n');
console.log(`  BEFORE  gating.enabled=true  blockOn=${JSON.stringify(BEFORE.blockOn)}`);
console.log(`  AFTER   gating.enabled=true  blockOn=${JSON.stringify(AFTER.blockOn)}`);
console.log(`                               insufficientExempt=${JSON.stringify(AFTER.insufficientExempt)}\n`);

let problems = [];

for (const lane of LANES) {
  const b = drive(lane.args, BEFORE);
  const a = drive(lane.args, AFTER);

  if (b.cause !== lane.id) {
    problems.push(`${lane.id}: probe drove the wrong path — compose() returned cause "${b.cause}"`);
  }
  // The cause alone does not pin the verdict. Every lane here must be an INSUFFICIENT
  // EVIDENCE, because that is the only verdict `insufficientExempt` is consulted for — a
  // refactor that returned one of these causes under a different verdict would leave the
  // probe reporting success about a lane it was no longer measuring.
  if (b.verdict !== VERDICTS.INSUFFICIENT) {
    problems.push(`${lane.id}: expected verdict INSUFFICIENT EVIDENCE, got "${b.verdict}"`);
  }
  // And the premise this whole design rests on: GitHub counts `neutral` as PASSING, so
  // under the legacy config every one of these lanes is green on a Required check. If this
  // ever stops being neutral, the "bypass" being closed was not the bypass we documented.
  if (b.conclusion !== 'neutral') {
    problems.push(`${lane.id}: BEFORE conclusion must be neutral (the passing state this closes), got "${b.conclusion}"`);
  }
  console.log(`  ${mark(b)} -> ${mark(a)}   ${lane.label}`);
  console.log(`                      cause=${b.cause}  conclusion ${b.conclusion} -> ${a.conclusion}`);

  if (lane.mustCloseWhenGated && a.blocks !== true) {
    problems.push(`${lane.id}: MUST close when gated, but still bypasses (conclusion ${a.conclusion})`);
  }
  // NOT asserted here: that a blocking lane reports `failure` to GitHub. drive() derives the
  // conclusion as `blocks ? 'failure' : ...`, so with a.blocks already checked above, such an
  // assertion could never fail — it would read as coverage while testing this file's own line.
  // The engine's real blocks→failure mapping is pinned in test/run.js against index.js.
  if (!lane.mustCloseWhenGated && a.blocks !== false) {
    problems.push(`${lane.id}: must STAY open (nothing in a PR can cause or fix it), but it blocks`);
  }
  if (b.blocks !== false) {
    problems.push(`${lane.id}: expected to bypass under the shipped default, but it blocked`);
  }
}

// Without a control, "everything blocks now" could just mean the probe blocks everything.
const cb = drive(CONTROL.args, BEFORE);
const ca = drive(CONTROL.args, AFTER);
console.log(`\n  ${mark(cb)} -> ${mark(ca)}   ${CONTROL.label}`);
console.log(`                      cause=${cb.cause}  conclusion ${cb.conclusion} -> ${ca.conclusion}`);
if (cb.verdict !== VERDICTS.NOT_VERIFIED || !cb.blocks || !ca.blocks) {
  problems.push('CONTROL: NOT VERIFIED must block under BOTH configs — the probe is not measuring what it claims');
}

if (problems.length) {
  console.log('\nDIAGNOSIS REFUTED — the probe did not observe what this change claims:\n');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('');
  process.exit(1);
}

console.log(
  '\nRESULT: the four attacker-reachable lanes and the residual close when the repo gates on\n' +
  '        insufficiency (the residual is not reachable — it closes by failing closed);\n' +
  '        judge_unconfigured stays open (no contributor can fix a missing adopter key);\n' +
  '        the control blocks under both, so the probe can tell the two directions apart.\n'
);
