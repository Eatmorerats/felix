/**
 * prompt.js — builds the judge's prompt string.
 *
 * Pure and dependency-free: given the PR title, criteria, diff, Tier 1 outputs and the two
 * mode flags (adversarial, chunk), it returns the exact text sent to the vendor. Both judge
 * families are held to the identical output schema produced here, so the shared parser in
 * judge.js can turn either vendor's raw JSON into the common verdict shape.
 */

/**
 * @param {{index:number,total:number}} [chunk] Set when the diff was too large for one
 *   call and is being judged in several passes. A judge seeing only PART of a diff must
 *   NOT report "not met" for something it simply cannot see — that false negative is
 *   indistinguishable from a real finding. So chunked mode swaps the boolean `met` for a
 *   three-valued verdict and mergeChunkRulings reassembles it (see there for why the two
 *   directions merge differently).
 */
function buildPrompt({ prTitle, criteria, diff, tier1, adversarial = false, chunk = null }) {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
  const checks = tier1
    .map((c) => `- ${c.name}: ${c.status.toUpperCase()} (${c.detail})`)
    .join('\n');
  const tier1Output = tier1
    .filter((c) => c.status === 'fail' && c.output)
    .map((c) => `### ${c.name} output\n${c.output}`)
    .join('\n\n');

  // No truncation here any more. The caller (runSeat) sizes the diff against the seat's
  // rate limit before we ever get here, and splits it if it doesn't fit — so whatever
  // arrives is already known to be within budget.
  const diffText = String(diff || '');
  const chunked = Boolean(chunk && chunk.total > 1);

  // Two grading modes. Adversarial "refute-first" forces the judge to state the strongest
  // reason each criterion is NOT met BEFORE deciding — the commit-then-grade technique that
  // sharply cuts over-eager "met" (false-positive) verdicts. Opt-in; default keeps the plain
  // prompt so existing behavior is unchanged until a repo turns it on.
  const instructions = adversarial ? [
    'You are a SKEPTICAL independent verification judge. You did NOT write this code. Your job is',
    'to catch PRs that only APPEAR to satisfy their acceptance criteria.',
    'For EACH criterion, work strictly in this order:',
    '  1. REFUTE — write the single strongest CONCRETE reason the submitted code does NOT satisfy',
    '     the criterion: a missing case, an unhandled path, a mock hiding real behavior, an',
    '     unimplemented branch. Ground it in the actual diff + test evidence, not speculation.',
    '  2. DECIDE — mark met:true ONLY if that refutation clearly fails against the diff + test',
    '     evidence. If the refutation stands, or the evidence is ambiguous or absent, mark met:false.',
    'Judge behavior and evidence, not intentions. The diff includes the full added source for new',
    'files, so an implementation present in the diff counts as shown. When unsure, prefer met:false.',
  ] : [
    'You are an independent verification judge. You did NOT write this code.',
    'Decide, for each acceptance criterion, whether the SUBMITTED CODE actually satisfies it.',
    'Judge behavior and evidence — not intentions. If the diff plus test results do not',
    'clearly demonstrate a criterion is met, mark it not met. Note: the diff includes the',
    'full added source for new files, so an implementation present in the diff counts as shown.',
  ];

  // In chunked mode the ONLY change to the grading rules is that "I can't see it here" gets
  // its own answer, distinct from "I looked and it's wrong". Everything else — including the
  // adversarial refute-first discipline above — is untouched.
  //
  // The "WHAT IS SPLIT" paragraph is load-bearing, not decoration. Without it every option
  // below reads as "…this part…", so a judge asked whether the build passes correctly answers
  // that a SLICE OF A DIFF cannot show that — in all N parts — and mergeChunkRulings sees
  // all-not_shown ⇒ NOT met. That is what happened on a large real PR: `build/smoke — exit 0` was
  // sitting in all 4 prompts and every part still answered not_shown. Only the DIFF is split;
  // the checks ran once over the whole PR and appear whole in every part.
  const chunkInstructions = chunked ? [
    '',
    `IMPORTANT: you are being shown PART ${chunk.index} OF ${chunk.total} of a large diff.`,
    'The files in this part are complete, but other parts contain other files you cannot see.',
    'WHAT IS SPLIT: only the UNIFIED DIFF. The DETERMINISTIC CHECK RESULTS (Tier 1) section is',
    'GLOBAL — those commands ran once against the WHOLE pull request, and you are seeing their',
    'complete results, identical in every part. So for a criterion about the OUTCOME OF A CHECK',
    '(e.g. "`npm run build` exits 0", "the test suite passes", "lint is clean"), decide it from',
    'that result and answer "met" or "violated" in EVERY part — NEVER "not_shown". That evidence',
    'is not split and is fully in front of you. This does not make a green check evidence for',
    'criteria about code: a passing build says nothing about whether a feature was implemented.',
    'For each criterion answer with exactly one verdict:',
    '  "met"       — this part of the diff, or the global check results, shows the criterion IS satisfied.',
    '  "violated"  — this part of the diff, or the global check results, shows it is NOT satisfied.',
    '  "not_shown" — neither this part nor the check results bears on the criterion either way.',
    'Use "not_shown" freely for criteria about code. Do NOT answer "violated" merely because the',
    'relevant code is absent from this part — absence here is expected and is what "not_shown" means.',
  ] : [];

  const responseFormat = chunked
    ? (adversarial
      ? '{"assessment":"<2-3 sentence summary of THIS part>","criteria":[{"text":"<criterion>","refutation":"<strongest reason it is NOT met, or empty if not_shown>","verdict":"met"|"violated"|"not_shown","reason":"<short>"}]}'
      : '{"assessment":"<2-3 sentence summary of THIS part>","criteria":[{"text":"<criterion>","verdict":"met"|"violated"|"not_shown","reason":"<short>"}]}')
    : (adversarial
      ? '{"assessment":"<2-3 sentence summary>","criteria":[{"text":"<criterion>","refutation":"<strongest reason it is NOT met>","met":true|false,"reason":"<why the refutation does or does not hold>"}]}'
      : '{"assessment":"<2-3 sentence summary>","criteria":[{"text":"<criterion>","met":true|false,"reason":"<short>"}]}');

  return [
    ...instructions,
    ...chunkInstructions,
    '',
    `PR title: ${prTitle}`,
    '',
    'ACCEPTANCE CRITERIA:',
    criteriaList || '(none provided)',
    '',
    'DETERMINISTIC CHECK RESULTS (Tier 1):',
    checks || '(none)',
    tier1Output ? `\nFAILING CHECK OUTPUT:\n${tier1Output}` : '',
    '',
    chunked ? `UNIFIED DIFF (part ${chunk.index} of ${chunk.total}):` : 'UNIFIED DIFF:',
    '```diff',
    diffText,
    '```',
    '',
    'Respond with ONLY JSON of the form:',
    responseFormat,
  ].join('\n');
}

module.exports = { buildPrompt };
