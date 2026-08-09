/**
 * index.js — Felix orchestrator. Runs the 9-step pipeline for one PR and
 * returns a structured result (and optionally posts the verdict comment).
 *
 * Designed so the CLI and any future GitHub Action are thin wrappers: they just
 * gather { target, repoPath, dryRun, post } and call run().
 */

const path = require('path');
const { version } = require('../../package.json');
const { logger } = require('./util/logger');
const { createGitHub, parseTarget } = require('./github');
const { loadConfig, resolveWorkdir, CONFIG_FILENAME } = require('./config');
// Shared with preflight.js so local and CI triage cannot drift apart — see triage.js.
const { triageFiles, NEVER_SKIP } = require('./triage');
const { buildSpec, linkedIssueNumbers, criteriaCapChars } = require('./spec');
const { promptBudgetTokens } = require('./budget');
const { PROVIDERS } = require('./providers');
const { createSandbox } = require('./sandbox');
const { runTier1 } = require('./tier1');
const { resolveIsolation, assertJailCoherent, preflightDocker } = require('./isolation');
const { buildDrivePlan } = require('./drive');
const { run: execRun } = require('./util/exec');
const { createJudge } = require('./judge');
const { compose, conclusionFor } = require('./verdict');
const { resolveGating, gateDecision } = require('./gating');
const {
  resolveFreeze, pinnableFingerprint, decideSpecDrift, decideAttempts, refuseOnUnprovenFreeze,
} = require('./freeze');
const { render, renderError } = require('./comment');
const { logVerdict, fetchPriorRuns } = require('./log');
const { preloadOptional, armModuleLock } = require('./preload');

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
 * May the cross-family judge be called on this run?
 *
 * Extracted from the inline conjunction it used to be so it can be unit-tested and MUTATED. Each
 * clause here is a decision not to spend, and an inline `&&` chain inside run() is unreachable
 * from a test without a live sandbox — which is how a clause gets dropped and nobody notices.
 *
 *   hadRealSpec / !overLimit  nothing gradeable, or a spec runSeat is guaranteed to refuse.
 *   !installFailed            the code never ran, so there is nothing to judge.
 *   !fork                     the judge secret is not exposed to fork PRs.
 *   !specDrift.changed        the verdict is already spec_changed. Skipping is not an
 *   !attempts.exhausted       optimization: a call here would still be LOGGED as an attempt, so
 *                             a PR whose budget is gone would keep burning budget, and a rubric
 *                             Felix refused would still be paid to grade. A cap that spends on
 *                             the run enforcing it is not a cap.
 */
function shouldRunJudge({ spec, installFailed, fork, specDrift, attempts }) {
  if (!spec || !spec.hadRealSpec) return false;
  if (!spec.size || spec.size.overLimit) return false;
  if (installFailed || fork) return false;
  if (specDrift && specDrift.changed) return false;
  if (attempts && attempts.exhausted) return false;
  return true;
}

/**
 * Publish a FAILING check run for a refusal, then let the caller throw.
 *
 * Throwing alone is NOT fail-closed here, and this is the difference between the freeze working
 * and the freeze being decorative. A check run persists on its head SHA until something PATCHes
 * it, and `createCheckRun` upserts by (SHA, name) — so a run that throws never touches the one
 * already there. The attack that writes itself:
 *
 *   1. PR is graded VERIFIED on sha X while the store is healthy → a `success` check run exists.
 *   2. The author edits the acceptance criteria. `pull_request: edited` fires on the SAME sha X.
 *   3. The store is now unreachable, so the refusal fires and Felix exits.
 *   4. Nothing PATCHed the check run, so the green from step 1 still stands — and it certifies a
 *      criteria set that is no longer the one on the page.
 *
 * That is exactly the drift the freeze exists to catch, surviving BECAUSE of the guard meant to
 * catch it. So write the red first. It is best-effort — a failure here still exits — and the
 * residual is narrow: a stale green survives only if the verdict store AND checks:write are both
 * down at once.
 *
 * assertJailCoherent above throws bare and that remains correct: it fires on incoherent config,
 * which has no reason to coincide with "a green already exists on this SHA". This refusal fires
 * PREFERENTIALLY on re-runs of an already-graded SHA, because that is what an `edited` event is.
 *
 * Deliberately NOT routed through compose(): every verdict reachable from here is one Felix maps
 * to `neutral`, and GitHub counts `neutral` as PASSING.
 */
