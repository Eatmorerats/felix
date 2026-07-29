/**
 * live-flows.js — end-to-end proof that R1(B) interaction flows actually drive a real app.
 *
 * test/run.js covers the GRADING (interpretFlow) offline. That is not the same as proving the
 * driver works: a flow engine whose clicks silently do nothing would pass every unit test and
 * verify nothing — exactly the failure mode Felix exists to catch. So this boots a real HTTP
 * server with a real form and drives it in a real browser.
 *
 * Playwright is an OPT-IN dependency, so this suite SKIPS cleanly (exit 0) when it isn't
 * installed. Run it where a browser exists:
 *
 *   npm i --no-save playwright-core && node test/live-flows.js
 */

const assert = require('assert');
const http = require('http');
const { buildDrivePlan, driveApp } = require('../src/engine/drive');

function hasPlaywright() {
  try { require('playwright'); return true; } catch (_) {}
  try { require('playwright-core'); return true; } catch (_) {}
  return false;
}

if (!hasPlaywright()) {
  console.log('live-flows: SKIPPED — Playwright not installed (opt-in dependency).');
  process.exit(0);
}

// A tiny app with REAL behavior: the form only says "Welcome back" for the right password.
// That is the whole point — an HTTP probe and a page-load render both pass on this page no
// matter what you type, so only an interaction flow can tell the two outcomes apart.
const PAGE = `<!doctype html><html><body>
<h1>Sign in</h1>
<form id="f">
  <input id="email" name="email" />
  <input id="password" name="password" type="password" />
  <button id="go" type="submit">Sign in</button>
</form>
<div id="out"></div>
<script>
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = document.getElementById('password').value;
    document.getElementById('out').textContent =
      pw === 'correct-horse' ? 'Welcome back' : 'Invalid credentials';
  });
</script>
</body></html>`;

const PORT = 45731;
let failed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

/** Run driveApp against the live server with the given flows, return results by flow name. */
async function drive(flows) {
  const plan = buildDrivePlan({
    drive: {
      enabled: true,
      // The server is already up (we start it below), so the "start command" is a no-op that
      // exits immediately — driveApp only needs the readiness poll to succeed.
      startCommand: process.platform === 'win32' ? 'cmd /c exit 0' : 'true',
      port: PORT,
      routes: ['/'],
      flows,
      flowOpts: { stepTimeoutMs: 3000, flowTimeoutMs: 20000, settleMs: 100 },
    },
  });
  const { results } = await driveApp({
    cwd: process.cwd(),
    env: { ...process.env, FELIX_FLOW_GOOD_PASSWORD: 'correct-horse' },
    plan,
  });
  return results;
}

check('a flow that drives the form to the SUCCESS path passes', async () => {
  const [r] = (await drive([{
    name: 'right password signs in',
    path: '/',
    steps: [
      { fill: '#email', value: 'test@example.com' },
      { fill: '#password', valueEnv: 'FELIX_FLOW_GOOD_PASSWORD' },
      { click: '#go' },
      { expectText: 'Welcome back' },
    ],
  }])).filter((x) => x.name.startsWith('flow:'));
  assert.strictEqual(r.status, 'pass', `expected pass, got ${r.status}: ${r.detail}`);
});

check('a flow whose assertion is genuinely false FAILS (the driver is not rubber-stamping)', async () => {
  const [r] = (await drive([{
    name: 'wrong password must not sign in',
    path: '/',
    steps: [
      { fill: '#password', value: 'wrong' },
      { click: '#go' },
      { expectText: 'Welcome back' },   // deliberately false — the app says "Invalid credentials"
    ],
  }])).filter((x) => x.name.startsWith('flow:'));
  assert.strictEqual(r.status, 'fail', `a false assertion must fail, got ${r.status}`);
  assert.strictEqual(r.hard, true);
  assert.match(r.detail, /step 3\/3/);
  assert.match(r.detail, /expectText/);
});

check('the negative case is really driven: wrong password shows Invalid credentials', async () => {
  const [r] = (await drive([{
    name: 'wrong password is rejected',
    path: '/',
    steps: [
      { fill: '#password', value: 'wrong' },
      { click: '#go' },
      { expectText: 'Invalid credentials' },
      { expectNoText: 'Welcome back' },
    ],
  }])).filter((x) => x.name.startsWith('flow:'));
  assert.strictEqual(r.status, 'pass', `expected pass, got ${r.status}: ${r.detail}`);
});

check('a missing selector fails with the step named, and never echoes the typed value', async () => {
  const [r] = (await drive([{
    name: 'typo in a selector',
    path: '/',
    steps: [{ fill: '#nonexistent-field', value: 'hunter2' }],
  }])).filter((x) => x.name.startsWith('flow:'));
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /step 1\/1/);
  assert.match(r.detail, /fill #nonexistent-field \*\*\*/);
  assert.ok(!r.detail.includes('hunter2'), 'the typed value leaked into the report');
});

check('an unset FELIX_FLOW_ var fails loudly instead of silently typing an empty string', async () => {
  const [r] = (await drive([{
    name: 'missing env',
    path: '/',
    steps: [{ fill: '#password', valueEnv: 'FELIX_FLOW_NOT_SET_ANYWHERE' }],
  }])).filter((x) => x.name.startsWith('flow:'));
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /FELIX_FLOW_NOT_SET_ANYWHERE is not set/);
});

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`live-flows: driving a real app on http://127.0.0.1:${PORT}\n`);

  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
  }

  await new Promise((r) => server.close(r));
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
