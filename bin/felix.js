#!/usr/bin/env node
/**
 * felix — CLI entry point.
 *
 *   felix <owner/repo#PR> [options]
 *
 * Options:
 *   --post                 post/update the verdict comment (implies not dry-run)
 *   --dry-run              compute + print only (default)
 *   --repo-path <dir>      local git checkout for config + sandbox (default: cwd)
 *   --json                 print the full result object as JSON
 *   -h, --help
 *
 * Env (see .env.example): GITHUB_TOKEN, OPENAI_API_KEY, FELIX_JUDGE_*,
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FELIX_DRY_RUN, FELIX_POST_COMMENT.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

// EVERY engine module is required lazily, inside the command that needs it. That is not style:
// `felix preflight` claims to be incapable of touching the verdict store or the GitHub API, and
// the honest form of that claim is that log.js and github.js are never loaded into the process at
// all. Top-level requires would load them for every subcommand and reduce the claim to "we loaded
// the code but promise not to call it". probe-preflight-containment.js asserts the strong version.
const { logger } = require('../src/engine/util/logger');

function parseArgs(argv) {
  const args = { _: [], dryRun: undefined, post: undefined, repoPath: undefined, repo: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--post') { args.post = true; args.dryRun = false; }
    else if (a === '--dry-run') { args.dryRun = true; args.post = false; }
    else if (a === '--json') args.json = true;
    else if (a === '--judge') args.judge = true;
    else if (a === '--loop') args.loop = true;
    else if (a === '--reset-loop') args.resetLoop = true;
    else if (a === '--max-attempts') args.maxAttempts = argv[++i];
    else if (a === '--repo-path') args.repoPath = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--criteria') args.criteria = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

const HELP = `felix — behavioral PR verification

Usage:
  felix <owner/repo#PR> [--post] [--repo-path <dir>] [--json]   verify a PR (default)
  felix preflight [--judge] [--criteria <f>] [--base <ref>]     verify your WORKING TREE, no PR
  felix preflight --loop [--max-attempts N] [--reset-loop]      …as one counted attempt in a loop
  felix spec-sentinel <owner/repo#PR> [--post] [--json]         re-check the criteria pin only
  felix outcome <owner/repo#PR> <clean|defect>                  record a post-merge outcome
  felix scan-outcomes --repo <owner/repo> [--limit N]           auto-mark reverted PRs as defects
  felix metrics [--repo <owner/repo>] [--json]                  print calibration metrics

Examples:
  felix owner/repo#42 --post --repo-path .
  felix preflight --judge
  felix preflight --loop --judge --json
  felix outcome owner/repo#42 defect
  felix metrics --repo owner/repo

Pre-flight runs Felix against your uncommitted working tree before a PR exists, so an agent can
iterate locally instead of burning CI's one independent shot. It publishes NOTHING — no verdict
row, no comment, no check run — and needs neither GITHUB_TOKEN nor any SUPABASE_* variable.
`;

/**
 * felix spec-sentinel <target> — recompute the criteria fingerprint and nothing else.
 *
 * Exit 1 on drift so the job is red even for an adopter who marked the WORKFLOW required rather
 * than the check run. Exit 0 for every other state, including "not enforced": a store outage is
 * reported on the check run, and reddening the job as well would train people to ignore it.
 */
