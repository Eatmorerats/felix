/**
 * merge.js — reassemble judge verdicts.
 *
 * Two merges live here and they run in OPPOSITE directions on purpose:
 *   • across CHUNKS (one seat, several passes over a split diff) the merge is closer to OR —
 *     the slices are disjoint pieces of ONE body of evidence (mergeChunkRulings);
 *   • across VENDORS (the jury) the merge is AND — two independent opinions, so agreement
 *     must be earned (mergeJuryResults).
 * Plus describeCoverage (the honest "how much did we see" line) and two private helpers,
 * findRuling / normText, that locate a judge's ruling for a given criterion. Dependency-free.
 */

const normText = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Find one judge's ruling on a given spec criterion. Judges are prompted with the criteria
 * in order and asked to echo the text back, but wording drifts — so match on normalized
 * text first and fall back to position. A criterion a judge never ruled on returns null,
 * which the merge treats as NOT met: silence is never taken as a pass.
 */
function findRuling(result, criterionText, index) {
  const list = Array.isArray(result.criteria) ? result.criteria : [];
  const target = normText(criterionText);
  return list.find((c) => normText(c.text) === target) || list[index] || null;
}

/**
 * Read one chunk's answer for a criterion as met | violated | not_shown.
 *
 * Chunked prompts ask for a three-valued `verdict` string, but a model can ignore the
 * schema and send the boolean `met` from the single-pass format. The fallback maps
 * met:false to "not_shown", NOT to "violated" — deliberately. A chunk that simply doesn't
 * contain the relevant file will say "not met", and promoting that to a violation would
 * recreate the exact false-negative this whole change exists to remove. Nothing is lost by
 * being lenient here: if EVERY chunk comes back not_shown the criterion still fails (see
 * mergeChunkRulings), so the fallback can never manufacture a pass.
 */
function chunkVerdict(ruling) {
  if (!ruling) return null;
  const v = String(ruling.verdict || '').trim().toLowerCase();
  if (v === 'met' || v === 'violated' || v === 'not_shown') return v;
  if (ruling.met === true) return 'met';
  if (ruling.met === false) return 'not_shown';
  return null;
}

/**
 * mergeChunkRulings — reassemble one seat's verdict from several passes over a split diff.
 *
 * This merges in the OPPOSITE direction from the jury merge below, and the asymmetry is
 * deliberate:
 *
 *   • Across VENDORS (mergeJuryResults) the merge is AND. Two vendors are two independent
 *     opinions on the same evidence, so agreement must be earned.
 *   • Across CHUNKS (here) the merge is closer to OR. The chunks are not independent
 *     opinions — they are disjoint slices of ONE body of evidence. Requiring every slice to
 *     confirm a criterion would fail every criterion whose implementation lives in a single
 *     file, which is most of them.
 *
 * Precedence is violated > met > all-not_shown:
 *   - a concrete violation anywhere beats confirmation elsewhere (a universal criterion like
 *     "no secrets are logged" must not pass because four of five slices looked clean);
 *   - otherwise positive evidence in any slice carries it (an existential criterion like
 *     "adds a retry helper" is satisfied by the one slice containing the helper);
 *   - if no slice showed anything, the criterion is NOT met — silence is never a pass, the
 *     same rule the jury merge applies to a silent vendor.
 */
function mergeChunkRulings({ specCriteria = [], chunkResults, coverage, family, model, adversarial = false }) {
  const criteria = specCriteria.map((sc, i) => {
    const rulings = chunkResults.map((r, ci) => ({
      part: ci + 1,
      ruling: findRuling(r, sc.text, i),
      verdict: chunkVerdict(findRuling(r, sc.text, i)),
    }));

    const violated = rulings.filter((v) => v.verdict === 'violated');
    const affirmed = rulings.filter((v) => v.verdict === 'met');

    if (violated.length) {
      const v = violated[0];
      return {
        text: sc.text, met: false,
        reason: `Part ${v.part} of ${chunkResults.length} found a violation: ${v.ruling.reason || '(no reason given)'}`,
      };
    }
    if (affirmed.length) {
      const a = affirmed[0];
      return {
        text: sc.text, met: true,
        reason: `${a.ruling.reason || 'met'} (evidence in part ${a.part} of ${chunkResults.length})`,
      };
    }
    return {
      text: sc.text, met: false,
      reason: `No part of the diff showed evidence for this criterion (judged in ${chunkResults.length} parts).`,
    };
  });

  return {
    family, model, adversarial,
    chunked: true,
    coverage,
    assessment: [describeCoverage(coverage), ...chunkResults.map((r, i) => `- part ${i + 1}: ${r.assessment || '(no assessment)'}`)].join('\n'),
    criteria,
  };
}

