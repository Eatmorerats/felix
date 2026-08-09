/**
 * freeze.js — the spec freeze and the judge attempt cap: policy resolution plus the pure
 * decisions index.js hands to compose().
 *
 * These two controls exist because of a property Felix cannot design away: the criteria it
 * grades are written by the PR author, in the PR body, which the author keeps a pen over — and
 * the judge that grades them is a language model, which is not deterministic. So a green check
 * says "this criteria set was met, once". Both of those words need pinning:
 *
 *   THIS SET   `spec_changed`      — the fingerprint of the criteria set is pinned to the
 *                                    EARLIEST one recorded for the PR. Any later add, delete or
 *                                    reword lands here instead of being silently re-graded.
 *   ONCE       `attempts_exhausted` — LIFETIME judge attempts per (repo, pr_number) are capped,
 *                                    read from the durable store BEFORE the spend, so pushing
 *                                    again does not buy a fresh roll of the dice.
 *
 * Everything here is PURE except resolveFreeze's config read, which is deliberate: index.js does
 * the I/O (fetchPriorRuns) and this file decides what the answer means, so the decisions are
 * unit-testable without a store. Same split as gating.js.
 *
 * The `judge` config block is POLICY (config.js POLICY_KEYS), so it is read from the BASE ref.
 * That is what makes `maxJudgeRuns` safe to expose at all — head cannot raise its own budget.
 */

const DEFAULT_FREEZE = {
  // Binomial arithmetic, not measurement: at a 10% per-run false-pass rate, seven independent
  // rolls win more often than not, so a cap in the tens is the point at which resampling stops
  // being cheaper than fixing the code. It is NOT calibrated — scripts/smoke-judge-variance.js
  // (unwritten) is what would replace this guess with a number. If measured variance at
  // temperature 0 turns out to be near zero, 10 is needlessly tight; if it is 10%+, 10 is
  // already too generous. Sized so an honest PR never notices: Felix's own busiest PR to date
  // spent 6.
  maxJudgeRuns: 10,
};

/**
 * There is deliberately NO `respecLabel` key here yet.
 *
 * The designed relief for `spec_changed` is two-tier: revert the criteria (free, no human, the
 * hash matches again), or a maintainer applies a respec label that RE-BASELINES the pin. The
 * second tier is not built — github.js has no label methods at all, so the label could be read
 * but never removed, and a label that survives its own use is a standing "rewrite your own
 * rubric" permit for that PR. That is the hole, not the fix.
 *
 * Shipping the config key ahead of the mechanism would be worse than not shipping it: an adopter
 * would name a label, apply it, and watch it do nothing. So until deletion + consume-on-use is
 * built and probed against a real token, the maintainer valve is the one that already works —
 * `gating.overrideLabel`, which also needs write access an attacker cannot self-grant. verdict.js
 * only names a respec label when one is passed to it, so nothing promises a valve that is absent.
 */

/** Config errors throw by name rather than degrading to the default — see gating.js assertKnown. */
function resolveFreeze(config = {}) {
  const j = config.judge;
  if (j !== undefined && (typeof j !== 'object' || Array.isArray(j) || j === null)) {
    throw new Error(
      'felix.config.json judge must be an object, got '
      + `${Array.isArray(j) ? 'array' : j === null ? 'null' : typeof j}. `
      + 'Example: {"maxJudgeRuns": 10, "adversarial": false}.'
    );
  }
  const out = { ...DEFAULT_FREEZE };
  if (j && Object.prototype.hasOwnProperty.call(j, 'maxJudgeRuns')) {
    const n = j.maxJudgeRuns;
    // Absence takes the default; present-but-wrong is a config error. An adopter who wrote
    // `"maxJudgeRuns": "10"` meant to set a budget, and silently keeping 10 would be right by
    // luck — the next one writes "5" and silently gets 10.
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new Error(
        `felix.config.json judge.maxJudgeRuns must be an integer >= 1, got ${JSON.stringify(n)}. `
        + 'It caps how many times ONE pull request may be graded by the cross-family judge, '
        + 'because the judge is not deterministic and unbounded re-runs are a way to obtain a '
        + 'green check by repetition. 0 is rejected rather than read as "never judge": a repo '
        + 'that wants no judge leaves the key unset and configures no judge key.'
      );
    }
    out.maxJudgeRuns = n;
  }
  return out;
}

/**
 * The fingerprint this run would PIN — and therefore the only one it may be JUDGED against.
 *
 * One function, two call sites (the drift comparison and the logVerdict row), because they must
 * agree by construction. Same discipline as spec.js normKey(): if a run logs a fingerprint it
 * did not compare, or compares one it will not log, the baseline drifts by itself.
 *
 * Null unless the spec was real AND gradeable. A PR-title fallback spec and an over-limit spec
 * are both never put in front of the judge, so neither was ever "graded against" — pinning one
 * would flag the author's first legitimate criteria as drift, and comparing against one would
 * flag drift that nobody was graded on either side of.
 */
function pinnableFingerprint(spec) {
  if (!spec || !spec.hadRealSpec) return null;
  if (!spec.size || spec.size.overLimit) return null;
  return spec.fingerprint || null;
}

/**
 * Did the criteria move after a grade was rendered against them?
 *
 * Changed requires BOTH sides present. A null baseline is a legitimate first run — nothing has
 * been pinned yet — and a null current is a spec this run may not be graded against anyway
 * (see pinnableFingerprint), where the verdict is already decided by no_spec or spec_too_large.
 * Reporting either as drift would block PRs that did nothing wrong, which is how a control gets
 * turned off by the people it protects.
 */
function decideSpecDrift({ current, baseline, respecLabel } = {}) {
  const changed = Boolean(current && baseline && current !== baseline);
  return { changed, baseline: baseline || null, current: current || null, respecLabel: respecLabel || null };
}

