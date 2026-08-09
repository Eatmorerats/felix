/**
 * preflight.js — Felix without a pull request.
 *
 * WHY. Felix's whole value is being an INDEPENDENT one-shot: CI grades the pushed head once,
 * against criteria it pinned, under a budget it enforces. The obvious "improvement" — let the
 * agent read Felix's verdict in CI and push a fix, repeat — destroys exactly that. `required_to_pass`
 * and the judge's reasons are derived from head content, so a code comment in the diff becomes a
 * prompt-injection channel straight into an agent holding push credentials. There is no version of
 * CI auto-repair that is worth building.
 *
 * The iteration loop is still worth having; it just belongs BEFORE the PR exists. Locally the same
 * text is not a channel into anything, because the agent already owns the working tree it would be
 * "injected" from — reading your own file back is not a privilege boundary. So: the agent grinds
 * against a local Felix until it is clean, opens the PR once, and CI's single independent shot is
 * left untouched. That is what this file is.
 *
 * ── THE CONTAINMENT BOUNDARY, WHICH IS THE POINT OF THE MODULE LIST ABOVE ────────────────────
 *
 * This file imports NOTHING from index.js, log.js or github.js — not directly and not through
 * anything else. That is not tidiness, it is the security property, and a `--dry-run` flag would
 * not have bought it. Two attacks, both purely local, both closed by the absence of an import:
 *
 *   - THE PIN. fetchPriorRuns() takes the EARLIEST non-null `spec_fingerprint` for a
 *     (repo, pr_number) as the freeze baseline. A local run that wrote one row would BE that
 *     baseline — the agent would pin its own rubric before CI ever graded, and CI's freeze would
 *     then faithfully protect the agent's choice.
 *   - THE CAP. `judge_attempted: true` rows are what the ten-attempt cap counts. A loop that
 *     logged them would burn CI's budget from the outside: a denial-of-verification that costs
 *     the attacker nothing.
 *
 * It follows that pre-flight must also RUN with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
 * `GITHUB_TOKEN` entirely absent from the environment, and `probe-preflight-containment.js`
 * asserts that. "Cannot write because the code doesn't" is good; "cannot write because the
 * credential was never needed" is what actually survives a future refactor. Note the store is not
 * READ either: it is keyed on (repo, pr_number) and pre-flight runs before a PR number exists, so
 * there is nothing to query — and requiring the service-role key to ask would forfeit the
 * property above for no information, in a process that spawns the repo's own test code in a loop.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────────────────────
 *
 * A tripwire, not a wall. The criteria come from a file the agent can rewrite, the local refs are
 * refs the agent can move, and the spend counter is a file the agent can delete. Every one of
 * those is stated out loud in the output rather than papered over, because a control that reads
 * as enforcement and isn't is worse than no control. The wall is still CI, and the honest claim
 * for this file is narrower: it tells you what CI is *going to* say, before you spend CI's one
 * shot finding out.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { version } = require('../../package.json');
const { logger } = require('./util/logger');
const { loadConfig, resolveWorkdir, parseConfigJSON, CONFIG_FILENAME } = require('./config');
const { triageFiles } = require('./triage');
const { buildSpec, criteriaCapChars, specFingerprint } = require('./spec');
const { promptBudgetTokens } = require('./budget');
const { PROVIDERS } = require('./providers');
const { createLocalSandbox } = require('./sandbox');
const { snapshotWorkingTree } = require('./snapshot');
const { runTier1 } = require('./tier1');
const { resolveIsolation, assertJailCoherent, preflightDocker } = require('./isolation');
const { buildDrivePlan } = require('./drive');
const { run: execRun } = require('./util/exec');
const { buildCleanEnv } = require('./util/env');
const { createJudge } = require('./judge');
const { compose, CAUSES } = require('./verdict');
const { render } = require('./comment');
const { preloadOptional, armModuleLock } = require('./preload');

/** Where criteria live when the caller does not say. Conventional, and gitignore-able. */
const DEFAULT_CRITERIA_PATH = path.join('.felix', 'preflight-criteria.md');

