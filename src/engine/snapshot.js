/**
 * snapshot.js — turn a DIRTY working tree into a real commit, without touching it.
 *
 * WHY THIS EXISTS. Felix's sandbox is `git worktree add <dir> <SHA>`: it needs a commit. That is
 * fine for CI, where the thing being verified is a pushed head SHA by definition. It is exactly
 * wrong for local pre-flight, where the whole point is that an agent just edited files and wants
 * to know whether they pass BEFORE anything is committed or pushed. Forcing a commit per loop
 * iteration would either pollute the user's history or require an amend dance around their index.
 *
 * So this builds a commit object out of the current working tree using nothing but plumbing:
 *
 *     GIT_INDEX_FILE=<temp>  git read-tree HEAD     seed a THROWAWAY index from HEAD
 *     GIT_INDEX_FILE=<temp>  git add -A             stage the working tree into it
 *     GIT_INDEX_FILE=<temp>  git write-tree         → a tree object
 *                            git commit-tree <tree> -p HEAD  → a dangling commit
 *
 * Every write lands in the temp index or in loose objects. The user's index, working tree, stash
 * and refs are never touched — `commit-tree` deliberately writes no ref, which is what leaves the
 * commit dangling and disposable. `probe-preflight-snapshot.js` asserts that byte-for-byte.
 *
 * ── WHAT IS AND IS NOT IN THE TREE, AND WHY THAT IS THE RIGHT SET ────────────────────────────
 *
 * `git add -A` honours .gitignore, and that is a FEATURE rather than a limitation to work around.
 * The tree pre-flight should grade is the tree CI will eventually grade, and a gitignored file was
 * never going to be in the pushed PR. Including them (`add -f`) would be wrong twice: it invents
 * local greens that come from an uncommitted `.env` or a stray fixture, and it blobs those secrets
 * into `.git/objects` inside a commit nothing will ever prune on purpose.
 *
 * The real divergence is UNTRACKED-BUT-NOT-IGNORED files: `add -A` folds them in, but CI will not
 * see them until the agent actually commits them. That direction produces a local green and a CI
 * red — and a CI red costs one of the ten judge attempts. So the list is returned and the caller
 * says it out loud. It is a warning, not a refusal: iterating on brand-new files is the single
 * most common thing a pre-flight loop does.
 *
 * ── DETERMINISM ──────────────────────────────────────────────────────────────────────────────
 *
 * Author and committer identity and dates are pinned to fixed values rather than inherited. Two
 * reasons, both load-bearing. Inherited identity means `commit-tree` fails outright on a machine
 * with no `user.email` configured — a fine state for a repo you only ever read. And pinning the
 * dates makes the commit SHA a pure function of (tree, HEAD): the same working tree snapshotted
 * twice yields the SAME sha, which is what lets the caller recognize "nothing changed since the
 * last graded run" without keeping any state of its own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run } = require('./util/exec');
const { buildCleanEnv } = require('./util/env');
const { logger } = require('./util/logger');

/** Fixed identity + date, so an identical (tree, parent) always hashes to an identical commit. */
const STAMP = {
  GIT_AUTHOR_NAME: 'Felix preflight',
  GIT_AUTHOR_EMAIL: 'preflight@felix.invalid',
  GIT_COMMITTER_NAME: 'Felix preflight',
  GIT_COMMITTER_EMAIL: 'preflight@felix.invalid',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_DATE: '@0 +0000',
};

/** Run a git command in the repo, under the clean env, and demand success. */
async function git(cmd, { cwd, env, timeoutMs = 120000, deps = {} }) {
  const runFn = deps.run || run;
  const r = await runFn(`git ${cmd}`, { cwd, env, timeoutMs });
  if (r.code !== 0) {
    throw new Error(`git ${cmd.split(' ')[0]} failed: ${(r.combined || '').slice(-400)}`);
  }
  return r.stdout.trim();
}

/**
 * Snapshot `repoPath`'s working tree into a dangling commit.
 *
 * @param {object} opts
 * @param {string} opts.repoPath  a git repository (any subdirectory of one; the top level is
 *                                resolved, because `git add -A` is scoped to the cwd and a
 *                                snapshot taken from a subdirectory would silently omit siblings)
 * @param {object} [opts.deps]    test seam: { run }
 * @returns {Promise<{sha:string, tree:string, headSha:string, headTree:string, dirty:boolean,
 *                    untracked:string[], repoRoot:string}>}
 */
