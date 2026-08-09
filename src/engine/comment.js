/**
 * comment.js — render the verdict as a compact markdown PR comment.
 *
 * The hidden marker is added by github.upsertComment so re-runs edit one
 * comment instead of spamming the thread.
 */

const { version: PKG_VERSION } = require('../../package.json'); // single-source the version fallback

const BADGE = {
  'VERIFIED': '✅ **VERIFIED**',
  'NOT VERIFIED': '❌ **NOT VERIFIED**',
  'INSUFFICIENT EVIDENCE': '⚠️ **INSUFFICIENT EVIDENCE**',
  'SKIPPED': '⏭️ **SKIPPED**',
};

const ICON = { pass: '✅', fail: '❌', skip: '⏭️' };

/** Short form of a spec fingerprint — long enough to be unambiguous, short enough to read. */
const shortPin = (fp) => (fp ? String(fp).slice(0, 12) : '');

/**
 * Render what the freeze and the attempt cap did on this run, so a human can see WHICH criteria
 * set was graded and how much of the PR's judge budget is gone — the two facts a green check
 * silently depends on and that nothing else on the page shows.
 *
 * Every state is an icon PLUS a word ("🔒 frozen", "⚠️ CHANGED", "❓ not enforced"). Never an
 * icon alone and never colour alone: the reader may be colour blind, and this block is the one
 * place a reviewer looks to decide whether the criteria above are the ones Felix graded.
 *
 * Returns [] when there is nothing to say — a draft or triage-skipped run never reaches these
 * controls, and inventing a reassuring "frozen" line for a run that never checked would be worse
 * than silence.
 */
function renderFreeze(freeze) {
  if (!freeze) return [];
  const L = [];
  const { pinned, drift, attempts, available, attempted } = freeze;

  if (!available) {
    // Said out loud rather than omitted. A missing line reads as "nothing to report"; this run
    // genuinely did not enforce either control, and the reader is entitled to know that before
    // trusting the verdict above.
    L.push('**Spec pin:** ❓ not enforced — Felix could not read this PR\'s verdict history, '
      + 'so the criteria freeze and the judge attempt cap did not run on this verdict.');
  } else if (drift && drift.changed) {
    L.push(`**Spec pin:** ⚠️ **CHANGED** — Felix first graded \`${shortPin(drift.baseline)}\`, `
      + `this run reads \`${shortPin(drift.current)}\`. The criteria above are not the ones the `
      + 'earlier verdict was rendered against.');
  } else if (pinned && drift && drift.baseline) {
    L.push(`**Spec pin:** 🔒 frozen \`${shortPin(pinned)}\` — unchanged since Felix first graded this PR.`);
  } else if (pinned) {
    L.push(`**Spec pin:** 📌 pinned \`${shortPin(pinned)}\` — first graded run; these criteria are now frozen.`);
  } else {
    L.push('**Spec pin:** — none. Felix only freezes criteria it can actually grade, so a '
      + 'fallback or over-limit spec pins nothing.');
  }

  if (available && attempts) {
    // `used` counts attempts BEFORE this run, so a run that spent one is run used+1 of the cap.
    const n = attempts.used + (attempted ? 1 : 0);
    L.push(attempts.exhausted
      ? `**Judge budget:** ❌ exhausted — ${attempts.used} of ${attempts.limit} attempts used.`
      : attempted
        ? `**Judge budget:** ✅ judge run ${n} of ${attempts.limit}.`
        : `**Judge budget:** ⏭️ judge not run — ${attempts.used} of ${attempts.limit} attempts used.`);
  }

  L.push('');
  return L;
}

function render({ verdict, spec, tier1, tier3, required_to_pass, meta, note, freeze }) {
  const L = [];
  L.push(`## Felix — ${BADGE[verdict] || verdict}`);
  L.push('');
  L.push(verdict === 'SKIPPED'
    ? '_Felix skipped behavioral verification for this PR._'
    : '_Behavioral verification: Felix built and ran this PR, then checked it against the human spec. (Complementary to CodeRabbit, which reviews the diff.)_');
  if (note) {
    L.push('');
    L.push(`> ${note}`);
  }
  L.push('');

  // Spec / criteria.
  if (spec && spec.total) {
    L.push(`**Spec:** ${spec.source || 'n/a'} — ${spec.total} criteria (${spec.mappedCount} mapped to changed files)`);
    if (tier3 && tier3.criteria && tier3.criteria.length) {
      L.push('');
      L.push('| Criterion | Met |');
      L.push('| --- | :-: |');
      for (const c of tier3.criteria) {
        const text = String(c.text || '').replace(/\|/g, '\\|').slice(0, 140);
        L.push(`| ${text} | ${c.met ? '✅' : '❌'} |`);
      }
    }
    L.push('');
  } else {
    L.push('**Spec:** none found.');
    L.push('');
  }

  // The freeze + cap, directly under the criteria they qualify.
  L.push(...renderFreeze(freeze));

  // Tier 1 checks.
  if (tier1 && tier1.length) {
    L.push('**Checks (Tier 1):**');
    for (const c of tier1) {
      const hard = c.hard ? '' : ' _(soft)_';
      L.push(`- ${ICON[c.status] || '•'} ${c.name}${hard} — ${c.detail}`);
    }
    L.push('');
  }

  // Judge summary.
  if (tier3 && tier3.assessment) {
    const mode = tier3.adversarial ? ', adversarial' : '';
    L.push(`**Judge (${tier3.family}/${tier3.model}${mode}):** ${tier3.assessment}`);
    L.push('');
  }

  // Required to pass.
  if (required_to_pass && required_to_pass.length) {
    L.push('**Required to pass:**');
    for (const r of required_to_pass) L.push(`- [ ] ${r}`);
    L.push('');
  }

  const m = meta || {};
  L.push('---');
  L.push(`<sub>Felix v${m.version || PKG_VERSION} · head \`${(m.headSha || '').slice(0, 7)}\` · ${m.durationMs || 0}ms${m.dryRun ? ' · dry-run' : ''}</sub>`);

  return L.join('\n');
}

/** Render a diagnostic comment when Felix itself fails (not a PR defect). */
function renderError({ error, meta }) {
  const m = meta || {};
  const msg = String((error && error.message) || error || 'unknown error').slice(0, 800);
  return [
    '## Felix — 🛠️ **ERROR**',
    '',
    '_Felix could not complete verification due to an internal error. This is a Felix problem, not necessarily a defect in your PR._',
    '',
    '```',
    msg,
    '```',
    '',
    '---',
    `<sub>Felix v${m.version || PKG_VERSION}${m.headSha ? ` · head \`${String(m.headSha).slice(0, 7)}\`` : ''}</sub>`,
  ].join('\n');
}

module.exports = { render, renderError, renderFreeze, BADGE };
