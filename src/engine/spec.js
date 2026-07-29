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
 */

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
        if (txt.length > 3) out.push(txt);
      }
    }
  }
  return dedupe(out);
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter((s) => {
    const k = s.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

/**
 * Build the spec model.
 * @param {object} pr  PR object (needs .title, .body)
 * @param {Array}  issues  fetched linked-issue objects ({number, title, body})
 * @param {Array}  files  changed files ({filename, ...})
 */
function buildSpec(pr, issues, files) {
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

  return {
    source: sources.length ? sources.join(', ') : null,
    hadRealSpec,
    criteria: mapped,
    total: mapped.length,
    mappedCount: mapped.filter((c) => c.mapped).length,
  };
}

module.exports = { buildSpec, extractCriteria, linkedIssueNumbers, mapCriterion, keywords };
