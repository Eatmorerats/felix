/**
 * sentinel.js — the `pull_request: edited` half of the spec freeze.
 *
 * WHY A SECOND ENTRY POINT AT ALL. The freeze in index.js only fires when Felix runs, and Felix
 * runs on the events the ADOPTER listed in their workflow. Two gaps follow, and neither is
 * fixable from inside the main pipeline:
 *
 *   - a workflow that omits `edited` sees no event when the PR body changes, so the pin waits for
 *     the next push — and "edit the criteria after the final green, then merge" needs no push.
 *   - even a workflow that DOES list `edited` (examples/felix.yml has, since v1.0.0) pays for a
 *     full pipeline on every body edit: a checkout, an install, the PR's own test suite. That is
 *     expensive enough that adopters trim the trigger, which is how the first gap gets created.
 *
 * So this recomputes ONE thing — the criteria fingerprint — and compares it to the pin. It reads
 * the PR body and its linked issues over the API and hashes them. It does not check out the head
 * ref, does not install anything, does not run a line of PR code, and never calls the judge. That
 * is what makes it cheap, and it is also what makes it safe to run from `pull_request_target`
 * (where a fork PR's edit still reaches a token that can write a check run at all).
 *
 * IT PUBLISHES ITS OWN CHECK RUN, deliberately not "Felix verdict".
 *
 * Sharing the name looked tidier and is a trap: check runs upsert by (SHA, name), so a sentinel
 * that wrote "Felix verdict" would overwrite a real verdict with a judgment it did not make. Worse
 * is the recovery path — the free relief for `spec_changed` is "put the criteria back", and after
 * a revert the sentinel finds no drift and would have nothing to write, leaving the verdict stuck
 * red until someone pushed a commit. A separate check is self-healing: drift reds it, a revert
 * greens it again, and it can never turn a genuinely failing verdict into a pass.
 *
 * Which means a repo that gates on Felix must mark BOTH checks Required. Said in the README and
 * in the example workflow, because a control nobody marks Required is advisory.
 */

const { version } = require('../../package.json');
const { logger } = require('./util/logger');
const { createGitHub, parseTarget } = require('./github');
const { parseConfigJSON, CONFIG_FILENAME } = require('./config');
const { resolveGating } = require('./gating');
const { buildSpec, linkedIssueNumbers, criteriaCapChars } = require('./spec');
const { promptBudgetTokens } = require('./budget');
const { PROVIDERS } = require('./providers');
const { pinnableFingerprint, decideSpecDrift, refuseOnUnprovenFreeze } = require('./freeze');
const { fetchPriorRuns } = require('./log');
const { baseConfigFetcher } = require('./index');

const CHECK_NAME = 'Felix spec pin';

const short = (fp) => (fp ? String(fp).slice(0, 12) : '');

/**
 * Read the POLICY half of the config without a checkout.
 *
 * loadConfig() cannot be used here: it needs a local repoPath for the MECHANICS half and for
 * auto-detection, and the whole point of the sentinel is that nothing is checked out. Only
 * `gating` is wanted anyway, and gating is base-sourced — so the base fetcher is used directly.
 * An unreadable base ref THROWS, exactly as it does in loadConfig: falling back to the head's own
 * config would let the PR choose whether its own drift is enforced.
 */
async function baseGating(gh, owner, repo, pr) {
  const fetchBase = baseConfigFetcher(gh, owner, repo, { baseSha: pr.base.sha, baseRef: pr.base.ref });
  const base = await fetchBase();
  return resolveGating(base && base.present ? parseConfigJSON(base.raw, 'the base ref') : {});
}

/**
 * Recompute the criteria fingerprint for one PR and report whether it still matches the pin.
 *
 * @returns {{state:'held'|'first'|'changed'|'unpinnable'|'unproven', conclusion:string, title:string, summary:string, ...}}
 */
async function runSpecSentinel(opts) {
  const env = opts.env || process.env;
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : env.FELIX_DRY_RUN !== 'false';
  const post = opts.post !== undefined ? opts.post : env.FELIX_POST_COMMENT === 'true';

  const { owner, repo, number } = parseTarget(opts.target);
  const gh = createGitHub(env.GITHUB_TOKEN, opts.apiBase ? { apiBase: opts.apiBase } : {});

  const pr = await gh.getPR(owner, repo, number);
  if (!pr) throw new Error(`PR ${owner}/${repo}#${number} not found (or no access).`);

  const gating = await baseGating(gh, owner, repo, pr);

  // The same sources buildSpec folds in during a real run, so the hash is computed over the same
  // set — including linked issues, which is the one spec source no pull_request event covers at
  // all (editing an issue fires nothing). Same 10-issue bound as index.js.
  const issues = [];
  for (const n of linkedIssueNumbers(pr.body || '').slice(0, 10)) {
    const issue = await gh.getIssue(owner, repo, n);
    if (issue && !issue.pull_request) issues.push(issue);
  }

  // `files: []` and it still matches the real run byte for byte: buildSpec only uses the changed
  // files to compute `mappedFiles`, and specFingerprint hashes `mapped[].text`, which file
  // mapping never touches. That is what lets the sentinel skip the getFiles call entirely.
  // The cap is taken from the same env-adjusted seat budget, so `overLimit` — and therefore
  // whether a spec is pinnable at all — agrees with the pipeline rather than approximating it.
  const spec = buildSpec(pr, issues, [], {
    maxCriteriaChars: criteriaCapChars(promptBudgetTokens(env, PROVIDERS)),
  });
  const current = pinnableFingerprint(spec);
  const prior = await fetchPriorRuns({ repo: `${owner}/${repo}`, prNumber: number }, env);

  const result = decide({ current, prior, gating, labels: (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name)) });
  logger.info(`spec pin: ${result.state} — ${result.title}`);

  let published = false;
  if (post && !dryRun && pr.head && pr.head.sha) {
    try {
      await gh.createCheckRun(owner, repo, {
        headSha: pr.head.sha, name: CHECK_NAME,
        conclusion: result.conclusion, title: result.title, summary: result.summary,
      });
      published = true;
    } catch (e) {
      logger.warn(`could not publish the ${CHECK_NAME} check run: ${e.message}`);
    }
  } else {
    logger.info(`dry-run — not publishing. ${CHECK_NAME}: ${result.conclusion}`);
  }

  return { ...result, published, current, baseline: prior.baselineFingerprint, repo: `${owner}/${repo}`, number };
}

