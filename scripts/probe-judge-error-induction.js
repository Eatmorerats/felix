#!/usr/bin/env node
/**
 * probe-judge-error-induction.js — HOW a PR reaches judge_error, and that the cap now stops it.
 *
 * ── PART 1: the diagnosis (why the mitigation is shaped the way it is) ───────────────────────
 *
 * PR #12 made judge_error a blocking cause on the strength of a claim that was written but
 * never measured: "acceptance criteria come verbatim from the attacker-written PR body, and
 * judge.js throws when criteria overhead alone exceeds the seat budget, so a large PR body
 * reliably induces judge_error."
 *
 * The first half is true. The conclusion was wrong, and this probe is why the wording changed.
 * GitHub caps a PR body at 65,536 characters. The smallest shipped seat budgets
 * 30,000 * SAFETY_FACTOR = 25,500 tokens, which at CHARS_PER_TOKEN is ~102,000 characters. A
 * body filled to GitHub's own limit lands ~37% short of that. It cannot get there alone.
 *
 * What gets there is buildSpec CONCATENATING linked issues (spec.js) — index.js fetches up to
 * ten, each with its own 65,536-char body, and dedupe() only collapses identical lines. One
 * linked issue is enough to double the overhead and clear the budget.
 *
 * Why the distinction was load-bearing rather than pedantic: the mitigation differs. A cap on
 * the PR body would have closed nothing. Any cap has to apply to the MERGED criteria set, after
 * the issues are folded in.
 *
 * ── PART 2: the receipt (that the shipped cap actually fires) ────────────────────────────────
 *
 * buildSpec now measures the merged, RENDERED criteria set against a cap derived from the
 * smallest seat, and verdict.js turns an overrun into a blocking `spec_too_large` — checked
 * here end to end, because a cap that is never reached from a real PR shape defends nothing.
 *
 * Note the cap binds BELOW the induction threshold: a maxed body ALONE is refused even though
 * it could never have induced judge_error, because the criteria must also leave room for the
 * diff. That is deliberate, and it is asserted rather than assumed.
 *
 * judge_error stays attacker-reachable by other routes — CHARS_PER_TOKEN is an English/code
 * approximation, so a non-Latin-script payload passes the local budget check and is refused by
 * the vendor instead — so #12's decision to block on it is unchanged by any of this.
 *
 * Exits non-zero if either half stops holding.
 */
const { buildSpec, criteriaCapChars } = require('../src/engine/spec');
const { buildPrompt } = require('../src/engine/prompt');
const { planJudgeCalls, SAFETY_FACTOR, CHARS_PER_TOKEN, seatBudgetChars } = require('../src/engine/budget');
const { PROVIDERS } = require('../src/engine/providers');
const { compose, CAUSES, VERDICTS, conclusionFor } = require('../src/engine/verdict');

/** GitHub's hard limit on the body of a pull request or an issue. */
const GH_BODY_MAX = 65_536;

/** The smallest budget Felix ships, which is the easiest one to overrun. */
const SMALL_SEAT = Math.min(
  ...Object.values(PROVIDERS).map((p) => p.maxPromptTokens).filter(Boolean)
);

const tier1 = [];

// A line that survives extractCriteria: a checkbox bullet under a criteria heading, longer
// than the 4-char minimum. Padded to a fixed width so the fill math is exact.
// The salt goes INSIDE the criterion text, never in front of the bullet: a leading character
// stops the line matching extractCriteria's bullet pattern at all, so the issue contributes
// zero criteria and the probe measures nothing while looking like it measured something.
const line = (n, width, salt = '') =>
  `- [ ] ${salt}${String(n).padStart(6, '0')} ${'x'.repeat(Math.max(0, width - 14 - salt.length))}`;

/** A body filled as close to GitHub's cap as whole criteria lines allow. */
function maxBody(width, salt = '') {
  const head = '## Acceptance criteria\n';
  const n = Math.floor((GH_BODY_MAX - head.length) / (width + 1));
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(line(i, width, salt));
  const text = head + lines.join('\n');
  if (text.length > GH_BODY_MAX) throw new Error(`built a ${text.length}-char body over the ${GH_BODY_MAX} cap`);
  return text;
}

/**
 * Measure BOTH things for one PR shape:
 *   - what judge.js would have done (the overhead at its throw site), and
 *   - what Felix now does instead (the spec cap, and the verdict it composes to).
 */
