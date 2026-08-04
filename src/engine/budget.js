/**
 * budget.js — size a judge prompt against the account's RATE LIMIT, not the model's
 * context window.
 *
 * Why this module exists: Felix shipped with `MAX_DIFF_CHARS = 240000` ("~60K tokens,
 * comfortably within budget"), a number taken from gpt-4.1's CONTEXT WINDOW. But an
 * OpenAI org also has a tokens-per-minute (TPM) ceiling, and on this account that ceiling
 * is 30,000 — half the cap. So every PR big enough to actually reach the cap was
 * *guaranteed* to 429:
 *
 *   429 Request too large for gpt-4.1 … tokens per min (TPM): Limit 30000, Requested 61227
 *
 * That is how Felix returned INSUFFICIENT EVIDENCE on a large real PR. A prompt can fit the window
 * and still be refused by the rate limiter — the two limits are unrelated, and the smaller
 * one governs.
 *
 * The fix is not just a smaller cap. A smaller cap silently drops the tail of a big diff,
 * which reads as "criterion not shown in the diff" — a false negative that looks exactly
 * like a real finding. Instead we split the diff at file boundaries and judge it in
 * several passes, so a large PR degrades to PARTIAL evidence (with the coverage stated)
 * rather than NO evidence.
 *
 * Everything here is pure and synchronous so it can be tested offline with no network.
 */

// Tokens are estimated, never counted — we have no tokenizer and don't want the dependency.
// ~4 characters per token is the standard English/code approximation, and it held on the
// live failure that motivated this module (240 KB of diff ⇒ ~60K tokens estimated, 61,227
// actually billed, ~2% under).
const CHARS_PER_TOKEN = 4;

// Spend only this fraction of the stated budget. Covers the ~2% estimator drift above plus
// the model's own reply, which counts against the SAME per-minute pool as the prompt.
const SAFETY_FACTOR = 0.85;

// Hard ceiling on judge calls per seat per PR. Chunks are paced against TPM (see
// paceMs), so each extra chunk costs real wall-clock in CI. Past this we stop and report
// the shortfall instead of letting one enormous PR run for ten minutes.
const DEFAULT_MAX_CHUNKS = 6;

/**
 * How the smallest seat's prompt budget is divided among the regions that are NOT diff.
 *
 * EVERY region below is written by the pull request under review: the criteria come from its
 * body and the issues it links, `checks` carries its changed-file paths, and `tier1Output` is
 * the stdout of its own code. Left unbounded, any ONE of them pushes prompt overhead past the
 * seat budget by itself — which throws in runSeat and lands the PR on `judge_error`. Measured:
 * a PR body filled to GitHub's 65,536-char cap falls ~37% short alone, but folding in one
 * linked issue clears it (scripts/probe-judge-error-induction.js).
 *
 * Fractions of the smallest seat rather than absolute numbers, so the relationship survives an
 * edit to SAFETY_FACTOR, CHARS_PER_TOKEN, or any provider's ceiling. The suite pins the
 * relationship, not the numbers.
 *
 * THE TWO KINDS OF OVERFLOW ARE NOT HANDLED THE SAME WAY, and that asymmetry is the design:
 *
 *   criteria    are the QUESTION being asked. Dropping some grades a subset and reports the
 *               result as complete — which is not a degradation but a BYPASS PRIMITIVE: an
 *               author pushes the one criterion their code violates past the cutoff and
 *               collects VERIFIED on the survivors. So overflow BLOCKS, loudly, and Felix
 *               grades nothing (verdict.js `spec_too_large`).
 *   tier1Output is EVIDENCE, and so is `checks`. Showing less of it is an honest degradation
 *               so long as the judge can see that it happened — so overflow TRUNCATES with a
 *               visible marker, the same contract packChunks uses for an oversized file.
 */
const PROMPT_REGION_FRACTIONS = Object.freeze({
  criteria: 0.40,
  tier1Output: 0.15,
  checks: 0.05,
});

/**
 * What must survive for the diff once every non-diff region sits at its cap.
 *
 * Not enforced at runtime — it is the invariant the suite pins, so raising a fraction above
 * fails a test instead of quietly starving the judge of the code it exists to read. A judge
 * shown no diff does not report "I saw nothing"; it reports criteria as NOT met, which is
 * indistinguishable from a real finding.
 */
const DIFF_FLOOR_FRACTION = 0.30;

/** Estimated token count for a string. Deliberately conservative — see CHARS_PER_TOKEN. */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

