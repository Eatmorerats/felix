/**
 * flows.js — R1(B): drive the app like a USER, not just like a status-code checker.
 *
 * R1 slice 1 boots the app and probes HTTP status. Slice 2 renders each route in a real
 * browser and catches the "200 but blank screen" class. Both are still *page-level* — they
 * prove a page loads, never that it WORKS. The whole class of "the button does nothing",
 * "the form submits but nothing happens", "login accepts a wrong password" sails straight
 * through, and those are exactly the acceptance criteria a PR is usually claiming.
 *
 * This adds opt-in interaction flows: a named sequence of clicks/fills/assertions run
 * against the already-running app. A failed flow is a HARD Tier 1 check → NOT VERIFIED.
 *
 *   "drive": {
 *     "enabled": true,
 *     "startCommand": "npm run preview -- --port 4173",
 *     "flows": [
 *       {
 *         "name": "login rejects a bad password",
 *         "path": "/login",
 *         "steps": [
 *           { "fill": "#email", "value": "test@example.com" },
 *           { "fill": "#password", "valueEnv": "FELIX_FLOW_BAD_PASSWORD" },
 *           { "click": "button[type=submit]" },
 *           { "expectText": "Invalid credentials" }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Deliberate constraints, because this config is attacker-controlled — Felix runs on PRs, so
 * whoever opens the PR writes this file:
 *
 *  1. STEPS ARE DATA, NOT CODE. A fixed verb table, no eval / no page.evaluate passthrough.
 *     A flow can only do what a user could do.
 *  2. NAVIGATION IS SAME-ORIGIN. `goto` takes a path ("/login"), never an absolute URL, so a
 *     flow can't turn CI into a beacon or an SSRF hop.
 *  3. ENV READS ARE PREFIX-FENCED. `valueEnv` may only name FELIX_FLOW_* vars, so a PR cannot
 *     write { "fill": "#x", "valueEnv": "OPENAI_API_KEY" } and type a real secret into a page
 *     it controls.
 *  4. VALUES ARE NEVER ECHOED. Step descriptions redact typed values — the PR comment says
 *     `fill #password ***`. Assertions (expectText) ARE echoed: they're the point of the check.
 *  5. A MALFORMED FLOW FAILS LOUD. A typo'd verb is a hard fail, never a silent skip — a
 *     smoke test that quietly does nothing is worse than no smoke test.
 *
 * Same pure/impure split as drive.js: validateFlow / buildFlows / describeStep / interpretFlow
 * are pure and unit-tested; runFlows is the thin live wrapper, exercised in CI.
 */

const { joinUrl } = require('./util/url');

const DEFAULT_FLOWS_OPTS = {
  stepTimeoutMs: 8000,      // per-step budget (waiting for a selector, a click, a nav)
  flowTimeoutMs: 60000,     // whole-flow budget, so one wedged flow can't eat the CI job
  failOnPageError: true,    // an uncaught exception mid-flow is a real crash → hard fail
  settleMs: 250,            // pause after interacting steps so the DOM can react before we assert
};

// Only env vars under this prefix can be read into a flow (guard #3 above).
const ENV_PREFIX = 'FELIX_FLOW_';

/**
 * The verb table. `arg` names the key that carries the verb's argument; every step object is
 * exactly one verb plus its modifiers. `acts` marks steps that change the page (we settle after
 * those); `asserts` marks steps that can fail the flow on their own terms.
 */
const VERBS = {
  goto: { arg: 'goto', acts: true, desc: (s) => `goto ${s.goto}` },
  click: { arg: 'click', acts: true, desc: (s) => `click ${s.click}` },
  fill: { arg: 'fill', acts: true, desc: (s) => `fill ${s.fill} ***` },        // value redacted
  select: { arg: 'select', acts: true, desc: (s) => `select ${s.select} ***` }, // value redacted
  press: { arg: 'press', acts: true, desc: (s) => `press ${s.press}${s.selector ? ` on ${s.selector}` : ''}` },
  waitFor: { arg: 'waitFor', acts: false, desc: (s) => `waitFor ${s.waitFor}` },
  waitMs: { arg: 'waitMs', acts: false, desc: (s) => `waitMs ${s.waitMs}` },
  expectText: { arg: 'expectText', asserts: true, desc: (s) => `expectText "${s.expectText}"` },
  expectNoText: { arg: 'expectNoText', asserts: true, desc: (s) => `expectNoText "${s.expectNoText}"` },
  expectSelector: { arg: 'expectSelector', asserts: true, desc: (s) => `expectSelector ${s.expectSelector}` },
  expectNoSelector: { arg: 'expectNoSelector', asserts: true, desc: (s) => `expectNoSelector ${s.expectNoSelector}` },
  expectUrl: { arg: 'expectUrl', asserts: true, desc: (s) => `expectUrl ${s.expectUrl}` },
};

