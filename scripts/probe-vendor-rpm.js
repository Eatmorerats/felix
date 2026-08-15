#!/usr/bin/env node
/**
 * probe-vendor-rpm.js — MEASURE a vendor's requests-per-minute ceiling. Do not guess it.
 *
 * `paceMs` waits `tokens/TPM` of a minute after every call, which is the right control for a
 * TOKENS-per-minute ceiling and no control at all for a REQUESTS-per-minute one. On a small prompt
 * the two are wildly different: a 1,027-token judge prompt against OpenAI's 30K TPM buys a 2.1s
 * wait — ~29 requests a minute — and a seat whose real limit is 10 RPM 429s on the third one. That
 * is exactly what a two-vendor variance run hits: a 20s 429 per roll, which turns a measurement
 * into a retry test.
 *
 * The fix needs a NUMBER, and this repo's rule is that the number comes from the live 429, not
 * from a vendor doc that changes under you and not from a plausible-sounding constant. So: fire
 * minimal requests as fast as the socket allows and watch for the first refusal.
 *
 * ── WHY --concurrency EXISTS, AND WHY THE SEQUENTIAL MODE IS A TRAP ──────────────────────────
 * The first version of this probe was sequential, and it "found no ceiling" in 40 requests — a
 * conclusion it could not have reached any other way. A Gemini call for a ONE-TOKEN completion took
 * 750ms–11s (median ~2.5s), so awaiting each one caps the OFFERED rate at ~16-24 req/min. A probe
 * that never offers more than 24 rpm cannot detect a 30 rpm ceiling; it can only ever report the
 * vendor's latency back to you wearing a rate limit's clothes.
 *
 * So the burst is CONCURRENT by default. The rate under test is what is offered, not what the
 * socket happened to sustain, and the two are the same number only when latency is negligible.
 *
 * ── WHAT IT COSTS ────────────────────────────────────────────────────────────────────────────
 * The prompt is a handful of tokens and the output cap is pinned to 1 token. At flash / gpt-4.1
 * input rates a full 40-request probe is a fraction of a cent. It is still REAL SPEND on a REAL
 * key, so it needs --spend like everything else here.
 *
 * ── WHAT IT MEASURES, AND WHAT IT CANNOT ─────────────────────────────────────────────────────
 * It measures THIS KEY's ceiling on THIS DAY — a tier is a property of the billing plan, not of the
 * vendor, so a free-tier key and a paid one give different answers and both are correct. That is
 * why the output is a recommended `rpm` for the registry plus the evidence, rather than a number
 * this script writes anywhere itself.
 *
 * It CANNOT prove an absence: finishing 40 requests with no 429 means the ceiling is above the
 * burst that was sent, not that there isn't one. The report says so in those words rather than
 * printing a reassuring "no limit found".
 *
 *   node scripts/probe-vendor-rpm.js --family gemini --spend
 *   node scripts/probe-vendor-rpm.js --family openai --spend --n 40
 */

'use strict';

const path = require('path');
if (!/^(1|true|yes|on)$/i.test(process.env.FELIX_NO_DOTENV || '')) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
}

const { PROVIDERS } = require('../src/engine/providers');

// Same wallet order as smoke-judge-variance: a probe must not spend the key CI grades PRs with
// when a variance key exists for exactly this.
function resolveKey(env, provider) {
  const base = provider.apiKeyEnv;
  for (const suffix of ['_VARIANCE', '_PREFLIGHT', '']) {
    if (env[`${base}${suffix}`]) return { key: env[`${base}${suffix}`], from: `${base}${suffix}` };
  }
  return { key: null, from: null };
}

/**
 * One minimal request, timed, returning the outcome rather than throwing.
 *
 * Deliberately NOT provider.call(): that path parses a verdict and would fail on a 1-token
 * completion. What is under measurement is the transport's admission decision — status, and the
 * vendor's own advice about when to come back — so the request is built here, minimally.
 */
