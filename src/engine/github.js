/**
 * github.js — minimal GitHub REST client for Felix.
 *
 * Plain fetch + Bearer PAT,
 * v3 Accept header, User-Agent. Read PR/issue data; upsert the verdict comment
 * (idempotent via a hidden marker so re-runs edit one comment, never spam).
 */

const { logger } = require('./util/logger');
const { version } = require('../../package.json'); // single source of truth for the Felix version

const API_BASE = 'https://api.github.com';
const MARKER = '<!-- felix-verdict -->';

/** Parse "owner/repo#123" (or a full PR URL) into {owner, repo, number}. */
function parseTarget(target) {
  const m = String(target).match(/(?:github\.com\/)?([^/\s]+)\/([^/#\s]+)(?:\/pull\/|#)(\d+)/);
  if (!m) throw new Error(`Could not parse PR target "${target}". Expected owner/repo#123.`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function createGitHub(token, { apiBase = API_BASE } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is required.');

  async function gh(endpoint, { method = 'GET', accept = 'application/vnd.github+json', body } = {}) {
    const res = await fetch(`${apiBase}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `Felix/${version}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 404) return null;
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        const reset = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000);
        throw new Error(`GitHub rate limited; resets at ${reset.toISOString()}`);
      }
    }
    const isJSON = (res.headers.get('content-type') || '').includes('json');
    const payload = isJSON ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = isJSON && payload && payload.message ? payload.message : String(payload).slice(0, 200);
      throw new Error(`GitHub ${method} ${endpoint} → ${res.status}: ${msg}`);
    }
    return payload;
  }

  return {
    parseTarget,
    MARKER,

    getPR(owner, repo, number) {
      return gh(`/repos/${owner}/${repo}/pulls/${number}`);
    },

    async getFiles(owner, repo, number) {
      const files = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await gh(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
        if (!batch || !batch.length) break;
        files.push(...batch);
        if (batch.length < 100) break;
      }
      return files;
    },

    getDiff(owner, repo, number) {
      return gh(`/repos/${owner}/${repo}/pulls/${number}`, { accept: 'application/vnd.github.v3.diff' });
    },

    getIssue(owner, repo, number) {
      return gh(`/repos/${owner}/${repo}/issues/${number}`);
    },

    /**
     * Entries at the repo ROOT for a ref. Null when the ref itself does not resolve.
     *
     * This exists to disambiguate a 404. The contents API answers 404 both for "that file is not
     * there" and for "that ref is not there", and conflating them is dangerous in one direction:
     * an unresolvable ref would read as "no config at base" → built-in defaults → a repo that
     * configured gating silently loses it. Listing the root separates the two — a 404 here means
     * the ref is bad, while a 200 without the file means the file is genuinely absent.
     */
    listRootContents(owner, repo, ref) {
      return gh(`/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(ref)}`);
    },

    /** Raw bytes of one file at a ref (no base64 envelope). Null when the path is absent. */
    getRawFile(owner, repo, filePath, ref) {
      const encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
      return gh(`/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
        accept: 'application/vnd.github.raw',
      });
    },

    /** Recent commits on the default branch (or a given ref) for outcome scans. */
    listCommits(owner, repo, { perPage = 100, sha } = {}) {
      return gh(`/repos/${owner}/${repo}/commits?per_page=${Math.min(perPage, 100)}${sha ? `&sha=${encodeURIComponent(sha)}` : ''}`);
    },

    /** Create or update the single Felix verdict comment on the PR. */
    async upsertComment(owner, repo, number, body) {
      const tagged = `${MARKER}\n${body}`;
      // PR comments live on the issues endpoint.
      const comments = (await gh(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`)) || [];
      const existing = comments.find((c) => c.body && c.body.includes(MARKER));
      if (existing) {
        logger.debug(`updating comment ${existing.id}`);
        await gh(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body: tagged } });
        return { id: existing.id, updated: true, url: existing.html_url };
      }
      logger.debug('creating new verdict comment');
      const created = await gh(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', body: { body: tagged } });
      return { id: created.id, updated: false, url: created.html_url };
    },

    /**
     * Publish the verdict as a first-class check run on the head commit.
     * Idempotent: re-runs for the same head SHA update the existing run (by
     * name) instead of stacking duplicates — mirroring upsertComment. Needs
     * checks:write (which also grants the read used to find the prior run).
     */
    async createCheckRun(owner, repo, { headSha, name = 'Felix verdict', conclusion, title, summary }) {
      const payload = {
        name,
        head_sha: headSha,
        status: 'completed',
        conclusion,
        output: { title: title || '', summary: (summary || '').slice(0, 65000) },
      };
      let existing = null;
      try {
        const list = await gh(`/repos/${owner}/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`);
        existing = list && list.check_runs && list.check_runs.find((r) => r.name === name);
      } catch (e) {
        logger.debug(`check-run lookup failed, will create: ${e.message}`);
      }
      if (existing) {
        logger.debug(`updating check run ${existing.id}`);
        return gh(`/repos/${owner}/${repo}/check-runs/${existing.id}`, { method: 'PATCH', body: payload });
      }
      return gh(`/repos/${owner}/${repo}/check-runs`, { method: 'POST', body: payload });
    },
  };
}

module.exports = { createGitHub, parseTarget, MARKER };
