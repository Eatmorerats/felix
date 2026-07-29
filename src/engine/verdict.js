/**
 * verdict.js — combine triage + Tier 1 + Tier 3 into one verdict.
 *
 * Pure function (no I/O) so it is trivially testable. Implements the decision
 * table from the plan; the first matching rule wins.
 *
 *   SKIPPED               only non-behavioral (skipGlob) files changed
 *   INSUFFICIENT EVIDENCE no spec, or install/build broke, or judge unavailable
 *   NOT VERIFIED          a hard Tier 1 check failed, or a criterion is unmet
 *   VERIFIED              all hard checks pass AND all mapped criteria met
 */

const VERDICTS = {
  SKIPPED: 'SKIPPED',
  INSUFFICIENT: 'INSUFFICIENT EVIDENCE',
  NOT_VERIFIED: 'NOT VERIFIED',
  VERIFIED: 'VERIFIED',
};

function compose({ triage, spec, tier1, tier3, installFailed, judgeStatus, trigger }) {
  const required = [];

  // 0. Draft PRs are deferred until marked ready.
  if (trigger && trigger.draft) {
    return { verdict: VERDICTS.SKIPPED, required_to_pass: [], reason: 'PR is a draft — verification deferred until marked ready for review.' };
  }

  // 1. Nothing behavioral changed.
  if (triage && triage.skipped) {
    return { verdict: VERDICTS.SKIPPED, required_to_pass: [], reason: triage.reason || 'only non-behavioral files changed' };
  }

  const hardFails = (tier1 || []).filter((c) => c.hard && c.status === 'fail');

  // 2. Couldn't actually exercise the code, or no spec to verify against.
  if (installFailed) {
    required.push('Fix install/build so the PR can be exercised.');
    return { verdict: VERDICTS.INSUFFICIENT, required_to_pass: required, reason: 'install/build failed' };
  }
  if (!spec || !spec.hadRealSpec) {
    return {
      verdict: VERDICTS.INSUFFICIENT,
      required_to_pass: ['Add acceptance criteria to the PR description or a linked issue so Felix can verify behavior.'],
      reason: 'no human spec found',
    };
  }

  // 3. Hard deterministic failures block.
  if (hardFails.length) {
    for (const f of hardFails) required.push(`${f.name} must pass (${f.detail}).`);
  }

  // 3b. Judge-found unmet criteria block (only when the judge ran).
  let judgedUnmet = [];
  if (tier3 && Array.isArray(tier3.criteria) && tier3.criteria.length) {
    judgedUnmet = tier3.criteria.filter((c) => c.met === false);
    for (const c of judgedUnmet) {
      required.push(`Criterion not met: "${c.text}"${c.reason ? ` — ${c.reason}` : ''}`);
    }
  }

  if (hardFails.length || judgedUnmet.length) {
    return { verdict: VERDICTS.NOT_VERIFIED, required_to_pass: required, reason: 'hard check failed or criteria unmet' };
  }

  // 4. Hard checks pass, but the judge couldn't run → can't confirm behavior.
  // Distinguish "not configured" from "configured but the call failed".
  if (!tier3) {
    const js = judgeStatus || {};
    if (js.fork) {
      return {
        verdict: VERDICTS.INSUFFICIENT,
        required_to_pass: ['Cross-family judge skipped on fork PRs (the judge secret is not exposed to forks). Tier 1 ran; re-run from a branch in this repo, or have a maintainer approve to confirm the criteria.'],
        reason: 'judge skipped on fork',
      };
    }
    if (js.error) {
      return {
        verdict: VERDICTS.INSUFFICIENT,
        required_to_pass: [`The cross-family judge failed and could not confirm the criteria: ${js.error}`],
        reason: 'judge errored',
      };
    }
    return {
      verdict: VERDICTS.INSUFFICIENT,
      required_to_pass: ['Configure the cross-family judge (OPENAI_API_KEY) so criteria can be confirmed.'],
      reason: 'judge not configured',
    };
  }

  // 5. All clear.
  return { verdict: VERDICTS.VERIFIED, required_to_pass: [], reason: 'all hard checks pass and criteria met' };
}

// Map a verdict to a GitHub check-run conclusion (gateable by branch protection).
const CHECK_CONCLUSION = {
  'VERIFIED': 'success',
  'NOT VERIFIED': 'failure',
  'INSUFFICIENT EVIDENCE': 'neutral',
  'SKIPPED': 'skipped',
};

function conclusionFor(verdict) {
  return CHECK_CONCLUSION[verdict] || 'neutral';
}

module.exports = { compose, VERDICTS, conclusionFor };