/** Characters that fit in a token budget. Inverse of estimateTokens. */
function tokensToChars(tokens) {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

/**
 * Split a unified diff into per-file units.
 *
 * Splitting on `diff --git` keeps every chunk independently readable: a judge that sees a
 * chunk sees whole files, never half a hunk. Any preamble before the first `diff --git`
 * (rare, but git can emit one) is preserved as its own leading unit rather than dropped.
 */
function splitDiffByFile(diff) {
  const text = String(diff || '');
  if (!text) return [];

  const units = [];
  const lines = text.split('\n');
  let current = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) units.push(current);
      current = { path: parseDiffPath(line), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      // Preamble before the first file header.
      current = { path: '(preamble)', lines: [line] };
    }
  }
  if (current) units.push(current);

  return units.map((u) => ({ path: u.path, text: u.lines.join('\n') }));
}

/** Best-effort b-side path out of a `diff --git a/x b/y` header, for coverage reporting. */
function parseDiffPath(headerLine) {
  const m = String(headerLine).match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (m) return m[2];
  return String(headerLine).replace(/^diff --git\s*/, '').trim() || '(unknown)';
}

/**
 * Pack per-file diff units into chunks that each fit `budgetChars`.
 *
 * Greedy and order-preserving: files stay adjacent to their neighbours, so a chunk reads
 * like a coherent slice of the PR. A single file larger than the whole budget cannot be
 * packed, so it is truncated with an explicit marker — never silently — and the omission
 * is reported so the verdict can say the diff was only partly seen.
 *
 * @returns {{chunks: {text, paths, truncatedPaths}[], omittedPaths: string[], omittedChars: number}}
 */
function packChunks(units, budgetChars, { maxChunks = DEFAULT_MAX_CHUNKS } = {}) {
  const chunks = [];
  let current = { parts: [], paths: [], truncatedPaths: [], size: 0 };

  const flush = () => {
    if (current.parts.length) {
      chunks.push({
        text: current.parts.join('\n'),
        paths: current.paths,
        truncatedPaths: current.truncatedPaths,
      });
    }
    current = { parts: [], paths: [], truncatedPaths: [], size: 0 };
  };

  for (const unit of units) {
    if (unit.text.length > budgetChars) {
      // One file bigger than an entire chunk. Truncating loses evidence, so say so inline
      // (the judge sees the marker) AND structurally (truncatedPaths feeds coverage).
      flush();
      const kept = unit.text.slice(0, budgetChars);
      const dropped = unit.text.length - kept.length;
      chunks.push({
        text: `${kept}\n…(${unit.path} truncated — ${dropped} of ${unit.text.length} chars not shown)…`,
        paths: [unit.path],
        truncatedPaths: [unit.path],
      });
      continue;
    }
    // +1 for the newline join.
    if (current.size && current.size + unit.text.length + 1 > budgetChars) flush();
    current.parts.push(unit.text);
    current.paths.push(unit.path);
    current.size += unit.text.length + 1;
  }
  flush();

  if (chunks.length <= maxChunks) return { chunks, omittedPaths: [], omittedChars: 0 };

  // Too many chunks: keep the first maxChunks and report exactly what was dropped, so the
  // verdict can state partial coverage instead of implying the whole diff was judged.
  const kept = chunks.slice(0, maxChunks);
  const dropped = chunks.slice(maxChunks);
  return {
    chunks: kept,
    omittedPaths: dropped.flatMap((c) => c.paths),
    omittedChars: dropped.reduce((n, c) => n + c.text.length, 0),
  };
}

/**
 * Plan the judge calls for one seat.
 *
 * `overheadChars` is everything in the prompt that is NOT diff — instructions, criteria,
 * Tier 1 results, failing-check output, the response schema. Budgeting against the diff
 * alone is what produced the original bug: the live 429 asked for 61,227 tokens when the
 * diff cap alone was sized at ~60,000.
 *
 * @returns {{chunks, singlePass: boolean, coverage: {...}}}
 */
