/**
 * calibration.js — turn logged verdicts + post-merge outcomes into metrics.
 *
 * Felix is framed as a *defect detector*: a positive prediction is NOT VERIFIED
 * (Felix flags a problem). After a PR merges, a human (or automation) records the
 * real outcome — `clean` or `defect` — on its felix_verdicts row. From the pairs
 * we compute a confusion matrix and precision/recall, so signal weights and the
 * judge's strictness can be tuned from real data instead of guesswork.
 *
 *   TP: NOT VERIFIED + defect   (correctly flagged)
 *   FP: NOT VERIFIED + clean    (false alarm)
 *   FN: VERIFIED     + defect   (escaped defect — the costly one)
 *   TN: VERIFIED     + clean    (correctly passed)
 *
 * INSUFFICIENT EVIDENCE and SKIPPED are not decisive predictions, so they are
 * counted but excluded from precision/recall.
 *
 * computeMetrics is pure (no I/O) and unit-tested.
 */

const OUTCOMES = { CLEAN: 'clean', DEFECT: 'defect', UNKNOWN: 'unknown' };
const DECISIVE = new Set(['VERIFIED', 'NOT VERIFIED']);

/**
 * @param {Array<{verdict:string, outcome?:string}>} rows
 * @returns {object} metrics
 */
function computeMetrics(rows = []) {
  const m = {
    total: rows.length,
    scored: 0,
    tp: 0, fp: 0, fn: 0, tn: 0,
    byVerdict: {},
    precision: null,
    recall: null,
    accuracy: null,
    escapedDefects: 0,
  };

  for (const r of rows) {
    const v = r.verdict || 'UNKNOWN';
    m.byVerdict[v] = (m.byVerdict[v] || 0) + 1;

    const outcome = r.outcome;
    if (!outcome || outcome === OUTCOMES.UNKNOWN) continue;
    if (!DECISIVE.has(v)) continue;

    m.scored++;
    const flagged = v === 'NOT VERIFIED';
    const defect = outcome === OUTCOMES.DEFECT;
    if (flagged && defect) m.tp++;
    else if (flagged && !defect) m.fp++;
    else if (!flagged && defect) m.fn++;
    else m.tn++;
  }

  m.escapedDefects = m.fn;
  const flaggedTotal = m.tp + m.fp;
  const actualDefects = m.tp + m.fn;
  m.precision = flaggedTotal ? m.tp / flaggedTotal : null;
  m.recall = actualDefects ? m.tp / actualDefects : null;
  m.accuracy = m.scored ? (m.tp + m.tn) / m.scored : null;
  return m;
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/** Human-readable one-screen summary for the CLI. */
function formatMetrics(m) {
  const lines = [
    `Felix calibration — ${m.total} verdict(s), ${m.scored} scored`,
    `  by verdict: ${Object.entries(m.byVerdict).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`,
    `  confusion : TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn}`,
    `  precision : ${pct(m.precision)}   recall: ${pct(m.recall)}   accuracy: ${pct(m.accuracy)}`,
    `  escaped defects (VERIFIED→defect): ${m.escapedDefects}`,
  ];
  return lines.join('\n');
}

module.exports = { computeMetrics, formatMetrics, OUTCOMES, DECISIVE };