/**
 * Pre-flight's scratch space lives OUTSIDE the repository, keyed by the repo's path.
 *
 * The CI sandbox puts its worktree in `<repo>/.felix-worktrees/` and gets away with it because
 * Felix's own .gitignore lists that path — an adopter's does not, and pre-flight snapshots the
 * working tree with `git add -A`. Writing scratch inside the repo therefore feeds Felix's output
 * back into Felix's input: the second run folds a whole checked-out copy of the repository into
 * its own snapshot, the tree is never byte-identical to the last one, and the "unchanged tree, do
 * not re-judge" rule silently stops working. snapshot.js drops the directory defensively as well;
 * this is the half that stops it being created in the first place.
 */
function scratchDirFor(repoRoot) {
  const key = crypto.createHash('sha1').update(path.resolve(repoRoot)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'felix-preflight', key);
}

/**
 * The ONLY two causes an automated loop may retry. Everything else is terminal.
 *
 * `criteria_unmet` and `install_failed` are the two states where the fix is unambiguously in the
 * CODE: the tests do not pass, or the thing would not build. An agent iterating on those is doing
 * the work.
 *
 * Every other cause is terminal, and two of them are the hard line: `no_spec` and
 * `spec_too_large` are states where the only way to "pass" is to author or trim the RUBRIC. The
 * moment a loop can do that, the verifier grades a spec written by the thing being graded, and
 * the whole apparatus is decorative. A human writes the acceptance criteria. That is not a
 * configurable stance and there is no flag for it here.
 *
 * `judge_error` and `judge_unconfigured` are terminal for a duller reason — retrying them just
 * re-buys the same failure — and `spec_changed` / `attempts_exhausted` cannot occur locally at
 * all, since neither control has a durable store to read.
 */
const RETRYABLE_CAUSES = [CAUSES.CRITERIA_UNMET, CAUSES.INSTALL_FAILED];

/** Default ceiling on graded pre-flight runs per day. Advisory — see the note on spend below. */
const DEFAULT_DAILY_JUDGE_CAP = 20;

/** Run a git command locally and return stdout, or null when it fails. */
async function gitOut(cmd, { cwd, env, timeoutMs = 60000, deps = {} }) {
  const runFn = deps.run || execRun;
  const r = await runFn(`git ${cmd}`, { cwd, env, timeoutMs });
  return r.code === 0 ? r.stdout : null;
}

/**
 * Work out what to diff against.
 *
 * An explicit `--base` wins. Otherwise: the remote's default branch, because that is the ref the
 * eventual PR will actually target, and predicting CI is this tool's only job. `origin/HEAD` is
 * asked first (it names the default branch rather than assuming it), then the two conventional
 * names, then the local branch of the same name for a repo with no remote at all.
 *
 * Returns `{ref, source}` — or `{ref: null}`, which the caller treats as "diff against HEAD",
 * i.e. grade only what is uncommitted. That is the honest answer for a repo with no upstream:
 * inventing a base would make the diff wrong in a way nothing downstream could detect.
 */
async function resolveBaseRef({ repoRoot, env, explicit, deps = {} }) {
  const verify = async (ref) => {
    const out = await gitOut(`rev-parse --verify --quiet ${ref}`, { cwd: repoRoot, env, deps });
    return out ? ref : null;
  };

  if (explicit) {
    if (!(await verify(explicit))) throw new Error(`--base "${explicit}" is not a ref in this repository.`);
    return { ref: explicit, source: 'you passed --base' };
  }

  const symbolic = await gitOut('symbolic-ref --quiet --short refs/remotes/origin/HEAD', { cwd: repoRoot, env, deps });
  if (symbolic && (await verify(symbolic))) return { ref: symbolic, source: "origin's default branch" };

  for (const ref of ['origin/main', 'origin/master']) {
    if (await verify(ref)) return { ref, source: 'the conventional default branch' };
  }
  for (const ref of ['main', 'master']) {
    if (await verify(ref)) return { ref, source: 'a LOCAL branch — there is no origin to compare against' };
  }
  return { ref: null, source: 'nothing — no default branch found' };
}

