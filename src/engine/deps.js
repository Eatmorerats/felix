/**
 * deps.js — the dependency-direction Tier 1 signal (opt-in, soft/advisory).
 *
 * After Felix checks out a PR, this compares the module graph of the HEAD commit
 * against the graph of the PR's BASE commit and flags **new** structural problems
 * the PR introduces: a new circular import (a→b→a), or a new edge that crosses a
 * forbidden layer boundary the repo declared (e.g. "engine must not reach bin/").
 * Both graphs are built by the SAME dependency-cruiser, same version, same temp
 * ruleset, same flags — so any fidelity gap (dynamic import(), alias configs,
 * un-parsed TS) degrades BOTH sides identically and cancels in the base-vs-head
 * diff. That symmetry is the whole design.
 *
 * WHY THIS IS FELIX'S LANE, NOT CODERABBIT'S: a static diff reader sees the lines
 * that changed; it does not build the whole-repo import graph and cannot know that
 * a one-line `require` closed a cycle three files away. Cruising the actual graph
 * on both commits is the only way to attribute a *new* cycle to *this* PR.
 *
 * ── FAIL-SAFE INVARIANT: a data problem (missing base, parse failure, timeout, ──
 * unresolvable modules, an undetected rename) may only ever REDUCE the set of
 * flags — it must never manufacture one. When in doubt: SKIP with a labeled
 * reason, or PASS. A phantom "new violation" on pre-existing structure is the
 * expensive failure: it trains people to ignore Felix. So the identity keys below
 * are built as sorted SETS (invariant to which node dc reports a cycle from), the
 * base side is NEVER treated as an empty key set on failure (that would flag every
 * pre-existing cycle as new), and every candidate must ALSO touch a changed file
 * (the attribution gate) before it can be flagged.
 *
 * ALL-SOFT v1: `hard:false` on every path. verdict.compose only flips NOT VERIFIED
 * on `hard && fail`, so this check can never gate a verdict — the design trades
 * false-PASS for never-false-FLAG (set-key collisions, attribution suppression),
 * which is correct for an advisory and indefensible for a gate. Graph fidelity is
 * incomplete and the threshold is uncalibrated; promotion to a gate is a later
 * opt-in after N clean PRs.
 *
 * Design authored against a Fable adversarial spec + a live dependency-cruiser
 * 18.1.0 probe (cycle membership is always the FULL member list). Touch with the
 * tests open (test/run.js "deps —" block, test/deps-live.js).
 */

const DEFAULT_DEPS_TIMEOUT_MS = 120000;

// ── path + violation normalization ───────────────────────────────────────────
/**
 * Repo-relative POSIX form. dependency-cruiser emits forward slashes already, but
 * a rename map / changed-file set is built from GitHub paths, so normalize both
 * ends the same way. Do NOT lowercase — CI filesystems are case-sensitive and a
 * `Foo.js` vs `foo.js` collision is a real bug we must not paper over.
 */