/** One-line, honest statement of how much of the diff the judge actually saw. */
function describeCoverage(coverage) {
  const pct = coverage.totalChars
    ? Math.round((coverage.judgedChars / coverage.totalChars) * 100)
    : 100;
  const parts = [`Diff too large for one call — judged in ${coverage.chunkCount} parts covering ~${pct}% of the diff`];
  if (coverage.omittedPaths.length) {
    parts.push(`PARTIAL: ${coverage.omittedPaths.length} file(s) not judged (${coverage.omittedPaths.slice(0, 5).join(', ')}${coverage.omittedPaths.length > 5 ? ', …' : ''})`);
  }
  if (coverage.truncatedPaths.length) {
    parts.push(`truncated: ${coverage.truncatedPaths.join(', ')}`);
  }
  return `${parts.join('. ')}.`;
}

/**
 * mergeJuryResults — conservative unanimity merge (R2b slice 2).
 *
 * A criterion counts as met ONLY if EVERY seated judge rules it met. One dissent — or one
 * judge that never ruled on it — blocks. That asymmetry is the entire point: the jury
 * exists to kill false "VERIFIED" verdicts, so agreement must be earned while disagreement
 * is cheap. The split is named in the reason so a human can see WHICH vendor objected and
 * why, rather than getting an unexplained downgrade.
 */
function mergeJuryResults({ specCriteria = [], results, failures = [], adversarial = false }) {
  const voters = results.map((r) => r.family);
  let splits = 0;

  const criteria = specCriteria.map((sc, i) => {
    const rulings = results.map((r) => ({ family: r.family, ruling: findRuling(r, sc.text, i) }));
    const silent = rulings.filter((v) => !v.ruling);
    const dissent = rulings.filter((v) => v.ruling && v.ruling.met !== true);
    const met = rulings.length > 0 && silent.length === 0 && dissent.length === 0;
    if (!met) splits += 1;

    let reason;
    if (met) {
      reason = `${rulings[0].ruling.reason || 'met'} (unanimous: ${voters.join(' + ')})`;
    } else {
      const parts = [
        ...dissent.map((d) => `${d.family} says NOT met: ${d.ruling.reason || '(no reason given)'}`),
        ...silent.map((s) => `${s.family} returned no ruling on this criterion`),
      ];
      const agreed = rulings.filter((v) => v.ruling && v.ruling.met === true).map((v) => v.family);
      if (agreed.length) parts.push(`${agreed.join(' + ')} say met`);
      reason = `Split verdict — ${parts.join('; ')}.`;
    }
    return { text: sc.text, met, reason };
  });

  const degraded = failures.length > 0;
  const header = [
    `${results.length}-vendor jury (${voters.join(' + ')}), unanimity required`,
    degraded ? `DEGRADED — ${failures.map((f) => `${f.family} unavailable: ${f.error}`).join('; ')}` : null,
    `${splits} of ${criteria.length} criteria split or unmet`,
  ].filter(Boolean).join('. ');

  return {
    family: voters.join('+'),
    model: results.map((r) => r.model).join('+'),
    adversarial,
    // Per-vendor detail is preserved so the log/comment can show who said what.
    jury: results.map((r) => ({
      family: r.family, model: r.model, assessment: r.assessment, criteria: r.criteria,
    })),
    degraded,
    failures,
    splits,
    assessment: [`${header}.`, ...results.map((r) => `- ${r.family}: ${r.assessment || '(no assessment)'}`)].join('\n'),
    criteria,
  };
}

module.exports = { chunkVerdict, mergeChunkRulings, mergeJuryResults, describeCoverage };
