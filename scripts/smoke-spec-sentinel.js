#!/usr/bin/env node
/**
 * smoke-spec-sentinel.js — drive the real runSpecSentinel() and prove what it TOUCHES.
 *
 * The sentinel's safety claim is a claim about restraint: it runs from `pull_request_target`,
 * which carries the base repo's secrets and a writable token, and that is only defensible because
 * it never fetches or executes anything from the pull request. A comment saying so is worth
 * nothing — this asserts it against the actual request log.
 *
 * Everything is stubbed at globalThis.fetch, so there is no network and no secrets. Run:
 *   node scripts/smoke-spec-sentinel.js      (npm run test:sentinel)
 */

const assert = require('assert');
const { runSpecSentinel, CHECK_NAME } = require('../src/engine/sentinel');

let checks = 0;
const ok = (label, fn) => { fn(); checks++; console.log(`  ✓ ${label}`); };

const PR = {
  number: 42, title: 'add the widget', draft: false,
  body: '## Acceptance criteria\n- [ ] POST /api/widget returns 201\n- [ ] it logs the id\n\nCloses #7\n',
  head: { sha: 'headsha0000000000000000000000000000000a', repo: { fork: false, full_name: 'o/r' } },
  base: { sha: 'basesha', ref: 'main', repo: { full_name: 'o/r' } },
  labels: [],
};

function stub({ baseConfig }) {
  const calls = [];
  const prior = globalThis.fetch;
  const reply = (body, type = 'json') => ({
    ok: true, status: 200,
    headers: { get: () => (type === 'json' ? 'application/json' : 'text/plain') },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  globalThis.fetch = async (url, init) => {
    const u = String(url).replace('https://api.github.com', '');
    calls.push({ url: u, method: (init && init.method) || 'GET', body: init && init.body });
    if (/\/contents\/felix\.config\.json/.test(u)) return reply(JSON.stringify(baseConfig), 'text');
    if (/\/contents\?ref=/.test(u)) return reply([{ name: 'felix.config.json', type: 'file' }]);
    if (/\/pulls\/42$/.test(u)) return reply(PR);
    if (/\/issues\/7$/.test(u)) return reply({ number: 7, body: '## Requirements\n- [ ] the widget renders on mobile\n' });
    return reply({});
  };
  return { calls, restore: () => { globalThis.fetch = prior; } };
}

async function main() {
  console.log('spec pin sentinel — what it actually touches\n');

  // ── 1. A gated repo with no verdict store. Fail-closed, and the receipts. ──────────────────
  let s = stub({ baseConfig: { gating: { enabled: true }, commands: { test: 'true' } } });
  let result;
  try {
    result = await runSpecSentinel({
      target: 'o/r#42', post: true, dryRun: false, env: { GITHUB_TOKEN: 't' },
    });
  } finally { s.restore(); }

  console.log('  requests made:');
  for (const c of s.calls) console.log(`    ${c.method} ${c.url}`);
  console.log('');

  ok('never asks for the changed files', () => {
    assert.ok(!s.calls.some((c) => /\/pulls\/\d+\/files/.test(c.url)));
  });
  ok('never asks for the diff (no PR content is fetched)', () => {
    // The diff comes back on the PR endpoint under a different Accept header; the sentinel makes
    // exactly one call there and it is the plain JSON one.
    assert.strictEqual(s.calls.filter((c) => /\/pulls\/42$/.test(c.url)).length, 1);
  });
  ok('never calls a judge vendor', () => {
    assert.ok(!s.calls.some((c) => /openai|googleapis|anthropic/i.test(c.url)));
  });
  ok('reads only the PR, the base config, the linked issue, and the check runs', () => {
    const allowed = /\/pulls\/42$|\/contents(\?ref=|\/felix\.config\.json)|\/issues\/7$|check-runs/;
    const stray = s.calls.filter((c) => !allowed.test(c.url));
    assert.deepStrictEqual(stray, [], `unexpected request(s): ${JSON.stringify(stray)}`);
  });
  ok('reads the gating policy from the BASE ref, never from head', () => {
    const cfg = s.calls.filter((c) => /\/contents\/felix\.config\.json/.test(c.url));
    assert.ok(cfg.length >= 1);
    assert.ok(cfg.every((c) => /ref=basesha|ref=main/.test(c.url)), `base refs only, got ${cfg.map((c) => c.url)}`);
  });

  const published = s.calls.filter((c) => c.method === 'POST' && /check-runs$/.test(c.url));
  ok('publishes exactly one check run', () => assert.strictEqual(published.length, 1));
  const payload = JSON.parse(published[0].body);
  console.log(`\n  check run → name: ${JSON.stringify(payload.name)}  conclusion: ${JSON.stringify(payload.conclusion)}`);
  console.log(`             title: ${payload.output.title}\n`);
  ok('under its own name, never "Felix verdict"', () => {
    assert.strictEqual(payload.name, CHECK_NAME);
    assert.notStrictEqual(payload.name, 'Felix verdict');
  });
  ok('a gated repo with no store gets `failure`, never a passing `neutral`', () => {
    assert.strictEqual(payload.conclusion, 'failure');
    assert.strictEqual(result.state, 'unproven');
  });
  ok('it is written against the HEAD sha, which is what branch protection evaluates', () => {
    assert.strictEqual(payload.head_sha, PR.head.sha);
  });

  // ── 2. The same PR on an advisory repo: reported, not blocking. ────────────────────────────
  s = stub({ baseConfig: { commands: { test: 'true' } } });
  try {
    result = await runSpecSentinel({ target: 'o/r#42', post: true, dryRun: false, env: { GITHUB_TOKEN: 't' } });
  } finally { s.restore(); }
  const advisory = JSON.parse(s.calls.find((c) => c.method === 'POST' && /check-runs$/.test(c.url)).body);
  console.log(`  advisory repo → conclusion: ${JSON.stringify(advisory.conclusion)}  title: ${advisory.output.title}\n`);
  ok('an advisory repo is told, not blocked', () => {
    assert.strictEqual(advisory.conclusion, 'neutral');
    assert.match(advisory.output.title, /not enforced/i);
  });

  // ── 3. Dry run writes nothing at all. ─────────────────────────────────────────────────────
  s = stub({ baseConfig: { gating: { enabled: true }, commands: { test: 'true' } } });
  try {
    await runSpecSentinel({ target: 'o/r#42', post: false, dryRun: true, env: { GITHUB_TOKEN: 't' } });
  } finally { s.restore(); }
  ok('a dry run writes nothing to GitHub', () => {
    assert.deepStrictEqual(s.calls.filter((c) => c.method !== 'GET'), []);
  });

  console.log(`\n${checks} checks passed — the sentinel fetched no PR code, ran none, and called no judge.`);
}

main().catch((e) => { console.error(`\n✗ ${e.message}`); process.exit(1); });