function norm(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True for anything living under a node_modules segment (asymmetry scrub target). */
function underNodeModules(p) {
  return /(^|\/)node_modules\//.test(norm(p));
}

/**
 * The normalized member list of a cycle violation: the entry node plus every node
 * in `cycle[]`. Probe-confirmed on dc 18.1.0 that `cycle[]` is ALWAYS the full,
 * rotated member list from any reporting node — so this union is the same set no
 * matter which edge dc happened to report the cycle from.
 */
function nodeSet(v) {
  const members = [norm(v.from)];
  for (const c of v.cycle || []) members.push(norm(c && c.name != null ? c.name : c));
  return members;
}

/**
 * Stable identity key for a violation, so "same violation on base and head" keys
 * IDENTICALLY and drops out of the set-diff.
 *
 *  - cycle:  a sorted SET of its members (union of `from` + cycle names). Invariant
 *            to entry node and to whether `from` is repeated in `cycle[]`. The one
 *            collision mode — two DISTINCT cycles over the identical node set — makes
 *            the key merge and a new one hide (a false PASS), the acceptable
 *            fail-safe direction. `rule.name` is excluded (we inject one cycle rule).
 *  - edge:   rule name + from→to. `rule.name` IS included, because one edge can
 *            violate two different author layer rules and each is its own finding.
 *
 * `mapFn` rewrites BASE names into HEAD names for rename safety (see mapBaseFn).
 */
function keyOf(v, mapFn) {
  const map = mapFn || ((x) => x);
  if (v.type === 'cycle') {
    const members = Array.from(new Set(nodeSet(v).map(map))).sort();
    return 'cycle:' + members.join('|');
  }
  // type 'dependency' — a forbidden layering edge.
  const rule = (v.rule && v.rule.name) || '?';
  return 'dep:' + rule + ':' + map(norm(v.from)) + '→' + map(norm(v.to));
}

/** Human-readable traversal of a cycle: `a.js → b.js → c.js → a.js`. */
function cyclePath(v) {
  return [norm(v.from), ...(v.cycle || []).map((c) => norm(c && c.name != null ? c.name : c))].join(' → ');
}

// ── violation extraction (identical on both sides) ───────────────────────────
/**
 * The set of module paths dependency-cruiser could NOT resolve — collected from any
 * edge marked `couldNotResolve`. A violation touching one of these is an artifact of
 * incomplete resolution, not real structure, so we scrub it. This only ever REMOVES
 * flags, and it runs identically on both graphs, so it stays symmetric.
 */
function unresolvableSet(json) {
  const set = new Set();
  for (const m of (json && json.modules) || []) {
    for (const d of m.dependencies || []) {
      if (d && d.couldNotResolve) {
        if (d.resolved) set.add(norm(d.resolved));
        if (d.module) set.add(norm(d.module));
      }
    }
  }
  return set;
}

/**
 * Pull the cycle + forbidden-edge violations out of one cruise result, dropping any
 * that touch node_modules or an unresolvable module (asymmetry scrub). Pure: caller
 * supplies the parsed dc JSON. The scrub can only shrink the set — never invent one.
 */
function extract(json) {
  const unresolvable = unresolvableSet(json);
  const violations = (json && json.summary && json.summary.violations) || [];
  const out = [];
  for (const v of violations) {
    if (v.type !== 'cycle' && v.type !== 'dependency') continue;
    const from = norm(v.from);
    const to = v.to ? norm(v.to) : '';
    if (underNodeModules(from) || (to && underNodeModules(to))) continue;
    if (unresolvable.has(from) || (to && unresolvable.has(to))) continue;
    out.push(v);
  }
  return out;
}

// ── rename safety + changed-file attribution ─────────────────────────────────
/**
 * base-path → head-path for every file GitHub reports as `renamed`. Applied to BASE
 * violation keys so a pure rename produces identical key sets on both sides ⇒ PASS.
 * Built from the FULL file list (filesAll), never the behavioral subset, because a
 * rename can move a file that triage would otherwise skip.
 */
function buildRenameMap(filesAll) {
  const m = new Map();
  for (const f of filesAll || []) {
    if (f && f.status === 'renamed' && f.previous_filename) {
      m.set(norm(f.previous_filename), norm(f.filename));
    }
  }
  return m;
}

/** A mapFn for keyOf: rewrite a base path to its head path if it was renamed. */
function mapBaseFn(renameMap) {
  const rm = renameMap || new Map();
  return (p) => (rm.has(p) ? rm.get(p) : p);
}

/**
 * Every path this PR touched, in head-name space: changed filenames plus any
 * previous filenames. A violation must intersect this to be flagged (the
 * attribution gate) — a new-in-the-diff violation that touches NO changed file is
 * a resolution artifact, counted for debug and never flagged.
 */
function buildChangedSet(filesAll) {
  const s = new Set();
  for (const f of filesAll || []) {
    if (f && f.filename) s.add(norm(f.filename));
    if (f && f.previous_filename) s.add(norm(f.previous_filename));
  }
  return s;
}

/**
 * The hybrid delta: a violation is a candidate iff it is (a) ABSENT from the base
 * key set AND (b) touches at least one changed file. This is the unit-testable heart
 * of the check — no I/O.
 *
 * CRITICAL fail-safe: `baseViolations` is the extracted base set. If the base cruise
 * FAILED, the caller must SKIP rather than pass an empty array here — an empty base
 * set would make every pre-existing cycle read as "new". This function trusts that
 * its baseViolations argument is real.
 */
function diffViolations({ headViolations, baseViolations, renameMap, changedSet }) {
  const mapBase = mapBaseFn(renameMap);
  const baseKeys = new Set((baseViolations || []).map((v) => keyOf(v, mapBase)));
  const changed = changedSet || new Set();

  const candidates = [];
  const suppressed = [];
  const seen = new Set();
  let preExisting = 0;

  for (const v of headViolations || []) {
    const k = keyOf(v);
    if (seen.has(k)) continue; // dc emits ~1 violation per cycle, but a node in two
    seen.add(k);               // cycles could still repeat a key — dedupe defensively.
    if (baseKeys.has(k)) { preExisting++; continue; } // present on base → not this PR
    const members = v.type === 'cycle' ? nodeSet(v) : [norm(v.from), norm(v.to)];
    if (!members.some((m) => changed.has(m))) { suppressed.push(k); continue; } // artifact
    candidates.push({ key: k, v });
  }
  candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { candidates, suppressed, preExisting };
}

// ── coupling delta (report-only, never gates) ────────────────────────────────
/**
 * For each changed module, how its fan-in (dependents) and fan-out (dependencies)
 * moved base→head. REPORT-ONLY text in `output`, never in `status` — a thresholded
 * coupling gate is deferred to v1.1, so this can never cry wolf. Emits ≤3 lines,
 * only where |Δfan-in| ≥ 2, sorted by |Δfan-in| desc. A module new in head has base
 * fan-in/out 0 and is tagged `new file`. Base modules are matched through the rename
 * map (into head-name space) so a renamed-but-unchanged module reads Δ0.
 */
function couplingDelta({ headModules, baseModules, changedSet, renameMap }) {
  const mapBase = mapBaseFn(renameMap);
  const changed = changedSet || new Set();
  const baseBySource = new Map();
  for (const m of baseModules || []) {
    baseBySource.set(mapBase(norm(m.source)), {
      fanIn: (m.dependents || []).length,
      fanOut: (m.dependencies || []).length,
    });
  }
  const rows = [];
  for (const m of headModules || []) {
    const src = norm(m.source);
    if (!changed.has(src)) continue;
    const fanIn = (m.dependents || []).length;
    const fanOut = (m.dependencies || []).length;
    const base = baseBySource.get(src);
    const bIn = base ? base.fanIn : 0;
    const bOut = base ? base.fanOut : 0;
    const dIn = fanIn - bIn;
    if (Math.abs(dIn) < 2) continue;
    rows.push({ src, bIn, fanIn, bOut, fanOut, dIn, isNew: !base });
  }
  rows.sort((a, b) => Math.abs(b.dIn) - Math.abs(a.dIn));
  return rows.slice(0, 3).map((r) => {
    const sign = r.dIn >= 0 ? `+${r.dIn}` : `${r.dIn}`;
    const tag = r.isNew ? ' (new file)' : '';
    return `coupling (advisory): ${r.src} fan-in ${r.bIn} → ${r.fanIn} (${sign}), fan-out ${r.bOut} → ${r.fanOut}${tag}`;
  });
}

// ── result-row assembly ──────────────────────────────────────────────────────
/**
 * Fold the diff into one Tier 1 row. status:'fail' means the PR introduced at least
 * one new, attributable cycle/edge (SOFT — never gates); 'pass' means analyzed and
 * clean. The word "advisory" ALWAYS appears in the detail so nobody mistakes a soft
 * signal for a gate. A 2-node cycle names both files in the detail (criterion 1);
 * longer cycles render the full traversal in `output`. Labels are WORDS (FLAG / ok /
 * note), never colour.
 */
function buildDepsRow({ candidates, suppressed = [], preExisting = 0, couplingLines = [] }) {
  const cands = candidates || [];
  const cycles = cands.filter((c) => c.v.type === 'cycle');
  const edges = cands.filter((c) => c.v.type !== 'cycle');
  const status = cands.length ? 'fail' : 'pass';

  let detail;
  if (!cands.length) {
    detail = preExisting
      ? `no new cycles or forbidden edges (advisory) — ${preExisting} pre-existing ignored`
      : 'no new cycles or forbidden edges (advisory)';
  } else {
    const parts = [];
    if (cycles.length) {
      const first = cycles[0].v;
      const members = Array.from(new Set(nodeSet(first))).sort();
      const named = members.length === 2 ? `${members[0]} ↔ ${members[1]}` : cyclePath(first);
      parts.push(`${cycles.length} new circular ${cycles.length === 1 ? 'dependency' : 'dependencies'} (advisory) — ${named}`);
    }
    if (edges.length) {
      const first = edges[0].v;
      parts.push(`${edges.length} new forbidden ${edges.length === 1 ? 'edge' : 'edges'} (advisory) — ${(first.rule && first.rule.name) || '?'}: ${norm(first.from)} → ${norm(first.to)}`);
    }
    detail = parts.join('; ');
  }

  const out = [];
  out.push('dependency direction — new cycles + forbidden edges vs base, changed-file attributed  ·  soft/advisory');
  for (const c of cands) {
    if (c.v.type === 'cycle') {
      const members = Array.from(new Set(nodeSet(c.v))).sort();
      out.push(`FLAG cycle — ${cyclePath(c.v)}  [members: ${members.join(', ')}]`);
    } else {
      out.push(`FLAG edge  — ${(c.v.rule && c.v.rule.name) || '?'}: ${norm(c.v.from)} → ${norm(c.v.to)}`);
    }
  }
  if (!cands.length) out.push('ok   no new dependency-direction violations attributable to this PR');
  if (preExisting) out.push(`note: ${preExisting} pre-existing violation(s) ignored (present on base)`);
  if (suppressed.length) out.push(`note: ${suppressed.length} candidate(s) suppressed — not attributable to changed files`);
  for (const line of couplingLines) out.push(line);

  return { name: 'deps', tier: 1, status, hard: false, detail, output: out.join('\n') };
}

// ── config → dependency-cruiser ruleset ──────────────────────────────────────
/**
 * Compile the felix.config `deps` block into a dependency-cruiser forbidden-rule set.
 * The `no-circular` rule is ALWAYS injected (zero-config cycle detection); each
 * declared layer becomes a forbidden edge whose from/to picomatch globs are compiled
 * to RegExp sources. Returns `{ error }` on the first invalid layer so runTier1 can
 * emit a labeled SKIP — a config typo must neither crash Tier 1 nor silently drop a
 * rule (that would be a lie by omission).
 */
function buildForbiddenRules(depsCfg, picomatch) {
  const rules = [{ name: 'no-circular', severity: 'error', from: {}, to: { circular: true } }];
  const layers = (depsCfg && depsCfg.layers) || [];
  const seen = new Set();
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (!l || typeof l.name !== 'string' || !l.name.trim()) {
      return { error: `invalid deps.layers[${i}] (missing name)` };
    }
    if (seen.has(l.name)) return { error: `invalid deps.layers[${i}] (duplicate name "${l.name}")` };
    seen.add(l.name);
    if (!l.from || !l.to) return { error: `invalid deps.layers[${i}] (from and to are required)` };
    let fromRe;
    let toRe;
    try { fromRe = picomatch.makeRe(l.from, { dot: true }); } catch { fromRe = null; }
    try { toRe = picomatch.makeRe(l.to, { dot: true }); } catch { toRe = null; }
    if (!fromRe || !toRe) return { error: `invalid deps.layers[${i}] (glob did not compile)` };
    rules.push({
      name: l.name, severity: 'error', comment: l.comment || '',
      from: { path: fromRe.source }, to: { path: toRe.source },
    });
  }
  return { rules };
}

