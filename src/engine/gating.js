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
 *   "gating": { "enabled": true, "blockOn": ["NOT VERIFIED"], "overrideLabel": "felix-override" }
 */

const DEFAULT_GATING = {
  enabled: false,
  blockOn: ['NOT VERIFIED'],
  overrideLabel: 'felix-override',
};

function resolveGating(config = {}) {
  const g = { ...DEFAULT_GATING, ...(config.gating || {}) };
  if (!Array.isArray(g.blockOn)) g.blockOn = DEFAULT_GATING.blockOn.slice();
  return g;
}

/**
 * @param {object} opts
 * @param {string} opts.verdict
 * @param {object} opts.gating  resolved gating config
 * @param {string[]} [opts.labels]  PR label names
 * @returns {{blocks:boolean, overridden:boolean, reason:string}}
 */
function gateDecision({ verdict, gating, labels = [] }) {
  const g = gating || DEFAULT_GATING;
  if (!g.enabled) {
    return { blocks: false, overridden: false, reason: 'gating disabled — advisory only' };
  }
  const wouldBlock = (g.blockOn || []).includes(verdict);
  if (wouldBlock && g.overrideLabel && (labels || []).map(String).includes(g.overrideLabel)) {
    return { blocks: false, overridden: true, reason: `${verdict} would block, bypassed by "${g.overrideLabel}" label` };
  }
  return {
    blocks: wouldBlock,
    overridden: false,
    reason: wouldBlock ? `${verdict} blocks merge (gating enabled)` : `${verdict} does not block`,
  };
}

module.exports = { resolveGating, gateDecision, DEFAULT_GATING };
