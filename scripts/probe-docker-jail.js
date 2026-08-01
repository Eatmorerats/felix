/**
 * probe-docker-jail.js — does the docker jail actually let a real install run?
 *
 * This exists because the fix it guards was reasoned, not observed. The claim was: `--read-only`
 * plus `-u <uid>:<gid>` for a uid with no /etc/passwd entry leaves container HOME at `/`, on the
 * read-only layer, so `npm ci` cannot write its cache or `_logs` and docker mode has most likely
 * never completed a Node install. That was high-confidence reasoning from docker's documented
 * `-u` behaviour — and nobody had run it, because there is no docker on the dev box.
 *
 * So this probe is DIFFERENTIAL and it is allowed to prove the diagnosis WRONG:
 *
 *   A. the real wrapCommand output           -> must succeed
 *   B. the same command with the cache env stripped (i.e. the pre-fix shape) -> must fail
 *
 * If B succeeds, the committed rationale is wrong: the env block was not what fixed anything.
 * That exits non-zero on purpose. A green run here is only worth something if the control could
 * have gone red.
 *
 * Runs in CI (ubuntu-latest has docker). `node scripts/probe-docker-jail.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveIsolation, wrapCommand, CACHE_ENV } = require('../src/engine/isolation');
const { run } = require('../src/engine/util/exec');

// One real dependency, so the install genuinely exercises the npm cache rather than short-
// circuiting on an empty tree. Tiny and dependency-free to keep the probe fast.
const FIXTURE = {
  'package.json': JSON.stringify({
    name: 'felix-jail-probe', version: '1.0.0', private: true,
    dependencies: { 'is-odd': '3.0.1' },
  }, null, 2),
};

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-jail-probe-'));
  for (const [name, body] of Object.entries(FIXTURE)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

/** Remove the -e flags the fix added, reproducing the shape that shipped before it. */
function stripCacheEnv(cmd) {
  let out = cmd;
  for (const k of Object.keys(CACHE_ENV)) out = out.replace(new RegExp(`-e ${k}=\\S+ `), '');
  return out;
}

async function attempt(label, cmd, cwd) {
  process.stdout.write(`\n── ${label}\n${cmd}\n`);
  const r = await run(cmd, { cwd, timeoutMs: 300000 });
  const ok = r.code === 0 && !r.timedOut;
  console.log(`   exit ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''} in ${r.durationMs}ms`);
  if (!ok) console.log(`   output tail: ${String(r.combined).slice(-600)}`);
  return { ok, out: String(r.combined) };
}

(async () => {
  const docker = await run('docker version --format "{{.Server.Version}}"', { timeoutMs: 15000 });
  if (docker.code !== 0) {
    console.error('docker is not usable here — this probe only means anything with a real daemon.');
    console.error(docker.combined);
    process.exit(2);
  }
  console.log(`docker server ${docker.combined.trim()}`);

  const cwd = makeFixture();
  const iso = resolveIsolation({ language: 'node', isolation: { mode: 'docker' } });
  // network:'allow' because this is the install step, the one step the jail lets reach the network.
  const real = wrapCommand('npm install --no-audit --no-fund', { isolation: iso, cwd, network: 'allow' });

  const a = await attempt('A. wrapCommand as shipped (writable HOME + cache env)', real, cwd);

  // Fresh tree — A left node_modules behind, which would let B pass for the wrong reason.
  fs.rmSync(cwd, { recursive: true, force: true });
  const cwd2 = makeFixture();
  const control = stripCacheEnv(wrapCommand('npm install --no-audit --no-fund', { isolation: iso, cwd: cwd2, network: 'allow' }));
  const b = await attempt('B. CONTROL — same jail, cache env stripped (the pre-fix shape)', control, cwd2);

  fs.rmSync(cwd2, { recursive: true, force: true });

  console.log('\n──────── result ────────');
  console.log(`A (must PASS): ${a.ok ? 'PASS' : 'FAIL'}`);
  console.log(`B (must FAIL): ${b.ok ? 'PASS' : 'FAIL'}`);

  if (a.ok && !b.ok) {
    console.log('\nCONFIRMED. The jail runs a real install only with the cache env block, and the');
    console.log('pre-fix shape genuinely could not — the diagnosis held up under execution.');
    process.exit(0);
  }
  if (!a.ok) {
    console.error('\nFAILED. Docker mode still cannot complete an install. The fix is incomplete.');
    process.exit(1);
  }
  console.error('\nDIAGNOSIS REFUTED. The control PASSED, so the read-only HOME was not what broke');
  console.error('docker mode and the rationale committed alongside the fix is wrong. The env block');
  console.error('is harmless, but the comment explaining it must be corrected — go look properly.');
  process.exit(1);
})();
