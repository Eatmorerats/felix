/**
 * outcomes.js — auto-detect post-merge defects from revert signals (Phase 4).
 *
 * Manually running `felix outcome <pr> defect` is reliable but tedious. The
 * strongest automatic signal that a merged PR was bad is a *revert*: GitHub's
 * revert button creates a commit/PR that references the original ("Revert
 * "<title>" (#123)" or a body "Reverts #123"). Scanning recent commits for that
 * lets Felix mark the original PR's calibration outcome as `defect` on its own.
 *
 * parseRevertedPR is pure and unit-tested; the CLI wires it to GitHub commits +
 * log.recordOutcome.
 */

// Matches the PR number a revert points back at. Conservative: requires explicit
// revert wording so a normal commit that merely mentions "#123" isn't flagged.
const REVERT_PATTERNS = [
  /\brevert(?:s|ed|ing)?\b[^\n]*?#(\d+)/i, // Revert "..." (#123) / Reverts #123
  /\breverts?\s+commit\b[\s\S]*?#(\d+)/i,  // This reverts commit ... (#123)
];

/**
 * @param {string} message  a commit (or PR) message
 * @returns {number|null} the reverted PR number, or null if not a revert ref
 */
function parseRevertedPR(message) {
  const text = String(message || '');
  if (!/\brevert/i.test(text)) return null;
  for (const re of REVERT_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) return Number(m[1]);
  }
  return null;
}

/**
 * Scan commit objects (GitHub API shape) and return the distinct PR numbers a
 * revert points back at, in first-seen order.
 * @param {Array<{commit?:{message?:string}, message?:string}>} commits
 * @returns {number[]}
 */
function detectRevertedPRs(commits = []) {
  const seen = new Set();
  const out = [];
  for (const c of commits) {
    const msg = (c && c.commit && c.commit.message) || (c && c.message) || '';
    const pr = parseRevertedPR(msg);
    if (pr && !seen.has(pr)) { seen.add(pr); out.push(pr); }
  }
  return out;
}

module.exports = { parseRevertedPR, detectRevertedPRs, REVERT_PATTERNS };