function measure(prBody, issueBodies) {
  const issues = issueBodies.map((body, i) => ({ number: 100 + i, title: 't', body }));
  const spec = buildSpec({ title: 'x', body: prBody }, issues, []);
  const overheadChars = buildPrompt({
    prTitle: 'x', criteria: spec.criteria, diff: '', tier1, adversarial: false,
  }).length;
  const plan = planJudgeCalls({
    diff: 'diff --git a/a b/a\n+one line\n',
    overheadChars,
    maxPromptTokens: SMALL_SEAT,
  });
  const verdict = compose({ spec, tier1, tier3: null, judgeStatus: { configured: true } });
  return {
    criteria: spec.total,
    overheadChars,
    overBudget: plan.coverage.overBudget,
    renderedChars: spec.size.renderedChars,
    overLimit: spec.size.overLimit,
    cause: verdict.cause,
    conclusion: conclusionFor(verdict.verdict),
  };
}

const budgetTokens = Math.floor(SMALL_SEAT * SAFETY_FACTOR);
const budgetChars = seatBudgetChars(SMALL_SEAT);
const cap = criteriaCapChars();

console.log('\nFelix — how a PR reaches judge_error, and that the cap now refuses it first\n');
console.log(`  smallest seat   ${SMALL_SEAT} tokens x ${SAFETY_FACTOR} = ${budgetTokens} tokens`);
console.log(`                  = ${budgetChars} chars at ${CHARS_PER_TOKEN} chars/token`);
console.log(`  criteria cap    ${cap} rendered chars (the merged set, after linked issues)`);
console.log(`  GitHub body cap ${GH_BODY_MAX} chars (a PR body AND each issue body)\n`);

const problems = [];

// Two criterion widths, because the count and the char total are different levers and a
// mitigation might cap either one. Both must tell the same story.
for (const width of [40, 120]) {
  const prBody = maxBody(width);
  const alone = measure(prBody, []);
  const plusOne = measure(prBody, [maxBody(width, 'a')]);

  const row = (label, m) =>
    `    ${label.padEnd(20)} ${String(m.criteria).padStart(5)} criteria  ` +
    `overhead ${String(m.overheadChars).padStart(7)}  overBudget=${String(m.overBudget).padEnd(5)}` +
    `  ${m.cause}`;

  console.log(`  criterion width ${width} chars — PR body filled to ${prBody.length}/${GH_BODY_MAX}`);
  console.log(row('PR body alone', alone));
  console.log(row('+ 1 linked issue', plusOne));

  // ── PART 1: the unmitigated diagnosis still holds ──────────────────────────────────────
  if (alone.overBudget) {
    problems.push(
      `width ${width}: a maxed PR body ALONE now overruns the seat budget (overhead ` +
      `${alone.overheadChars} > ${budgetChars}). The body-only lane is open — a cap that ` +
      'only counts linked issues would not close it.'
    );
  }
  if (!plusOne.overBudget) {
    problems.push(
      `width ${width}: one linked issue no longer overruns the budget (overhead ` +
      `${plusOne.overheadChars} <= ${budgetChars}). Either the budget moved, or the criteria ` +
      'are no longer concatenated — update this probe and the docs it backs.'
    );
  }

  // ── PART 2: the cap fires, from a real PR shape, all the way to a red check ────────────
  for (const [label, m] of [['PR body alone', alone], ['+ 1 linked issue', plusOne]]) {
    if (!m.overLimit) {
      problems.push(
        `width ${width}, ${label}: the merged set (${m.renderedChars} rendered chars) was NOT ` +
        `flagged against the ${cap}-char cap. The mitigation does not fire on a real PR shape.`
      );
    }
    if (m.cause !== CAUSES.SPEC_TOO_LARGE) {
      problems.push(
        `width ${width}, ${label}: composed to "${m.cause}", not "${CAUSES.SPEC_TOO_LARGE}". ` +
        'The cap is measured but not acted on.'
      );
    }
    if (m.conclusion !== 'failure') {
      problems.push(
        `width ${width}, ${label}: check conclusion is "${m.conclusion}", not "failure". ` +
        'GitHub counts neutral as PASSING, so this would be a green light on an inducible state.'
      );
    }
  }
  console.log('');
}

if (problems.length) {
  console.log('DIAGNOSIS REFUTED — the measured induction path or its mitigation has changed:\n');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('');
  process.exit(1);
}

console.log('RESULT: the PR body alone falls short of the smallest seat budget; folding in one');
console.log('        linked issue clears it — so the cap applies to the MERGED set, after');
console.log('        buildSpec concatenates the issues. Capping the body would defend nothing.');
console.log(`        Both shapes are now refused up front as ${CAUSES.SPEC_TOO_LARGE} ` +
  `(${VERDICTS.NOT_VERIFIED} -> failure),`);
console.log('        before the judge is ever called.\n');