async function publishRefusal({ gh, owner, repo, headSha, reason, post, dryRun, env }) {
  if (!post || dryRun || env.FELIX_CHECK_RUN === 'false' || !headSha) return false;
  try {
    await gh.createCheckRun(owner, repo, {
      headSha,
      conclusion: 'failure',
      title: 'Felix: NOT VERIFIED — verdict store unavailable',
      summary: `## Felix — ❌ **NOT VERIFIED**\n\n${reason}`,
    });
    return true;
  } catch (e) {
    // Still exit non-zero. Say it out loud, because this is the one path where a stale green can
    // survive, and the operator needs to know the check on this SHA may be lying.
    logger.warn(`could not publish the refusal check run (a stale check on ${String(headSha).slice(0, 7)} may still show green): ${e.message}`);
    return false;
  }
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
  // The cap is sized against the strictest seat Felix ships, lowered further if this repo set
  // FELIX_JUDGE_MAX_PROMPT_TOKENS — never against the seats this repo happens to have keyed, so
  // adding a second vendor key cannot silently change whether a PR is gradeable.
  const spec = buildSpec(pr, issues, triage.behavioral, {
    maxCriteriaChars: criteriaCapChars(promptBudgetTokens(env, PROVIDERS)),
  });
  logger.info(`spec: ${spec.source || 'none'} (${spec.total} criteria, ${spec.size.renderedChars} chars)`);
  if (spec.size.overLimit) {
    logger.warn(
      `spec too large: ${spec.size.renderedChars} rendered chars exceeds the ${spec.size.limitChars}-char ` +
      'limit — the judge is skipped and the verdict blocks (spec_too_large).'
    );
  }

  // (4b) The spec freeze and the judge attempt cap.
  //
  // HERE, and not later, for the same reason DAILY_JOB_CAP is enforced before the spend rather
  // than after it: both controls answer "may this PR be graded at all", and a control consulted
  // after the money is gone is a report, not a cap. Everything below this line either runs PR
  // code or bills a judge call.
  //
  // Both answers come from the DURABLE store (fetchPriorRuns), never from this process. An
  // in-process counter is reset by pushing again, and an in-process fingerprint has nothing to
  // compare against — the whole point is that the PR body can change between runs.
  const freeze = resolveFreeze(config);
  const prior = await fetchPriorRuns({ repo: `${owner}/${repo}`, prNumber: number }, env);
  // The fingerprint this run may be judged against IS the one it would pin — one function, so
  // the comparison and the recorded baseline cannot drift apart. See freeze.js.
  const pinned = pinnableFingerprint(spec);
  // Fail-closed when the store did not answer. This deliberately overrides log.js's "logging
  // must never block a verdict" contract, and freeze.js documents exactly why: these two are not
  // features computed from the log, they ARE the log. Throwing (rather than composing a verdict)
  // because every verdict reachable from here is one GitHub may count as passing — INSUFFICIENT
  // EVIDENCE maps to `neutral`, which passes a Required check. A throw never reaches finalize(),
  // so no check run is created. Same shape as assertJailCoherent above.
  const refusal = refuseOnUnprovenFreeze({
    available: prior.available,
    gating,
    labels,
    // Both controls guard against laundering a PASS. A run that cannot reach VERIFIED — fork, no
    // real spec, over-limit spec — has no pass to launder, and `pinned` is already exactly the
    // "real and gradeable" test.
    couldReachVerified: Boolean(pinned) && !gate.fork,
    storeReason: prior.reason,
  });
  if (refusal.refuse) {
    await publishRefusal({ gh, owner, repo, headSha, reason: refusal.reason, post, dryRun, env });
    throw new Error(refusal.reason);
  }
  if (!prior.available) {
    logger.warn(`spec freeze + attempt cap are UNPROVEN (${prior.reason || 'store unavailable'}) — ${refusal.reason}`);
  }
  const specDrift = decideSpecDrift({ current: pinned, baseline: prior.baselineFingerprint });
  const attempts = decideAttempts({ used: prior.judgeAttempts, limit: freeze.maxJudgeRuns });
  if (specDrift.changed) {
    logger.warn(
      `spec changed after grading: pinned ${String(specDrift.baseline).slice(0, 12)}, `
      + `now ${String(specDrift.current).slice(0, 12)} — the judge is skipped and the verdict blocks (spec_changed).`
    );
  } else if (attempts.exhausted) {
    logger.warn(`judge attempts exhausted: ${attempts.used}/${attempts.limit} — the judge is skipped (attempts_exhausted).`);
  } else if (prior.available) {
    logger.info(`judge budget: attempt ${attempts.used + 1} of ${attempts.limit}${pinned ? ` · spec pin ${pinned.slice(0, 12)}` : ''}`);
  }

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
    //
    // `!spec.size.overLimit` because that call is GUARANTEED to throw: runSeat folds the
    // criteria into its overhead measurement and refuses to fire a request it already knows
    // exceeds the seat budget. The verdict is decided either way — spec_too_large blocks —
    // so firing it would buy an identical red check minus the diagnosis, plus the CI minutes.
    // Falling to the else still runs createJudge, so the cross-family guard is not skipped.
    // The full set of reasons NOT to spend lives in shouldRunJudge() above, where it is testable.
    if (shouldRunJudge({ spec, installFailed, fork: gate.fork, specDrift, attempts })) {
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
  const verdictObj = compose({ triage, spec, tier1, tier3, installFailed, judgeStatus, trigger: gate, specDrift, attempts });

  return finalize({ gh, owner, repo, number, dryRun, post, started, meta, configSource, detected, env,
    verdictObj, spec, tier1, tier3, diff, gating, labels, judgeStatus,
    // `attempted` is folded in so the comment can say "run k of N" counting THIS run, without
    // re-deriving from a judgeStatus the renderer would otherwise have to interpret.
    freezeState: { pinned, drift: specDrift, attempts, available: prior.available, attempted: judgeStatus.attempted } });
}

async function finalize({ gh, owner, repo, number, dryRun, post, started, meta, configSource, detected, env, verdictObj, spec, tier1, tier3, gating, labels, judgeStatus, freezeState }) {
  meta.durationMs = Date.now() - started;
  // `cause` is what lets an INSUFFICIENT EVIDENCE gate distinguish the lanes a PR can
  // drive (broken install, no criteria, fork, an induced judge error) from the one it
  // cannot (the adopter has no judge key). Dropping it here would collapse them back
  // into one bucket and quietly re-open the bypass — the F2/M7 dead-code shape.
  const gateResult = gateDecision({ verdict: verdictObj.verdict, cause: verdictObj.cause, gating: gating || resolveGating({}), labels: labels || [] });
  const note = verdictObj.verdict === 'SKIPPED' ? verdictObj.reason : undefined;
  let body = render({
    verdict: verdictObj.verdict, spec, tier1, tier3,
    required_to_pass: verdictObj.required_to_pass, meta, note, freeze: freezeState,
  });
  if (gateResult.blocks) {
    body += '\n\n> 🚫 **Gating:** this verdict is configured to block — it blocks merge when the "Felix verdict" check is marked Required in branch protection.';
  } else if (gateResult.overridden) {
    body += `\n\n> ⚠️ **Gating override:** ${gateResult.reason}.`;
  }

  // (9) Log + report.
  //
  // ORDER IS LOAD-BEARING: the log is awaited BEFORE the check run is created below, and the
  // attempt cap depends on it. `judge_attempted` is what the next run counts, so any green an
  // attacker could harvest must already have charged the budget. Post the check first and a run
  // that dies in between publishes a passing check while its judge roll goes unrecorded — free
  // re-rolls, which is the whole thing the cap exists to stop. A crash BEFORE this line loses the
  // attempt too, but it also produces no check run and no comment, so it advances nothing.
  //
  // Do not "optimize" this by posting the verdict first or by not awaiting. A test pins it.
  await logVerdict({
    repo: `${owner}/${repo}`, pr_number: number, pr_title: meta.prTitle,
    head_sha: meta.headSha, base_sha: meta.baseSha,
    verdict: verdictObj.verdict,
    // The verdict is the label; the cause is the contract. gating.js keys its exemptions on
    // the cause, and INSUFFICIENT EVIDENCE alone is six different situations — logging the
    // verdict without the cause records which word was printed and discards which lane the PR
    // actually drove. It is also what the freeze and the attempt cap read back on the next run.
    cause: verdictObj.cause || null,
    // Pinned ONLY by a run that had a real, gradeable spec — pinnableFingerprint() is the same
    // call the drift comparison made at step 4b, deliberately shared so what gets RECORDED and
    // what gets COMPARED can never disagree. A fallback (PR-title) or over-limit spec was never
    // put in front of the judge, so letting either become the baseline would pin criteria nobody
    // was graded against, and would then flag the author's first real criteria as drift.
    spec_fingerprint: pinnableFingerprint(spec),
    // Charged per JUDGE CALL, not per run: a run that skipped the judge rolled no dice.
    judge_attempted: Boolean(judgeStatus && judgeStatus.attempted),
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

module.exports = { run, triageFiles, triggerGate, reportError, baseConfigFetcher, shouldRunJudge, NEVER_SKIP };
