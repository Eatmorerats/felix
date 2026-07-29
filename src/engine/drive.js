/**
 * drive.js — R1: actually DRIVE the running app, not just build + test it.
 *
 * Felix's judge reads the diff + test output but never boots the app, so a
 * criterion that only fails when the app actually RUNS slips through: a page
 * that 500s, a route that 404s, a missing named-export or a broken lazy route
 * that survives `vite build` but crashes at runtime, a blank white screen.
 * Unit tests with mocks pass while the real thing is broken.
 *
 * This adds an opt-in "drive" step: boot the app's start command, wait for it to
 * answer, and probe declared routes for an acceptable HTTP status. A failed
 * drive is a HARD Tier 1 check → NOT VERIFIED. Opt-in per repo via
 * felix.config.json:
 *
 *   "drive": {
 *     "enabled": true,
 *     "startCommand": "npm run preview -- --port 4173",
 *     "url": "http://127.0.0.1",
 *     "port": 4173,
 *     "routes": ["/", "/login"],
 *     "readyTimeoutMs": 60000,
 *     "expectStatusBelow": 400
 *   }
 *
 * Default disabled, so non-web repos are completely unchanged. Slice 1 covered
 * boot + HTTP-status probing (dependency-free: Node's global fetch + spawn).
 *
 * Slice 2 adds an OPTIONAL headless page load (`drive.pageLoad`) to catch the
 * "200 but blank screen" class the HTTP probe can't see: a route answers 200 but a
 * missing named export / crashed lazy route / runtime error leaves an empty <div id=root>
 * and a white page. That needs a real browser, so it uses Playwright — but only when the
 * user opts in AND Playwright is installed. If it isn't, the page-load check SKIPS softly
 * (never a hard fail), so a missing dev tool can't flip a verdict to NOT VERIFIED.
 *
 * R1(B) adds interaction flows on top — clicking and asserting like a user, which catches the
 * "loads fine, does nothing" class both probes miss. Those live in flows.js; this module owns
 * the browser lifecycle and hands ONE chromium to both the page-load render and the flows.
 *
 * Following isolation.js: resolveDrive / buildDrivePlan / interpretProbe / interpretPageLoad
 * are pure and unit-tested; driveApp + loadPages are the thin live wrappers (boot / poll /
 * probe / render / kill), integration-tested in CI like sandbox.js.
 */

const { spawn } = require('child_process');
const { logger } = require('./util/logger');
const { joinUrl } = require('./util/url');
const { buildFlows, resolveFlowOpts, runFlows } = require('./flows');

const DEFAULT_DRIVE = {
  enabled: false,
  startCommand: '',            // how to boot the app (e.g. "npm run preview -- --port 4173")
  url: 'http://127.0.0.1',     // base URL the app serves on
  port: 4173,                  // port appended to url unless the url already has one
  routes: ['/'],               // paths to probe once the app is up
  readyTimeoutMs: 60000,       // how long to wait for the app to start answering
  probeTimeoutMs: 10000,       // per-route request timeout
  expectStatusBelow: 400,      // a route passes if its status is < this (2xx/3xx ok)
  flows: [],                   // R1(B): declarative interaction smoke (see flows.js)
};

// Slice 2: the optional headless page-load layered on top of the HTTP probe. The HTTP probe
// catches 404/500/no-boot; this catches a 200 that renders a blank screen or throws at
// runtime. Opt-in (pageLoad.enabled) and needs Playwright in felix/'s own node_modules.
const DEFAULT_PAGE_LOAD = {
  enabled: false,
  waitUntil: 'load',          // playwright nav lifecycle: 'load' | 'domcontentloaded' | 'networkidle'
  settleMs: 400,              // extra pause after load so SPA hydration can paint before we look
  minBodyChars: 1,            // blank-screen floor: fail if <body> renders fewer trimmed chars (0 disables)
  requireSelector: '',        // optional stronger assertion: this selector must exist after load
  failOnPageError: true,      // an uncaught exception is a real crash → hard fail (very low false-positive)
  failOnConsoleError: false,  // console.error is noisy → captured + reported, but not gated unless set
  navTimeoutMs: 20000,        // per-route navigation timeout
};

