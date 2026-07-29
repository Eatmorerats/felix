/**
 * index.js — Felix orchestrator. Runs the 9-step pipeline for one PR and
 * returns a structured result (and optionally posts the verdict comment).
 *
 * Designed so the CLI and any future GitHub Action are thin wrappers: they just
 * gather { target, repoPath, dryRun, post } and call run().
 */

const path = require('path');
const picomatch = require('picomatch');
const { version } = require('../../package.json');
const { logger } = require('./util/logger');
const { createGitHub, parseTarget } = require('./github');
const { loadConfig } = require('./config');
const { buildSpec, linkedIssueNumbers } = require('./spec');
const { createSandbox } = require('./sandbox');
const { runTier1 } = require('./tier1');
const { createJudge } = require('./judge');
const { compose, conclusionFor } = require('./verdict');
const { resolveGating, gateDecision } = require('./gating');
const { render, renderError } = require('./comment');
const { logVerdict } = require('./log');

/** Triage: are all changed files non-behavioral (skipGlobs)? */
function triageFiles(files, skipGlobs) {
  const matchers = (skipGlobs || []).map((g) => picomatch(g));
  const isSkip = (p) => matchers.some((m) => m(p));
  const behavioral = files.filter((f) => !isSkip(f.filename));
  return {
    skipped: files.length > 0 && behavioral.length === 0,
    reason: `${files.length} changed, ${behavioral.length} behavioral`,
    behavioral,
  };
}

/**
 * Classify the PR's trigger conditions:
 *  - draft: defer verification until marked ready
 *  - fork:  the cross-family judge secret isn't exposed to fork PRs
 */
function triggerGate(pr) {
  const head = (pr && pr.head && pr.head.repo) || null;
  const base = (pr && pr.base && pr.base.repo) || null;
  const fork = Boolean(head && head.fork)
    || Boolean(head && base && head.full_name && base.full_name && head.full_name !== base.full_name);
  return { draft: Boolean(pr && pr.draft), fork };
}

/**
 * @param {object} opts
 * @param {string} opts.target    "owner/repo#123"
 * @param {string} opts.repoPath  local git checkout of the repo (for config + sandbox)
 * @param {boolean} [opts.dryRun] compute + print, never comment (default true)
 * @param {boolean} [opts.post]   post/update the PR comment
 * @param {object} [opts.env]     environment (default process.env)
 */