/**
 * Render the ONE temp dependency-cruiser config used for BOTH cruises. Passing an
 * explicit `--config` means the target repo's OWN .dependency-cruiser.js never
 * loads — a base-vs-head difference in the repo's config would break the symmetry
 * the whole diff relies on. node_modules is always excluded AND not-followed.
 */
function renderDcConfig(depsCfg, forbiddenRules) {
  // node_modules and Felix's OWN worktree dir are always excluded — the base checkout lives
  // under .felix-worktrees/ inside the repo, so cruising it would double-count every module.
  const excludes = Array.from(new Set([
    ...(((depsCfg && depsCfg.exclude) || [])), '(^|/)node_modules/', '(^|/)\\.felix-worktrees/',
  ]));
  const excludePath = excludes.map((e) => `(?:${e})`).join('|');
  const options = {
    exclude: { path: excludePath },
    doNotFollow: { path: '(^|/)node_modules/' },
  };
  if (depsCfg && depsCfg.includeOnly) options.includeOnly = { path: depsCfg.includeOnly };
  return 'module.exports = ' + JSON.stringify({ forbidden: forbiddenRules, options }, null, 2) + ';\n';
}

// ── dependency-cruiser bin resolution ────────────────────────────────────────
/**
 * Locate dependency-cruiser's CLI from Felix's OWN install (so it works against any
 * target repo, offline, without the target depending on dependency-cruiser).
 *
 * NOTE: `require.resolve('dependency-cruiser/package.json')` THROWS
 * ERR_PACKAGE_PATH_NOT_EXPORTED on 18.1.0 (its `exports` map gates subpaths). We walk
 * `require.resolve.paths` and look for the package dir directly — proven against
 * 18.1.0. Returns null ⇒ the runner emits a labeled SKIP, never a crash.
 */
