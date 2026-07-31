/**
 * crap.js — the CRAP Tier 1 signal (Change Risk Anti-Patterns).
 *
 * After Felix runs a PR's suite under coverage, this flags **changed** functions
 * that are both COMPLEX and UNDER-TESTED — the combination Uncle Bob calls out:
 * a tangled function with no tests is where regressions hide.
 *
 *   CRAP(m) = comp(m)^2 * (1 - cov(m))^3 + comp(m)
 *
 * where comp is cyclomatic complexity and cov is the *fraction* of the function's
 * statements the tests actually executed. Fully covered => CRAP == comp; fully
 * uncovered => comp^2 + comp (explodes). Default threshold 30 (crap4j convention;
 * Uncle Bob drives to <6). SOFT/advisory — it never gates the verdict in v1.
 *
 * WHY THIS IS FELIX'S LANE, NOT CODERABBIT'S: CRAP fuses the two things only a
 * tool that RUNS the code can know — real coverage + complexity. A static diff
 * reader can't produce a coverage number.
 *
 * ── The one rule that keeps this check HONEST ────────────────────────────────
 * An advisory that cries wolf gets ignored. So a *data* problem (missing coverage,
 * a parse failure, a path mismatch, all-zero instrumentation) may only ever
 * REDUCE the number of flags — it must NEVER manufacture one. Every such case
 * emits a labeled `skip` with a reason, never a `cov=0` guess. This is why the
 * fusion math below works in raw statement COUNTS, never in a re-derived
 * percentage: the classic "lying check" bug is a count-vs-boolean or a
 * fraction-vs-percentage unit slip, and both are designed out here rather than
 * guarded against.
 *
 * Design authored against a Fable adversarial spec; the fusion boundary math and
 * the fail-safe table are deliberate, not incidental. Touch with the tests open.
 */

const DEFAULT_CRAP_THRESHOLD = 30;

// ── patch parsing ────────────────────────────────────────────────────────────
/**
 * The set of NEW-file line numbers a unified-diff `patch` adds or modifies
 * (the `+` lines). Deletions don't advance the new-file counter; context lines do.
 */
function parseAddedLines(patch) {
  const added = new Set();
  if (!patch || typeof patch !== 'string') return added;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { newLine = parseInt(h[1], 10); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file" — not a real line
    if (line.startsWith('+')) { added.add(newLine); newLine++; }
    else if (line.startsWith('-')) { /* old-file only — no new-line advance */ }
    else { newLine++; } // context line ' '
  }
  return added;
}

// ── path matching (Windows-safe) ─────────────────────────────────────────────
function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Map a repo-relative POSIX path (from the diff) to its absolute key in the
 * Istanbul coverage map. Istanbul keys are absolute, OS-native (backslashes on
 * win32). Zero matches => skip (the file was never loaded / a path bug) — NEVER
 * treated as cov=0, because that single mistake would zero the whole PR. Two
 * matches (src vs dist) => skip as ambiguous.
 */
function matchCoverageKey(covKeys, relPath) {
  const suffix = '/' + normalizePath(relPath).toLowerCase();
  const hits = covKeys.filter((k) => normalizePath(k).toLowerCase().endsWith(suffix));
  if (hits.length === 1) return { key: hits[0] };
  if (hits.length === 0) return { skip: 'no coverage data for file (never loaded by the suite, or excluded)' };
  return { skip: 'ambiguous coverage mapping (multiple coverage entries match this path)' };
}

// ── statement attribution (innermost-wins) ───────────────────────────────────
/**
 * Assign each Istanbul statement to the INNERMOST escomplex method that contains
 * its start line. escomplex lists nested functions/arrows as their own methods,
 * so without this an uncovered inline callback would drag down the coverage of an
 * otherwise well-tested outer function and flag it falsely.
 *
 * A statement inside two methods of *identical* span (a rare parser tie) is
 * assigned to NEITHER — failing toward silence, never toward a false flag.
 *
 * @returns {Map<number, string[]>} method index → owned statement ids
 */