const VERB_NAMES = Object.keys(VERBS);

/** Human-readable one-liner for a step, with typed values redacted. Pure. */
function describeStep(step) {
  const v = VERBS[step && step.verb];
  return v ? v.desc(step) : 'unknown step';
}

/** Normalize the flows options block, filling defaults. Pure. */
function resolveFlowOpts(driveConfig = {}) {
  return { ...DEFAULT_FLOWS_OPTS, ...(driveConfig.flowOpts || {}) };
}

/**
 * Validate + normalize one step. Returns {ok:true, step} or {ok:false, error}. Pure.
 *
 * Rejects: no verb, more than one verb, a verb with a non-string/empty argument, an absolute
 * `goto`, and a `valueEnv` outside the FELIX_FLOW_ fence.
 */
function normalizeStep(raw, index) {
  const at = `step ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${at}: expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}` };
  }
  const found = VERB_NAMES.filter((v) => Object.prototype.hasOwnProperty.call(raw, v));
  if (found.length === 0) {
    return { ok: false, error: `${at}: no known verb (expected one of ${VERB_NAMES.join(', ')})` };
  }
  if (found.length > 1) {
    return { ok: false, error: `${at}: ${found.length} verbs in one step (${found.join(', ')}) — split them` };
  }

  const verb = found[0];
  const arg = raw[verb];

  if (verb === 'waitMs') {
    const ms = Number(arg);
    if (!Number.isFinite(ms) || ms < 0) return { ok: false, error: `${at}: waitMs must be a non-negative number` };
    return { ok: true, step: { verb, waitMs: ms } };
  }

  if (typeof arg !== 'string' || !arg.trim()) {
    return { ok: false, error: `${at}: ${verb} needs a non-empty string` };
  }

  // Guard #2 — navigation stays inside the app under test.
  if (verb === 'goto') {
    if (/^[a-z][a-z0-9+.-]*:/i.test(arg) || arg.startsWith('//')) {
      return { ok: false, error: `${at}: goto must be a same-origin path like "/login", not an absolute URL` };
    }
    if (!arg.startsWith('/')) return { ok: false, error: `${at}: goto path must start with "/"` };
  }

  const step = { verb, [verb]: arg };

  // `press` may target a specific element; everything else ignores `selector`.
  if (verb === 'press' && typeof raw.selector === 'string' && raw.selector.trim()) {
    step.selector = raw.selector.trim();
  }

  // Typed values, for fill/select only.
  if (verb === 'fill' || verb === 'select') {
    if (raw.valueEnv !== undefined) {
      if (typeof raw.valueEnv !== 'string' || !raw.valueEnv.startsWith(ENV_PREFIX)) {
        // Guard #3 — the fence is the whole point; name it in the error so it's fixable.
        return { ok: false, error: `${at}: valueEnv must name a ${ENV_PREFIX}* variable (got "${raw.valueEnv}")` };
      }
      step.valueEnv = raw.valueEnv;
    } else {
      step.value = typeof raw.value === 'string' ? raw.value : '';
    }
  }

  return { ok: true, step };
}

/**
 * Validate + normalize one flow. Returns a flow plan, or one carrying `invalid` with the
 * reason (an invalid flow becomes a hard fail, not a skip — guard #5). Pure.
 */
function validateFlow(raw, index, { origin, port } = {}) {
  const name = (raw && typeof raw.name === 'string' && raw.name.trim())
    ? raw.name.trim()
    : `flow ${index + 1}`;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { name, invalid: `expected a flow object, got ${typeof raw}` };
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return { name, invalid: 'has no steps' };
  }

  const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : '/';
  if (!path.startsWith('/')) return { name, invalid: `path must start with "/" (got "${path}")` };

  const steps = [];
  for (let i = 0; i < raw.steps.length; i++) {
    const r = normalizeStep(raw.steps[i], i);
    if (!r.ok) return { name, invalid: r.error };
    steps.push(r.step);
  }

  // origin/port ride along so a mid-flow `goto` re-joins against the app, never a raw string.
  return { name, path, origin, port, url: joinUrl(origin, port, path), steps };
}

