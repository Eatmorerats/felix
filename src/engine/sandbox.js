/**
 * sandbox.js — check out the PR head into a disposable git worktree.
 *
 * Felix exercises the *actual PR code*, so it needs that commit on disk. We use
 * `git worktree` against the target repo clone: fast, shares the object store,
 * and tears down cleanly. The worktree dir lives under .felix-worktrees/ (which
 * .gitignore already excludes) and gets a clean, secret-free environment.
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./util/exec');
const { buildCleanEnv } = require('./util/env');
const { logger } = require('./util/logger');

/**
 * @param {object} opts
 * @param {string} opts.repoPath   git clone of the *base* repo
 * @param {string} opts.headSha    commit SHA of the PR head
 * @param {number} opts.prNumber   PR number (used to fetch refs/pull/N/head)
 * @param {string} [opts.rootDir]  where to place worktrees (default: repoPath/.felix-worktrees)
 * @param {object} [opts.deps]     test seam: { run } — so the env handed to `git worktree add`
 *                                 is assertable at the CALL SITE, not just in buildCleanEnv
 */
async function createSandbox({ repoPath, headSha, prNumber, rootDir, deps = {} }) {
  const runFn = deps.run || run;
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`${repoPath} is not a git repository (no .git).`);
  }
  const base = rootDir || path.join(repoPath, '.felix-worktrees');
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, `pr-${prNumber}-${headSha.slice(0, 8)}`);

  // Minimal, secret-free environment. Used for BOTH halves of this function: the untrusted
  // scripts the caller will run, and the local git commands below.
  const cleanEnv = buildCleanEnv();

  // Make sure the head commit is present locally. In CI the PR ref is usually
  // already fetched; otherwise pull it explicitly. Best-effort — a missing
  // remote ref just means we rely on the SHA already being in the object store.
  //
  // These two keep the PARENT environment on purpose. They are the only git calls here that
  // touch the network, and authentication rides in the environment on some setups (GIT_ASKPASS,
  // a credential helper's own vars). Stripping it would turn a working private-repo fetch into
  // a silent "|| true" no-op, and Felix would then judge whatever stale SHA it already had.
  // Fetch runs no checkout hook, so there is nothing here for a plant to catch. `env` is
  // written out rather than left to util/exec's default so the exception is visible as a
  // choice — an unmarked missing `env` is exactly the bug this change is fixing.
  await runFn(`git fetch --quiet origin "+refs/pull/${prNumber}/head:refs/felix/pr-${prNumber}" || true`, {
    cwd: repoPath, env: process.env, timeoutMs: 120000,
  });
  await runFn(`git fetch --quiet origin ${headSha} || true`, { cwd: repoPath, env: process.env, timeoutMs: 120000 });

  // Remove a stale worktree at the same path, then add fresh. BOTH get the clean env: `add`
  // runs the repo's post-checkout hook (see util/env.js), and neither needs credentials.
  await runFn(`git worktree remove --force "${dir}" || true`, { cwd: repoPath, env: cleanEnv, timeoutMs: 60000 });
  const add = await runFn(`git worktree add --detach --force "${dir}" ${headSha}`, {
    cwd: repoPath, env: cleanEnv, timeoutMs: 120000,
  });
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.combined.slice(-500)}`);
  }
  logger.debug(`sandbox at ${dir}`);

  return {
    dir,
    cleanEnv,
    async teardown() {
      try {
        await runFn(`git worktree remove --force "${dir}"`, { cwd: repoPath, env: cleanEnv, timeoutMs: 60000 });
      } catch (e) {
        logger.warn(`sandbox teardown: ${e.message}`);
      }
    },
  };
}

module.exports = { createSandbox };
