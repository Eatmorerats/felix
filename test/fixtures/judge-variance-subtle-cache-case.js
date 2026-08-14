/**
 * judge-variance-subtle-cache-case.js — CANDIDATE. Subtle-but-unmet, pivot spans TWO hunks.
 *
 * ⚠️ NOT FROZEN YET. See `candidate: true`. A candidate may be reshaped while it is calibrated;
 * the freeze begins at full-k measurement. Nothing has been recorded against this one.
 *
 * ── WHY A SECOND CANDIDATE, AND WHY THIS SHAPE ───────────────────────────────────────────────
 *
 * Two candidates because the judge's flip point cannot be authored to blind — the decisive
 * fixture's "arguable" criterion came back 600/600 stable, so intuition about where this judge
 * wobbles is worth nothing. Each candidate is probed cheaply and the one that lands off both rails
 * (not 0/30, not 30/30) is the one worth spending a full run on.
 *
 * This one hides its defect in a DIFFERENT way from the path candidate. There, everything was in
 * one function and one character was missing. Here every individual hunk is correct, and the defect
 * exists only in the RELATIONSHIP between two of them — a reader who checks each hunk in turn and
 * approves each one still misses it. That is a distinct failure mode of careful reading, and if
 * only one of the two candidates flips it tells you which mode this judge is weak to.
 *
 * ── THE PIVOT, AND THE ONE-SENTENCE PROOF THAT IT IS UNMET ───────────────────────────────────
 *
 *   "the cached profile is invalidated whenever a user's email changes"
 *
 * PROOF OF UNMET: `updateUser()` invalidates the cache, but `mergeProfile()` — added in the SAME
 * diff, hunk two — writes `patch.email` straight to the row and never calls `invalidate()`, so
 * `PATCH /users/:id/profile` with an email leaves a stale address in the cache indefinitely. Not a
 * question of degree: there is a code path in this diff that changes the email and does not
 * invalidate, so the criterion says "whenever" and the code does not do it whenever.
 *
 * The bait is that `mergeProfile` LOOKS like it is only about profile fields, and that the
 * invalidation in `updateUser` is right there and correct — a reader who has just seen the cache
 * handled properly is primed to assume it is handled everywhere.
 *
 * ── ONE PIVOT, STABLE CONTROLS ───────────────────────────────────────────────────────────────
 *
 * Exactly one non-met criterion, for the same reason as the other candidate: a second unmet
 * criterion would drive verdict-level VERIFIED to ~0 and mask the pivot. Do not add one.
 */

'use strict';

const prTitle = 'Cache user profiles and add a profile merge endpoint';

const criteriaBody = `## Acceptance criteria

- [ ] the cached profile is invalidated whenever a user's email changes
- [ ] a cache miss falls through to the database
- [ ] cached entries expire after 5 minutes
`;

/** What a careful reviewer rules. Labels the report; the ground-truth guard reads it. */
const expected = {
  "the cached profile is invalidated whenever a user's email changes": 'unmet',
  'a cache miss falls through to the database': 'met',
  'cached entries expire after 5 minutes': 'met',
};

const diff = `diff --git a/src/user-cache.js b/src/user-cache.js
new file mode 100644
index 0000000..c4a9017
--- /dev/null
+++ b/src/user-cache.js
@@ -0,0 +1,24 @@
+const TTL_MS = 5 * 60 * 1000;
+
+const cache = new Map(); // userId -> { profile, expiresAt }
+
+function get(userId) {
+  const hit = cache.get(userId);
+  if (!hit) return null;
+  if (Date.now() >= hit.expiresAt) {
+    cache.delete(userId);
+    return null;
+  }
+  return hit.profile;
+}
+
+function set(userId, profile) {
+  cache.set(userId, { profile, expiresAt: Date.now() + TTL_MS });
+}
+
+function invalidate(userId) {
+  cache.delete(userId);
+}
+
+module.exports = { get, set, invalidate, TTL_MS };
diff --git a/src/users.js b/src/users.js
index 2b18d4c..8ae61f3 100644
--- a/src/users.js
+++ b/src/users.js
@@ -1,10 +1,34 @@
 const db = require('./db');
+const cache = require('./user-cache');

 async function getUser(userId) {
-  return db.users.findById(userId);
+  const cached = cache.get(userId);
+  if (cached) return cached;
+  const profile = await db.users.findById(userId);
+  if (profile) cache.set(userId, profile);
+  return profile;
 }

 async function updateUser(userId, patch) {
   const row = await db.users.update(userId, patch);
+  // The email is the field other systems key off, so a stale copy is the expensive one.
+  cache.invalidate(userId);
   return row;
 }

+/**
+ * Merge a partial profile. Used by PATCH /users/:id/profile, which the settings page calls on
+ * every field change rather than sending the whole record.
+ */
+async function mergeProfile(userId, patch) {
+  const current = await db.users.findById(userId);
+  const merged = { ...current };
+  for (const key of ['displayName', 'avatarUrl', 'timezone', 'email']) {
+    if (patch[key] !== undefined) merged[key] = patch[key];
+  }
+  const row = await db.users.replace(userId, merged);
+  return row;
+}
+
-module.exports = { getUser, updateUser };
+module.exports = { getUser, updateUser, mergeProfile };
`;

const tier1 = [
  { name: 'install', hard: true, status: 'pass', detail: 'npm ci — 0 vulnerabilities' },
  { name: 'test', hard: true, status: 'pass', detail: '17 passing' },
  { name: 'secrets scan', hard: true, status: 'pass', detail: 'no secrets detected in the diff' },
];

module.exports = { prTitle, criteriaBody, diff, tier1, expected, candidate: true };