/**
 * The whole decision, pure and separated from the I/O above so the table is testable.
 *
 * Every message pairs an icon with words — a reader who cannot distinguish the tick from the
 * cross still gets the state from the sentence.
 */
function decide({ current, prior, gating, labels }) {
  const foot = `\n\n<sub>Felix v${version} · spec pin sentinel · recomputed from the PR body and its linked issues; no PR code was fetched or run.</sub>`;

  if (!prior.available) {
    // Mirrors index.js exactly, through the same predicate, so an outage cannot mean one thing to
    // the pipeline and another to the sentinel. couldReachVerified is `Boolean(current)` here:
    // the sentinel never judges, so "is there a real, gradeable spec to protect" is the whole test.
    const refusal = refuseOnUnprovenFreeze({
      available: false, gating, labels, couldReachVerified: Boolean(current), storeReason: prior.reason,
    });
    return {
      state: 'unproven',
      conclusion: refusal.refuse ? 'failure' : 'neutral',
      title: refusal.refuse ? 'Spec pin: ❌ cannot be checked' : 'Spec pin: ❓ not enforced',
      summary: `## Felix — spec pin ${refusal.refuse ? '❌ **CANNOT BE CHECKED**' : '❓ **NOT ENFORCED**'}\n\n${refusal.reason}${foot}`,
    };
  }

  if (!current) {
    // No real, gradeable criteria to freeze. `success` and not `neutral`: there is nothing wrong
    // here, and the PR's actual problem (no_spec / spec_too_large) is the verdict check's job to
    // report. A second red saying the same thing twice teaches people to ignore this one.
    return {
      state: 'unpinnable', conclusion: 'success', title: 'Spec pin: — no criteria to freeze',
      summary: '## Felix — spec pin ⏭️ **NOTHING TO FREEZE**\n\nThis PR has no acceptance criteria '
        + 'that Felix can grade, so there is no criteria set to pin. The "Felix verdict" check '
        + 'reports what that means for the PR.' + foot,
    };
  }

  const drift = decideSpecDrift({ current, baseline: prior.baselineFingerprint });
  if (drift.changed) {
    return {
      state: 'changed', conclusion: 'failure', title: 'Spec pin: ⚠️ criteria CHANGED after grading',
      summary: '## Felix — spec pin ⚠️ **CHANGED**\n\n'
        + `Felix first graded this PR against criteria \`${short(drift.baseline)}\`. The criteria now `
        + `on this PR hash to \`${short(drift.current)}\`.\n\n`
        + 'Felix pins the criteria set the first time it grades one, because the criteria live in '
        + 'the PR description — an artifact the author keeps write access to — and editing away a '
        + 'failing criterion would otherwise be a cheaper route to a green check than fixing the '
        + 'code. Any earlier VERIFIED on this PR certified the OLD set, not the one displayed now.'
        + '\n\n**To proceed:** restore the previous criteria (the hash then matches again and this '
        + 'check goes green on its own, no push and no human needed), or have a maintainer '
        + `apply the "${gating.overrideLabel}" label.` + foot,
    };
  }

  return drift.baseline
    ? {
      state: 'held', conclusion: 'success', title: `Spec pin: 🔒 frozen ${short(current)}`,
      summary: `## Felix — spec pin 🔒 **FROZEN**\n\nThe acceptance criteria are unchanged since `
        + `Felix first graded this PR (\`${short(current)}\`).` + foot,
    }
    : {
      state: 'first', conclusion: 'success', title: `Spec pin: 📌 not yet graded (${short(current)})`,
      summary: '## Felix — spec pin 📌 **NOT YET PINNED**\n\nFelix has not graded this PR against '
        + `these criteria yet, so nothing is frozen. The set currently hashes to \`${short(current)}\`; `
        + 'it becomes the pin on the first run that grades it.' + foot,
    };
}

module.exports = { runSpecSentinel, decide, CHECK_NAME };