/**
 * Is this PR out of judge attempts?
 *
 * `used` is the LIFETIME count from the durable store, not an in-process counter — an
 * in-process one is reset by pushing again, so it bounds nothing. `>=`, not `>`: `used` counts
 * attempts already spent, so at used === limit the budget is gone and this run may not spend
 * another.
 */
function decideAttempts({ used, limit } = {}) {
  const u = Number.isFinite(used) ? used : 0;
  const l = Number.isFinite(limit) ? limit : DEFAULT_FREEZE.maxJudgeRuns;
  return { exhausted: u >= l, used: u, limit: l, remaining: Math.max(0, l - u) };
}

/**
 * THE FAIL-CLOSED RULE. This is the one place in Felix where "logging must never block a
 * verdict" is deliberately overridden, so it is stated here in full rather than left implicit
 * at the call site.
 *
 * log.js is best-effort by contract: a lost row costs history. This read is not, and the
 * difference is that the freeze and the cap are not features computed FROM the store — they ARE
 * the store. If Felix cannot tell what criteria it pinned or how many times it has already
 * graded this PR, then "the spec did not change" and "this PR has attempts left" are both
 * unproven, and answering them TRUE is a fail-open on the two controls that exist precisely
 * because the author can edit the rubric and the judge is stochastic. An unreachable Supabase is
 * also not an exotic state — it is one expired key away, and it is silent.
 *
 * So when the store does not answer, an ADVISORY repo warns and proceeds (nothing it reports can
 * block a merge, so an unproven control changes no outcome), and a GATING repo REFUSES. The
 * caller throws on a refusal rather than composing a verdict, because every verdict Felix can
 * compose here is one GitHub may count as passing — INSUFFICIENT EVIDENCE maps to `neutral`,
 * which is a PASS on a Required check. Throwing exits before finalize(), so no check run is
 * created at all.
 *
 * Two conjuncts narrow the refusal, and both are load-bearing:
 *
 *   couldReachVerified  Both controls protect against laundering a PASS. If the judge cannot run
 *                       this time — a fork PR (no judge secret), no real spec, an over-limit spec
 *                       — the verdict cannot be VERIFIED whatever the store says, so refusing
 *                       buys nothing and costs a lot: fork PRs get no secrets at all, so
 *                       SUPABASE_* is empty there BY CONSTRUCTION and without this conjunct every
 *                       fork PR on a gated repo would hard-error forever. Store-up and store-down
 *                       reach the SAME outcome in each of those states, which is the invariant
 *                       this whole rule exists to preserve.
 *   !overridden         Without an escape hatch, a gated repo plus a down store is a repo with no
 *                       way to merge anything. The override label needs write access on the base
 *                       repo, which is exactly the authority this refusal is deferring to.
 *
 * `gating.enabled` ALONE, deliberately — NOT `blockOn.includes('NOT VERIFIED')`. That looked like
 * a harmless narrowing and was a fail-open: when gateDecision says the verdict does not block,
 * index.js falls through to conclusionFor(), and conclusionFor('NOT VERIFIED') is `failure`. So a
 * PROVEN spec_changed fails a Required check whatever blockOn says. A repo configured
 * `blockOn: ["INSUFFICIENT EVIDENCE"]` — valid, assertKnown accepts it — would then get a red
 * check with the store up and a re-graded, possibly VERIFIED one with the store down. Divergence
 * between store-up and store-down IS the bug; the extra conjunct bought nothing and created one.
 *
 * Neither conjunct is head-reachable: `gating` is POLICY read from the base ref, labels need
 * write access, and the spec conjunct can only be turned off by making the PR ungradeable —
 * which forfeits VERIFIED in the same move.
 *
 * RESIDUAL, not closed: `gating.enabled` is a PROXY for "the Felix verdict check is marked
 * Required in branch protection", and the two can disagree. A repo that marks the check Required
 * while leaving gating disabled gets no store-outage refusal. Felix's token cannot read branch
 * protection in every setup, so the proxy stays — it is named in the README instead.
 *
 * @returns {{refuse:boolean, reason:string}}
 */
function refuseOnUnprovenFreeze({ available, gating, labels, couldReachVerified, storeReason } = {}) {
  if (available) return { refuse: false, reason: 'prior-run state is available' };
  const g = gating || {};
  const overridden = Boolean(g.overrideLabel) && (labels || []).map(String).includes(g.overrideLabel);
  if (!g.enabled) {
    return { refuse: false, reason: 'gating disabled — advisory only, so an unproven freeze can block nothing' };
  }
  if (!couldReachVerified) {
    return { refuse: false, reason: 'this run cannot reach VERIFIED, so there is no pass to launder' };
  }
  if (overridden) {
    return { refuse: false, reason: `bypassed by the "${g.overrideLabel}" label` };
  }
  return {
    refuse: true,
    reason:
      'Felix could not read this PR\'s prior-run state, so the spec freeze and the judge attempt '
      + 'cap are both unproven — Felix cannot tell whether the acceptance criteria changed after '
      + 'it graded them, or how many times it has already graded this PR. This repo has gating '
      + 'enabled, so proceeding would publish a verdict that silently rests on two checks that '
      + 'did not run. Fix SUPABASE_URL + '
      + 'SUPABASE_SERVICE_ROLE_KEY, or have a maintainer apply the '
      + `"${g.overrideLabel || 'felix-override'}" label to merge without them.`
      + (storeReason ? ` Store said: ${storeReason}` : ''),
  };
}

module.exports = {
  DEFAULT_FREEZE, resolveFreeze, pinnableFingerprint, decideSpecDrift, decideAttempts,
  refuseOnUnprovenFreeze,
};
