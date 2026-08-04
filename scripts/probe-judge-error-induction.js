#!/usr/bin/env node
/**
 * probe-judge-error-induction.js — HOW a PR actually reaches judge_error.
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
 * What gets there is buildSpec CONCATENATING linked issues (spec.js) — index.js:206 fetches up
 * to ten, each with its own 65,536-char body, and dedupe() only collapses identical lines. One
 * linked issue is enough to double the overhead and clear the budget.
 *
 * Why the distinction is load-bearing rather than pedantic: the mitigation differs. A cap on
 * the PR body would close nothing. Any cap has to apply to the MERGED criteria set, after the
 * issues are folded in. Getting this wrong would ship a mitigation that measures clean and
 * defends nothing.
 *
 * judge_error stays attacker-reachable either way — in a public repo anyone may open the issue
 * that carries the payload — so #12's decision to block on it is unchanged by this.
 *
 * Exits non-zero if either half of the measured claim stops holding.
 */
const { buildSpec } = require('../src/engine/spec');
const { buildPrompt } = require('../src/engine/prompt');
const { planJudgeCalls, SAFETY_FACTOR, CHARS_PER_TOKEN } = require('../src/engine/budget');
const { PROVIDERS } = require('../src/engine/providers');

/** GitHub's hard limit on the body of a pull request or an issue. */
const GH_BODY_MAX = 65_536;

/** The smallest budget Felix ships, which is the easiest one to overrun. */
const SMALL_SEAT = Math.min(
  ...Object.values(PROVIDERS).map((p) => p.maxPromptTokens).filter(Boolean)
);

const tier1 = [];

// A line that survives extractCriteria: a checkbox bullet under a criteria heading, longer
// than the 3-char minimum. Padded to a fixed width so the fill math is exact.
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

/** Exactly what judge.js measures at its throw site: the whole prompt minus its diff. */
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
  return { criteria: spec.total, overheadChars, overBudget: plan.coverage.overBudget };
}

const budgetTokens = Math.floor(SMALL_SEAT * SAFETY_FACTOR);
const budgetChars = budgetTokens * CHARS_PER_TOKEN;

console.log('\nFelix — how a PR reaches judge_error\n');
console.log(`  smallest seat   ${SMALL_SEAT} tokens x ${SAFETY_FACTOR} = ${budgetTokens} tokens`);
console.log(`                  ~= ${budgetChars} chars at ${CHARS_PER_TOKEN} chars/token`);
console.log(`  GitHub body cap ${GH_BODY_MAX} chars (a PR body AND each issue body)\n`);

const problems = [];

// Two criterion widths, because the count and the char total are different levers and a
// mitigation might cap either one. Both must tell the same story.
for (const width of [40, 120]) {
  const prBody = maxBody(width);
  const alone = measure(prBody, []);
  const plusOne = measure(prBody, [maxBody(width, 'a')]);

  console.log(`  criterion width ${width} chars — PR body filled to ${prBody.length}/${GH_BODY_MAX}`);
  console.log(`    PR body alone        ${String(alone.criteria).padStart(5)} criteria  ` +
    `overhead ${String(alone.overheadChars).padStart(7)}  overBudget=${alone.overBudget}`);
  console.log(`    + 1 linked issue     ${String(plusOne.criteria).padStart(5)} criteria  ` +
    `overhead ${String(plusOne.overheadChars).padStart(7)}  overBudget=${plusOne.overBudget}` +
    `${plusOne.overBudget ? '   <-- judge_error' : ''}`);

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
      `${plusOne.overheadChars} <= ${budgetChars}). Either a cap landed — update this probe ` +
      'and the docs it backs — or the budget moved.'
    );
  }
  console.log('');
}

if (problems.length) {
  console.log('DIAGNOSIS REFUTED — the measured induction path has changed:\n');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('');
  process.exit(1);
}

console.log('RESULT: the PR body alone falls short of the smallest seat budget; folding in one');
console.log('        linked issue clears it. Any cap on criteria must apply to the MERGED set,');
console.log('        after buildSpec concatenates the issues — capping the body defends nothing.\n');
