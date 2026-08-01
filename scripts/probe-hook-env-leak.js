/**
 * probe-hook-env-leak.js — does `git worktree add` really hand the repo's post-checkout hook
 * Felix's environment, and does the fix really stop it?
 *
 * The claim behind the fix: `git worktree add` performs a checkout, a checkout runs the
 * repository's `post-checkout` hook, and util/exec's `run` defaults `env` to `process.env` —
 * so a hook planted in `<repo>/.git/hooks/` receives GITHUB_TOKEN and every judge key. That is
 * reachable in the real flow: `createSandbox` checks the PR out, the PR's own install/build/test
 * then runs with write access to the parent clone's `.git`, and deps.js calls `git worktree add`
 * twice more afterwards.
 *
 * "Reasonable" is not the standard here, so this probe is DIFFERENTIAL and it is allowed to
 * prove the diagnosis WRONG:
 *
 *   A. the shipped shape   — `run(cmd, { env: buildCleanEnv() })`  -> the hook must NOT see it
 *   B. the pre-fix shape   — `run(cmd, {})`, no env at all         -> the hook MUST see it
 *
 * If B comes back clean, there was never a leak, the committed rationale is wrong, and this
 * exits non-zero printing DIAGNOSIS REFUTED. A green A alone would prove nothing: a hook that
 * silently failed to run also produces "no secret found". So both runs additionally have to
 * show the hook FIRED — that is the second control, and it is the one that catches a probe
 * lying in the safe direction.
 *
 *   node scripts/probe-hook-env-leak.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { run } = require('../src/engine/util/exec');
const { buildCleanEnv } = require('../src/engine/util/env');

// A value no real environment contains, so finding it is unambiguous.
const SECRET_NAME = 'FELIX_PROBE_FAKE_TOKEN';
const SECRET_VALUE = 'ghp_PROBE_0000_THIS_IS_NOT_A_REAL_TOKEN';

async function git(args, cwd) {
  const r = await run(`git ${args}`, { cwd, timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`git ${args} failed:\n${r.combined}`);
  return r;
}

/**
 * A repo whose post-checkout hook dumps its whole environment to `dumpPath`. Hooks are neither
 * tracked nor cloned, which is exactly why this looks unreachable — Felix's own ordering is
 * what supplies the write (see the header).
 */
async function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-hook-probe-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  await git('init --quiet .', repo);
  await git('config user.email probe@felix.local', repo);
  await git('config user.name probe', repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  await git('add -A', repo);
  await git('commit --quiet -m init', repo);

  const dumpPath = path.join(root, 'hook-env.txt').replace(/\\/g, '/');
  const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
  // git runs hooks through its own sh on every platform, so one POSIX script covers Windows too.
  fs.writeFileSync(hook, `#!/bin/sh\nenv > "${dumpPath}"\n`);
  fs.chmodSync(hook, 0o755); // no-op on Windows, required on Linux CI
  return { root, repo, dumpPath };
}

/**
 * One checkout. `opts` is spliced into the `run` call exactly as the corresponding call site
 * writes it — B passes nothing, which is the pre-fix code.
 */
async function attempt(label, opts, { repo, dumpPath }, i) {
  if (fs.existsSync(dumpPath)) fs.unlinkSync(dumpPath);
  const dir = path.join(path.dirname(repo), `wt-${i}`);
  const cmd = `git worktree add --detach --force "${dir}" HEAD`;
  process.stdout.write(`\n── ${label}\n   ${cmd}\n   run opts: ${JSON.stringify(Object.keys(opts))}\n`);

  const r = await run(cmd, { cwd: repo, timeoutMs: 60000, ...opts });
  if (r.code !== 0) throw new Error(`${label}: worktree add failed:\n${r.combined}`);

  const fired = fs.existsSync(dumpPath);
  const dump = fired ? fs.readFileSync(dumpPath, 'utf8') : '';
  const leaked = dump.includes(`${SECRET_NAME}=${SECRET_VALUE}`);
  console.log(`   hook fired: ${fired ? 'YES' : 'NO'}   secret in hook env: ${leaked ? 'YES — LEAKED' : 'no'}`);
  if (fired) console.log(`   hook saw ${dump.trim().split('\n').length} variables`);
  await run(`git worktree remove --force "${dir}"`, { cwd: repo, timeoutMs: 60000 });
  return { fired, leaked, dump };
}

(async () => {
  // Plant the secret in THIS process, so both attempts inherit it the way Felix would.
  process.env[SECRET_NAME] = SECRET_VALUE;

  const v = await run('git --version', { timeoutMs: 15000 });
  if (v.code !== 0) { console.error('git is not usable here.'); process.exit(2); }
  console.log(v.combined.trim());

  const ctx = await makeRepo();
  let failures = 0;

  // B FIRST. It is the control, and if it does not reproduce there is nothing to fix.
  const pre = await attempt('B. PRE-FIX shape — no env passed (util/exec defaults to process.env)', {}, ctx, 1);
  if (!pre.fired) {
    console.error('\nCONTROL BROKEN: the post-checkout hook never ran, so this probe cannot see a leak either way.');
    process.exit(3);
  }
  if (!pre.leaked) {
    console.error('\nDIAGNOSIS REFUTED: the pre-fix call did NOT leak the environment to the hook.');
    console.error('The rationale committed with this fix is wrong — read it again before trusting the fix.');
    process.exit(1);
  }

  const post = await attempt('A. SHIPPED shape — env: buildCleanEnv()', { env: buildCleanEnv() }, ctx, 2);

  // Beyond the planted value: nothing SECRET-SHAPED that this process is actually carrying may
  // appear by name in the hook's environment. On a CI runner that includes the real
  // GITHUB_TOKEN, so the allowlist is checked against live names, not just the one we invented.
  const secretish = Object.keys(process.env).filter((k) => /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(k));
  const survivors = secretish.filter((k) => new RegExp(`^${k}=`, 'm').test(post.dump));
  console.log(`   checked ${secretish.length} secret-shaped name(s) from this process against the hook env`);
  if (secretish.length < 1) console.log('   (note: none present here — this control is weak on a bare dev box)');
  if (survivors.length) {
    console.error(`\nALLOWLIST HOLE: these reached the hook by name — ${survivors.join(', ')}`);
    failures++;
  }

  if (!post.fired) {
    console.error('\nCONTROL BROKEN: the hook did not run under the clean env, so "no secret" proves nothing.');
    console.error('A clean env that stops the hook from running would hide a leak rather than close it.');
    failures++;
  }
  if (post.leaked) {
    console.error('\nFIX DOES NOT HOLD: the secret still reached the hook with buildCleanEnv() in place.');
    failures++;
  }

  console.log('\n── result');
  console.log(`   pre-fix : hook fired=${pre.fired}  leaked=${pre.leaked}   (${pre.dump.trim().split('\n').length} vars)`);
  console.log(`   shipped : hook fired=${post.fired}  leaked=${post.leaked}   (${post.dump ? post.dump.trim().split('\n').length : 0} vars)`);
  if (failures) { console.error('\nPROBE FAILED'); process.exit(1); }
  console.log('\nPROBE PASSED — the leak reproduces before the fix and is closed after it.');
  fs.rmSync(ctx.root, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
