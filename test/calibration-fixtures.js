/**
 * calibration-fixtures.js — a labelled corpus of "known-good" and "known-BAD"
 * PRs, so Felix's catch-power can finally be MEASURED (R0 in the v1.1 roadmap).
 *
 * The problem this solves: every real verdict Felix has ever produced has been
 * ✅ VERIFIED, so we have zero evidence it can say "no" to a genuinely bad PR.
 * These fixtures are the ground truth. Each one feeds a real spec + diff + Tier 1
 * result to the SAME judge + verdict path production uses, and we check whether
 * the verdict matches the KNOWN truth:
 *
 *   label 'good' → the diff really satisfies the criteria → expect VERIFIED
 *   label 'bad'  → a criterion is genuinely UNMET in the diff → expect NOT VERIFIED
 *
 * The "bad" cases are the point: each is a defect that the PR's own tests do NOT
 * catch (they pass), so only a judge reading the diff against the human spec can
 * flag it — exactly the class Felix exists to cover. If the judge marks one
 * VERIFIED, that's an ESCAPED DEFECT (a false pass), the costly failure mode.
 *
 * The corpus is intentionally small and hand-audited. `test/calibrate.js` runs
 * it against the live judge (needs OPENAI_API_KEY) and prints a confusion matrix
 * via the existing calibration module. `test/run.js` validates the corpus shape
 * and the verdict wiring offline, using `oracleJudge` (a perfect judge) so the
 * harness itself is proven without any network.
 */

// A clean Tier 1 result set: install + test + secrets all pass, so the verdict
// hinges entirely on the judge (which is what these fixtures probe). Every bad
// fixture ships a PASSING test on purpose — the defect hides behind green tests.
const PASSING_TIER1 = [
  { name: 'install', tier: 1, status: 'pass', hard: true, detail: 'exit 0', output: '' },
  { name: 'test', tier: 1, status: 'pass', hard: true, detail: 'exit 0 (all tests green)', output: '' },
  { name: 'secrets scan', tier: 1, status: 'pass', hard: true, detail: 'no secrets in changed files', output: '' },
];

const FIXTURES = [
  // ── GOOD: the diff genuinely satisfies the spec → VERIFIED ────────────────
  {
    id: 'good-add',
    label: 'good',
    prTitle: 'feat: add(a, b) helper',
    criteria: ['add(a, b) returns the sum of its two arguments'],
    diff: [
      'diff --git a/src/add.js b/src/add.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/add.js',
      '@@ -0,0 +1,3 @@',
      '+function add(a, b) {',
      '+  return a + b;',
      '+}',
      '+module.exports = { add };',
    ].join('\n'),
    tier1: PASSING_TIER1,
    expected: 'VERIFIED',
  },
  {
    id: 'good-email',
    label: 'good',
    prTitle: 'feat: email validation',
    criteria: [
      'validateEmail returns false for a string with no @ sign',
      'validateEmail returns true for a well-formed address like a@b.com',
    ],
    diff: [
      'diff --git a/src/email.js b/src/email.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/email.js',
      '@@ -0,0 +1,4 @@',
      '+function validateEmail(s) {',
      "+  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(String(s));",
      '+}',
      '+module.exports = { validateEmail };',
    ].join('\n'),
    tier1: PASSING_TIER1,
    expected: 'VERIFIED',
  },

  // ── BAD: a criterion is genuinely UNMET; tests still pass → NOT VERIFIED ───
  {
    id: 'bad-plaintext-password',
    label: 'bad',
    // Defect: the criterion demands hashing; the code stores the password in
    // plaintext. The test only asserts a user row was created, so it passes.
    prTitle: 'feat: user registration',
    criteria: ['The password is hashed with bcrypt before it is stored (never persisted in plaintext)'],
    diff: [
      'diff --git a/src/register.js b/src/register.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/register.js',
      '@@ -0,0 +1,6 @@',
      '+async function register(db, email, password) {',
      '+  // store the new user',
      '+  const user = { email, password };',
      '+  await db.users.insert(user);',
      '+  return user;',
      '+}',
      '+module.exports = { register };',
    ].join('\n'),
    tier1: PASSING_TIER1,
    expected: 'NOT VERIFIED',
  },
  {
    id: 'bad-wrong-status-code',
    label: 'bad',
    // Defect: criterion asks for 201; handler returns 200.
    prTitle: 'feat: create item endpoint',
    criteria: ['POST /items responds with HTTP status 201 on successful creation'],
    diff: [
      'diff --git a/src/items.js b/src/items.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/items.js',
      '@@ -0,0 +1,5 @@',
      '+router.post("/items", async (req, res) => {',
      '+  const item = await db.items.insert(req.body);',
      '+  return res.status(200).json(item);',
      '+});',
    ].join('\n'),
    tier1: PASSING_TIER1,
    expected: 'NOT VERIFIED',
  },
  {
    id: 'bad-no-retry',
    label: 'bad',
    // Defect: criterion asks for retry-on-5xx; the code never retries.
    prTitle: 'feat: resilient fetch',
    criteria: ['fetchWithRetry retries the request up to 3 times when the server responds with a 5xx status'],
    diff: [
      'diff --git a/src/fetchRetry.js b/src/fetchRetry.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/fetchRetry.js',
      '@@ -0,0 +1,6 @@',
      '+async function fetchWithRetry(url) {',
      '+  const r = await fetch(url);',
      '+  if (!r.ok) return null;   // gives up immediately, no retry',
      '+  return r.json();',
      '+}',
      '+module.exports = { fetchWithRetry };',
    ].join('\n'),
    tier1: PASSING_TIER1,
    expected: 'NOT VERIFIED',
  },
  {
    id: 'bad-mock-hides-contract',
    label: 'bad',
    // Defect (the "mocks hide contract bugs" class): the criterion wants the
    // numeric id returned; the code returns the whole row object. The unit test
    // mocks the DB to return { id: 1 } and asserts result.id === 1, so it passes
    // even though the real contract is wrong.
    prTitle: 'feat: createUser',
    criteria: ["createUser resolves with the new user's numeric id (e.g. 42), not the full row object"],
    diff: [
      'diff --git a/src/createUser.js b/src/createUser.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/createUser.js',
      '@@ -0,0 +1,5 @@',
      '+async function createUser(db, data) {',
      '+  const row = await db.insert(data);   // row = { id, email, ... }',
      '+  return row;                          // returns the object, not row.id',
      '+}',
      '+module.exports = { createUser };',
    ].join('\n'),
    tier1: PASSING_TIER1,
    expected: 'NOT VERIFIED',
  },
];

/**
 * A perfect ("oracle") judge for offline harness tests: it marks every criterion
 * met iff the fixture is labelled good. Lets test/run.js prove the corpus + the
 * compose() wiring produce the expected verdicts without any network call.
 */
function oracleJudge(fixture) {
  const met = fixture.label === 'good';
  return {
    family: 'oracle',
    model: 'oracle',
    assessment: `oracle: fixture "${fixture.id}" is ${fixture.label}`,
    criteria: fixture.criteria.map((text) => ({ text, met, reason: met ? 'met' : 'unmet (known defect)' })),
  };
}

/** Map a fixture's known truth to a calibration outcome (bad = defect). */
function truthOutcome(fixture) {
  return fixture.label === 'bad' ? 'defect' : 'clean';
}

module.exports = { FIXTURES, PASSING_TIER1, oracleJudge, truthOutcome };
