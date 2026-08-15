/**
 * providers.js — the vendor REST contracts.
 *
 * Each judge family is a genuinely different vendor (the point of a cross-family second
 * opinion) and speaks plain REST — no SDK dependency. This module owns the request/response
 * shape for every family plus `httpError`, the shared error constructor whose SHAPE is a
 * cross-seam contract the orchestrator (judge.js) reads (see below). Dependency-free.
 */

/**
 * Build the error for a non-OK judge response, carrying the HTTP status as a property.
 * The retry path keys off `err.status === 429` rather than grepping the message — a
 * message that happens to contain "429" (an echoed diff, a token count) must not be
 * mistaken for a rate limit.
 *
 * CROSS-SEAM CONTRACT (judge.js callOnce depends on this exact shape):
 *   - err.message is prefixed `"Judge call failed: <status> "` — callOnce runs
 *     TOO_LARGE.test(err.message) against it to tell a refillable 429 from an oversized one.
 *   - err.status is the numeric HTTP status (callOnce keys retry on === 429 and the
 *     TRANSIENT_STATUSES set).
 *   - err.retryAfterMs is an OPTIONAL number of ms parsed from Retry-After; when present the
 *     orchestrator honors it instead of its exponential backoff.
 * Changing this shape without updating callOnce silently breaks retry/backoff.
 */
function httpError(res, bodyText) {
  const err = new Error(`Judge call failed: ${res.status} ${String(bodyText).slice(0, 200)}`);
  err.status = res.status;
  // Vendors send Retry-After on rate limits; honoring it beats guessing a backoff.
  const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
  return err;
}

/**
 * Judge provider registry. Each family is a genuinely different vendor (the point of a
 * cross-family second opinion) and speaks plain REST — no SDK dependency. A provider's
 * `call` builds the vendor-specific request and returns the model's RAW text (a JSON
 * string); the shared parser in createJudge turns that into the common verdict shape, so
 * both families are held to the identical output schema from buildPrompt.
 *
 *   defaultModel — used when FELIX_JUDGE_MODEL is unset (per-family, so a Gemini run never
 *                  inherits the OpenAI default).
 *   apiKeyEnv    — the env var holding that vendor's key; missing key ⇒ judge skipped.
 *   call         — async ({ apiKey, model, prompt, fetch }) → raw JSON string (or throws).
 */
const PROVIDERS = {
  openai: {
    defaultModel: 'gpt-4.1',
    apiKeyEnv: 'OPENAI_API_KEY',
    // Sized against a measured gpt-4.1 TPM ceiling of 30,000 — the number in the
    // live 429, not a guess. NOT the context window: gpt-4.1's window is ~1M tokens, and
    // budgeting against that is precisely the bug this replaced.
    tpm: 30_000,
    maxPromptTokens: 30_000,
    // No `rpm`: measured 2026-08-14 with scripts/probe-vendor-rpm.js — 60 concurrent requests
    // accepted in 2.77s (~1,300/min offered), zero 429s. The request ceiling is nowhere near
    // anything Felix does; TPM is what binds this seat. Deliberately absent rather than set to a
    // large guess, because a number here would read as measured on a key that never measured it.
    // A lower-tier key sets FELIX_JUDGE_RPM.
    async call({ apiKey, model, prompt, fetch }) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw httpError(res, txt);
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('Judge returned an empty response (no choices/content).');
      return text;
    },
  },
  gemini: {
    // NOT gemini-2.5-flash. It's still listed as "stable" in Google's model docs, but the API
    // rejects it for keys created recently: 404 "no longer available to new users". Felix's own
    // production run caught this live — the two-vendor jury silently ran DEGRADED (openai-only) on
    // every PR, which is the one thing the jury exists to prevent. Verified against the official
    // model list (ai.google.dev/gemini-api/docs/models), not a comparison blog.
    defaultModel: 'gemini-3.6-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    // A paid Gemini key has a far larger per-minute allowance than the OpenAI seat, so the
    // budget is PER VENDOR: Gemini usually judges a big PR in one pass while OpenAI chunks
    // the same diff. Kept well below the advertised ceiling — the cost of being wrong here
    // is a 429, and the point of this module is to stop guessing high.
    tpm: 200_000,
    maxPromptTokens: 200_000,
    // No `rpm`, same as openai and same date: 250 concurrent requests accepted in 19.2s
    // (~780/min offered), zero 429s. ⚠️ That is a PAID key. A FREE-tier Gemini key is the opposite
    // case — it meters requests hard (~10/min, and it answers with a 20s `retryDelay`), which is
    // what makes a two-vendor variance run eat a 429 per roll. That user sets FELIX_JUDGE_RPM=10
    // and gets paced instead of retried. Do not encode 10 here: it would slow every paid seat by
    // 6s a call to fix a tier this key is not on.
    async call({ apiKey, model, prompt, fetch }) {
      // Key travels in the x-goog-api-key HEADER, never the URL query string — so it can't
      // leak through request logs, proxies, or referrers. (Gemini accepts ?key= too; we
      // deliberately don't use it.)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // responseMimeType forces raw JSON (no ```json fences) so the shared parser below
          // works identically to OpenAI's json_object mode.
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw httpError(res, txt);
      }
      const data = await res.json();
      const cand = data.candidates?.[0];
      // Join all text parts (Gemini may split output). Empty ⇒ the response was blocked or hit
      // a non-STOP finish (SAFETY / MAX_TOKENS); surface WHY instead of a cryptic parse error.
      const text = (cand?.content?.parts || []).map((p) => p && p.text).filter(Boolean).join('');
      if (!text) {
        const why = cand?.finishReason || data.promptFeedback?.blockReason || 'no candidates';
        throw new Error(`Judge returned no content (Gemini finishReason=${why}).`);
      }
      return text;
    },
  },
};

module.exports = { PROVIDERS, httpError };