/**
 * Turn `git diff --name-status` into the file objects the rest of the pipeline expects.
 *
 * The shape is GitHub's, deliberately: `{filename, status, previous_filename?, patch?}` is what
 * tier1's secret scan, deps.js's rename map and crap.js's coverage attribution already read. Any
 * other shape would mean a local-only branch through code the CI path has proven.
 */
function parseNameStatus(raw) {
  const files = [];
  for (const line of (raw || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0];
    if (code.startsWith('R') && parts.length >= 3) {
      files.push({ filename: parts[2], status: 'renamed', previous_filename: parts[1] });
    } else if (code.startsWith('C') && parts.length >= 3) {
      files.push({ filename: parts[2], status: 'copied', previous_filename: parts[1] });
    } else if (parts.length >= 2) {
      const status = code[0] === 'A' ? 'added' : code[0] === 'D' ? 'removed' : 'modified';
      files.push({ filename: parts[1], status });
    }
  }
  return files;
}

/**
 * Split a unified diff into per-file patches and attach them.
 *
 * Only crap.js reads `.patch` (and only when the opt-in coverage check is on), but attaching it
 * here keeps the local file objects indistinguishable from GitHub's — so nothing downstream has
 * to learn that it might be running locally.
 */
function attachPatches(files, diff) {
  if (!diff) return files;
  const byName = new Map(files.map((f) => [f.filename, f]));
  // Split on the `diff --git` header, keeping it: each chunk is one file's patch.
  const chunks = diff.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const header = chunk.split('\n', 1)[0];
    // `a/path b/path` — take the b-side, which is the post-change name (and the rename target).
    const m = header.match(/\sb\/(.+)$/);
    if (!m) continue;
    const f = byName.get(m[1]);
    if (f) f.patch = `diff --git ${chunk}`;
  }
  return files;
}

/**
 * Read felix.config.json's POLICY half from the base ref — and be loud when that is impossible.
 *
 * In CI this fetcher THROWS on an unreadable base ref, because falling back to head would let the
 * pull request choose the policy it is judged by. That reasoning does not transfer here, and
 * copying it would be theatre: locally there is no second principal. The agent owns the working
 * tree, every local ref (`git update-ref refs/remotes/origin/main <anything>` is one command), the
 * config file and the environment. A lock whose hinges the adversary owns protects nobody, and
 * throwing would break the legitimate offline / no-remote case for that nothing.
 *
 * What the base-ref split DOES still buy locally is prediction accuracy — CI will judge under the
 * base ref's config, so pre-flight should too. Hence: read the base ref when it is readable, fall
 * back to the working tree when it is not, and never do the second one silently. `warnings` comes
 * back to the caller so the banner is printed with the verdict rather than buried in a log line.
 */
