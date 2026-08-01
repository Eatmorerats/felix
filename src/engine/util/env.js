/**
 * env.js — the one allowlisted, secret-free environment Felix hands to anything it does not
 * trust.
 *
 * DENY BY DEFAULT. This names the variables to KEEP, never the ones to drop. A blocklist is
 * the wrong shape for the same reason it always is: the next secret added to CI — a new
 * `*_TOKEN`, another vendor key, whatever an adopter exports in their own workflow — is
 * inherited automatically by a blocklist and refused automatically by an allowlist. Felix's
 * process holds GITHUB_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY and SUPABASE_SERVICE_ROLE_KEY at
 * the moment it runs untrusted code, so the default has to be "no".
 *
 * ── TWO CALLERS, AND THE SECOND ONE IS A VULNERABILITY, NOT HARDENING ────────────────────
 *
 * 1. sandbox.js — the environment untrusted install/build/test scripts run under. This one
 *    was already deliberate; the extraction below keeps every key it used to pass.
 *
 * 2. `git worktree add`, in BOTH sandbox.js and deps.js — which **fires the repository's
 *    `post-checkout` hook**. Neither call passed an `env`, and util/exec's `run` defaults to
 *    `process.env`, so the hook ran with Felix's full secret set. Verified live, not inferred:
 *    a `post-checkout` writing `env` to a file captured a planted token on the first try
 *    (`scripts/probe-hook-env-leak.js` reproduces it with a control).
 *
 *    Hooks are not tracked by git and not transferred by clone or fetch, so a PR cannot ship
 *    one — which is exactly why this looks safe and isn't. Felix's own ordering supplies the
 *    write: `createSandbox` checks the PR out, THEN the untrusted install/build/test step runs,
 *    THEN deps.js calls `git worktree add` twice more. The sandbox worktree's `.git` is a file
 *    pointing back into the parent clone, so the untrusted step can drop a `post-checkout` into
 *    `<repo>/.git/hooks/` and simply wait for the deps check to run it. deps.js is the reachable
 *    exploit; sandbox.js is defence in depth (a dirty clone on a self-hosted runner, or a
 *    previous PR's leftovers).
 *
 * ── WINDOWS ─────────────────────────────────────────────────────────────────────────────
 * The env this replaces passed `HOME`, which is normally undefined on Windows, and no
 * `SystemRoot`, which Node itself needs there. So the "clean environment" was quietly a broken
 * one off Linux. The extraction is ADDITIVE: every key the old object set is still set, with
 * the same value, and the Windows block only ever adds — a Linux runner's environment is
 * byte-identical to what it was before.
 */

/**
 * Always present. PATH and HOME pass through; the rest are fixed values that make an
 * untrusted script's output deterministic and non-interactive.
 *
 * GIT_TERMINAL_PROMPT is the one genuinely new entry. Stripping the environment is exactly
 * what makes a git command decide it needs to ask for credentials, and a blocked prompt inside
 * a hook would burn the whole timeout instead of failing.
 */
const BASE_KEYS = ['PATH', 'HOME'];

/**
 * Windows-only additions. Every one is infrastructure, not configuration:
 *   SystemRoot/windir  — Node needs SystemRoot for crypto and DNS; omitting it breaks node itself
 *   ComSpec            — `spawn(..., {shell:true})` resolves the shell through it
 *   PATHEXT            — without it PATH cannot resolve `git.exe` or `npm.cmd`
 *   TEMP/TMP           — git and npm both write scratch files
 *   USERPROFILE        — the Windows home; also the HOME fallback below
 *   APPDATA/LOCALAPPDATA — where npm's prefix and cache live on Windows. This is the same
 *                        trade the POSIX side already makes by passing HOME (where ~/.npmrc
 *                        lives): a usable toolchain, at the cost of the user's own npm config.
 *   SYSTEMDRIVE, NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE — read by node-gyp and friends
 */
const WINDOWS_KEYS = [
  'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
];

/**
 * Build the clean environment.
 *
 * @param {object} [source]   env to draw pass-through values from (default: process.env)
 * @param {string} [platform] process.platform value (injectable so both branches are testable
 *                            from one machine — the Windows half was broken for years precisely
 *                            because nobody could see it from Linux)
 * @returns {Record<string,string>} a fresh object, safe to hand to child_process
 */
function buildCleanEnv(source = process.env, platform = process.platform) {
  const env = {
    LANG: source.LANG || 'C.UTF-8',
    CI: 'true',
    FORCE_COLOR: '0',
    NODE_ENV: 'test',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const k of BASE_KEYS) env[k] = source[k];

  if (platform === 'win32') {
    for (const k of WINDOWS_KEYS) env[k] = source[k];
    if (env.HOME === undefined) env.HOME = source.USERPROFILE;
  }

  // Drop the misses rather than carry `undefined` values. Node's spawn already skips them, so
  // this changes nothing for the child — it makes the returned object an honest description of
  // what the child will actually see, which is what the tests assert against.
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

module.exports = { buildCleanEnv, BASE_KEYS, WINDOWS_KEYS };
