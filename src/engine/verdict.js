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
 *
 * Every return also carries a `cause` — a stable machine-readable id for WHY this
 * verdict happened. `reason` is prose for humans and will be reworded; `cause` is
 * the contract gating.js keys on, so the two must never be conflated.
 *
 * `cause` exists because INSUFFICIENT EVIDENCE is six different situations wearing
 * one label, and they are not equally safe to let through a Required check. GitHub
 * counts the `neutral` conclusion as PASSING, so every one of them is a bypass lane
 * for a repo that gates on Felix. The axis that decides which may pass is
 * ATTACKER-INDUCIBILITY — can head content reach this state? — not "can the
 * contributor fix it":
 *
 *   install_failed            head-controlled. `"preinstall": "exit 1"`.
 *   no_spec                   head-controlled, and the cheapest of all: write no
 *                             acceptance criteria and there is nothing to verify.
 *   fork                      attacker-SELECTABLE. Not fixable by the contributor,
 *                             but simply opening the PR from a fork skips the judge
 *                             by construction (index.js gates it on !gate.fork). If
 *                             this lane stayed open, no attacker would bother with
 *                             any other — every other blocking rule here would be
 *                             decorative. Relief valve is the override label, which
 *                             needs write access an attacker cannot self-grant.
 *   judge_error               head-INDUCIBLE, and blocking for that reason — blocking is
 *                             what makes inducing it a self-DoS instead of a laundering
 *                             route out of a blocking cause into a passing one. The two
 *                             cheapest levers are now closed rather than merely blocked:
 *                             oversized criteria are refused up front by `spec_too_large`
 *                             below, and the Tier 1 evidence regions are truncated at the
 *                             budget in prompt.js. What is NOT closed: CHARS_PER_TOKEN is
 *                             an English/code approximation, so ~40,000 chars of CJK
 *                             estimate as 10,000 tokens and bill roughly 40,000 — the
 *                             prompt passes the local budget check and the vendor refuses
 *                             it. Still DoS-only, since this cause blocks either way.
 *   judge_unconfigured        the ONLY one no head content can reach: it is Felix's
 *                             own process env, behind the sandbox's clean env and the
 *                             module lock. The adopter forgot a key; the PR is
 *                             innocent. This is the one safe exemption.
 *   judge_unavailable_unknown the residual. See the guard note at the tier3 branch.
 *
 * `spec_too_large` is deliberately NOT one of them — it is NOT VERIFIED, and it is the only
 * cause on this page that is 100% author-controlled AND 100% author-fixable. Two consequences,
 * both intended:
 *
 *   - `failure`, not `neutral`. Gating is OFF by default, so a new INSUFFICIENT cause is GREEN
 *     in the majority adopter configuration. Shipping a deterministically PR-inducible state
 *     that passes a Required check would manufacture the exact lane this change closes.
 *   - it is absent from INSUFFICIENT_CAUSES, which is what gating.js validates
 *     `insufficientExempt` against. So an adopter cannot write it into their exemption list —
 *     assertKnown throws and names the valid values. That is the point: nobody should be able
 *     to configure "a PR that makes itself unverifiable passes my gate". Listing it there
 *     would also create config that reads as a gate and can never fire, since gateDecision
 *     only consults the exemption list for INSUFFICIENT EVIDENCE.
 */

const VERDICTS = {
  SKIPPED: 'SKIPPED',
  INSUFFICIENT: 'INSUFFICIENT EVIDENCE',
  NOT_VERIFIED: 'NOT VERIFIED',
  VERIFIED: 'VERIFIED',
};

/**
 * Stable cause ids. Values are the wire contract — gating config names them, and the
 * verdict log records them — so rename them only with a migration.
 */
const CAUSES = {
  DRAFT: 'draft',
  NON_BEHAVIORAL: 'non_behavioral',
  INSTALL_FAILED: 'install_failed',
  NO_SPEC: 'no_spec',
  SPEC_TOO_LARGE: 'spec_too_large',
  CRITERIA_UNMET: 'criteria_unmet',
  FORK: 'fork',
  JUDGE_ERROR: 'judge_error',
  JUDGE_UNCONFIGURED: 'judge_unconfigured',
  JUDGE_UNAVAILABLE_UNKNOWN: 'judge_unavailable_unknown',
  ALL_CLEAR: 'all_clear',
};

/** The causes that can accompany INSUFFICIENT EVIDENCE — the set gating may exempt. */
const INSUFFICIENT_CAUSES = Object.freeze([
  CAUSES.INSTALL_FAILED,
  CAUSES.NO_SPEC,
  CAUSES.FORK,
  CAUSES.JUDGE_ERROR,
  CAUSES.JUDGE_UNCONFIGURED,
  CAUSES.JUDGE_UNAVAILABLE_UNKNOWN,
]);