async function snapshotWorkingTree({ repoPath, deps = {} }) {
  const env = { ...buildCleanEnv(), ...STAMP };
  const start = path.resolve(repoPath || process.cwd());

  let repoRoot;
  try {
    repoRoot = await git('rev-parse --show-toplevel', { cwd: start, env, deps });
  } catch (_) {
    throw new Error(`${start} is not inside a git repository — pre-flight needs one to snapshot.`);
  }
  repoRoot = path.resolve(repoRoot);

  // An unborn HEAD (fresh `git init`, no commits) has nothing to read-tree and no parent to hang
  // the commit from. Say so in words rather than letting `read-tree` fail with plumbing noise.
  let headSha;
  try {
    headSha = await git('rev-parse --verify HEAD', { cwd: repoRoot, env, deps });
  } catch (_) {
    throw new Error(
      'This repository has no commits yet, so there is no base to snapshot against. '
      + 'Make one commit and run pre-flight again.'
    );
  }
  // `show -s --format=%T` and not `rev-parse <sha>^{tree}`: util/exec spawns with shell:true, and
  // on Windows cmd.exe `^` is the escape character, so the peel syntax arrives as `<sha>{tree}`
  // and rev-parse fails with "Needed a single revision". Found by running it, not by reading it.
  const headTree = await git(`show -s --format=%T ${headSha}`, { cwd: repoRoot, env, deps });

  // Recorded BEFORE `add -A` folds them in, because afterwards they are indistinguishable from
  // tracked files. This is the list the caller warns about.
  const untrackedRaw = await git('ls-files --others --exclude-standard', { cwd: repoRoot, env, deps });
  const untracked = untrackedRaw ? untrackedRaw.split(/\r?\n/).filter(Boolean) : [];

  const indexFile = path.join(os.tmpdir(), `felix-preflight-${crypto.randomBytes(8).toString('hex')}.index`);
  const idxEnv = { ...env, GIT_INDEX_FILE: indexFile };

  let tree;
  try {
    // Seed the throwaway index from HEAD before staging. The reason is narrower than it looks,
    // and it is NOT about deletions — a deleted file is absent from disk either way, so an empty
    // index and a seeded one produce the same tree for that case. A mutation run proved it.
    //
    // What it is actually for: TRACKED FILES THAT ARE ALSO GITIGNORED. Tracking wins over
    // .gitignore, but only for files git already knows about — and with an empty index it knows
    // about none. So without this line, a file that was committed and later added to .gitignore
    // (an ordinary thing to do to a config or a build artifact) is skipped by `add -A` and
    // VANISHES from the snapshot, and pre-flight silently grades a tree missing a tracked file.
    await git(`read-tree ${headSha}`, { cwd: repoRoot, env: idxEnv, deps });
    await git('add -A', { cwd: repoRoot, env: idxEnv, timeoutMs: 300000, deps });
    // Felix's own scratch directory can never be part of the tree being graded.
    //
    // `createSandbox` checks PR code out into `<repo>/.felix-worktrees/`, and that path is only
    // gitignored because Felix's own repo happens to ignore it — an adopter's does not. Without
    // this, one leftover worktree makes the next snapshot fold an entire second copy of the
    // repository into itself: the tree is enormous, it is never byte-identical to the previous
    // one, and so the "unchanged tree, do not re-judge" refusal can never fire. Found by running
    // pre-flight twice in a fixture repo and watching the file count go from 1 to 2.
    //
    // Done as a second command against the temp index rather than an `:(exclude)` pathspec: the
    // pathspec magic needs parentheses through a shell:true spawn, and cmd.exe is exactly where
    // that goes wrong quietly.
    await git('rm -r --cached --ignore-unmatch -q .felix-worktrees', { cwd: repoRoot, env: idxEnv, deps });
    tree = await git('write-tree', { cwd: repoRoot, env: idxEnv, deps });
  } finally {
    // The temp index is scratch; a leftover would be harmless but this keeps tmpdir honest.
    try { fs.unlinkSync(indexFile); } catch (_) { /* never existed, or already gone */ }
  }

  const sha = await git(`commit-tree ${tree} -p ${headSha} -m "felix preflight snapshot"`, {
    cwd: repoRoot, env, deps,
  });

  const dirty = tree !== headTree;
  logger.debug(`snapshot ${sha.slice(0, 8)} (tree ${tree.slice(0, 8)}, ${dirty ? 'dirty' : 'clean'})`);
  return { sha, tree, headSha, headTree, dirty, untracked, repoRoot };
}

module.exports = { snapshotWorkingTree, STAMP };