function localBaseConfigFetcher({ repoRoot, env, baseRef, warnings, deps = {} }) {
  return async () => {
    const wtPath = path.join(repoRoot, CONFIG_FILENAME);
    const wtRaw = fs.existsSync(wtPath) ? fs.readFileSync(wtPath, 'utf8') : null;

    if (baseRef) {
      // `git show <ref>:<file>` exits non-zero for BOTH "no such ref" and "no such file at ref",
      // so the ref is verified separately — otherwise a missing config would be misread as an
      // unreadable ref and trigger the fallback banner on a perfectly healthy repo.
      const refOk = await gitOut(`rev-parse --verify --quiet ${baseRef}`, { cwd: repoRoot, env, deps });
      if (refOk) {
        const raw = await gitOut(`show ${baseRef}:${CONFIG_FILENAME}`, { cwd: repoRoot, env, deps });
        if (raw === null) return { present: false, ref: baseRef };
        // Both sides exist and differ: the honest, common failure is an author editing the config
        // and wondering why CI ignored it. Name the keys that actually diverge.
        if (wtRaw !== null && wtRaw !== raw) {
          let keys = [];
          try {
            const a = parseConfigJSON(raw, baseRef);
            const b = parseConfigJSON(wtRaw, 'your working tree');
            keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
              .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
          } catch (_) { /* one side is malformed; the differing-key list is a nicety, not the point */ }
          warnings.push(
            `⚠️ POLICY DRIFT — your working tree's ${CONFIG_FILENAME} differs from ${baseRef}'s`
            + `${keys.length ? ` (${keys.join(', ')})` : ''}. Pre-flight used the ${baseRef} version, `
            + 'because that is the one CI will use.'
          );
        }
        return { present: true, raw, ref: baseRef };
      }
    }

    warnings.push(
      `⚠️ POLICY FALLBACK — could not read ${CONFIG_FILENAME} from a base ref, so policy came from `
      + 'your working tree. CI reads it from the base ref and may judge differently.'
    );
    return wtRaw !== null
      ? { present: true, raw: wtRaw, ref: 'your working tree' }
      : { present: false, ref: 'your working tree' };
  };
}

/** Read the criteria file into a PR-shaped object buildSpec already knows how to read. */
function loadCriteria({ repoRoot, criteriaPath }) {
  const rel = criteriaPath || DEFAULT_CRITERIA_PATH;
  const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return { present: false, path: rel, body: '' };
  return { present: true, path: rel, body: fs.readFileSync(abs, 'utf8') };
}

/**
 * The local spend controls. Read the header note before changing any of this.
 *
 * None of it is a wall, and pretending otherwise would be the dishonest kind of security. The
 * adversary is the process that INVOKES the CLI: `--max-attempts` resets on re-invocation, this
 * state file can be deleted with one command, and a loop driver that owns the count owns the
 * count. Every software cap here is defeated by an agent that simply runs the command again.
 *
 * So what are they for? Two real things:
 *
 *   - The default. The judge is OFF unless asked for, so the overwhelmingly common loop — grind
 *     until the tests pass — costs nothing at all. Tier 1 is where install_failed and most
 *     criteria_unmet surface anyway.
 *   - Visibility. Deleting the state file to keep judging is still possible, but it is an ACT,
 *     and it appears in the agent's transcript. That converts silent overspend into something a
 *     human can see afterwards, which is the achievable goal.
 *
 * The actual wall is the wallet: set `OPENAI_API_KEY_PREFLIGHT` to a key with a hard spend limit
 * at the vendor. That is the only mechanism the invoking agent cannot code around, and it is why
 * falling back to the shared `OPENAI_API_KEY` prints a warning instead of passing quietly.
 *
 * The unchanged-tree refusal is the one that earns its keep on merit: snapshot SHAs are
 * deterministic in (tree, HEAD), so re-judging an identical tree buys judge variance, not
 * information. It is also the local echo of what CI's attempt cap is really for.
 */
function judgeGuard({ repoRoot, sha, env, deps = {} }) {
  const statePath = deps.statePath || path.join(scratchDirFor(repoRoot), 'preflight-state.json');
  const today = (deps.today || new Date().toISOString().slice(0, 10));
  const cap = Number(env.FELIX_PREFLIGHT_JUDGE_CAP) > 0
    ? Number(env.FELIX_PREFLIGHT_JUDGE_CAP)
    : DEFAULT_DAILY_JUDGE_CAP;

  let state = { day: today, count: 0, lastJudgedSha: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object') state = { ...state, ...parsed };
  } catch (_) { /* absent or corrupt — a fresh counter is the right recovery, it is advisory */ }
  if (state.day !== today) state = { day: today, count: 0, lastJudgedSha: state.lastJudgedSha };

  const refuse = (reason) => ({ allowed: false, reason, state, statePath, cap });

  if (state.lastJudgedSha === sha) {
    return refuse(
      `the tree is byte-identical to the last graded run (${sha.slice(0, 8)}) — re-judging it buys `
      + 'judge variance, not information. Change something first.'
    );
  }
  if (state.count >= cap) {
    return refuse(
      `${state.count} graded pre-flight runs already today (cap ${cap}). Raise it with `
      + `FELIX_PREFLIGHT_JUDGE_CAP, or delete ${statePath}. This is a tripwire, not a wall — `
      + 'the real limit belongs on the API key.'
    );
  }
  return {
    allowed: true,
    state,
    statePath,
    cap,
    /** Charged on the ATTEMPT, before the result is known — same discipline as CI's cap. */
    charge() {
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ day: today, count: state.count + 1, lastJudgedSha: sha }, null, 2));
      } catch (e) {
        logger.warn(`could not record the pre-flight judge attempt (${e.message}) — the daily counter will undercount.`);
      }
    },
  };
}