function attributeStatements(methods, statementMap) {
  const byMethod = new Map();
  methods.forEach((_, idx) => byMethod.set(idx, []));
  for (const [sid, loc] of Object.entries(statementMap || {})) {
    if (!loc || !loc.start) continue;
    const L = loc.start.line;
    const containing = [];
    methods.forEach((m, idx) => {
      if (m.lineStart <= L && L <= m.lineEnd) containing.push(idx);
    });
    if (!containing.length) continue; // top-level statement, belongs to no function
    // Owner = a containing method with NO other containing method nested inside
    // (or equal to) it. In a nested chain that is the innermost; on an exact-span
    // tie, both disqualify each other and the statement is dropped (fail-safe).
    let owner = -1;
    for (const idx of containing) {
      const m = methods[idx];
      const hasInnerSibling = containing.some((j) => {
        if (j === idx) return false;
        const mp = methods[j];
        return mp.lineStart >= m.lineStart && mp.lineEnd <= m.lineEnd;
      });
      if (!hasInnerSibling) { owner = idx; break; }
    }
    if (owner >= 0) byMethod.get(owner).push(sid);
  }
  return byMethod;
}

// ── coverage + fusion ────────────────────────────────────────────────────────
/**
 * Fraction covered = executed statements / total statements, judged by a BOOLEAN
 * per statement (`s[id] > 0`), never by summing hit counts — a hot statement run
 * 5,000 times must not out-vote an uncovered one. Zero-statement functions report
 * covered==total==0 and are treated as fully covered by the fusion (they can't be
 * under-tested).
 */
function functionCoverage(stmtIds, s) {
  const total = stmtIds.length;
  let covered = 0;
  for (const id of stmtIds) if ((s[id] || 0) > 0) covered++;
  return { covered, total };
}

/**
 * The CRAP fusion. Works directly in counts so no percentage/fraction unit ever
 * enters the score: `frac` is `covered/total` on 0–1, and a fully covered
 * function returns EXACTLY `comp` (uncov cubes to 0 with no float dust). A
 * zero-statement function (`total === 0`) is treated as fully covered => `comp`,
 * with no division.
 */
function crapScore(comp, covered, total) {
  const frac = total === 0 ? 1 : covered / total;
  const uncov = 1 - frac;
  return comp * comp * (uncov * uncov * uncov) + comp;
}

function coveragePct(covered, total) {
  if (total === 0) return 100;
  return Math.round((1000 * covered) / total) / 10;
}

/** A function is "changed" iff any added line falls within its span. One is enough. */
function methodIsChanged(method, addedLines) {
  for (let L = method.lineStart; L <= method.lineEnd; L++) {
    if (addedLines.has(L)) return true;
  }
  return false;
}

/** Human-facing function name; synthesize a stable one for anonymous/arrow methods. */
function methodName(m) {
  const n = m && m.name;
  if (!n || n === '<anonymous>' || /^<anon/i.test(n)) return `<anonymous>@L${m.lineStart}`;
  return n;
}

/**
 * Score every CHANGED function in one already-parsed file. Pure: caller supplies
 * escomplex `methods`, Istanbul `statementMap`/`s`, and the added-line set. This
 * is the unit-testable heart of the check — the fusion never touches I/O.
 */
function analyzeFileParsed({ relPath, methods, statementMap, s, addedLines, threshold = DEFAULT_CRAP_THRESHOLD }) {
  const attribution = attributeStatements(methods, statementMap);
  const rows = [];
  methods.forEach((m, idx) => {
    if (!methodIsChanged(m, addedLines)) return;
    const { covered, total } = functionCoverage(attribution.get(idx) || [], s || {});
    const raw = crapScore(m.cyclomatic, covered, total);
    rows.push({
      file: relPath,
      name: methodName(m),
      lineStart: m.lineStart,
      complexity: m.cyclomatic,
      covered,
      total,
      covPct: coveragePct(covered, total),
      score: Math.round(raw * 10) / 10, // display value
      flagged: raw > threshold,          // decision on the RAW value
    });
  });
  return rows;
}

// ── whole-report guards ──────────────────────────────────────────────────────
/**
 * True when every statement in every file has zero hits — the single worst lie
 * this check could tell (c8 wrapped the wrong process => everything reads
 * uncovered => the entire PR flags). Indistinguishable from a suite that ran
 * nothing, so the check must skip, not flag.
 */
function coverageAllZero(coverageMap) {
  for (const f of Object.values(coverageMap || {})) {
    const s = (f && f.s) || {};
    for (const k in s) if (s[k] > 0) return false;
  }
  return true;
}

/** Cheap pre-parse guard: a minified/generated file yields thousands of bogus rows. */
function isLikelyGenerated(source) {
  if (!source) return false;
  for (const line of source.split('\n')) if (line.length > 2000) return true;
  return false;
}