function resolveDcBin() {
  const path = require('path');
  const fs = require('fs');
  const bases = require.resolve.paths('dependency-cruiser') || [];
  for (const base of bases) {
    const root = path.join(base, 'dependency-cruiser');
    if (fs.existsSync(path.join(root, 'package.json'))) {
      return path.join(root, 'bin', 'dependency-cruise.mjs');
    }
  }
  return null;
}

// ── the runner (async, does I/O — cruises head + a base worktree) ─────────────
/**
 * Run the deps check. The CALLER guarantees deps is enabled (the enabled gate lives
 * in runTier1, before any output is registered, so a disabled repo's verdict is
 * byte-identical — no worktree, no require, no row). This always returns a Tier 1
 * row: a real pass/fail, or a labeled SKIP explaining why the graph couldn't be
 * trusted (missing base, dc failure, timeout). hard:false on every path.
 *
 * @param {object}   o
 * @param {string}   o.cwd        head checkout (the sandbox workdir) to cruise
 * @param {string}   o.repoPath   git clone that owns the object store (for worktree add)
 * @param {string}   o.baseSha    PR base commit — cruised in a throwaway worktree
 * @param {string}   [o.headSha]  PR head commit; only used to short-circuit base===head
 * @param {Array}    o.filesAll   FULL changed-file list (rename map + attribution)
 * @param {object}   o.config     merged Felix config (config.deps holds the block)
 * @param {Function} o.run        the shell-command runner from util/exec (cmd,{cwd,timeoutMs})
 * @param {number}   [o.timeoutMs] per-cruise cap
 * @param {object}   [o.deps]     test seam: { dcBin, run, fs }
 */