/**
 * Verify the CURRENT WORKING TREE against a local criteria file. Publishes nothing, anywhere.
 *
 * @param {object} opts
 * @param {string} [opts.repoPath]     repo to verify (default: cwd)
 * @param {string} [opts.criteriaPath] criteria markdown (default: .felix/preflight-criteria.md)
 * @param {string} [opts.base]         explicit base ref to diff against
 * @param {boolean} [opts.judge]       call the cross-family judge (default false — it costs money)
 * @param {object} [opts.env]          environment (default process.env)
 * @param {object} [opts.deps]         test seam: { createJudge }. The judge is the one step that
 *                                     costs money and makes a network call, so the eligibility
 *                                     conjunction below is unreachable from a test without it —
 *                                     which is exactly how a clause gets dropped unnoticed.
 * @returns {Promise<object>} { verdict, cause, retryable, required_to_pass, body, ... }
 */
async function runPreflight(opts = {}) {
  const env = opts.env || process.env;
  const makeJudge = (opts.deps && opts.deps.createJudge) || createJudge;
  const started = Date.now();
  const warnings = [];
  const gitEnv = buildCleanEnv();

  // (1) Freeze the working tree into a real commit, without disturbing it.
  logger.step(1, 'snapshotting the working tree');
  const snap = await snapshotWorkingTree({ repoPath: opts.repoPath || process.cwd() });
  const { repoRoot } = snap;
  logger.info(`snapshot ${snap.sha.slice(0, 8)} — ${snap.dirty ? 'working tree differs from HEAD' : 'clean tree, identical to HEAD'}`);
  if (snap.untracked.length) {
    warnings.push(
      `⚠️ ${snap.untracked.length} NEW file(s) are included here but reach CI only if you commit them: `
      + `${snap.untracked.slice(0, 10).join(', ')}${snap.untracked.length > 10 ? ', …' : ''}`
    );
  }

  // (2) Base ref, then the diff.
  const base = await resolveBaseRef({ repoRoot, env: gitEnv, explicit: opts.base });
  const diffFrom = base.ref
    ? (await gitOut(`merge-base ${base.ref} ${snap.sha}`, { cwd: repoRoot, env: gitEnv })) || base.ref
    : snap.headSha;
  if (!base.ref) {
    warnings.push(
      '⚠️ NO BASE BRANCH found, so only your UNCOMMITTED changes were graded. Pass --base <ref> to '
      + 'compare against the branch the PR will target.'
    );
  }
  logger.info(`base: ${diffFrom.slice(0, 8)} (${base.source})`);

  const nameStatus = await gitOut(`diff -M --name-status ${diffFrom} ${snap.sha}`, { cwd: repoRoot, env: gitEnv, timeoutMs: 120000 });
  const diff = (await gitOut(`diff -M ${diffFrom} ${snap.sha}`, { cwd: repoRoot, env: gitEnv, timeoutMs: 120000 })) || '';
  const files = attachPatches(parseNameStatus(nameStatus), diff);
  logger.info(`${files.length} changed file(s) vs the base`);

  // (3) Config — policy from the base ref where possible, mechanics from the tree being run.
  logger.step(2, 'loading config');
  const fetchBaseConfig = localBaseConfigFetcher({ repoRoot, env: gitEnv, baseRef: base.ref, warnings });
  const { config, source: configSource, detected } = await loadConfig({ repoPath: repoRoot, fetchBaseConfig });

  // Same jail coherence check, in the same place, for the same reason — and additionally because
  // a pre-flight that ran outside the jail CI will use would be predicting the wrong thing.
  const isolation = resolveIsolation(config);
  assertJailCoherent({ isolation, hasDrivePlan: buildDrivePlan(config) !== null });
  await preflightDocker({ isolation, run: execRun });

  // (4) Triage — the SHARED implementation, so a local SKIP means a CI SKIP.
  logger.step(3, 'triage');
  const triage = triageFiles(files, config.skipGlobs);
  if (triage.skipped) logger.info('only non-behavioral files changed → SKIPPED');

  // (5) Spec, from the local criteria file.
  logger.step(4, 'loading spec');
  const criteria = loadCriteria({ repoRoot, criteriaPath: opts.criteriaPath });
  if (!criteria.present) {
    warnings.push(
      `⚠️ NO CRITERIA FILE at ${criteria.path}. Write the acceptance criteria you intend to put in `
      + 'the PR description there — as a markdown checklist under an "Acceptance criteria" heading.'
    );
  }
  // `title: ''` on purpose: buildSpec falls back to the PR title when it finds no criteria, and
  // locally there is no title to fall back to. Passing one would manufacture a spec out of a
  // branch name and let a `no_spec` run look gradeable — the exact laundering the fallback is
  // already marked as weak for. An empty title leaves hadRealSpec false, which is the truth.
  const spec = buildSpec({ title: '', body: criteria.body }, [], triage.behavioral, {
    maxCriteriaChars: criteriaCapChars(promptBudgetTokens(env, PROVIDERS)),
  });
  const fingerprint = specFingerprint(spec.criteria);
  logger.info(`spec: ${spec.source || 'none'} (${spec.total} criteria, ${spec.size.renderedChars} chars)`);

  // (6) Judge eligibility. NOT shouldRunJudge() from index.js, and the difference is real rather
  // than drift: there is no fork here, no durable pin and no durable attempt count, and there IS
  // an explicit opt-in plus the unchanged-tree rule. What the two DO share — a real spec, a spec
  // small enough to grade, and code that actually built — is asserted below in the same order.
  const judgeWanted = Boolean(opts.judge);
  // The guard is built UNCONDITIONALLY, even when the judge was not asked for. Building it only
  // when `judgeWanted` made the two conditions collapse into one: `guard && guard.allowed` was
  // then false whenever --judge was absent, so the `judgeWanted` clause in the conjunction below
  // was doing nothing and no test could tell if it were deleted. A mutation run proved exactly
  // that — the clause survived removal. Now the two are independent: `judgeWanted` is the opt-in,
  // `guard.allowed` is the spend rule, and each can be pinned on its own.
  const guard = judgeGuard({ repoRoot, sha: snap.sha, env });
  if (judgeWanted && !guard.allowed) warnings.push(`⚠️ JUDGE SKIPPED — ${guard.reason}`);
  // The judge reads OPENAI_API_KEY. Prefer a dedicated pre-flight key so a runaway local loop
  // cannot spend the budget CI depends on, and say so when there isn't one.
  const judgeEnv = { ...env };
  if (env.OPENAI_API_KEY_PREFLIGHT) {
    judgeEnv.OPENAI_API_KEY = env.OPENAI_API_KEY_PREFLIGHT;
  } else if (judgeWanted && env.OPENAI_API_KEY) {
    warnings.push(
      '⚠️ SHARED JUDGE KEY — pre-flight is spending the same OPENAI_API_KEY as CI. Set '
      + 'OPENAI_API_KEY_PREFLIGHT to a key with a hard spend limit; that is the only real cap.'
    );
  }

  // (7) Sandbox + Tier 1 + optional judge.
  logger.step(5, 'preparing sandbox');
  let sandbox;
  let tier1 = [];
  let installFailed = false;
  let tier3 = null;
  const judgeStatus = { configured: Boolean(judgeEnv.OPENAI_API_KEY), error: null, attempted: false, fork: false };
  preloadOptional();
  armModuleLock();

  try {
    // rootDir outside the repo — see scratchDirFor. The worktree still shares the repo's object
    // store (that is what makes `git worktree add` cheap); only the checkout location moves.
    sandbox = await createLocalSandbox({ repoPath: repoRoot, sha: snap.sha, rootDir: scratchDirFor(repoRoot) });
    const cwd = resolveWorkdir(sandbox.dir, config.workdir);

    logger.step(6, 'running Tier 1 checks');
    const t1 = await runTier1({
      cwd, repoRoot: sandbox.dir, env: sandbox.cleanEnv, config, files: triage.behavioral,
      repoPath: repoRoot, baseSha: diffFrom, headSha: snap.sha, filesAll: files,
    });
    tier1 = t1.results;
    installFailed = t1.installFailed;

    const eligible = !triage.skipped
      && spec.hadRealSpec
      && !spec.size.overLimit
      && !installFailed
      && judgeWanted
      && guard.allowed;

    if (eligible) {
      logger.step(7, 'cross-family judge');
      const adversarial = Boolean(
        (config.judge && config.judge.adversarial)
        || /^(1|true|yes|on)$/i.test(env.FELIX_JUDGE_ADVERSARIAL || '')
      );
      const judge = makeJudge(judgeEnv, { adversarial }); // throws if Anthropic family
      if (judge) {
        // Charged BEFORE the call, not after. Same reason CI awaits logVerdict before publishing
        // the check: a counter that only increments on success is not a counter, it is a
        // discount for whatever makes the call fail.
        guard.charge();
        judgeStatus.attempted = true;
        try {
          tier3 = await judge({ prTitle: '(pre-flight)', criteria: spec.criteria, diff, tier1 });
        } catch (e) {
          logger.warn(`judge error: ${e.message}`);
          judgeStatus.error = e.message;
          tier3 = null;
        }
      }
    } else {
      makeJudge(judgeEnv); // still enforce the cross-family guard even when skipping
      if (!judgeWanted) logger.info('judge not requested — pass --judge to grade the criteria (costs money)');
    }
  } finally {
    if (sandbox) await sandbox.teardown();
  }

  // (8) Verdict. `trigger` is spelled out rather than omitted so the draft/fork branches are
  // provably not reachable here, and specDrift/attempts are absent because both controls live in
  // a store this module cannot see — reporting either would be inventing a result.
  logger.step(8, 'composing verdict');
  const verdictObj = compose({
    triage, spec, tier1, tier3, installFailed, judgeStatus, trigger: { draft: false, fork: false },
  });

  // `judge_unconfigured` reads "this repo has no judge key" — true in CI, where nobody chose it.
  // Locally there are three different ways to arrive at it and only one is that one, so say which.
  // The VERDICT is left alone: tests passing while nothing graded the criteria genuinely is
  // INSUFFICIENT EVIDENCE, and bending a shared verdict to flatter a local mode is how the two
  // stop predicting each other.
  if (verdictObj.cause === CAUSES.JUDGE_UNCONFIGURED) {
    warnings.push(
      !judgeWanted
        ? '⚠️ CRITERIA NOT GRADED — Tier 1 only, because --judge was not passed. The checks below '
          + 'are real; nothing has yet checked the code against your acceptance criteria.'
        : !judgeStatus.configured
          ? '⚠️ CRITERIA NOT GRADED — --judge was passed but no judge key is set. Set '
            + 'OPENAI_API_KEY_PREFLIGHT (preferred) or OPENAI_API_KEY.'
          : '⚠️ CRITERIA NOT GRADED — the judge was requested but skipped; see the reason above.'
    );
  }

  const meta = {
    version,
    headSha: snap.sha,
    baseSha: diffFrom,
    dryRun: true,
    repo: '(local pre-flight)',
    prTitle: '(pre-flight)',
    durationMs: Date.now() - started,
  };
  const body = render({
    verdict: verdictObj.verdict, spec, tier1, tier3,
    required_to_pass: verdictObj.required_to_pass, meta,
    note: verdictObj.verdict === 'SKIPPED' ? verdictObj.reason : undefined,
  });

  return {
    verdict: verdictObj.verdict,
    cause: verdictObj.cause || null,
    reason: verdictObj.reason,
    required_to_pass: verdictObj.required_to_pass,
    // The loop's contract. Computed here, from the cause, so a caller cannot decide for itself
    // that no_spec looks retryable — see RETRYABLE_CAUSES.
    retryable: RETRYABLE_CAUSES.includes(verdictObj.cause),
    // Surfaced so a test can assert the judge was NOT called, which is the only way to pin the
    // eligibility conjunction — a skipped call leaves no other trace in the result.
    judge: {
      requested: judgeWanted,
      attempted: judgeStatus.attempted,
      error: judgeStatus.error,
      guard: { allowed: guard.allowed, reason: guard.reason || null },
    },
    fingerprint,
    criteriaPath: criteria.path,
    criteriaPresent: criteria.present,
    snapshot: { sha: snap.sha, tree: snap.tree, headSha: snap.headSha, dirty: snap.dirty, untracked: snap.untracked },
    base: { ref: base.ref, source: base.source, sha: diffFrom },
    warnings,
    spec, tier1, tier3, files, configSource, detected, meta, body,
  };
}