// ── result-row assembly ──────────────────────────────────────────────────────
/**
 * Fold scored rows + skip reasons into one Tier 1 result. status:'fail' means at
 * least one changed function crossed the threshold (SOFT — it never gates the
 * verdict); 'pass' means analyzed and clean; 'skip' means nothing could be
 * evaluated. Labels in the output are WORDS (FLAG/ok), never colour.
 */
function buildCrapRow({ rows, skips = [], threshold = DEFAULT_CRAP_THRESHOLD }) {
  rows.sort((a, b) => b.score - a.score);
  const shown = rows.slice(0, 100);
  const flagged = rows.filter((r) => r.flagged);

  let status;
  let detail;
  if (rows.length === 0) {
    status = 'skip';
    detail = skips.length
      ? `no analyzable changed functions (${skips.length} file(s) skipped)`
      : 'no changed functions to analyze';
  } else if (flagged.length) {
    status = 'fail';
    const worst = flagged.slice(0, 3).map((r) => `${r.name} (CRAP ${r.score}, comp ${r.complexity}, cov ${r.covPct}%)`).join('; ');
    detail = `${flagged.length} changed function(s) over CRAP ${threshold} — ${worst}`;
  } else {
    status = 'pass';
    detail = `${rows.length} changed function(s) analyzed, none over CRAP ${threshold}`;
  }

  const out = [];
  out.push(`CRAP = complexity^2 * (1 - coverage)^3 + complexity  ·  threshold ${threshold}  ·  soft/advisory`);
  for (const r of shown) {
    out.push(`${r.flagged ? 'FLAG' : 'ok  '} ${r.file}:${r.lineStart} ${r.name} — comp ${r.complexity}, cov ${r.covPct}% (${r.covered}/${r.total} stmts), CRAP ${r.score}`);
  }
  if (rows.length > shown.length) out.push(`… +${rows.length - shown.length} more not shown`);
  if (skips.length) {
    out.push('skipped:');
    for (const sreason of skips) out.push(`  - ${sreason}`);
  }

  return { name: 'crap', tier: 1, status, hard: false, detail, output: out.join('\n') };
}

// ── the runner (async, does I/O — runs c8, reads coverage) ────────────────────
/**
 * Run the CRAP check. The CALLER guarantees crap is enabled (the enabled gate
 * lives in runTier1, before any output is registered, so a disabled repo's
 * verdict is byte-identical). This always returns a Tier 1 row — real, or a
 * labeled skip explaining why coverage couldn't be trusted.
 *
 * Runs the suite a SECOND time under c8 (a self-contained instrumented pass) so
 * the existing hard `test` check is never perturbed. Opt-in, so the double run is
 * an accepted v1 cost; a single wrapped run is a later optimization.
 *
 * @param {object}   o
 * @param {string}   o.cwd            sandbox checkout (where tests run)
 * @param {object}   o.env            clean env for the child
 * @param {string}   o.testCmd        the repo's test command (config.commands.test)
 * @param {Array}    o.files          behavioral changed files (each may carry .patch)
 * @param {number}   o.threshold      CRAP flag threshold
 * @param {string}   o.isolationMode  'docker' => unsupported in v1 (skip)
 * @param {Function} o.run            exec(cmd,{cwd,env,timeoutMs}) → {code,timedOut,...}
 * @param {number}   o.timeoutMs      coverage-run time cap
 * @param {object}   [o.deps]         test seam: { escomplex, c8Bin, fs }
 */