async function runDepsCheck({ cwd, repoPath, baseSha, headSha, filesAll, config, run, timeoutMs, deps = {} }) {
  const path = require('path');
  const os = require('os');
  const fs = deps.fs || require('fs');
  const picomatch = require('picomatch');
  const { logger } = require('./util/logger');
  const runFn = deps.run || run;
  const depsCfg = (config && config.deps) || {};
  const cap = timeoutMs || depsCfg.timeoutMs || DEFAULT_DEPS_TIMEOUT_MS;
  const skip = (detail) => ({ name: 'deps', tier: 1, status: 'skip', hard: false, detail, output: '' });

  // v1 is JS/TS only — the graph builder is dependency-cruiser.
  if (config && config.language && config.language !== 'node') {
    return skip('skipped: deps check supports Node/JS only (v1)');
  }

  // Compile the ruleset; a bad layer is a labeled skip, not a crash or a dropped rule.
  const built = buildForbiddenRules(depsCfg, picomatch);
  if (built.error) return skip(`skipped: ${built.error}`);

  const dcBin = deps.dcBin || resolveDcBin();
  if (!dcBin) return skip('skipped: dependency-cruiser not resolvable');

  if (!baseSha) return skip('skipped: no base commit provided — cannot attribute violations to this PR');

  // base === head ⇒ trivially empty diff, no need to cruise twice.
  if (headSha && baseSha === headSha) {
    return buildDepsRow({ candidates: [], suppressed: [], preExisting: 0, couplingLines: [] });
  }

  // ONE temp config, used for BOTH cruises (symmetry).
  let scratch;
  try { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-deps-')); }
  catch (e) { return skip(`skipped: could not create deps workdir (${e.message})`); }
  const cleanupScratch = () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ } };
  const cfgPath = path.join(scratch, 'dc.cjs');
  try { fs.writeFileSync(cfgPath, renderDcConfig(depsCfg, built.rules)); }
  catch (e) { cleanupScratch(); return skip(`skipped: could not write deps config (${e.message})`); }

  // Base worktree (same mechanics as sandbox.js), torn down in the finally.
  const worktreeBase = path.join(repoPath, '.felix-worktrees', `deps-base-${String(baseSha).slice(0, 8)}`);
  let worktreeAdded = false;

  const cruise = async (dir) => {
    const cmd = `node "${dcBin}" . --config "${cfgPath}" --output-type json --exclude "(^|/)node_modules/"`;
    const r = await runFn(cmd, { cwd: dir, timeoutMs: cap });
    if (r.timedOut) return { timedOut: true };
    // dc exits non-zero when error-severity violations exist; the JSON is still on stdout.
    try { return { json: JSON.parse(r.stdout) }; }
    catch (e) {
      const firstErr = String(r.stderr || r.combined || e.message || '').split('\n')[0] || 'no JSON on stdout';
      return { error: firstErr };
    }
  };

  try {
    await runFn(`git worktree remove --force "${worktreeBase}" || true`, { cwd: repoPath, timeoutMs: 60000 });
    const add = await runFn(`git worktree add --detach --force "${worktreeBase}" ${baseSha}`, { cwd: repoPath, timeoutMs: cap });
    if (!add || add.code !== 0) {
      return skip(`skipped: base commit ${String(baseSha).slice(0, 8)} unavailable — cannot attribute violations to this PR`);
    }
    worktreeAdded = true;

    // HEAD first: if the PR's own graph won't build, there's nothing to compare.
    const headRes = await cruise(cwd);
    if (headRes.timedOut) return skip(`skipped: dependency-cruiser timed out after ${cap}ms`);
    if (headRes.error) return skip(`skipped: dependency-cruiser failed on head — ${headRes.error}`);
    if (!headRes.json.modules || headRes.json.modules.length === 0) {
      return skip('skipped: no modules found on head (check deps.includeOnly)');
    }

    // BASE: on failure SKIP — NEVER treat the base key set as empty (that would flag
    // every pre-existing cycle as new — the exact cry-wolf this check exists to avoid).
    const baseRes = await cruise(worktreeBase);
    if (baseRes.timedOut) return skip(`skipped: dependency-cruiser timed out after ${cap}ms`);
    if (baseRes.error) return skip(`skipped: dependency-cruiser failed on base — ${baseRes.error}`);

    const renameMap = buildRenameMap(filesAll);
    const changedSet = buildChangedSet(filesAll);
    const headViolations = extract(headRes.json);
    const baseViolations = extract(baseRes.json);
    const { candidates, suppressed, preExisting } = diffViolations({ headViolations, baseViolations, renameMap, changedSet });
    const couplingLines = couplingDelta({
      headModules: headRes.json.modules, baseModules: baseRes.json.modules, changedSet, renameMap,
    });
    return buildDepsRow({ candidates, suppressed, preExisting, couplingLines });
  } finally {
    if (worktreeAdded) {
      try { await runFn(`git worktree remove --force "${worktreeBase}"`, { cwd: repoPath, timeoutMs: 60000 }); }
      catch (e) { logger.warn(`deps worktree teardown: ${e.message}`); }
    }
    cleanupScratch();
  }
}

module.exports = {
  DEFAULT_DEPS_TIMEOUT_MS,
  // pure core (unit-tested directly)
  norm,
  nodeSet,
  keyOf,
  cyclePath,
  extract,
  buildRenameMap,
  mapBaseFn,
  buildChangedSet,
  diffViolations,
  couplingDelta,
  buildForbiddenRules,
  renderDcConfig,
  resolveDcBin,
  buildDepsRow,
  // runner (integration-tested live)
  runDepsCheck,
};