/** Normalize the drive config, filling defaults. Pure. */
function resolveDrive(config = {}) {
  const d = { ...DEFAULT_DRIVE, ...(config.drive || {}) };
  if (!Array.isArray(d.routes) || d.routes.length === 0) d.routes = ['/'];
  d.pageLoad = { ...DEFAULT_PAGE_LOAD, ...(d.pageLoad || {}) };
  d.flowOpts = resolveFlowOpts(d);
  if (!Array.isArray(d.flows)) d.flows = [];
  return d;
}

/**
 * Build the concrete drive plan from config, or null if driving is off / has no
 * start command (in which case the caller skips the whole step). Pure.
 * @returns {null | {startCommand, readyUrl, readyTimeoutMs, probeTimeoutMs,
 *   expectStatusBelow, routes: Array<{path, url}>}}
 */
function buildDrivePlan(config = {}) {
  const d = resolveDrive(config);
  if (!d.enabled) return null;
  if (!d.startCommand || !d.startCommand.trim()) return null;
  const routes = d.routes.map((path) => ({ path, url: joinUrl(d.url, d.port, path) }));
  return {
    startCommand: d.startCommand,
    readyUrl: joinUrl(d.url, d.port, routes[0].path),
    readyTimeoutMs: d.readyTimeoutMs,
    probeTimeoutMs: d.probeTimeoutMs,
    expectStatusBelow: d.expectStatusBelow,
    routes,
    pageLoad: d.pageLoad,   // resolved page-load opts; pageLoad.enabled gates the browser step
    flows: buildFlows(d),   // R1(B): validated interaction flows (invalid ones ride along to fail loud)
    flowOpts: d.flowOpts,
  };
}

/**
 * Turn one route's probe outcome into a Tier-1-style check result. Pure.
 * @param {{path, url}} route
 * @param {{status?:number, error?:string}} res  fetch outcome
 * @param {number} expectStatusBelow
 */
function interpretProbe(route, res, expectStatusBelow = 400) {
  const base = { name: `drive ${route.path}`, tier: 1, hard: true };
  if (res && typeof res.status === 'number') {
    const pass = res.status < expectStatusBelow;
    return {
      ...base,
      status: pass ? 'pass' : 'fail',
      detail: `HTTP ${res.status} at ${route.url}${pass ? '' : ` (expected < ${expectStatusBelow})`}`,
      output: '',
    };
  }
  return {
    ...base,
    status: 'fail',
    detail: `no response from ${route.url}${res && res.error ? ` — ${res.error}` : ''}`,
    output: String((res && res.error) || ''),
  };
}

/**
 * Turn one route's headless page-load observation into a Tier-1-style check. Pure.
 *
 * A blank screen, an uncaught page error, or a nav failure is a HARD fail — the exact
 * class HTTP-probing misses. But if the browser could not launch at all it is a SOFT skip:
 * a missing dev tool (Playwright) must never flip a verdict to NOT VERIFIED.
 *
 * @param {{path:string, url:string}} route
 * @param {{launched:boolean, launchError?:string, navigated?:boolean, navError?:string,
 *   status?:number|null, bodyChars?:number, consoleErrors?:string[], pageErrors?:string[],
 *   selectorFound?:boolean|null}} obs   what the live render observed
 * @param {object} opts  resolved pageLoad options (see DEFAULT_PAGE_LOAD)
 */