/**
 * Build every flow plan from a resolved drive config. Returns [] when none are declared, so
 * the caller skips the whole step. Pure.
 */
function buildFlows(driveResolved = {}) {
  const raw = driveResolved.flows;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((f, i) => validateFlow(f, i, { origin: driveResolved.url, port: driveResolved.port }));
}

/**
 * Grade one flow's outcome into a Tier-1-style check. Pure.
 *
 * Hard fail: a bad step, an uncaught page error, a failed assertion, a blown budget.
 * Soft skip: the browser never launched — a missing dev tool must not flip a verdict.
 *
 * @param {object} flow  flow plan from validateFlow
 * @param {{launched:boolean, launchError?:string, failedStep?:number, error?:string,
 *   completed?:number, pageErrors?:string[], timedOut?:boolean}} obs
 * @param {object} opts  resolved flow options
 */
function interpretFlow(flow, obs, opts = DEFAULT_FLOWS_OPTS) {
  const base = { name: `flow: ${flow.name}`, tier: 1, hard: true };

  // A flow that couldn't even be parsed is the PR's fault → hard fail (guard #5).
  if (flow.invalid) {
    return { ...base, status: 'fail', detail: `invalid flow — ${flow.invalid}`, output: '' };
  }

  if (!obs || !obs.launched) {
    return {
      ...base, hard: false, status: 'skip',
      detail: `flow skipped — ${(obs && obs.launchError) || 'browser unavailable'}`,
      output: '',
    };
  }

  const pageErrors = obs.pageErrors || [];
  const total = flow.steps.length;

  if (obs.timedOut) {
    const n = (obs.completed || 0) + 1;
    return {
      ...base, status: 'fail',
      detail: `${flow.name} — timed out after ${opts.flowTimeoutMs}ms at step ${n}/${total}: ${describeStep(flow.steps[n - 1])}`,
      output: pageErrors.join('\n'),
    };
  }

  if (typeof obs.failedStep === 'number') {
    const step = flow.steps[obs.failedStep];
    return {
      ...base, status: 'fail',
      detail: `${flow.name} — step ${obs.failedStep + 1}/${total} failed (${describeStep(step)}): ${obs.error || 'unknown error'}`,
      output: pageErrors.join('\n'),
    };
  }

  // The steps all ran, but the page threw along the way — a real crash the user would hit.
  if (opts.failOnPageError && pageErrors.length) {
    return {
      ...base, status: 'fail',
      detail: `${flow.name} — completed but the page threw: ${pageErrors[0]}`,
      output: pageErrors.join('\n'),
    };
  }

  return { ...base, status: 'pass', detail: `${flow.name} — ${total} step(s) passed`, output: '' };
}

/** Resolve a fill/select value, honoring the FELIX_FLOW_ fence. Pure. */
function resolveValue(step, env = {}) {
  if (step.valueEnv) {
    const v = env[step.valueEnv];
    if (v === undefined || v === '') return { error: `${step.valueEnv} is not set in the environment` };
    return { value: String(v) };
  }
  return { value: step.value || '' };
}

