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

const { run, reportError } = require('../src/engine');
const { recordOutcome, fetchVerdicts } = require('../src/engine/log');
const { computeMetrics, formatMetrics, OUTCOMES } = require('../src/engine/calibration');
const { detectRevertedPRs } = require('../src/engine/outcomes');
const { parseTarget, createGitHub } = require('../src/engine/github');
const { logger } = require('../src/engine/util/logger');

function parseArgs(argv) {
  const args = { _: [], dryRun: undefined, post: undefined, repoPath: undefined, repo: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--post') { args.post = true; args.dryRun = false; }
    else if (a === '--dry-run') { args.dryRun = true; args.post = false; }
    else if (a === '--json') args.json = true;
    else if (a === '--repo-path') args.repoPath = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

const HELP = `felix — behavioral PR verification

Usage:
  felix <owner/repo#PR> [--post] [--repo-path <dir>] [--json]   verify a PR (default)
  felix outcome <owner/repo#PR> <clean|defect>                  record a post-merge outcome
  felix scan-outcomes --repo <owner/repo> [--limit N]           auto-mark reverted PRs as defects
  felix metrics [--repo <owner/repo>] [--json]                  print calibration metrics

Examples:
  felix owner/repo#42 --post --repo-path .
  felix outcome owner/repo#42 defect
  felix metrics --repo owner/repo
`;

/** felix outcome <target> <clean|defect> */
async function cmdOutcome(args) {
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
  const rows = await fetchVerdicts({ repo: args.repo }, process.env);
  const m = computeMetrics(rows);
  console.log(args.json ? JSON.stringify(m, null, 2) : formatMetrics(m));
  process.exit(0);
}

/** felix scan-outcomes --repo owner/repo [--limit N] — auto-mark reverted PRs as defects */
async function cmdScanOutcomes(args) {
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
  if (['outcome', 'metrics', 'scan-outcomes'].includes(args._[0])) {
    try {
      if (args._[0] === 'outcome') return await cmdOutcome(args);
      if (args._[0] === 'metrics') return await cmdMetrics(args);
      return await cmdScanOutcomes(args);
    } catch (e) {
      logger.err(e.message);
      if (process.env.FELIX_DEBUG === 'true') console.error(e.stack);
      process.exit(3);
    }
  }

  const target = args._[0];

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