async function ping(family, apiKey, model) {
  const started = Date.now();
  let res;
  try {
    if (family === 'openai') {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
    } else {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      });
    }
  } catch (e) {
    return { status: 0, ms: Date.now() - started, error: String(e.message) };
  }
  const out = { status: res.status, ms: Date.now() - started };
  // Both the header and the body carry the vendor's own "come back in N" — Google puts it in a
  // RetryInfo detail in the JSON, OpenAI in Retry-After. Whichever exists is better evidence than
  // any backoff we would invent, and it is the tightest read on the real window.
  const hdr = Number(res.headers.get('retry-after'));
  if (Number.isFinite(hdr) && hdr > 0) out.retryAfterMs = hdr * 1000;
  if (!res.ok) {
    const txt = await res.text();
    out.body = txt.slice(0, 400);
    const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(txt);
    if (m && !out.retryAfterMs) out.retryAfterMs = Math.round(Number(m[1]) * 1000);
    // A quota name tells you WHICH ceiling was hit — per-minute requests vs per-day vs tokens.
    // Pacing can only fix the per-minute-requests one, so the distinction is load-bearing.
    const q = /"quotaId"\s*:\s*"([^"]+)"/.exec(txt) || /"quotaMetric"\s*:\s*"([^"]+)"/.exec(txt);
    if (q) out.quota = q[1];
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const family = String(arg('family', 'gemini')).toLowerCase();
  const n = Number(arg('n', 40));
  // All at once by default. `--concurrency 1` is the old sequential mode, kept only because it is
  // the right shape for measuring LATENCY — it is the wrong shape for measuring a ceiling.
  const concurrency = Number(arg('concurrency', n));
  const spend = argv.includes('--spend');

  const provider = PROVIDERS[family];
  if (!provider) {
    console.error(`unknown family "${family}". Known: ${Object.keys(PROVIDERS).join(', ')}.`);
    process.exit(1);
  }
  const model = arg('model', provider.defaultModel);
  const { key, from } = resolveKey(process.env, provider);

  console.log('\nprobe-vendor-rpm — find the requests-per-minute ceiling by hitting it\n');
  console.log(`  family      ${family}  ·  model ${model}`);
  console.log(`  key         ${key ? from : 'NONE FOUND'}`);
  console.log(`  burst       ${n} minimal requests, ${concurrency >= n ? 'ALL FIRED AT ONCE' : `${concurrency} at a time`}, no pacing`);
  console.log('  cost        a fraction of a cent — the output cap is 1 token\n');

  if (!key) {
    console.error(`  ${provider.apiKeyEnv} (or _VARIANCE/_PREFLIGHT) is not set.\n`);
    process.exit(1);
  }
  if (!spend) {
    console.log('  Nothing was called. Re-run with --spend to actually probe.\n');
    process.exit(0);
  }

  const t0 = Date.now();
  const results = new Array(n);
  let next = 0;
  // A fixed pool of `concurrency` workers pulling from one counter, rather than n promises
  // created up front: at --concurrency n the two are identical, and below it this keeps exactly
  // that many requests genuinely in flight instead of in batches that idle on the slowest member.
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      const r = await ping(family, key, model);
      r.at = Date.now() - t0;
      results[i] = r;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, n)) }, worker));

  for (let i = 0; i < n; i++) {
    const r = results[i];
    if (!r) continue;
    const mark = r.status === 200 ? 'ok ' : r.status === 429 ? '429' : `${r.status || 'ERR'}`;
    console.log(`  #${String(i + 1).padStart(3)}  ${mark}  t+${(r.at / 1000).toFixed(2)}s  ${r.ms}ms`
      + `${r.retryAfterMs ? `  · vendor says retry in ${(r.retryAfterMs / 1000).toFixed(0)}s` : ''}`
      + `${r.quota ? `  · quota ${r.quota}` : ''}`);
  }

  const done = results.filter(Boolean);
  const ok = done.filter((r) => r.status === 200);
  const limited = done.filter((r) => r.status === 429);
  // A non-429 failure is not a rate limit, and counting one as "no ceiling found" is the wrong
  // conclusion in the dangerous direction — a bad key or a dead model would read as headroom.
  const broken = done.filter((r) => r.status !== 200 && r.status !== 429);
  const elapsedS = Math.max(...done.map((r) => r.at)) / 1000;
  const offered = concurrency >= n ? `${n} at once` : `${concurrency} in flight`;

  console.log('\n' + '─'.repeat(78));
  console.log(`  offered ${offered} · ${ok.length} accepted · ${limited.length} rate-limited`
    + `${broken.length ? ` · ${broken.length} OTHER failure(s)` : ''} · ${elapsedS.toFixed(2)}s wall`);

  if (broken.length) {
    const b = broken[0];
    console.log(`  ⚠️ ${broken.length} request(s) failed with something that is NOT a rate limit `
      + `(first: ${b.status || 'transport'}). Fix that before reading anything else here.`);
    if (b.body) console.log(`     ${b.body.replace(/\s+/g, ' ').slice(0, 220)}`);
    if (b.error) console.log(`     ${b.error}`);
  }

  if (!limited.length) {
    // The honest negative. An absence of 429 bounds the ceiling from BELOW and nothing more, so it
    // prescribes no number — printing a confident rpm here is how a guess becomes a measurement.
    console.log(`  NO 429 with ${offered}. This does NOT mean there is no ceiling — it means the`);
    console.log(`  ceiling is ABOVE this burst. Re-run with a larger --n to find it, or leave rpm`);
    console.log('  unset for this family and let the retry path carry it.');
  } else {
    const advice = limited.map((r) => r.retryAfterMs).filter(Boolean)[0];
    const quota = limited.map((r) => r.quota).filter(Boolean)[0];
    console.log(`  CEILING FOUND: ${ok.length} accepted before the vendor started refusing.`);
    if (quota) console.log(`  Quota hit: ${quota}`);
    if (advice) console.log(`  The vendor's own advice was ${(advice / 1000).toFixed(0)}s — i.e. ~${(60000 / advice).toFixed(1)} req/min.`);
    console.log(`\n  Recommended for PROVIDERS.${family}:  rpm: ${ok.length}`);
    console.log('  Set it to what was ACCEPTED, not to the vendor advice: the accepted count is the');
    console.log('  window this key actually cleared, and pacing to it is the version that does not');
    console.log('  need the retry path at all. Record the date — a tier change moves this number.');
  }
  console.log('─'.repeat(78) + '\n');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`probe-vendor-rpm failed: ${e.stack || e.message}`);
    process.exit(1);
  });
}