/** Run one normalized step against a live page. Throws on failure with a readable message. */
async function runStep(page, step, flow, opts, env) {
  const t = opts.stepTimeoutMs;
  switch (step.verb) {
    case 'goto': {
      // Re-join against the flow's own origin so a path can never escape the app.
      const url = joinUrl(flow.origin, flow.port, step.goto);
      await page.goto(url, { timeout: t, waitUntil: 'load' });
      return;
    }
    case 'click':
      await page.click(step.click, { timeout: t });
      return;
    case 'fill': {
      const r = resolveValue(step, env);
      if (r.error) throw new Error(r.error);
      await page.fill(step.fill, r.value, { timeout: t });
      return;
    }
    case 'select': {
      const r = resolveValue(step, env);
      if (r.error) throw new Error(r.error);
      await page.selectOption(step.select, r.value, { timeout: t });
      return;
    }
    case 'press':
      if (step.selector) await page.press(step.selector, step.press, { timeout: t });
      else await page.keyboard.press(step.press);
      return;
    case 'waitFor':
      await page.waitForSelector(step.waitFor, { timeout: t, state: 'visible' });
      return;
    case 'waitMs':
      await new Promise((r) => setTimeout(r, step.waitMs));
      return;
    case 'expectText': {
      const body = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      if (!String(body).includes(step.expectText)) {
        throw new Error(`page text does not contain "${step.expectText}"`);
      }
      return;
    }
    case 'expectNoText': {
      const body = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      if (String(body).includes(step.expectNoText)) {
        throw new Error(`page text still contains "${step.expectNoText}"`);
      }
      return;
    }
    case 'expectSelector':
      // Wait rather than snapshot — an assertion right after a click needs the DOM to catch up.
      try {
        await page.waitForSelector(step.expectSelector, { timeout: t, state: 'attached' });
      } catch (_) {
        throw new Error(`selector "${step.expectSelector}" never appeared`);
      }
      return;
    case 'expectNoSelector': {
      const el = await page.$(step.expectNoSelector).catch(() => null);
      if (el) throw new Error(`selector "${step.expectNoSelector}" is present but should not be`);
      return;
    }
    case 'expectUrl': {
      const url = page.url();
      if (!url.includes(step.expectUrl)) throw new Error(`url is "${url}", expected it to contain "${step.expectUrl}"`);
      return;
    }
    default:
      // Unreachable — normalizeStep gates the verb — but never fail open.
      throw new Error(`unsupported step verb "${step.verb}"`);
  }
}

/** Run one flow in a fresh browser context. Never throws — returns a structured observation. */
async function runOneFlow(browser, flow, opts, env) {
  const pageErrors = [];
  let context;
  const deadline = Date.now() + opts.flowTimeoutMs;
  let completed = 0;

  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push((err && err.message) || String(err)));

    // Every flow starts from its own declared page.
    try {
      await page.goto(flow.url, { timeout: opts.stepTimeoutMs, waitUntil: 'load' });
    } catch (e) {
      return { launched: true, failedStep: 0, error: `could not open ${flow.url} — ${e.message}`, completed: 0, pageErrors };
    }

    for (let i = 0; i < flow.steps.length; i++) {
      if (Date.now() > deadline) return { launched: true, timedOut: true, completed, pageErrors };
      const step = flow.steps[i];
      try {
        await runStep(page, step, flow, opts, env);
      } catch (e) {
        return { launched: true, failedStep: i, error: e.message, completed, pageErrors };
      }
      // Let the DOM react to an interaction before the next assertion looks at it.
      if (VERBS[step.verb].acts && opts.settleMs) {
        await new Promise((r) => setTimeout(r, opts.settleMs));
      }
      completed++;
    }
    return { launched: true, completed, pageErrors };
  } catch (e) {
    return { launched: true, failedStep: completed, error: e.message, completed, pageErrors };
  } finally {
    try { if (context) await context.close(); } catch (_) { /* already gone */ }
  }
}

/**
 * Run every declared flow against the already-running app. Never throws. Live-only (needs a
 * real browser) → exercised in CI; interpretFlow carries the offline unit coverage.
 *
 * @param {{browser:object|null, skipReason?:string, flows:object[], opts:object, env:object}} args
 * @returns {Promise<object[]>} Tier-1-style results, one per flow
 */
async function runFlows({ browser, skipReason, flows, opts = DEFAULT_FLOWS_OPTS, env = {} }) {
  if (!flows || flows.length === 0) return [];

  // No browser → every VALID flow softly skips, but invalid ones still fail loud: a broken
  // flow definition is a real defect in the PR and shouldn't hide behind missing infra.
  if (!browser) {
    return flows.map((f) => interpretFlow(f, { launched: false, launchError: skipReason || 'browser unavailable' }, opts));
  }

  const results = [];
  for (const flow of flows) {
    if (flow.invalid) { results.push(interpretFlow(flow, { launched: true }, opts)); continue; }
    results.push(interpretFlow(flow, await runOneFlow(browser, flow, opts, env), opts));
  }
  return results;
}

module.exports = {
  DEFAULT_FLOWS_OPTS, ENV_PREFIX, VERB_NAMES,
  resolveFlowOpts, normalizeStep, validateFlow, buildFlows, describeStep, interpretFlow,
  resolveValue, runFlows,
};
