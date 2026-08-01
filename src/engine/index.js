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
const { loadConfig, resolveWorkdir, CONFIG_FILENAME } = require('./config');
const { buildSpec, linkedIssueNumbers } = require('./spec');
const { createSandbox } = require('./sandbox');
const { runTier1 } = require('./tier1');
const { resolveIsolation, assertJailCoherent, preflightDocker } = require('./isolation');
const { buildDrivePlan } = require('./drive');
const { run: execRun } = require('./util/exec');
const { createJudge } = require('./judge');
const { compose, conclusionFor } = require('./verdict');
const { resolveGating, gateDecision } = require('./gating');
const { render, renderError } = require('./comment');
const { logVerdict } = require('./log');
const { preloadOptional, armModuleLock } = require('./preload');

/**
 * Felix's own control surface — never triaged away, whatever skipGlobs says.
 *
 * The default skipGlobs include a catch-all for JSON files and one for `.github`, which between
 * them match felix.config.json, package.json and the workflow that runs Felix. A PR touching only
 * those was therefore SKIPPED — never
 * verified — and merged. That is a two-step bypass of the base-ref policy split, because step one
 * poisons the ref step two trusts: PR 1 sets package.json's `scripts.test` to `exit 0` in a
 * chore-looking diff, and from then on every PR's Tier 1 test check passes trivially from BASE
 * content. Reproduced by execution — the default globs really do skip a config-only PR.
 *
 * Not configurable, deliberately: a list the config can suppress is not a floor. The cost is that
 * dependency-bump PRs now get fully verified instead of skipped, which is the right answer anyway
 * — a lockfile bump is behavioural.
 */
const NEVER_SKIP = [
  'felix.config.json',
  '.github/workflows/**',
  '**/package.json',
];

/** Triage: are all changed files non-behavioral (skipGlobs)? */
function triageFiles(files, skipGlobs) {
  const matchers = (skipGlobs || []).map((g) => picomatch(g));
  const never = NEVER_SKIP.map((g) => picomatch(g));
  const isSkip = (p) => !never.some((m) => m(p)) && matchers.some((m) => m(p));
  const behavioral = files.filter((f) => !isSkip(f.filename));
  return {
    skipped: files.length > 0 && behavioral.length === 0,
    reason: `${files.length} changed, ${behavioral.length} behavioral`,
    behavioral,
  };
}

/**
 * Read felix.config.json from the BASE ref over the contents API, not from the local checkout.
 *
 * The API is depth-independent, and that deletes a failure mode rather than managing it:
 * `actions/checkout` at its default fetch-depth of 1 leaves no base commit in the object store, so
 * a `git show` read would have needed a fallback in precisely the place a fallback is fatal. It
 * also costs nothing new — GITHUB_TOKEN is already required, and for a fork PR the base repo is
 * the upstream, which the token reads fine.
 *
 * Tries pr.base.sha, then the branch tip pr.base.ref. Both are merged, reviewed content, so the
 * fallback chain never touches attacker input. If neither resolves, it throws — see loadConfig.
 */
