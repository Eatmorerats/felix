/**
 * spec.js — find the *human* spec and turn it into checkable criteria.
 *
 * Felix verifies behavior against what a person asked for. The spec can live in:
 *   1. The PR body — an "Acceptance Criteria" section or a task checklist.
 *   2. Linked issues — "Closes #12", "Fixes #34", or bare "#56" references.
 *   3. (weak fallback) the PR title.
 *
 * Tier 2 = mapping each criterion to the changed files/tests so we can report
 * coverage (criteria_total vs criteria_mapped) and feed the judge.
 *
 * SIZE IS A SECURITY PROPERTY HERE, not housekeeping. Criteria are read verbatim out of text
 * anyone can write, and index.js folds in up to TEN linked issues, each with its own
 * 65,536-char GitHub body. Past a point the criteria alone outgrow the judge's whole prompt
 * budget, judge.js throws, and the PR lands on `judge_error`. So buildSpec MEASURES the merged
 * set and reports `size.overLimit`; verdict.js turns that into a blocking `spec_too_large`.
 *
 * Three things about that measurement are load-bearing:
 *   - it is taken on the MERGED set, after the issues are folded in. A per-source cap measures
 *     clean and defends nothing: eleven under-cap sources sum to over-budget.
 *   - it counts the RENDERED string (prompt.js renderCriteriaList), not the sum of the texts.
 *     The `${i+1}. ` numbering is 2.73x the text itself at the minimum criterion width.
 *   - nothing here truncates. Grading a subset of a spec and reporting it as complete is a
 *     bypass primitive, not a degradation — see PROMPT_REGION_FRACTIONS in budget.js.
 */

const crypto = require('crypto');
const { renderCriteriaList, DEFAULT_PROMPT_BUDGET_TOKENS } = require('./prompt');
const { regionCapChars } = require('./budget');

const ISSUE_REF = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+#(\d+)|(?:^|\s)#(\d+)\b/gi;

const CRITERIA_HEADING = /(acceptance criteria|requirements?|definition of done|tasks?|checklist|expected behaviou?r)/i;

/** Pull issue numbers referenced by a PR body. */
function linkedIssueNumbers(prBody = '') {
  const nums = new Set();
  let m;
  ISSUE_REF.lastIndex = 0;
  while ((m = ISSUE_REF.exec(prBody)) !== null) {
    const n = m[1] || m[2];
    if (n) nums.add(Number(n));
  }
  return [...nums];
}

/** Extract discrete criteria lines from a markdown blob. */
function extractCriteria(text = '') {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  let inSection = false;
  let sawAnyHeading = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line) || /^\*\*.+\*\*:?$/.test(line)) {
      inSection = CRITERIA_HEADING.test(line);
      if (CRITERIA_HEADING.test(line)) sawAnyHeading = true;
      continue;
    }
    // Checkbox / bullet items.
    const item = line.match(/^[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/);
    if (item) {
      const txt = item[1].trim();
      // If we found a criteria heading, only take items under it; otherwise take
      // checkbox items anywhere (they almost always express requirements).
      const isCheckbox = /^[-*]\s+\[[ xX]\]/.test(line);
      if ((sawAnyHeading && inSection) || (!sawAnyHeading && isCheckbox)) {
        // A MINIMUM of 4 characters, and there is deliberately no maximum here — a single
        // source cannot know what the merged set costs. The maximum is enforced once, on the
        // merged set, in buildSpec.
        if (txt.length > 3) out.push(txt);
      }
    }
  }
  return dedupe(out);
}

/**
 * The canonical form of ONE criterion.
 *
 * Extracted rather than left inline because the dedupe and the fingerprint below must agree
 * by construction. If two texts collapse to a single criterion here, they have to collapse to
 * a single hash input too — otherwise swapping a bullet between two whitespace variants of
 * itself changes the fingerprint while changing nothing the judge sees, and the author gets a
 * free re-baseline out of a cosmetic edit.
 */
