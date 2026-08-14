/**
 * judge-variance-contested-case.js — a frozen case whose ground truth is CONTESTED, on purpose.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 *
 * `smoke-judge-variance.js` prints an argument about a safety cap, and that argument only holds if
 * a VERIFIED roll is WRONG. That is a property of the FIXTURE, not of the arithmetic. Point the
 * script at a case where every criterion is defensibly met and the same code path would report the
 * judge's agreement with a reasonable reader as a "false-green rate" — and its own branches would
 * then prescribe cutting `maxJudgeRuns`, or bless keeping it, from a number about nothing.
 *
 * So the script derives ground truth from the `expected` labels and REFUSES the cap section when
 * no criterion is labelled `unmet`. This fixture is the thing that guard is tested against. Its
 * job is to be legitimately contested, not to be a good measuring stick.
 *
 * ── HOW IT IS CONTESTED, HONESTLY ────────────────────────────────────────────────────────────
 *
 * Same diff as the decisive case — the rate limiter really does leak a Map entry per client id.
 * What changes is the CRITERIA: this PR's author never wrote one about unbounded growth. That is
 * not a contrived shape, it is the ordinary case. Felix grades against the criteria a human wrote,
 * so a real defect nobody asked about is simply not in scope, and every criterion that IS in scope
 * is defensibly met:
 *
 *   arguable  the fixed-window question, inherited unchanged from the decisive case. Five requests
 *             at t=59s and five at t=61s is ten inside a sixty-second span but two windows here.
 *   met       429 on rejection, and per-client independence. Both plainly done.
 *
 * There is no `unmet` label and there must never be one — the moment somebody adds a decisively
 * unmet criterion here, this stops being the guard's negative control and the guard stops being
 * tested. If you want a decisive case, use `judge-variance-case.js`; if you want a second one,
 * add a third file.
 *
 * The leak still being IN THE DIFF is the point rather than an oversight: it is what makes the
 * case contested rather than merely easy, and it is a fair model of the thing Felix cannot catch —
 * a defect outside the spec it was handed.
 */

'use strict';

const decisive = require('./judge-variance-case');

/** Same PR, same neutral title. */
const prTitle = decisive.prTitle;

/**
 * The decisive case's criteria MINUS the unbounded-growth one. Written out rather than filtered
 * from the other file's string, so that reshaping one case can never silently reshape this one —
 * both are frozen measuring sticks and neither may move underneath a recorded number.
 */
const criteriaBody = `## Acceptance criteria

- [ ] the limiter rejects the 6th request from one client within 60 seconds
- [ ] a rejected request returns HTTP 429
- [ ] each client is limited independently
`;

/** No `unmet` anywhere. That absence is the fixture's whole function — see the header. */
const expected = {
  'the limiter rejects the 6th request from one client within 60 seconds': 'arguable',
  'a rejected request returns HTTP 429': 'met',
  'each client is limited independently': 'met',
};

module.exports = {
  prTitle,
  criteriaBody,
  expected,
  // Byte-identical to the decisive case's, deliberately: holding the diff fixed while only the
  // criteria change is what isolates "ground truth comes from the SPEC, not from the code".
  diff: decisive.diff,
  tier1: decisive.tier1,
};