/**
 * The human-facing summary. Icons AND words on every line — a reader who cannot tell the tick
 * from the cross still gets the state from the sentence.
 */
function formatPreflight(result) {
  const lines = [];
  const mark = result.verdict === 'VERIFIED' ? '✅ VERIFIED'
    : result.verdict === 'NOT VERIFIED' ? '❌ NOT VERIFIED'
    : result.verdict === 'SKIPPED' ? '⏭️ SKIPPED'
    : '❓ INSUFFICIENT EVIDENCE';

  lines.push('', '─'.repeat(64));
  lines.push(`Felix pre-flight — ${mark}${result.cause ? `  (${result.cause})` : ''}`);
  lines.push('─'.repeat(64));
  lines.push(`snapshot   ${result.snapshot.sha.slice(0, 12)}  ${result.snapshot.dirty ? '· uncommitted changes included' : '· clean tree'}`);
  lines.push(`base       ${result.base.sha.slice(0, 12)}  · ${result.base.source}`);
  lines.push(`criteria   ${result.criteriaPresent ? `${result.spec.total} from ${result.criteriaPath}` : `MISSING — ${result.criteriaPath}`}`);
  if (result.fingerprint) {
    lines.push(`fingerprint ${result.fingerprint.slice(0, 12)}`);
    lines.push('           ↳ the PR description must produce this same hash, or CI grades a different spec.');
  }

  if (result.required_to_pass && result.required_to_pass.length) {
    lines.push('', 'Required to pass:');
    for (const r of result.required_to_pass) lines.push(`  • ${r}`);
  }
  if (result.warnings.length) {
    lines.push('', ...result.warnings.map((w) => `  ${w}`));
  }
  lines.push('', result.retryable
    ? '↻ RETRYABLE — fix the code and run pre-flight again.'
    : '■ TERMINAL for an automated loop — this needs a human, not another iteration.');
  lines.push('', 'Pre-flight published nothing: no verdict row, no comment, no check run. CI still grades this independently.');
  lines.push('─'.repeat(64), '');
  return lines.join('\n');
}

module.exports = {
  runPreflight, formatPreflight, RETRYABLE_CAUSES, DEFAULT_CRITERIA_PATH,
  // exported for tests: each is a decision that must be assertable without a live repo
  resolveBaseRef, parseNameStatus, attachPatches, localBaseConfigFetcher, judgeGuard, loadCriteria,
};