async function cmdSpecSentinel(args) {
  const { runSpecSentinel } = require('../src/engine/sentinel');
  if (!args._[1]) {
    logger.err('usage: felix spec-sentinel <owner/repo#PR> [--post]');
    process.exit(1);
  }
  const result = await runSpecSentinel({
    target: args._[1], dryRun: args.dryRun, post: args.post, env: process.env,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`\n${result.title}\n`);
  process.exit(result.conclusion === 'failure' ? 1 : 0);
}

/**
 * felix preflight — verify the working tree, publish nothing.
 *
 * Exit codes mirror the PR path so a loop driver can branch on them without parsing: 0 clean
 * (VERIFIED or SKIPPED), 1 NOT VERIFIED, 2 INSUFFICIENT EVIDENCE, 3 Felix itself failed. Whether
 * a non-zero code is worth RETRYING is a different question, and the answer is `retryable` in
 * --json — deliberately not encoded in the exit code, because "the tests failed" and "you have no
 * acceptance criteria" are both exit 1 and only one of them is a loop's business to fix.
 *
 * 4 is the loop ceiling: Felix REFUSED the attempt and graded nothing at all. It is its own code
 * rather than folded into 1 or 2 because those both mean "Felix looked and this is what it found",
 * and a shell driver that treated a refusal as a finding would report a verdict nobody rendered.
 */
async function cmdPreflight(args) {
  const { runPreflight, formatPreflight } = require('../src/engine/preflight');
  const result = await runPreflight({
    repoPath: args.repoPath || process.cwd(),
    criteriaPath: args.criteria,
    base: args.base,
    judge: args.judge,
    loop: args.loop,
    maxAttempts: args.maxAttempts,
    resetLoop: args.resetLoop,
    env: process.env,
  });
  console.log(args.json ? JSON.stringify(result, null, 2) : formatPreflight(result));
  process.exit(result.verdict === null ? 4
    : result.verdict === 'NOT VERIFIED' ? 1
    : result.verdict === 'INSUFFICIENT EVIDENCE' ? 2 : 0);
}

/** felix outcome <target> <clean|defect> */
async function cmdOutcome(args) {
  const { recordOutcome } = require('../src/engine/log');
  const { OUTCOMES } = require('../src/engine/calibration');
  const { parseTarget } = require('../src/engine/github');
  const target = args._[1];
  const outcome = (args._[2] || '').toLowerCase();
  if (!target || ![OUTCOMES.CLEAN, OUTCOMES.DEFECT].includes(outcome)) {
    logger.err('usage: felix outcome <owner/repo#PR> <clean|defect>');
    process.exit(1);
  }
  const { owner, repo, number } = parseTarget(target);
  const { updated } = await recordOutcome({ repo: `${owner}/${repo}`, prNumber: number, outcome }, process.env);
  logger.info(`recorded outcome "${outcome}" for ${owner}/${repo}#${number} (${updated} row(s) updated)`);
  process.exit(updated ? 0 : 1);
}

/** felix metrics [--repo owner/repo] */
async function cmdMetrics(args) {
  const { fetchVerdicts } = require('../src/engine/log');
  const { computeMetrics, formatMetrics } = require('../src/engine/calibration');
  const rows = await fetchVerdicts({ repo: args.repo }, process.env);
  const m = computeMetrics(rows);
  console.log(args.json ? JSON.stringify(m, null, 2) : formatMetrics(m));
  process.exit(0);
}

/** felix scan-outcomes --repo owner/repo [--limit N] — auto-mark reverted PRs as defects */
async function cmdScanOutcomes(args) {
  const { recordOutcome } = require('../src/engine/log');
  const { OUTCOMES } = require('../src/engine/calibration');
  const { detectRevertedPRs } = require('../src/engine/outcomes');
  const { createGitHub } = require('../src/engine/github');
  if (!args.repo || !args.repo.includes('/')) {
    logger.err('usage: felix scan-outcomes --repo <owner/repo> [--limit N]');
    process.exit(1);
  }
  const [owner, repo] = args.repo.split('/');
  const gh = createGitHub(process.env.GITHUB_TOKEN);
  const commits = (await gh.listCommits(owner, repo, { perPage: Number(args.limit) || 100 })) || [];
  const reverted = detectRevertedPRs(commits);
  let marked = 0;
  for (const pr of reverted) {
    const { updated } = await recordOutcome({ repo: args.repo, prNumber: pr, outcome: OUTCOMES.DEFECT }, process.env);
    if (updated) { marked++; logger.info(`marked #${pr} as defect (reverted)`); }
  }
  logger.info(`scan-outcomes: ${reverted.length} revert(s) found in ${commits.length} commits, ${marked} verdict row(s) updated`);
  process.exit(0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  // Subcommands (wrapped so a bad target reports cleanly, like the run path).
  if (['outcome', 'metrics', 'scan-outcomes', 'spec-sentinel', 'preflight'].includes(args._[0])) {
    try {
      if (args._[0] === 'outcome') return await cmdOutcome(args);
      if (args._[0] === 'metrics') return await cmdMetrics(args);
      if (args._[0] === 'spec-sentinel') return await cmdSpecSentinel(args);
      if (args._[0] === 'preflight') return await cmdPreflight(args);
      return await cmdScanOutcomes(args);
    } catch (e) {
      logger.err(e.message);
      if (process.env.FELIX_DEBUG === 'true') console.error(e.stack);
      process.exit(3);
    }
  }

  const target = args._[0];
  const { run, reportError } = require('../src/engine');

  try {
    const result = await run({
      target,
      repoPath: args.repoPath || process.cwd(),
      dryRun: args.dryRun,
      post: args.post,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n' + '─'.repeat(60));
      console.log(result.body);
      console.log('─'.repeat(60));
    }

    // Exit code: gating decision wins (override → 0, block → 1); otherwise the
    // verdict severity (1 NOT VERIFIED, 2 INSUFFICIENT, 0 VERIFIED/SKIPPED).
    const g = result.gate || {};
    const code = g.blocks ? 1
      : g.overridden ? 0
      : result.verdict === 'NOT VERIFIED' ? 1
      : result.verdict === 'INSUFFICIENT EVIDENCE' ? 2 : 0;
    process.exit(code);
  } catch (e) {
    logger.err(e.message);
    if (process.env.FELIX_DEBUG === 'true') console.error(e.stack);
    // Surface Felix's own failure on the PR instead of a silent CI red.
    const post = args.post || process.env.FELIX_POST_COMMENT === 'true';
    const dryRun = args.dryRun !== undefined ? args.dryRun : process.env.FELIX_DRY_RUN !== 'false';
    if (post && !dryRun && args._[0]) {
      await reportError({ target: args._[0], env: process.env, error: e });
    }
    process.exit(3);
  }
}

main().catch((e) => {
  logger.err(e.message);
  if (process.env.FELIX_DEBUG === 'true') console.error(e.stack);
  process.exit(3);
});
