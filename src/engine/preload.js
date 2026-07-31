/**
 * preload.js — load every optional module BEFORE untrusted PR code runs, then
 * refuse any first-time module load after that point.
 *
 * Why this exists. Felix executes untrusted PR install/build/test scripts at its
 * own UID, in directories it can write. Node resolves a bare `require('x')` by
 * walking `node_modules` UP from the calling file, and on a GitHub runner that
 * walk passes through several directories the untrusted step can create files in:
 * the action's own `node_modules`, `/home/runner/work/node_modules`, and
 * `$HOME/.node_modules` + `$HOME/.node_libraries` (both on `Module.globalPaths`).
 * So any `require()` evaluated AFTER the untrusted step can load attacker-written
 * code INSIDE the Felix process — which holds GITHUB_TOKEN, OPENAI_API_KEY and
 * SUPABASE_SERVICE_ROLE_KEY. The Docker jail does not help: it wraps children,
 * and this is the parent.
 *
 * Two lazy requires had exactly this shape:
 *   drive.js  require('playwright') / require('playwright-core')  — undeclared, opt-in
 *   log.js    require('@supabase/supabase-js')                    — DECLARED, called
 *                                                                   from finalize()
 *
 * Resolving by absolute path does not fix this — an absolute path still points
 * into a directory the same UID can overwrite, and the `@supabase/supabase-js`
 * case shows the problem is not "undeclared dependency" but "first load, late".
 * The invariant that actually holds is stronger and simpler:
 *
 *   FELIX LOADS NO MODULE FOR THE FIRST TIME AFTER UNTRUSTED CODE HAS EXECUTED.
 *
 * `preloadOptional()` warms everything at startup; `armModuleLock()` makes any
 * later first-time load throw. Builtins and already-cached modules stay allowed —
 * a cache hit does no filesystem walk, so there is nothing for a plant to win.
 * `tier1.js` requires `fs` mid-run, which is why the builtin carve-out is load-
 * bearing rather than a convenience.
 *
 * This is defence in depth, not a boundary: it closes in-process execution, not
 * the same-UID `/proc` and ptrace reads that only a job or kernel boundary closes.
 */

const Module = require('module');

let cache = null;
let originalLoad = null;

/**
 * Load the optional/lazy dependencies once, at startup, before any untrusted code
 * has run. Each is independently optional — a missing one must never throw, because
 * a missing dev tool must never flip a verdict.
 *
 * @returns {{playwrightChromium: object|null, supabaseCreateClient: Function|null}}
 */
function preloadOptional() {
  if (cache) return cache;

  let playwrightChromium = null;
  try {
    playwrightChromium = require('playwright').chromium;
  } catch (_) {
    try {
      playwrightChromium = require('playwright-core').chromium;
    } catch (_2) {
      playwrightChromium = null;
    }
  }

  let supabaseCreateClient = null;
  try {
    supabaseCreateClient = require('@supabase/supabase-js').createClient;
  } catch (_) {
    supabaseCreateClient = null;
  }

  cache = { playwrightChromium, supabaseCreateClient };
  return cache;
}

/** Preloaded `playwright.chromium`, or null when Playwright isn't installed. */
function getPlaywrightChromium() {
  return preloadOptional().playwrightChromium;
}

/** Preloaded `@supabase/supabase-js` `createClient`, or null when absent. */
function getSupabaseCreateClient() {
  return preloadOptional().supabaseCreateClient;
}

/** Is the lock currently armed? */
function isArmed() {
  return originalLoad !== null;
}

/**
 * Refuse any first-time module load from here on. Idempotent.
 *
 * Allowed while armed:
 *   - builtins (`fs`, `node:os`, …) — never resolved from disk
 *   - modules already in the require cache — a cache hit does no filesystem walk
 * Everything else throws E_FELIX_LATE_REQUIRE.
 */
function armModuleLock() {
  if (originalLoad) return; // idempotent
  originalLoad = Module._load;

  Module._load = function felixGuardedLoad(request, parent, isMain) {
    // Builtins are never resolved from disk, so no plant can win that lookup.
    // tier1.js requires 'fs' mid-run — this carve-out is load-bearing, not a nicety.
    if (Module.isBuiltin(request)) return originalLoad(request, parent, isMain);

    // A cache hit does no filesystem walk either. Resolving in order to CHECK the
    // cache is safe: resolution reads directory entries, it does not execute the
    // target — only originalLoad would, and we only reach it on a cache hit.
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch (_) {
      resolved = null; // unresolvable ⇒ certainly not already loaded
    }
    if (resolved && Module._cache[resolved]) return originalLoad(request, parent, isMain);

    const err = new Error(
      `E_FELIX_LATE_REQUIRE: refused to load "${request}" after untrusted code ran. `
      + 'Everything Felix needs must be loaded at startup — see src/engine/preload.js.',
    );
    err.code = 'E_FELIX_LATE_REQUIRE';
    throw err;
  };
}

/** Restore normal module resolution. Idempotent. */
function disarmModuleLock() {
  if (!originalLoad) return;
  Module._load = originalLoad;
  originalLoad = null;
}

module.exports = {
  preloadOptional,
  getPlaywrightChromium,
  getSupabaseCreateClient,
  armModuleLock,
  disarmModuleLock,
  isArmed,
};
