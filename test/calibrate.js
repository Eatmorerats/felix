#!/usr/bin/env node
/**
 * calibrate.js — run the labelled fixture corpus through Felix's REAL judge +
 * verdict path and print a confusion matrix. This is how we get Felix's first
 * honest precision/recall number (R0 in the v1.1 roadmap).
 *
 *   cd felix && npm run calibrate            # needs OPENAI_API_KEY (the judge)
 *
 * It reuses the production judge (judge.js), the production verdict composer
 * (verdict.js), and the production calibration math (calibration.js) — so a good
 * score here is real evidence about the code that actually runs on PRs, not a
 * parallel mock of it.
 *
 * Exit codes: 0 = no escaped defects; 1 = at least one ESCAPED DEFECT (a 'bad'
 * fixture the judge waved through — the failure mode we care about most);
 * 2 = could not score (no OPENAI_API_KEY).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { createJudge } = require('../src/engine/judge');
const { compose } = require('../src/engine/verdict');
const { computeMetrics, formatMetrics } = require('../src/engine/calibration');
const { FIXTURES, oracleJudge, truthOutcome } = require('./calibration-fixtures');

/** Shape a fixture's criteria the way spec.buildSpec would (mapping is unused by the judge). */
function specFor(fixture) {
  return {
    source: 'fixture',
    hadRealSpec: true,
    criteria: fixture.criteria.map((text) => ({ text, mappedFiles: [], mapped: false })),
    total: fixture.criteria.length,
    mappedCount: 0,
  };
}

/** Run one fixture: judge → compose → verdict. Returns { fixture, verdict, tier3 }. */
async function runFixture(fixture, judge) {
  const spec = specFor(fixture);
  let tier3 = null;
  if (judge) {
    tier3 = await judge({ prTitle: fixture.prTitle, criteria: spec.criteria, diff: fixture.diff, tier1: fixture.tier1 });
  }
  const verdictObj = compose({
    triage: { skipped: false },
    spec,
    tier1: fixture.tier1,
    tier3,
    installFailed: false,
    judgeStatus: { configured: Boolean(judge), attempted: Boolean(judge), error: null, fork: false },
  });
  return { fixture, verdict: verdictObj.verdict, tier3 };
}

const ICON = (ok) => (ok ? '✅' : '❌'); // colour-blind-safe: icon + text, never colour alone

async function main() {
  const useOracle = process.argv.includes('--oracle');
  let judge = null;

  if (useOracle) {
    // Plumbing smoke with a perfect judge — no network, always scores.
    judge = async ({ prTitle }) => oracleJudge(FIXTURES.find((f) => f.prTitle === prTitle));
    console.log('[FELIX] calibrate: --oracle mode (perfect judge, no network)\n');
  } else {
    judge = createJudge(process.env); // null if OPENAI_API_KEY is absent
    if (!judge) {
      console.log('[FELIX] calibrate: OPENAI_API_KEY not set — cannot score the judge.');
      console.log('        Run this where the key lives (CI, or set it in felix/.env), or use --oracle to smoke-test the wiring.');
      console.log(`        Corpus is ready: ${FIXTURES.length} fixtures (${FIXTURES.filter((f) => f.label === 'bad').length} known-bad).`);
      process.exit(2);
    }
    console.log('[FELIX] calibrate: scoring the live judge against the fixture corpus\n');
  }

  const rows = [];
  let escaped = 0;
  for (const fixture of FIXTURES) {
    const { verdict } = await runFixture(fixture, judge);
    const correct = verdict === fixture.expected;
    // ESCAPED DEFECT: a known-bad fixture the judge let through.
    const isEscape = fixture.label === 'bad' && verdict === 'VERIFIED';
    if (isEscape) escaped++;
    rows.push({ verdict, outcome: truthOutcome(fixture) });
    const tag = isEscape ? '  ⚠️ ESCAPED DEFECT' : '';
    console.log(`  ${ICON(correct)} ${fixture.id.padEnd(26)} expected ${fixture.expected.padEnd(13)} → got ${verdict}${tag}`);
  }

  console.log('\n' + formatMetrics(computeMetrics(rows)));
  console.log(`\nEscaped defects (known-bad judged VERIFIED): ${escaped}`);
  if (escaped > 0) {
    console.log('→ FAIL: the judge waved through a PR with a genuine, test-passing defect.');
  } else {
    console.log('→ OK: no known-bad fixture slipped past the judge.');
  }
  process.exit(escaped > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[FELIX] calibrate error:', e.message);
  process.exit(2);
});
