/**
 * triage.js — is this change behavioral at all?
 *
 * Extracted out of index.js so the CI pipeline and the local pre-flight run share ONE
 * implementation. A second copy would be worse than duplication: pre-flight exists to predict
 * what CI will decide, and a triage that drifts by a single glob makes it predict wrong in
 * precisely the direction that hurts — a local SKIP for a change CI grades, or the reverse.
 */

const picomatch = require('picomatch');

/**
 * Felix's own control surface — never triaged away, whatever skipGlobs says.
 *
 * The default skipGlobs include a catch-all for JSON files and one for `.github`, which between
 * them match felix.config.json, package.json and the workflow that runs Felix. A PR touching only
 * those was therefore SKIPPED — never
 * verified — and merged. That is a two-step bypass of the base-ref policy split, because step one
 * poisons the ref step two trusts: PR 1 sets package.json's `scripts.test` to `exit 0` in a
 * chore-looking diff, and from then on every PR's Tier 1 test check passes trivially from BASE
 * content. Reproduced by execution — the default globs really do skip a config-only PR.
 *
 * Not configurable, deliberately: a list the config can suppress is not a floor. The cost is that
 * dependency-bump PRs now get fully verified instead of skipped, which is the right answer anyway
 * — a lockfile bump is behavioural.
 */
const NEVER_SKIP = [
  'felix.config.json',
  '.github/workflows/**',
  '**/package.json',
];

/** Triage: are all changed files non-behavioral (skipGlobs)? */
function triageFiles(files, skipGlobs) {
  const matchers = (skipGlobs || []).map((g) => picomatch(g));
  const never = NEVER_SKIP.map((g) => picomatch(g));
  const isSkip = (p) => !never.some((m) => m(p)) && matchers.some((m) => m(p));
  const behavioral = files.filter((f) => !isSkip(f.filename));
  return {
    skipped: files.length > 0 && behavioral.length === 0,
    reason: `${files.length} changed, ${behavioral.length} behavioral`,
    behavioral,
  };
}

module.exports = { triageFiles, NEVER_SKIP };