function planJudgeCalls({ diff, overheadChars, maxPromptTokens, maxChunks = DEFAULT_MAX_CHUNKS }) {
  const text = String(diff || '');
  const budgetTokens = Math.floor(maxPromptTokens * SAFETY_FACTOR);
  const budgetChars = tokensToChars(budgetTokens) - overheadChars;

  // Overhead alone can exceed the budget (a tiny TPM, or a spec with very many criteria).
  // There is no useful call to make in that case; the caller reports it rather than firing
  // a request we know will 429.
  if (budgetChars <= 0) {
    return {
      chunks: [],
      singlePass: false,
      coverage: {
        totalChars: text.length, judgedChars: 0, chunkCount: 0,
        omittedPaths: [], omittedChars: text.length, truncatedPaths: [],
        overBudget: true,
      },
    };
  }

  if (text.length <= budgetChars) {
    // Fits in one call — byte-for-byte the pre-existing single-pass behavior.
    return {
      chunks: [{ text, paths: splitDiffByFile(text).map((u) => u.path), truncatedPaths: [] }],
      singlePass: true,
      coverage: {
        totalChars: text.length, judgedChars: text.length, chunkCount: 1,
        omittedPaths: [], omittedChars: 0, truncatedPaths: [], overBudget: false,
      },
    };
  }

  const units = splitDiffByFile(text);
  const { chunks, omittedPaths, omittedChars } = packChunks(units, budgetChars, { maxChunks });
  const truncatedPaths = chunks.flatMap((c) => c.truncatedPaths);

  return {
    chunks,
    singlePass: false,
    coverage: {
      totalChars: text.length,
      judgedChars: chunks.reduce((n, c) => n + c.text.length, 0),
      chunkCount: chunks.length,
      omittedPaths,
      omittedChars,
      truncatedPaths,
      overBudget: false,
    },
  };
}

/**
 * How long to wait before the next call on the same seat, so a multi-chunk run stays under
 * the per-MINUTE ceiling.
 *
 * This is the part a naive "just make the chunks smaller" fix misses: TPM is a RATE. Three
 * 25K-token chunks fired back-to-back is 75K tokens inside one minute and 429s just as hard
 * as a single 75K request. Spending `tokens` therefore buys the seat `tokens/TPM` of a
 * minute, and we wait that long before spending again.
 */
function paceMs(tokensJustSpent, tpm) {
  if (!tpm || tpm <= 0) return 0;
  return Math.max(0, Math.ceil((tokensJustSpent / tpm) * 60_000));
}

/** Characters a seat may actually spend on a prompt, after the safety factor. */
function seatBudgetChars(maxPromptTokens) {
  return tokensToChars(Math.floor(Number(maxPromptTokens) * SAFETY_FACTOR));
}

/** The cap for one non-diff prompt region, in characters. See PROMPT_REGION_FRACTIONS. */
function regionCapChars(region, maxPromptTokens) {
  const fraction = PROMPT_REGION_FRACTIONS[region];
  if (!fraction) {
    throw new Error(
      `Unknown prompt region "${region}". Known regions: ${Object.keys(PROMPT_REGION_FRACTIONS).join(', ')}.`
    );
  }
  return Math.floor(seatBudgetChars(maxPromptTokens) * fraction);
}

/** The smallest maxPromptTokens any shipped provider declares — the easiest one to overrun. */
function smallestSeatTokens(providers) {
  const budgets = Object.values(providers || {})
    .map((p) => p && p.maxPromptTokens)
    .filter(Boolean);
  if (!budgets.length) throw new Error('No judge provider declares a maxPromptTokens budget.');
  return Math.min(...budgets);
}

/**
 * The one token budget every PR-authored region is sized against.
 *
 * Deliberately the REGISTRY minimum, not the seated one. Which vendor keys a repo happens to
 * hold must not decide whether a PR is verifiable — otherwise the same PR is gradeable in one
 * repo and blocked in another for a reason its author cannot see, and a repo that adds a
 * second key silently changes its own verdicts. Take the strictest seat Felix ships and hold
 * everyone to it.
 *
 * FELIX_JUDGE_MAX_PROMPT_TOKENS is honored because it lowers EVERY seat (judge.js applies it
 * across the board), so a repo on a small rate-limit tier gets caps that fit its real ceiling
 * instead of caps sized for a seat it does not have — which would defend nothing.
 */
function promptBudgetTokens(env, providers) {
  const override = Number((env || {}).FELIX_JUDGE_MAX_PROMPT_TOKENS);
  if (override > 0) return override;
  return smallestSeatTokens(providers);
}

module.exports = {
  estimateTokens, tokensToChars, splitDiffByFile, packChunks, planJudgeCalls, paceMs,
  seatBudgetChars, regionCapChars, smallestSeatTokens, promptBudgetTokens,
  CHARS_PER_TOKEN, SAFETY_FACTOR, DEFAULT_MAX_CHUNKS,
  PROMPT_REGION_FRACTIONS, DIFF_FLOOR_FRACTION,
};
