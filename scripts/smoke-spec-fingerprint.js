#!/usr/bin/env node
/**
 * smoke-spec-fingerprint.js — prove the freeze pin actually pins.
 *
 * specFingerprint is the whole basis of the `spec_changed` block: if it can be made to agree
 * across two DIFFERENT criteria sets, an author (or an autonomous fixer) swaps a failing
 * criterion for a passing one and keeps the baseline. This exercises the properties that
 * claim rests on, against the real exported function.
 *
 * Run: node scripts/smoke-spec-fingerprint.js
 */

const assert = require('assert');
const { specFingerprint, buildSpec } = require('../src/engine/spec');

let n = 0;
function check(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  n++;
}

const A = ['Returns 201 on POST /api/x', 'Rejects a duplicate email with 409'];

check('reordering the criteria does NOT change the fingerprint', () => {
  assert.strictEqual(specFingerprint(A), specFingerprint([...A].reverse()));
});

check('case + whitespace variants do NOT change it (agrees with dedupe)', () => {
  const variant = ['returns    201 on post /api/x', 'REJECTS a duplicate email with 409'];
  assert.strictEqual(specFingerprint(A), specFingerprint(variant));
});

check('rewording a criterion DOES change it', () => {
  const weakened = ['Returns a 2xx on POST /api/x', A[1]];
  assert.notStrictEqual(specFingerprint(A), specFingerprint(weakened));
});

check('deleting a criterion DOES change it', () => {
  assert.notStrictEqual(specFingerprint(A), specFingerprint([A[0]]));
});

check('adding a criterion DOES change it', () => {
  assert.notStrictEqual(specFingerprint(A), specFingerprint([...A, 'Logs the request id']));
});

// The separator attack. normKey collapses whitespace, so joining with a SPACE would make
// these two sets hash identically — two different rubrics, one pin. NUL closes it.
check('re-splitting the same words across criteria DOES change it (NUL separator)', () => {
  const left = specFingerprint(['alpha', 'beta gamma']);
  const right = specFingerprint(['alpha beta', 'gamma']);
  assert.notStrictEqual(left, right, 'separator collision — a space separator would collide here');
});

check('empty / absent criteria fingerprint to null, not to a hash of nothing', () => {
  assert.strictEqual(specFingerprint([]), null);
  assert.strictEqual(specFingerprint(null), null);
  assert.strictEqual(specFingerprint([{ text: '' }]), null);
});

check('accepts both the {text} shape and bare strings identically', () => {
  assert.strictEqual(specFingerprint(A), specFingerprint(A.map((text) => ({ text }))));
});

check('buildSpec exposes the fingerprint of the array it hands the judge', () => {
  const pr = { title: 'x', body: '## Acceptance criteria\n- ' + A[0] + '\n- ' + A[1] + '\n' };
  const spec = buildSpec(pr, [], []);
  assert.strictEqual(spec.total, 2, 'fixture should parse two criteria');
  assert.strictEqual(spec.fingerprint, specFingerprint(spec.criteria));
  assert.strictEqual(spec.fingerprint, specFingerprint(A));
});

check('a no-spec PR pins nothing (fallback title still fingerprints, hadRealSpec is false)', () => {
  const spec = buildSpec({ title: 'chore: bump deps', body: '' }, [], []);
  assert.strictEqual(spec.hadRealSpec, false);
});

console.log(`\nsmoke-spec-fingerprint: ${n} checks passed`);
