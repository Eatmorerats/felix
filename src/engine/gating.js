/**
 * gating.js — make Felix authoritative (Phase 3).
 *
 * By default Felix is advisory: the "Felix verdict" check run reports a
 * conclusion but a repo only *blocks* merges if it marks that check Required in
 * branch protection. Gating mode adds policy on top:
 *
 *   - which verdicts block (default: NOT VERIFIED)
 *   - a maintainer override label that bypasses a block
 *
 * gateDecision is pure and unit-tested. The orchestrator maps the decision to
 * the check-run conclusion: blocks → failure, overridden → neutral, else the
 * normal advisory mapping.
 *
 * felix.config.json:
 *   "gating": {
 *     "enabled": true,
 *     "blockOn": ["NOT VERIFIED", "INSUFFICIENT EVIDENCE"],
 *     "insufficientExempt": ["judge_unconfigured"],
 *     "overrideLabel": "felix-override"
 *   }
 *
 * `blockOn` holds VERDICT strings only — no cause grammar mixed in, so there is never
 * a question of which entry wins. Causes get their own key: `insufficientExempt` carves
 * individual causes back OUT of a gated INSUFFICIENT EVIDENCE.
 *
 * It is an exemption list rather than an inclusion list on purpose. Listing what may
 * PASS means a cause introduced by a future Felix version blocks until someone decides
 * otherwise; listing what must BLOCK would let that same new cause slip through silently.
 * Same reasoning as verdict.js's residual branch — the unknown case costs a red check,
 * never a quiet green.
 */

const { VERDICTS, INSUFFICIENT_CAUSES } = require('./verdict');

const VALID_BLOCK_ON = Object.freeze(Object.values(VERDICTS));

const DEFAULT_GATING = {
  enabled: false,
  // NOTE: today's shipped default, deliberately unchanged by the attribution work.
  // Adding 'INSUFFICIENT EVIDENCE' here is what closes the bypass lane for repos that
  // gate on Felix; it is a product decision about every adopter, so it is made
  // explicitly rather than as a side effect. See docs/gating.md.
  blockOn: ['NOT VERIFIED'],
  // Only consulted when INSUFFICIENT EVIDENCE is in blockOn. `judge_unconfigured` is
  // the sole cause no head content can reach — it means the ADOPTER has no judge key,
  // so blocking on it would redden every PR in a repo that turned gating on before
  // finishing setup, for something no contributor can fix.
  insufficientExempt: ['judge_unconfigured'],
  overrideLabel: 'felix-override',
};

/**
 * Unrecognized values THROW rather than being dropped.
 *
 * Before this, `gateDecision` matched blockOn with `.includes(verdict)`, so a typo —
 * "INSUFFICENT EVIDENCE" — silently matched nothing and the repo believed it had a gate
 * it did not have. That is the same quiet-lie failure the strict config parser exists to
 * remove, and it fails OPEN, which is the direction that costs you. Throwing here is
 * consistent with assertJailCoherent: refuse at load, before any verdict can be created.
 */
function assertKnown(values, valid, key) {
  for (const v of values) {
    if (!valid.includes(v)) {
      throw new Error(
        `felix.config.json gating.${key}: unrecognized value ${JSON.stringify(v)}. ` +
        `Valid values: ${valid.map((x) => JSON.stringify(x)).join(', ')}.`
      );
    }
  }
}

function resolveGating(config = {}) {
  const g = { ...DEFAULT_GATING, ...(config.gating || {}) };
  // Absence takes the default; present-but-wrong-type is a config error, not a silent
  // downgrade — an adopter who wrote `"blockOn": "NOT VERIFIED"` (a string) meant to
  // configure a gate and would otherwise get the default without being told.
  if (config.gating && 'blockOn' in config.gating && !Array.isArray(g.blockOn)) {
    throw new Error(`felix.config.json gating.blockOn must be an array of verdict strings, got ${typeof g.blockOn}.`);
  }
  if (config.gating && 'insufficientExempt' in config.gating && !Array.isArray(g.insufficientExempt)) {
    throw new Error(`felix.config.json gating.insufficientExempt must be an array of cause ids, got ${typeof g.insufficientExempt}.`);
  }
  if (!Array.isArray(g.blockOn)) g.blockOn = DEFAULT_GATING.blockOn.slice();
  if (!Array.isArray(g.insufficientExempt)) g.insufficientExempt = DEFAULT_GATING.insufficientExempt.slice();
  assertKnown(g.blockOn, VALID_BLOCK_ON, 'blockOn');
  assertKnown(g.insufficientExempt, INSUFFICIENT_CAUSES, 'insufficientExempt');
  return g;
}

/**
 * @param {object} opts
 * @param {string} opts.verdict
 * @param {string} [opts.cause]  the verdict's machine-readable cause (see verdict.js)
 * @param {object} opts.gating  resolved gating config
 * @param {string[]} [opts.labels]  PR label names
 * @returns {{blocks:boolean, overridden:boolean, reason:string}}
 */
function gateDecision({ verdict, cause, gating, labels = [] }) {
  const g = gating || DEFAULT_GATING;
  if (!g.enabled) {
    return { blocks: false, overridden: false, reason: 'gating disabled — advisory only' };
  }
  let wouldBlock = (g.blockOn || []).includes(verdict);
  let exempt = null;
  // The exemption is granted on a POSITIVE cause match only. A missing or unrecognized
  // cause exempts nothing, so a caller that forgets to pass one gets the blocking
  // behavior, not the passing one.
  if (wouldBlock && verdict === VERDICTS.INSUFFICIENT && cause && (g.insufficientExempt || []).includes(cause)) {
    wouldBlock = false;
    exempt = cause;
  }
  if (wouldBlock && g.overrideLabel && (labels || []).map(String).includes(g.overrideLabel)) {
    return { blocks: false, overridden: true, reason: `${verdict} would block, bypassed by "${g.overrideLabel}" label` };
  }
  if (exempt) {
    return { blocks: false, overridden: false, reason: `${verdict} (${exempt}) is exempt from gating — nothing in the PR can cause or fix it` };
  }
  return {
    blocks: wouldBlock,
    overridden: false,
    reason: wouldBlock
      ? `${verdict}${cause ? ` (${cause})` : ''} blocks merge (gating enabled)`
      : `${verdict} does not block`,
  };
}

module.exports = { resolveGating, gateDecision, DEFAULT_GATING, VALID_BLOCK_ON };