async function run(opts) {
  const env = opts.env || process.env;
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : env.FELIX_DRY_RUN !== 'false';
  const post = opts.post !== undefined ? opts.post : env.FELIX_POST_COMMENT === 'true';
  const repoPath = path.resolve(opts.repoPath || process.cwd());
  const started = Date.now();

  const { owner, repo, number } = parseTarget(opts.target);
  const gh = createGitHub(env.GITHUB_TOKEN, opts.apiBase ? { apiBase: opts.apiBase } : {});

  // (1) Resolve PR.
  logger.step(1, `resolving ${owner}/${repo}#${number}`);
  const pr = await gh.getPR(owner, repo, number);
  if (!pr) throw new Error(`PR ${owner}/${repo}#${number} not found (or no access).`);
  const headSha = pr.head.sha;
  const meta = {
    version, headSha, baseSha: pr.base.sha, dryRun,
    repo: `${owner}/${repo}`, prNumber: number, prTitle: pr.title,
  };

  const labels = (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

  // Trigger gate: drafts are deferred; forks can't reach the judge secret.
  const gate = triggerGate(pr);
  if (gate.draft) {
    logger.info('PR is a draft → SKIPPED (deferred until ready for review)');
    // Honor repo gating config when it loads; a draft still SKIPs even if the
    // repo can't be configured (so don't let a config error break the skip).
    let draftGating = resolveGating({});
    try { draftGating = resolveGating(loadConfig(repoPath).config); } catch (_) { /* keep defaults */ }
    return finalize({ gh, owner, repo, number, dryRun, post, started, meta, configSource: null, detected: false, env,
      verdictObj: compose({ trigger: gate }), spec: null, tier1: [], tier3: null, gating: draftGating, labels });
  }
  if (gate.fork) logger.info('fork PR — Tier 3 judge will be skipped (secret unavailable on forks)');

  const files = await gh.getFiles(owner, repo, number);
  const diff = await gh.getDiff(owner, repo, number);

  // (2) Learn / load config.
  logger.step(2, 'loading config');
  const { config, source: configSource, detected } = loadConfig(repoPath);

  // (3) Triage.
  logger.step(3, 'triage');
  const triage = triageFiles(files, config.skipGlobs);
  const gating = resolveGating(config);

  if (triage.skipped) {
    logger.info('only non-behavioral files changed → SKIPPED');
    return finalize({ gh, owner, repo, number, dryRun, post, started, meta, configSource, detected, env,
      verdictObj: compose({ triage }), spec: null, tier1: [], tier3: null, gating, labels });
  }

  // (4) Spec.
  logger.step(4, 'loading spec');
  const issueNums = linkedIssueNumbers(pr.body || '');
  const issues = [];
  for (const n of issueNums.slice(0, 10)) {
    const issue = await gh.getIssue(owner, repo, n);
    if (issue && !issue.pull_request) issues.push(issue);
  }
  const spec = buildSpec(pr, issues, triage.behavioral);
  logger.info(`spec: ${spec.source || 'none'} (${spec.total} criteria)`);

  // (5) Sandbox.
  logger.step(5, 'preparing sandbox');
  let sandbox;
  let tier1 = [];
  let installFailed = false;
  let tier3 = null;
  // Why the judge did/didn't produce a result — surfaced in the verdict so a
  // null tier3 is diagnosable ("key not set" vs "the OpenAI call failed").
  const judgeStatus = { configured: Boolean(env.OPENAI_API_KEY), error: null, attempted: false, fork: gate.fork };
  try {
    sandbox = await createSandbox({ repoPath, headSha, prNumber: number });
    const cwd = config.workdir && config.workdir !== '.' ? path.join(sandbox.dir, config.workdir) : sandbox.dir;

    // (6) Tier 1.
    logger.step(6, 'running Tier 1 checks');
    const t1 = await runTier1({ cwd, env: sandbox.cleanEnv, config, files: triage.behavioral });
    tier1 = t1.results;
    installFailed = t1.installFailed;

    // (7) Tier 3 judge (only if we have a real spec, code ran, and it's not a fork).
    if (spec.hadRealSpec && !installFailed && !gate.fork) {
      logger.step(7, 'cross-family judge');
      // Opt-in adversarial "refute-first" judging (R2a): per-repo config.judge.adversarial,
      // or the FELIX_JUDGE_ADVERSARIAL env for a global/Action toggle. Default off.
      const adversarial = Boolean(
        (config.judge && config.judge.adversarial) ||
        /^(1|true|yes|on)$/i.test(env.FELIX_JUDGE_ADVERSARIAL || '')
      );
      if (adversarial) logger.info('judge: adversarial refute-first mode');
      const judge = createJudge(env, { adversarial }); // throws if Anthropic family
      if (judge) {
        judgeStatus.attempted = true;
        try {
          tier3 = await judge({ prTitle: pr.title, criteria: spec.criteria, diff, tier1 });
        } catch (e) {
          logger.warn(`judge error: ${e.message}`);
          judgeStatus.error = e.message;
          tier3 = null;
        }
      }
    } else {
      createJudge(env); // still enforce the cross-family guard even when skipping
    }
  } finally {
    if (sandbox) await sandbox.teardown();
  }

  // (8) Verdict.
  logger.step(8, 'composing verdict');
  const verdictObj = compose({ triage, spec, tier1, tier3, installFailed, judgeStatus, trigger: gate });

  return finalize({ gh, owner, repo, number, dryRun, post, started, meta, configSource, detected, env,
    verdictObj, spec, tier1, tier3, diff, gating, labels });
}

async function finalize({ gh, owner, repo, number, dryRun, post, started, meta, configSource, detected, env, verdictObj, spec, tier1, tier3, gating, labels }) {
  meta.durationMs = Date.now() - started;
  const gateResult = gateDecision({ verdict: verdictObj.verdict, gating: gating || resolveGating({}), labels: labels || [] });
  const note = verdictObj.verdict === 'SKIPPED' ? verdictObj.reason : undefined;
  let body = render({
    verdict: verdictObj.verdict, spec, tier1, tier3,
    required_to_pass: verdictObj.required_to_pass, meta, note,
  });
  if (gateResult.blocks) {
    body += '\n\n> 🚫 **Gating:** this verdict is configured to block — it blocks merge when the "Felix verdict" check is marked Required in branch protection.';
  } else if (gateResult.overridden) {
    body += `\n\n> ⚠️ **Gating override:** ${gateResult.reason}.`;
  }

  // (9) Log + report.
  await logVerdict({
    repo: `${owner}/${repo}`, pr_number: number, pr_title: meta.prTitle,
    head_sha: meta.headSha, base_sha: meta.baseSha,
    verdict: verdictObj.verdict,
    spec_source: spec ? spec.source : null,
    criteria_total: spec ? spec.total : 0,
    criteria_mapped: spec ? spec.mappedCount : 0,
    tier1_results: tier1,
    tier3,
    required_to_pass: verdictObj.required_to_pass,
    judge_family: tier3 ? tier3.family : null,
    judge_model: tier3 ? tier3.model : null,
    duration_ms: meta.durationMs,
    felix_version: meta.version,
  }, env);

  let comment = null;
  if (post && !dryRun) {
    // Best-effort: fork PRs get a read-only token, so a 403 here must not crash.
    try {
      logger.info('posting verdict comment');
      comment = await gh.upsertComment(owner, repo, number, body);
    } catch (e) {
      logger.warn(`could not post verdict comment: ${e.message}`);
    }
    // Publish a first-class check run (gateable). Needs checks:write; best-effort.
    if (env.FELIX_CHECK_RUN !== 'false' && meta.headSha) {
      try {
        // Gating shapes the conclusion: blocks → failure (gateable when the
        // check is Required), overridden → neutral, else the advisory mapping.
        const conclusion = gateResult.blocks ? 'failure'
          : gateResult.overridden ? 'neutral'
          : conclusionFor(verdictObj.verdict);
        await gh.createCheckRun(owner, repo, {
          headSha: meta.headSha,
          conclusion,
          title: `Felix: ${verdictObj.verdict}`,
          summary: body,
        });
      } catch (e) {
        logger.warn(`could not create check run: ${e.message}`);
      }
    }
  } else {
    logger.info(`dry-run — not posting. Verdict: ${verdictObj.verdict}`);
  }

  return {
    verdict: verdictObj.verdict,
    required_to_pass: verdictObj.required_to_pass,
    reason: verdictObj.reason,
    gate: gateResult,
    configSource, detected,
    spec, tier1, tier3, meta, body, comment, dryRun,
  };
}

/**
 * Best-effort: post a diagnostic comment when Felix itself errors, so a crash
 * surfaces on the PR instead of only failing the CI job silently.
 */
async function reportError({ target, env = process.env, error }) {
  try {
    if (!env.GITHUB_TOKEN) return false;
    const { owner, repo, number } = parseTarget(target);
    const gh = createGitHub(env.GITHUB_TOKEN, env.FELIX_API_BASE ? { apiBase: env.FELIX_API_BASE } : {});
    await gh.upsertComment(owner, repo, number, renderError({ error, meta: { version } }));
    return true;
  } catch (e) {
    logger.warn(`could not post error comment: ${e.message}`);
    return false;
  }
}

module.exports = { run, triageFiles, triggerGate, reportError };