function normKey(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter((s) => {
    const k = normKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const NUL = String.fromCharCode(0);

/**
 * A stable fingerprint of the criteria set a run was graded against — the pin that makes the
 * rubric immutable to its own author mid-flight.
 *
 * Felix reads its criteria out of the PR body, the one artifact the PR author holds a pen over.
 * Without a pin, the cheapest response to "criterion not met" is to delete the criterion, and
 * that is not hypothetical even without an agent in the loop: Felix runs once per PUSH and
 * never on `pull_request: edited`, so a green check can be earned against one spec and merged
 * while displaying another. An autonomous fixer just finds that door faster than a person does.
 *
 * Three properties are load-bearing:
 *   - it hashes the SAME array index.js hands the judge (`mapped[].text`), not the raw sources.
 *     Same discipline as the size measurement below: measure the real thing, never a proxy.
 *   - it hashes normKey() output, so the hash agrees with the dedupe (see above).
 *   - it SORTS. Reordering criteria is cosmetic and must not trip the freeze; any add, delete
 *     or reword must. No algorithm can separate a typo fix from a weakening, so both trip it
 *     and both route through the human relief valve. That is the intended trade, not a gap.
 *
 * Separator is NUL, which cannot appear in a markdown bullet, so no pair of criteria can be
 * concatenated into a colliding preimage.
 *
 * Returns null for an empty set — "there was nothing to pin", which is a different state from
 * "pinned the empty set" and is what lets a `no_spec` PR legitimately gain criteria later.
 */
function specFingerprint(criteria) {
  const texts = (criteria || [])
    .map((c) => normKey(typeof c === 'string' ? c : (c && c.text) || ''))
    .filter(Boolean)
    .sort();
  if (!texts.length) return null;
  return crypto.createHash('sha256').update(texts.join(NUL), 'utf8').digest('hex');
}

const STOP = new Set(('the a an and or of to in on for with is are be should must when then ' +
  'that this it as by add adds added support new feature fix update').split(' '));

function keywords(text) {
  return [...new Set(
    text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []
  )].filter((w) => !STOP.has(w));
}

/** Map a criterion to changed files by keyword overlap with file paths. */
function mapCriterion(criterion, files) {
  const kws = keywords(criterion);
  const hits = [];
  for (const f of files) {
    const p = f.filename.toLowerCase();
    if (kws.some((k) => p.includes(k))) hits.push(f.filename);
  }
  return hits;
}

/** The merged-criteria cap, in rendered characters, for a given seat budget. */
function criteriaCapChars(maxPromptTokens = DEFAULT_PROMPT_BUDGET_TOKENS) {
  return regionCapChars('criteria', maxPromptTokens);
}

/**
 * Build the spec model.
 * @param {object} pr  PR object (needs .title, .body)
 * @param {Array}  issues  fetched linked-issue objects ({number, title, body})
 * @param {Array}  files  changed files ({filename, ...})
 * @param {{maxCriteriaChars?: number}} [opts]  cap on the RENDERED merged criteria set.
 *   Defaults to the strictest seat Felix ships; index.js passes the env-adjusted value.
 */
function buildSpec(pr, issues, files, { maxCriteriaChars = criteriaCapChars() } = {}) {
  const sources = [];
  let criteria = [];

  const fromPR = extractCriteria(pr.body || '');
  if (fromPR.length) { criteria = fromPR; sources.push('PR description'); }

  for (const issue of issues) {
    const fromIssue = extractCriteria(issue.body || '');
    if (fromIssue.length) {
      criteria = criteria.concat(fromIssue);
      sources.push(`issue #${issue.number}`);
    }
  }
  criteria = dedupe(criteria);

  // Weak fallback: the title as a single criterion.
  if (!criteria.length && pr.title) {
    criteria = [pr.title.trim()];
    sources.push('PR title (fallback)');
  }

  const mapped = criteria.map((text) => {
    const m = mapCriterion(text, files);
    return { text, mappedFiles: m, mapped: m.length > 0 };
  });

  const hadRealSpec = sources.length > 0 && !(sources.length === 1 && sources[0].includes('fallback'));

  // Measured on `mapped` — the very array index.js hands to the judge — and through the same
  // renderer buildPrompt uses, so this is the real cost and not an estimate of it.
  const renderedChars = renderCriteriaList(mapped).length;

  return {
    source: sources.length ? sources.join(', ') : null,
    hadRealSpec,
    criteria: mapped,
    // Computed on `mapped` for the same reason renderedChars is: it is the array that
    // actually reaches the judge. Present on every spec, including fallback and over-limit
    // ones — WHETHER to pin it is index.js's decision, not this function's.
    fingerprint: specFingerprint(mapped),
    total: mapped.length,
    mappedCount: mapped.filter((c) => c.mapped).length,
    size: {
      renderedChars,
      limitChars: maxCriteriaChars,
      overLimit: renderedChars > maxCriteriaChars,
    },
  };
}

module.exports = {
  buildSpec, extractCriteria, linkedIssueNumbers, mapCriterion, keywords, criteriaCapChars,
  specFingerprint, normKey,
};