function compose({ triage, spec, tier1, tier3, installFailed, judgeStatus, trigger }) {
  const required = [];

  // 0. Draft PRs are deferred until marked ready.
  if (trigger && trigger.draft) {
    return { verdict: VERDICTS.SKIPPED, cause: CAUSES.DRAFT, required_to_pass: [], reason: 'PR is a draft — verification deferred until marked ready for review.' };
  }

  // 1. Nothing behavioral changed.
  if (triage && triage.skipped) {
    return { verdict: VERDICTS.SKIPPED, cause: CAUSES.NON_BEHAVIORAL, required_to_pass: [], reason: triage.reason || 'only non-behavioral files changed' };
  }

  const hardFails = (tier1 || []).filter((c) => c.hard && c.status === 'fail');

  // 2. Couldn't actually exercise the code, or no spec to verify against.
  if (installFailed) {
    required.push('Fix install/build so the PR can be exercised.');
    return { verdict: VERDICTS.INSUFFICIENT, cause: CAUSES.INSTALL_FAILED, required_to_pass: required, reason: 'install/build failed' };
  }
  // 2b. There IS a spec, and it is too large to put in front of a judge.
  //
  // Ordered BEFORE the !hadRealSpec branch, and that is a decision rather than line-order
  // accident. Today the two cannot both be true: an over-limit spec always has
  // hadRealSpec === true, and the only way hadRealSpec goes false with criteria present is the
  // PR-title fallback, which GitHub caps at 256 chars and so can never overflow. It is ordered
  // this way for the fourth spec source nobody has written yet (commit messages, review
  // comments), which could be both oversized AND fallback-only — the redder branch first means
  // such a source cannot silently downgrade this `failure` into a `neutral`.
  //
  // Ordered AFTER installFailed, which is the opposite trade and also deliberate: ordering
  // cannot open or close a lane here (an attacker who wants the neutral just breaks their own
  // install with an ordinary spec — a lane already documented as head-controlled above), so
  // the tie goes to diagnostics, and a broken install is what the author hits first.
  if (spec && spec.size && spec.size.overLimit) {
    return {
      verdict: VERDICTS.NOT_VERIFIED,
      cause: CAUSES.SPEC_TOO_LARGE,
      required_to_pass: [
        `Acceptance criteria are too large to verify: ${spec.total} criteria, ` +
        `${spec.size.renderedChars} characters, against a limit of ${spec.size.limitChars}. ` +
        'Felix will not grade a subset — that would report a verdict on criteria it never read. ' +
        'Reduce the criteria, or split this PR so each part carries its own spec.' +
        (spec.source ? ` Sources: ${spec.source}.` : ''),
      ],
      reason: 'spec too large to verify',
    };
  }
  if (!spec || !spec.hadRealSpec) {
    return {
      verdict: VERDICTS.INSUFFICIENT,
      cause: CAUSES.NO_SPEC,
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
    // `met !== true`, not `met === false`. This table is the last thing standing between a
    // model's bytes and a green check, so it counts a criterion as met only where something
    // said so explicitly. `met === false` let undefined, null, 0 and the string "false" —
    // every shape a truncated or schema-drifting completion produces — read as met.
    judgedUnmet = tier3.criteria.filter((c) => c.met !== true);
    for (const c of judgedUnmet) {
      required.push(`Criterion not met: "${c.text}"${c.reason ? ` — ${c.reason}` : ''}`);
    }
  }

  if (hardFails.length || judgedUnmet.length) {
    return { verdict: VERDICTS.NOT_VERIFIED, cause: CAUSES.CRITERIA_UNMET, required_to_pass: required, reason: 'hard check failed or criteria unmet' };
  }

  // 4. Hard checks pass, but the judge couldn't run → can't confirm behavior.
  // Distinguish "not configured" from "configured but the call failed".
  //
  // ORDER AND POSITIVITY BOTH MATTER HERE. `judge_unconfigured` is the one cause a
  // gated repo is allowed to pass on, so it must be granted on POSITIVE evidence —
  // `configured === false`, an explicit "we looked and there is no key" — and never
  // by falling off the end of the branch. This used to be the else: any future path
  // that leaves tier3 null without setting fork or error (a "diff too large, judge
  // skipped" say) would have inherited the exemption and silently passed a Required
  // check. The residual below fails CLOSED instead, so a state nobody anticipated
  // costs a red check and a bug report rather than a quiet green.
  if (!tier3) {
    const js = judgeStatus || {};
    if (js.fork) {
      return {
        verdict: VERDICTS.INSUFFICIENT,
        cause: CAUSES.FORK,
        required_to_pass: ['Cross-family judge skipped on fork PRs (the judge secret is not exposed to forks). Tier 1 ran; re-run from a branch in this repo, or have a maintainer approve to confirm the criteria.'],
        reason: 'judge skipped on fork',
      };
    }
    if (js.error) {
      return {
        verdict: VERDICTS.INSUFFICIENT,
        cause: CAUSES.JUDGE_ERROR,
        required_to_pass: [`The cross-family judge failed and could not confirm the criteria: ${js.error}`],
        reason: 'judge errored',
      };
    }
    if (js.configured === false) {
      return {
        verdict: VERDICTS.INSUFFICIENT,
        cause: CAUSES.JUDGE_UNCONFIGURED,
        required_to_pass: ['Configure the cross-family judge (OPENAI_API_KEY) so criteria can be confirmed.'],
        reason: 'judge not configured',
      };
    }
    return {
      verdict: VERDICTS.INSUFFICIENT,
      cause: CAUSES.JUDGE_UNAVAILABLE_UNKNOWN,
      required_to_pass: ['The cross-family judge produced no result and Felix cannot say why. This is a bug — please report it with the run log.'],
      reason: 'judge unavailable (cause unknown)',
    };
  }

  // 5. All clear.
  return { verdict: VERDICTS.VERIFIED, cause: CAUSES.ALL_CLEAR, required_to_pass: [], reason: 'all hard checks pass and criteria met' };
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

module.exports = { compose, VERDICTS, CAUSES, INSUFFICIENT_CAUSES, conclusionFor };