function baseConfigFetcher(gh, owner, repo, { baseSha, baseRef }) {
  const refs = [baseSha, baseRef].filter(Boolean);
  return async () => {
    const problems = [];
    for (const ref of refs) {
      let root;
      try {
        root = await gh.listRootContents(owner, repo, ref);
      } catch (e) {
        problems.push(`${ref}: ${e.message}`);
        continue;
      }
      // null = 404 on the REF (gh() maps 404 to null); a resolved ref always lists an array.
      if (!Array.isArray(root)) {
        problems.push(`${ref}: ref did not resolve`);
        continue;
      }
      const entry = root.find((e) => e && e.name === CONFIG_FILENAME && e.type === 'file');
      if (!entry) return { present: false, ref };
      const raw = await gh.getRawFile(owner, repo, CONFIG_FILENAME, ref);
      if (raw === null || raw === undefined) return { present: false, ref };
      return { present: true, raw: String(raw), ref };
    }
    throw new Error(
      `Could not read ${CONFIG_FILENAME} from the base ref (tried ${refs.join(', ') || 'nothing'}), so `
      + 'Felix cannot establish the policy to judge this PR by. Refusing rather than falling back to '
      + "the pull request's own config, which would let it choose that policy."
      + (problems.length ? ` Details: ${problems.join('; ')}` : '')
    );
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

  const fetchBaseConfig = baseConfigFetcher(gh, owner, repo, { baseSha: pr.base.sha, baseRef: pr.base.ref });

  // Trigger gate: drafts are deferred; forks can't reach the judge secret.
  const gate = triggerGate(pr);
  if (gate.draft) {
    logger.info('PR is a draft → SKIPPED (deferred until ready for review)');
    // Honor repo gating config when it loads; a draft still SKIPs even if the
    // repo can't be configured (so don't let a config error break the skip).
    // Base policy here too — reading it from head would hand a draft the same bypass.
    let draftGating = resolveGating({});
    try {
      draftGating = resolveGating((await loadConfig({ repoPath, fetchBaseConfig })).config);
    } catch (_) { /* keep defaults */ }
    return finalize({ gh, owner, repo, number, dryRun, post, started, meta, configSource: null, detected: false, env,
      verdictObj: compose({ trigger: gate }), spec: null, tier1: [], tier3: null, gating: draftGating, labels });
  }
  if (gate.fork) logger.info('fork PR — Tier 3 judge will be skipped (secret unavailable on forks)');

  const files = await gh.getFiles(owner, repo, number);
  const diff = await gh.getDiff(owner, repo, number);

  // (2) Learn / load config.
  logger.step(2, 'loading config');
  const { config, source: configSource, detected } = await loadConfig({ repoPath, fetchBaseConfig });

  // (2b) The jail is checked HERE — before triage, before the sandbox worktree exists, and
  // before a single line of PR code is fetched. Two things are established, both of which throw
  // rather than degrade:
  //
  //   - the isolation block is coherent (a valid mode, and not docker-plus-drive, which would
  //     boot the PR's app on the host outside the jail), and
  //   - if it asks for docker, docker actually answers on this runner.
  //
  // Throwing is the only outcome that is fail-closed under BOTH gating setups. It exits 3, so
  // the job goes red, and it never reaches `finalize`, so no check run is created and a Required
  // check cannot go green. The tempting alternative — carry on and report INSUFFICIENT EVIDENCE
  // — maps to `neutral`, which GitHub counts as PASSING. `reportError` still posts a diagnostic
  // comment naming the real culprit, so this is loud rather than silent.
  const isolation = resolveIsolation(config);
  assertJailCoherent({ isolation, hasDrivePlan: buildDrivePlan(config) !== null });
  await preflightDocker({ isolation, run: execRun });

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
  // Everything Felix could ever need is loaded HERE, while the only code that has run
  // is Felix's own. From the arm() call on, a first-time module load throws — because
  // every step below this line either executes PR code or runs after code that did,
  // and a module resolved at that point can be one the PR planted (S2, F5). Arming
  // before createSandbox rather than before runTier1 is deliberate: `git worktree add`
  // fires the base repo's post-checkout hook, which is plantable on a persistent runner.
  preloadOptional();
  armModuleLock();

  try {
    sandbox = await createSandbox({ repoPath, headSha, prNumber: number });
    // Resolved, not joined: workdir is base-sourced now, but the sandbox is a worktree of PR
    // content, so the directory it names can be a symlink the PR planted. Throws on escape —
    // which lands in the finally below, tearing the sandbox down before anything ran.
    const cwd = resolveWorkdir(sandbox.dir, config.workdir);

    // (6) Tier 1.
    logger.step(6, 'running Tier 1 checks');
    // `files` is the FULL getFiles list (unfiltered by triage) — the deps check needs the
    // widest set for its rename map + changed-file attribution gate. `triage.behavioral` is
    // the narrower behavioral subset used for the per-file test re-runs.
    // repoRoot is the sandbox root, NOT `cwd`. Changed-file paths from the API are
    // repo-root-relative, so anything that reads a changed file off disk must join from
    // the root — under a workdir, `cwd` points somewhere those paths do not exist.
    const t1 = await runTier1({
      cwd, repoRoot: sandbox.dir, env: sandbox.cleanEnv, config, files: triage.behavioral,
      repoPath, baseSha: pr.base.sha, headSha, filesAll: files,
    });
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

module.exports = { run, triageFiles, triggerGate, reportError, baseConfigFetcher, NEVER_SKIP };