function interpretPageLoad(route, obs, opts = DEFAULT_PAGE_LOAD) {
  const base = { name: `page ${route.path}`, tier: 1, hard: true };

  // Browser unavailable → soft skip (infra, not the PR's fault).
  if (!obs || !obs.launched) {
    return {
      ...base, hard: false, status: 'skip',
      detail: `page-load skipped — ${(obs && obs.launchError) || 'browser unavailable'}`,
      output: '',
    };
  }

  const consoleErrors = obs.consoleErrors || [];
  const pageErrors = obs.pageErrors || [];

  // The app was up (HTTP probe passed) but the real browser couldn't load the route.
  if (obs.navigated === false) {
    return {
      ...base, status: 'fail',
      detail: `${route.url} — page did not load: ${obs.navError || 'navigation failed'}`,
      output: [obs.navError, ...pageErrors].filter(Boolean).join('\n'),
    };
  }

  const problems = [];
  if (opts.failOnPageError && pageErrors.length) {
    problems.push(`uncaught page error: ${pageErrors[0]}`);
  }
  if (typeof obs.bodyChars === 'number' && obs.bodyChars < opts.minBodyChars) {
    problems.push(`blank screen — <body> rendered ${obs.bodyChars} char(s) (min ${opts.minBodyChars})`);
  }
  if (opts.requireSelector && obs.selectorFound === false) {
    problems.push(`required selector "${opts.requireSelector}" not found`);
  }
  if (opts.failOnConsoleError && consoleErrors.length) {
    problems.push(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);
  }

  if (problems.length) {
    return {
      ...base, status: 'fail',
      detail: `${route.url} — ${problems.join('; ')}`,
      output: [...pageErrors, ...consoleErrors].join('\n'),
    };
  }

  // Passed. Surface (but don't gate on) console errors so a noisy-but-working page is visible.
  const note = consoleErrors.length ? ` (${consoleErrors.length} console error(s), not gated)` : '';
  return {
    ...base, status: 'pass',
    detail: `${route.url} rendered ${obs.bodyChars} char(s)${note}`,
    output: '',
  };
}

/** fetch a URL with a hard per-request timeout; never throws. */
async function probe(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    return { status: r.status };
  } catch (e) {
    return { error: e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll readyUrl until it answers (any HTTP status) or the deadline passes. */
async function waitForReady(readyUrl, deadlineMs, probeTimeoutMs) {
  const start = Date.now();
  const step = 1000;
  while (Date.now() - start < deadlineMs) {
    const r = await probe(readyUrl, probeTimeoutMs);
    if (typeof r.status === 'number') return true;
    await new Promise((res) => setTimeout(res, step));
  }
  return false;
}

/** Lazy-load Playwright's chromium; returns null if it isn't installed (opt-in dep). */
function loadChromium() {
  try { return require('playwright').chromium; }
  catch (_) {
    try { return require('playwright-core').chromium; }
    catch (_2) { return null; }
  }
}

/**
 * Render a single route in a fresh browser context and collect the observation. Never throws
 * — any failure becomes a structured obs the pure interpreter can grade.
 */
async function renderOne(browser, route, opts) {
  const consoleErrors = [];
  const pageErrors = [];
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => pageErrors.push((err && err.message) || String(err)));

    let status = null;
    try {
      const resp = await page.goto(route.url, { waitUntil: opts.waitUntil, timeout: opts.navTimeoutMs });
      status = resp ? resp.status() : null;
    } catch (e) {
      return { launched: true, navigated: false, navError: e.message, consoleErrors, pageErrors };
    }

    // Give an SPA a moment to hydrate/paint before we judge "blank".
    if (opts.settleMs) await new Promise((r) => setTimeout(r, opts.settleMs));

    const bodyChars = await page
      .evaluate(() => (document.body ? document.body.innerText.trim().length : 0))
      .catch(() => 0);

    let selectorFound = null;
    if (opts.requireSelector) {
      selectorFound = (await page.$(opts.requireSelector).catch(() => null)) !== null;
    }
    return { launched: true, navigated: true, status, bodyChars, consoleErrors, pageErrors, selectorFound };
  } catch (e) {
    return { launched: true, navigated: false, navError: e.message, consoleErrors, pageErrors };
  } finally {
    try { if (context) await context.close(); } catch (_) { /* already gone */ }
  }
}

/**
 * Headless page-load probe (slice 2). Boots a real browser against the ALREADY-running app and
 * renders each route, catching the "200 but blank screen" / uncaught-crash class the HTTP probe
 * can't see. Never throws. Opt-in via plan.pageLoad.enabled; if Playwright isn't installed every
 * route SKIPS (soft) with an install hint. Live-only (needs a browser) → exercised in CI, not the
 * offline unit suite; the grading in interpretPageLoad is what the unit tests cover.
 * @returns {Promise<object[]>} Tier-1-style results, one per route
 */