async function runCrapCheck({ cwd, env, testCmd, files, threshold = DEFAULT_CRAP_THRESHOLD, isolationMode, run, timeoutMs = 600000, deps = {} }) {
  const path = require('path');
  const fs = deps.fs || require('fs');
  const os = require('os');
  const skip = (detail, output = '') => ({ name: 'crap', tier: 1, status: 'skip', hard: false, detail, output });

  if (isolationMode === 'docker') {
    return skip('crap: not supported under docker isolation in v1 (coverage runs on the host toolchain)');
  }
  if (!testCmd || !testCmd.trim()) {
    return skip('crap: no test command configured — nothing to instrument');
  }

  const changed = (files || []).filter((f) => f.status !== 'removed');
  const jsFiles = changed.filter((f) => /\.(js|mjs|cjs)$/i.test(f.filename));
  const nonJs = changed.filter((f) => /\.(ts|tsx|jsx)$/i.test(f.filename)).length;
  if (!jsFiles.length) {
    const tail = nonJs ? ` (${nonJs} non-JS file(s) not analyzed — v1 is JS-only)` : '';
    return skip(`crap: no changed .js files to analyze${tail}`);
  }

  // Resolve the tooling from Felix's OWN install so it works against any target
  // repo without network (Tier 1 runs net-deny) and without the target depending
  // on c8/escomplex itself.
  let escomplex = deps.escomplex;
  let c8Bin = deps.c8Bin;
  try {
    if (!escomplex) escomplex = require('typhonjs-escomplex');
    if (!c8Bin) {
      const c8PkgPath = require.resolve('c8/package.json');
      const bin = require(c8PkgPath).bin;
      // npm allows `bin` to be a string (command == package name) or a map.
      const binRel = typeof bin === 'string' ? bin : bin.c8;
      c8Bin = path.join(path.dirname(c8PkgPath), binRel);
    }
  } catch (e) {
    return skip(`crap: coverage tooling unavailable (${String(e.message).split('\n')[0]})`);
  }

  // ── coverage pass ──
  let covDir;
  try { covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-crap-')); }
  catch (e) { return skip(`crap: could not create coverage workdir (${e.message})`); }
  const cleanup = () => { try { fs.rmSync(covDir, { recursive: true, force: true }); } catch { /* best-effort */ } };

  // The repo's OWN test command, wrapped once by c8. `testCmd` is the same value
  // Felix already runs through a shell in the normal Tier 1 `test` check, inside
  // the timed, network-denied sandbox — this adds no trust surface, it instruments
  // the identical command. Assembled by join (no interpolation) for clarity.
  const covCmd = [
    'node', '"' + c8Bin + '"',
    '--reporter=json', '--report-dir="' + covDir + '"', '--all=false',
    '--', testCmd,
  ].join(' ');

  const r = await run(covCmd, { cwd, env, timeoutMs });
  if (r.timedOut) { cleanup(); return skip('crap: coverage run timed out — coverage untrustworthy'); }
  if (r.code !== 0) { cleanup(); return skip(`crap: suite failed under coverage instrumentation (exit ${r.code}) — coverage untrustworthy`); }

  let coverageMap;
  try {
    coverageMap = JSON.parse(fs.readFileSync(path.join(covDir, 'coverage-final.json'), 'utf8'));
  } catch (e) {
    cleanup();
    return skip('crap: no coverage-final.json produced — the test command may not run under Node/c8');
  }
  cleanup();

  const covKeys = Object.keys(coverageMap || {});
  if (!covKeys.length) return skip('crap: coverage report empty — instrumentation suspect');
  if (coverageAllZero(coverageMap)) return skip('crap: coverage is all-zero across every file — instrumentation suspect, not scoring');

  // ── per-file scoring ──
  const rows = [];
  const skips = [];
  for (const f of jsFiles) {
    const rel = f.filename;
    if (!f.patch) { skips.push(`${rel}: no patch available (large/binary/renamed diff)`); continue; }
    const match = matchCoverageKey(covKeys, rel);
    if (match.skip) { skips.push(`${rel}: ${match.skip}`); continue; }
    let source;
    try { source = fs.readFileSync(path.join(cwd, rel), 'utf8'); }
    catch { skips.push(`${rel}: source unreadable in checkout`); continue; }
    if (isLikelyGenerated(source)) { skips.push(`${rel}: generated/minified — not analyzed`); continue; }
    let report;
    try { report = escomplex.analyzeModule(source); }
    catch { skips.push(`${rel}: complexity parse failed (unsupported syntax)`); continue; }
    const methods = (report && report.methods) || [];
    if (methods.length > 500) { skips.push(`${rel}: ${methods.length} functions — generated/minified, not analyzed`); continue; }
    const fileCov = coverageMap[match.key] || {};
    const addedLines = parseAddedLines(f.patch);
    rows.push(...analyzeFileParsed({
      relPath: rel,
      methods,
      statementMap: fileCov.statementMap || {},
      s: fileCov.s || {},
      addedLines,
      threshold,
    }));
  }

  return buildCrapRow({ rows, skips, threshold });
}

module.exports = {
  DEFAULT_CRAP_THRESHOLD,
  // pure core (unit-tested directly)
  parseAddedLines,
  normalizePath,
  matchCoverageKey,
  attributeStatements,
  functionCoverage,
  crapScore,
  coveragePct,
  methodIsChanged,
  methodName,
  analyzeFileParsed,
  coverageAllZero,
  isLikelyGenerated,
  buildCrapRow,
  // runner (integration-tested live)
  runCrapCheck,
};
