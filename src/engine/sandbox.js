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
const { logger } = require('./util/logger');

/**
 * @param {object} opts
 * @param {string} opts.repoPath   git clone of the *base* repo
 * @param {string} opts.headSha    commit SHA of the PR head
 * @param {number} opts.prNumber   PR number (used to fetch refs/pull/N/head)
 * @param {string} [opts.rootDir]  where to place worktrees (default: repoPath/.felix-worktrees)
 */
async function createSandbox({ repoPath, headSha, prNumber, rootDir }) {
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`${repoPath} is not a git repository (no .git).`);
  }
  const base = rootDir || path.join(repoPath, '.felix-worktrees');
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, `pr-${prNumber}-${headSha.slice(0, 8)}`);

  // Make sure the head commit is present locally. In CI the PR ref is usually
  // already fetched; otherwise pull it explicitly. Best-effort — a missing
  // remote ref just means we rely on the SHA already being in the object store.
  await run(`git fetch --quiet origin "+refs/pull/${prNumber}/head:refs/felix/pr-${prNumber}" || true`, {
    cwd: repoPath, timeoutMs: 120000,
  });
  await run(`git fetch --quiet origin ${headSha} || true`, { cwd: repoPath, timeoutMs: 120000 });

  // Remove a stale worktree at the same path, then add fresh.
  await run(`git worktree remove --force "${dir}" || true`, { cwd: repoPath, timeoutMs: 60000 });
  const add = await run(`git worktree add --detach --force "${dir}" ${headSha}`, {
    cwd: repoPath, timeoutMs: 120000,
  });
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.combined.slice(-500)}`);
  }
  logger.debug(`sandbox at ${dir}`);

  // Minimal, secret-free environment for running untrusted scripts.
  const cleanEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    CI: 'true',
    FORCE_COLOR: '0',
    NODE_ENV: 'test',
  };

  return {
    dir,
    cleanEnv,
    async teardown() {
      try {
        await run(`git worktree remove --force "${dir}"`, { cwd: repoPath, timeoutMs: 60000 });
      } catch (e) {
        logger.warn(`sandbox teardown: ${e.message}`);
      }
    },
  };
}

module.exports = { createSandbox };