async function loadPages({ plan, browser, skipReason }) {
  const opts = (plan && plan.pageLoad) || DEFAULT_PAGE_LOAD;
  if (!opts.enabled) return [];

  // Back-compat: when called without an injected browser, launch one and own its lifecycle.
  // driveApp injects one so the page-load render and the flows share a single launch.
  let own = null;
  if (browser === undefined) {
    const l = await launchBrowser();
    browser = l.browser;
    skipReason = l.skipReason;
    own = l.browser;
  }
  if (!browser) {
    const why = skipReason || 'browser unavailable';
    return plan.routes.map((route) => interpretPageLoad(route, { launched: false, launchError: why }, opts));
  }

  const results = [];
  try {
    for (const route of plan.routes) {
      results.push(interpretPageLoad(route, await renderOne(browser, route, opts), opts));
    }
  } finally {
    if (own) { try { await own.close(); } catch (_) { /* already gone */ } }
  }
  return results;
}

/**
 * Launch one headless chromium, shared by the page-load probe and the interaction flows.
 * Never throws — a missing or broken Playwright comes back as a skipReason that the graders
 * turn into SOFT skips, so a missing dev tool can never flip a verdict to NOT VERIFIED.
 * @returns {Promise<{browser: object|null, skipReason: string}>}
 */
async function launchBrowser() {
  const chromium = loadChromium();
  if (!chromium) {
    return {
      browser: null,
      skipReason: 'Playwright not installed — run `npm i -D playwright && npx playwright install chromium` in felix/',
    };
  }
  try {
    return { browser: await chromium.launch({ args: ['--no-sandbox'] }), skipReason: '' };
  } catch (e) {
    return { browser: null, skipReason: `browser launch failed — ${e.message} (try \`npx playwright install chromium\`)` };
  }
}

/**
 * Live wrapper: boot the app, wait for it to answer, probe each route, kill it.
 * Returns Tier-1-style check results. Never throws — a boot failure becomes a
 * hard-fail check so the verdict can react. driveApp is intentionally NOT part
 * of the offline unit suite (it needs a real server); it is exercised in CI.
 *
 * @returns {Promise<{results: object[], booted: boolean}>}
 */
async function driveApp({ cwd, env, plan }) {
  if (!plan) return { results: [], booted: false };
  const child = spawn(plan.startCommand, {
    cwd, env, shell: true,
    detached: process.platform !== 'win32', // own process group so we can kill the tree
    stdio: 'ignore',
  });
  const kill = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (_) { /* already gone */ }
  };

  try {
    logger.step('T1', `drive: booting "${plan.startCommand}" → ${plan.readyUrl}`);
    const booted = await waitForReady(plan.readyUrl, plan.readyTimeoutMs, plan.probeTimeoutMs);
    if (!booted) {
      return {
        booted: false,
        results: [{
          name: 'drive boot', tier: 1, hard: true, status: 'fail',
          detail: `app did not answer ${plan.readyUrl} within ${plan.readyTimeoutMs}ms`, output: '',
        }],
      };
    }
    const results = [];
    for (const route of plan.routes) {
      const res = await probe(route.url, plan.probeTimeoutMs);
      results.push(interpretProbe(route, res, plan.expectStatusBelow));
    }
    // Slice 2 + R1(B): opt-in browser work on top of the HTTP probe. ONE chromium launch is
    // shared by the page-load render (blank-screen / crash class) and the interaction flows
    // (the-button-does-nothing class) — launching per step would double the CI cost.
    const wantsPageLoad = Boolean(plan.pageLoad && plan.pageLoad.enabled);
    const wantsFlows = Boolean(plan.flows && plan.flows.length);
    if (wantsPageLoad || wantsFlows) {
      const { browser, skipReason } = await launchBrowser();
      try {
        if (wantsPageLoad) {
          logger.step('T1', `drive: headless page-load on ${plan.routes.length} route(s)`);
          results.push(...await loadPages({ plan, browser, skipReason }));
        }
        if (wantsFlows) {
          logger.step('T1', `drive: ${plan.flows.length} interaction flow(s)`);
          results.push(...await runFlows({ browser, skipReason, flows: plan.flows, opts: plan.flowOpts, env }));
        }
      } finally {
        if (browser) { try { await browser.close(); } catch (_) { /* already gone */ } }
      }
    }
    return { results, booted: true };
  } finally {
    kill();
  }
}

module.exports = {
  DEFAULT_DRIVE, DEFAULT_PAGE_LOAD, resolveDrive, buildDrivePlan,
  interpretProbe, interpretPageLoad, joinUrl, driveApp, loadPages, launchBrowser,
};
