/**
 * golden-judge.js — byte-for-byte characterization net for src/engine/judge.js.
 *
 * WHY THIS EXISTS
 * ---------------
 * judge.js (the Tier 3 verdict core) is about to be split into smaller modules. The split
 * MUST preserve behavior exactly. run.js proves individual invariants, but it does not pin
 * the FULL observable output of the module the way a golden/approval test does. This harness
 * captures three observable channels for a battery of scenarios and freezes them:
 *
 *   (i)  every fetch call — url, headers, and the FULL prompt string sent to the vendor;
 *   (ii) every sleep the module asked for (recorded via an injected spy, never real waiting);
 *   (iii) the returned verdict object, or for a throw the error's message/status/retryAfterMs.
 *
 * Plus the exact buildPrompt() output string for a matrix of prompt shapes.
 *
 * USAGE
 *   node test/golden-judge.js            → assert current judge.js still produces the pinned
 *                                          fixture BYTE-for-BYTE; non-zero exit on any drift.
 *   node test/golden-judge.js --update   → regenerate test/fixtures/judge-golden.json from
 *                                          whatever judge.js currently is (the baseline capture).
 *
 * DETERMINISM
 *   - fetch is always injected (canned replies keyed by URL host + per-host call index).
 *   - sleep is always injected — a spy that RECORDS the ms and resolves immediately, so a
 *     retryable status never burns real wall-clock.
 *   - Promise.allSettled preserves input order, so the merged jury object is order-stable and
 *     safe to pin. But fetch-call INTERLEAVING across two parallel seats is microtask-order
 *     dependent, so recorded fetch calls are GROUPED BY HOST (per-vendor sequences are
 *     deterministic) rather than pinned in global interleaved order. Likewise jury sleeps are
 *     pinned as a sorted multiset, single-seat sleeps as an exact ordered sequence.
 *   - No Date/random/timestamp is captured. The fixture is byte-stable across --update runs.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const judgeMod = require('../src/engine/judge');
const { createJudge, buildPrompt } = judgeMod;
const { logger } = require('../src/engine/util/logger');

const FIXTURE = path.join(__dirname, 'fixtures', 'judge-golden.json');

// ── canned vendor replies ────────────────────────────────────────────────────────────────
const oai = (json) => ({ body: { choices: [{ message: { content: JSON.stringify(json) } }] } });
const gem = (json) => ({
  body: { candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP' }] },
});
const httpFail = (status, body, headers) => ({ ok: false, status, body, headers });

function hostOf(url) {
  if (url.includes('openai.com')) return 'openai';
  if (url.includes('generativelanguage')) return 'gemini';
  return 'other';
}
// The prompt lives in a vendor-specific place in the request body; pull it out generically so
// both families record the identical "prompt" channel.
function extractPrompt(body) {
  if (!body) return null;
  if (body.messages) return body.messages[0].content;          // openai chat/completions
  if (body.contents) return body.contents[0].parts[0].text;    // gemini generateContent
  return null;
}

// A recording fetch. `scripts` maps host → (array of specs | fn(hostCallIndex) → spec). Each
// spec is { ok?, status?, body, headers? }. Records every call for later grouping-by-host.
function makeFetch(scripts) {
  const perHost = {};
  const impl = async (url, opts) => {
    const host = hostOf(url);
    const i = perHost[host] || 0;
    perHost[host] = i + 1;
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
    impl.record.push({ host, url, headers: (opts && opts.headers) || null, prompt: extractPrompt(body) });
    const script = scripts[host];
    let spec;
    if (typeof script === 'function') spec = script(i);
    else if (Array.isArray(script)) spec = script[Math.min(i, script.length - 1)];
    else spec = script || {};
    return {
      ok: spec.ok !== false,
      status: spec.status || 200,
      headers: spec.headers,
      async json() { return spec.body; },
      async text() { return typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body); },
    };
  };
  impl.record = [];
  return impl;
}

// ── deterministic diff builders (real `git diff` shape so splitDiffByFile has headers) ──────
function fileDiff(name, len) {
  const header = `diff --git a/${name} b/${name}\n@@ -1 +1 @@\n`;
  const pad = Math.max(0, len - header.length - 1);
  return `${header}+${'x'.repeat(pad)}`;
}
function multiDiff(specs) {
  return specs.map(([n, l]) => fileDiff(n, l)).join('\n');
}

// ── the harness core: run one createJudge scenario capturing all three channels ─────────────
async function runScenario({ env, opts = {}, input, scripts, sleepMode = 'seq' }) {
  const sleeps = [];
  const logs = [];
  const origWarn = logger.warn;
  const origInfo = logger.info;
  // Capture the module's log lines (seat-skip 521, retry-warn 542, part-progress 612). These
  // are deterministic strings; pinning them strengthens the net and keeps harness stdout quiet.
  logger.warn = (msg) => { logs.push(`warn: ${msg}`); };
  logger.info = (msg) => { logs.push(`info: ${msg}`); };

  const ff = makeFetch(scripts);
  const doSleep = (ms) => { sleeps.push(ms); return Promise.resolve(); };
  const rec = {};
  try {
    const judge = createJudge(env, { ...opts, fetchImpl: ff, sleepImpl: doSleep });
    if (judge === null) {
      rec.result = null; // judge skipped (no seated key)
    } else {
      rec.result = await judge(input);
    }
  } catch (e) {
    rec.error = { message: e.message, status: e.status, retryAfterMs: e.retryAfterMs };
  } finally {
    logger.warn = origWarn;
    logger.info = origInfo;
  }

  // Group fetch calls by host so cross-seat interleaving cannot destabilize the pin.
  const byHost = {};
  for (const c of ff.record) {
    (byHost[c.host] = byHost[c.host] || []).push({ url: c.url, headers: c.headers, prompt: c.prompt });
  }
  const fetchOut = {};
  for (const h of ['openai', 'gemini', 'other']) if (byHost[h]) fetchOut[h] = byHost[h];

  const out = { fetch: fetchOut };
  out.sleeps = sleepMode === 'set' ? [...sleeps].sort((a, b) => a - b) : sleeps;
  if (logs.length) out.logs = logs;
  if ('result' in rec) out.result = rec.result;
  if ('error' in rec) out.error = rec.error;
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// BUILD THE GOLDEN OBJECT
// ════════════════════════════════════════════════════════════════════════════════════════
async function build() {
  const g = {};

  // ── A. buildPrompt string matrix (exact full strings, byte-compared) ──────────────────
  const A1args = { prTitle: 'PR one', criteria: [{ text: 'login works' }], diff: 'some diff', tier1: [] };
  g.A1_plain_singlepass_emptyTier1 = buildPrompt(A1args);
  g.A2_adversarial_singlepass = buildPrompt({ ...A1args, adversarial: true });
  g.A3_plain_chunked_failoutput = buildPrompt({
    prTitle: 'PR three',
    criteria: [{ text: 'first' }, { text: 'second' }],
    diff: 'part 2 diff body',
    tier1: [
      { name: 'build', status: 'pass', detail: 'exit 0' },
      { name: 'lint', status: 'fail', detail: '2 problems', output: 'a.js:1 no-unused\nb.js:9 semi' },
    ],
    chunk: { index: 2, total: 4 },
  });
  g.A4_adversarial_chunked = buildPrompt({
    prTitle: 'PR four',
    criteria: [{ text: 'only criterion' }],
    diff: 'adversarial chunk diff',
    tier1: [{ name: 'test', status: 'pass', detail: 'ok' }],
    adversarial: true,
    chunk: { index: 3, total: 4 },
  });
  g.A5_emptyCriteria_failNoOutput = buildPrompt({
    prTitle: 'PR five',
    criteria: [],
    diff: 'd5',
    tier1: [{ name: 'x', status: 'fail', detail: 'boom' }], // fail but NO output → no FAILING block
  });
  g.A6_chunk_1of1_identical_to_A1 = buildPrompt({ ...A1args, chunk: { index: 1, total: 1 } });
  g.A7_diff_null_coercion = buildPrompt({ prTitle: 'p', criteria: [{ text: 'c' }], diff: null, tier1: [] });

  // Structural invariant: chunk.total===1 must be byte-identical to the un-chunked prompt.
  assert.strictEqual(
    g.A6_chunk_1of1_identical_to_A1, g.A1_plain_singlepass_emptyTier1,
    'A6: chunk {index:1,total:1} must be byte-identical to the single-pass prompt (judge.js chunk.total>1 guard)',
  );

  // ── B. createJudge end-to-end (G1–G13) ────────────────────────────────────────────────
  const BASE_INPUT = { prTitle: 'p', criteria: [{ text: 'c' }], diff: 'd', tier1: [] };

  // G1 — single openai happy path
  g.G1_openai_happy = await runScenario({
    env: { OPENAI_API_KEY: 'sk-test' },
    input: BASE_INPUT,
    scripts: { openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'ok' }] }) },
  });

  // G2 — single gemini happy path
  g.G2_gemini_happy = await runScenario({
    env: { FELIX_JUDGE_FAMILY: 'gemini', GEMINI_API_KEY: 'g-key' },
    input: BASE_INPUT,
    scripts: { gemini: gem({ assessment: 'g', criteria: [{ text: 'c', met: false, reason: 'nope' }] }) },
  });

  // G3 — chunked single-vendor: merge precedence (violated>met), part numbering, describeCoverage,
  //      AND the pacing sleep sequence (paceMs per chunk after the first).
  const G3_DIFF = multiDiff([
    ['src/f0.js', 1300], ['src/f1.js', 1300], ['src/f2.js', 1300], ['src/f3.js', 1300], ['src/f4.js', 1300],
  ]);
  const g3verdict = (i) => (i === 0 ? 'met' : i === 2 ? 'violated' : 'not_shown');
  g.G3_chunked_precedence_pacing = await runScenario({
    env: { OPENAI_API_KEY: 'sk', FELIX_JUDGE_MAX_PROMPT_TOKENS: '1335' },
    input: { prTitle: 'big', criteria: [{ text: 'c' }], diff: G3_DIFF, tier1: [] },
    scripts: {
      openai: (i) => oai({ assessment: `part ${i + 1}`, criteria: [{ text: 'c', verdict: g3verdict(i), reason: 'r' }] }),
    },
  });

  // G3b — S3 boundary variant. maxChunks:10 makes the re-plan header "PART 10 OF 10" two chars
  //      wider than the single-digit header the mutation would print. File sizes sit a packing
  //      boundary inside that window, so S3 shifts chunk boundaries. chunk.index/total appears
  //      TWICE in the chunked prompt (the PART header and the "UNIFIED DIFF (part i of n)" line),
  //      so "10" vs a single digit moves overhead by 4 chars → budgetChars 1345 (index:10) vs
  //      1349 (index:4, the count S3 would print here). File size 672 puts a 2-file pack at
  //      cumulative 1346 — fits at 1349 (S3), flushes at 1345 (correct) → 4 chunks vs 8.
  //
  //      THE BUDGET IS PART OF THE TUNING, NOT A ROUND NUMBER. It was 1000 until the F11 fence
  //      added ~1366 chars of prompt overhead, which drove budgetChars to 209 — small enough that
  //      every file truncated identically on both sides, S3 went GREEN, and a routine `--update`
  //      would have silently deleted this detector. 1335 is the ONLY budget that restores the
  //      8-vs-4 split at file size 672, and it also holds G3/G12 at 5 chunks and G4 at 6 chunks +
  //      7 omitted. Re-solve the pair, don't nudge it, if prompt overhead moves again. The
  //      mutation below PROVES it discriminates; arithmetic alone did not, twice now.
  const G3B_DIFF = multiDiff([
    ['src/a0.js', 672], ['src/a1.js', 672], ['src/a2.js', 672], ['src/a3.js', 672],
    ['src/a4.js', 672], ['src/a5.js', 672], ['src/a6.js', 672], ['src/a7.js', 672],
  ]);
  g.G3b_maxchunks_boundary = await runScenario({
    env: { OPENAI_API_KEY: 'sk', FELIX_JUDGE_MAX_PROMPT_TOKENS: '1335', FELIX_JUDGE_MAX_CHUNKS: '10' },
    input: { prTitle: 'boundary', criteria: [{ text: 'c' }], diff: G3B_DIFF, tier1: [] },
    scripts: { openai: (i) => oai({ assessment: `p${i + 1}`, criteria: [{ text: 'c', verdict: 'not_shown' }] }) },
  });

  // G4 — chunked with 6+ omitted files (ellipsis at :382) and one file larger than the whole
  //      budget (truncation marker flowing through coverage → assessment).
  const G4_DIFF = multiDiff([
    ['src/huge.js', 5000],
    ['src/g0.js', 1300], ['src/g1.js', 1300], ['src/g2.js', 1300], ['src/g3.js', 1300],
    ['src/g4.js', 1300], ['src/g5.js', 1300], ['src/g6.js', 1300], ['src/g7.js', 1300],
    ['src/g8.js', 1300], ['src/g9.js', 1300], ['src/g10.js', 1300], ['src/g11.js', 1300],
  ]);
  g.G4_chunked_omitted_and_truncated = await runScenario({
    env: { OPENAI_API_KEY: 'sk', FELIX_JUDGE_MAX_PROMPT_TOKENS: '1335' },
    input: { prTitle: 'huge', criteria: [{ text: 'c' }], diff: G4_DIFF, tier1: [] },
    scripts: { openai: () => oai({ assessment: 'seen', criteria: [{ text: 'c', verdict: 'not_shown' }] }) },
  });

  // G5 — jury unanimous
  g.G5_jury_unanimous = await runScenario({
    env: { FELIX_JUDGE_FAMILY: 'openai,gemini', OPENAI_API_KEY: 'sk', GEMINI_API_KEY: 'g' },
    input: BASE_INPUT,
    sleepMode: 'set',
    scripts: {
      openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'ok' }] }),
      gemini: gem({ assessment: 'b', criteria: [{ text: 'c', met: true, reason: 'ok too' }] }),
    },
  });

  // G6 — jury split (one dissent)
  g.G6_jury_split = await runScenario({
    env: { FELIX_JUDGE_FAMILY: 'openai,gemini', OPENAI_API_KEY: 'sk', GEMINI_API_KEY: 'g' },
    input: BASE_INPUT,
    sleepMode: 'set',
    scripts: {
      openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'looks fine' }] }),
      gemini: gem({ assessment: 'b', criteria: [{ text: 'c', met: false, reason: 'no test covers it' }] }),
    },
  });

  // G7 — jury degraded: gemini 503 on EVERY attempt → backoff 20000, 40000, then throw. openai
  //      survives. Pins degraded:true + failures text + the retry sleep multiset.
  g.G7_jury_degraded_503 = await runScenario({
    env: { FELIX_JUDGE_FAMILY: 'openai,gemini', OPENAI_API_KEY: 'sk', GEMINI_API_KEY: 'g' },
    input: BASE_INPUT,
    sleepMode: 'set',
    scripts: {
      openai: oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'ok' }] }),
      gemini: httpFail(503, 'high demand'),
    },
  });

  // G8 — THE UNTESTED CONTRACT: a 429 carrying Retry-After: 7 → sleep spy MUST record 7000
  //      (proves httpError's Retry-After parsing), then succeed on retry.
  const retryAfter7 = { get: (k) => (k === 'retry-after' ? '7' : undefined) };
  g.G8_retry_after_header = await runScenario({
    env: { OPENAI_API_KEY: 'sk' },
    input: BASE_INPUT,
    scripts: {
      openai: (i) => (i === 0
        ? httpFail(429, 'slow down', retryAfter7)
        : oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'ok' }] })),
    },
  });

  // G8b — companion: a 429 with NO usable Retry-After falls back to RETRY_BASE_MS (20000).
  g.G8b_retry_after_absent_fallback = await runScenario({
    env: { OPENAI_API_KEY: 'sk' },
    input: BASE_INPUT,
    scripts: {
      openai: (i) => (i === 0
        ? httpFail(429, 'slow down') // no headers → err.retryAfterMs undefined → 20000 fallback
        : oai({ assessment: 'a', criteria: [{ text: 'c', met: true, reason: 'ok' }] })),
    },
  });

  // G9 — too-large 429 → thrown IMMEDIATELY, exactly 1 fetch call, message pinned incl. 200-char slice.
  const TOO_LARGE_BODY =
    'Request too large for gpt-4.1 in organization org-xxxx on tokens per min (TPM): '
    + 'Limit 30000, Requested 61227. The input or output tokens must be reduced in order to run successfully.';
  g.G9_too_large_immediate = await runScenario({
    env: { OPENAI_API_KEY: 'sk' },
    input: BASE_INPUT,
    scripts: { openai: httpFail(429, TOO_LARGE_BODY) },
  });

  // G10 — empty bench, mixed failures: openai keyed but 400s, gemini keyless. Pins the thrown
  //      message ORDERING (keyless seats listed before erroring seats).
  g.G10_empty_bench_ordering = await runScenario({
    env: { FELIX_JUDGE_FAMILY: 'openai,gemini', OPENAI_API_KEY: 'sk' }, // no GEMINI_API_KEY
    input: BASE_INPUT,
    sleepMode: 'set',
    scripts: { openai: httpFail(400, 'bad request: malformed') },
  });

  // G11 — overhead alone over budget → exact "no room left for any diff" message, 0 fetch calls.
  g.G11_overhead_over_budget = await runScenario({
    env: { OPENAI_API_KEY: 'sk', FELIX_JUDGE_MAX_PROMPT_TOKENS: '50' },
    input: { prTitle: 'p', criteria: [{ text: 'c' }], diff: 'x', tier1: [] },
    scripts: {},
  });

  // G12 — chunked run where the model ignores the 3-valued schema and replies boolean met:false
  //      → mapped to not_shown, criterion fails with the "No part of the diff showed evidence" reason.
  g.G12_boolean_false_as_not_shown = await runScenario({
    env: { OPENAI_API_KEY: 'sk', FELIX_JUDGE_MAX_PROMPT_TOKENS: '1335' },
    input: { prTitle: 'bool', criteria: [{ text: 'c' }], diff: G3_DIFF, tier1: [] },
    scripts: { openai: (i) => oai({ assessment: `p${i + 1}`, criteria: [{ text: 'c', met: false, reason: 'r' }] }) },
  });

  // G13 — findRuling: openai echoes the criterion text with different case/whitespace (normText
  //      path), gemini echoes UNRELATED text (positional list[index] fallback). Pins that the
  //      positional fallback resolved gemini's ruling (dissent named, NOT "returned no ruling").
  g.G13_findRuling_normtext_vs_positional = await runScenario({
    env: { FELIX_JUDGE_FAMILY: 'openai,gemini', OPENAI_API_KEY: 'sk', GEMINI_API_KEY: 'g' },
    input: { prTitle: 'p', criteria: [{ text: 'Login works' }], diff: 'd', tier1: [] },
    sleepMode: 'set',
    scripts: {
      openai: oai({ assessment: 'a', criteria: [{ text: '  LOGIN   works ', met: true, reason: 'matched by normText' }] }),
      gemini: gem({ assessment: 'b', criteria: [{ text: 'entirely unrelated wording', met: false, reason: 'matched positionally' }] }),
    },
  });

  // G14 — REGISTRY-PURITY SENTINEL (catches S5). This is a no-override openai run placed AFTER
  //      several override runs. A ~5000-char diff is single-pass at the real 30k-token seat
  //      budget, so under correct code it stays one call with a plain met/unmet result. If a
  //      prior override run MUTATED the shared PROVIDERS.openai in place (S5), its maxPromptTokens
  //      has leaked down to 1000 here and this same diff chunks instead — a totally different
  //      object. The spread in judge.js is what keeps the registry pristine across seats/runs.
  const SENTINEL_DIFF = multiDiff([
    ['src/s0.js', 1250], ['src/s1.js', 1250], ['src/s2.js', 1250], ['src/s3.js', 1250],
  ]);
  g.G14_registry_purity_sentinel = await runScenario({
    env: { OPENAI_API_KEY: 'sk' }, // NO FELIX_JUDGE_MAX_PROMPT_TOKENS — must see the 30k default
    input: { prTitle: 'sentinel', criteria: [{ text: 'c' }], diff: SENTINEL_DIFF, tier1: [] },
    scripts: { openai: () => oai({ assessment: 'whole', criteria: [{ text: 'c', met: true, reason: 'ok' }] }) },
  });

  return g;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// EXPORT-SHAPE HYGIENE (asserted in BOTH modes — will matter after the split)
// ════════════════════════════════════════════════════════════════════════════════════════
function assertExportContract() {
  const EXPECTED = [
    'createJudge', 'assertCrossFamily', 'buildPrompt', 'alignSingleRulings', 'mergeJuryResults',
    'mergeChunkRulings', 'chunkVerdict', 'describeCoverage', 'PROVIDERS',
  ];
  assert.deepStrictEqual(
    Object.keys(judgeMod), EXPECTED,
    `judge.js must export exactly these 9 keys in this order; got [${Object.keys(judgeMod).join(', ')}]`,
  );
  // TODO(after extraction): once src/engine/providers.js exists, additionally assert
  //   require('../src/engine/judge').PROVIDERS === require('../src/engine/providers').PROVIDERS
  // Guarded off now because providers.js does not exist yet, so this must PASS today.
  try {
    // eslint-disable-next-line global-require
    const providers = require('../src/engine/providers');
    assert.strictEqual(judgeMod.PROVIDERS, providers.PROVIDERS, 'PROVIDERS must be the shared singleton after the split');
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e; // pre-split: providers.js absent → skip, do not fail
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// COMPARE / UPDATE
// ════════════════════════════════════════════════════════════════════════════════════════
function firstStringDiff(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return { line: i + 1, expected: la[i] === undefined ? '<no line>' : la[i], actual: lb[i] === undefined ? '<no line>' : lb[i] };
    }
  }
  return null;
}

async function main() {
  const update = process.argv.includes('--update');
  assertExportContract();
  const golden = await build();
  const serialized = JSON.stringify(golden, null, 2);

  if (update) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${serialized}\n`);
    const caseCount = Object.keys(golden).length;
    console.log(`[golden] wrote ${FIXTURE}`);
    console.log(`[golden] ${caseCount} cases captured (${serialized.length} bytes).`);
    return;
  }

  if (!fs.existsSync(FIXTURE)) {
    console.error(`[golden] FAIL — fixture missing: ${FIXTURE}\n         run: node test/golden-judge.js --update`);
    process.exit(1);
  }
  const committed = fs.readFileSync(FIXTURE, 'utf8');
  const current = `${serialized}\n`;

  if (committed === current) {
    const caseCount = Object.keys(golden).length;
    console.log(`[golden] OK — ${caseCount} judge cases match the golden fixture byte-for-byte.`);
    return;
  }

  // Mismatch: pinpoint the first drifting CASE (compared as strings so key-order drift shows too).
  const committedObj = JSON.parse(committed);
  const keys = [...new Set([...Object.keys(committedObj), ...Object.keys(golden)])];
  let firstCase = null;
  for (const k of keys) {
    const cur = JSON.stringify(golden[k], null, 2);
    const old = JSON.stringify(committedObj[k], null, 2);
    if (cur !== old) { firstCase = k; break; }
  }
  console.error('[golden] FAIL — judge.js output drifted from the pinned fixture.');
  if (firstCase) {
    const cur = JSON.stringify(golden[firstCase] === undefined ? '<case removed>' : golden[firstCase], null, 2);
    const old = JSON.stringify(committedObj[firstCase] === undefined ? '<new case>' : committedObj[firstCase], null, 2);
    console.error(`\n  First mismatching case: ${firstCase}`);
    const d = firstStringDiff(old, cur);
    if (d) {
      console.error(`  First differing line (${d.line}):`);
      console.error(`    expected (golden): ${d.expected}`);
      console.error(`    actual   (now):    ${d.actual}`);
    }
  } else {
    // Whole-file byte drift with no per-case object difference (e.g. trailing-newline / ordering).
    const d = firstStringDiff(committed, current);
    if (d) {
      console.error(`  First differing line (${d.line}):`);
      console.error(`    expected: ${d.expected}`);
      console.error(`    actual:   ${d.actual}`);
    }
  }
  console.error('\n  If this change is INTENTIONAL, re-baseline with: node test/golden-judge.js --update');
  process.exit(1);
}

main().catch((e) => { console.error('[golden] harness crashed:', e); process.exit(1); });
