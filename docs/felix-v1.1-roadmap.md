# Felix — v1.1 roadmap (research + recommendation)

_Status: research complete, nothing built. This is the "pick what to build" menu._
_Date: 2026-07-17 · Felix @ v1.0.0, 68 tests green, 13 PRs shipped (12 merged, #11 open)._

---

## TL;DR — read this first

Felix is **well-built and well-organized**, but it has never been **proven to catch a
bad PR**, and it can't currently be proven because **its measurement loop is dark**.

Three things I found that matter more than the polish:

1. 🔴 **The calibration table doesn't exist.** `felix_verdicts` was never created in the
   SamPulse Supabase — the schema was never applied. So every verdict Felix has ever
   produced lives **only** as a PR comment; the Phase-3 precision/recall loop has **zero
   rows**, and **no post-merge outcome has ever been recorded**. The whole "learn from
   real outcomes" investment is switched off.
2. 🔴 **Every real verdict has been ✅ VERIFIED** (#1, #7, #9, #11, #12, #13). Felix has
   **never emitted a NOT VERIFIED** in the wild. That's not proof it's good — it's the
   absence of evidence that it can say "no." Its discriminating power is **untested**.
3. 🟡 **Your caveat (b) is real but currently harmless.** The spec→file mapping swung from
   7/7 and 5/5 (early new-file PRs) down to **1/5 and 2/5** on the recent deep-in-a-file
   bug fixes — but that scary "1/5" **changed nothing**, because the mapping is cosmetic:
   the judge never reads it and the verdict never uses it (proven in the code).

**My recommendation in one line:** before spending on fidelity (drive-the-app, second
judge), spend **half a session lighting up ground truth** (apply the schema + build a
small known-good / known-**bad** fixture set) so every later improvement is *measurable* —
then do your caveat (a) "drive the app," because for PayCare it's the biggest real gap.

**Compute for this session:** `[Opus 4.8 · High]` main synthesis · `[Sonnet · Med ×3]`
parallel web research (judge reliability / web-drive-in-CI / secrets-tool line-drawing).
No Fable — nothing here was irreversible or money/security-critical enough to warrant it.

---

## 1. How Felix has actually been performing

Pulled from the real verdict comments on every Felix PR + a live check of the Supabase.

| PR | What it was | Verdict | Criteria mapped | Judge time |
| --- | --- | --- | --- | --- |
| #1 | Phase 1 engine (new files) | ✅ VERIFIED | **7 / 7** | 7.1s |
| #7 | gating mode (new file) | ✅ VERIFIED | **5 / 5** | 7.0s |
| #9 | multi-lang detect (edit config) | ✅ VERIFIED | **4 / 5** | 6.5s |
| #11 | multi-judge (open PR) | ✅ VERIFIED | **5 / 6** | 7.4s |
| #12 | Teams 404 fix (deep in a file) | ✅ VERIFIED | **2 / 5** | 7.7s |
| #13 | entropy gate (deep in a file) | ✅ VERIFIED | **1 / 5** | 11.8s |

**What this tells us (honestly):**

- ✅ **The judge writes accurate, specific assessments.** On #13 it correctly summarised the
  entropy gate; on #12 the 404-permanent logic. No hallucinations *visible* — but every
  case is a ✅, so we've never watched it handle a genuinely broken PR.
- 🔴 **No ground truth exists.** The `felix_verdicts` table is absent from the DB, so
  `felix metrics` returns nothing and precision/recall is literally uncomputable. The
  calibration code (Phase 3) and auto-revert-detection (Phase 4) are built but **have
  never received a single data point.**
- 🟡 **Mapping quality tracks PR shape, not correctness.** Criteria map well when they name
  a new file (7/7) and badly when the change is behaviour buried in an existing file
  (1/5). Since mapping is cosmetic today, this mismatch has cost nothing — but it makes the
  comment's "1 mapped" look like a failure when the verification was fine.
- ⚪ **Cost is a non-issue.** One gpt-4.1 call per PR ≈ **$0.11** (≈50K-token diff). Even
  doubling the judge or adding an adversarial pass stays in **pennies/PR** (see R2).

---

## 2. What value Felix adds to your code (and where it doesn't)

Felix's lane is **behavioral**: it builds and *runs* the PR, then asks an independent
cross-family model "does the running result satisfy what a human asked for?" That's
genuinely complementary to CodeRabbit (which reasons over the diff text) — the two catch
different bug classes.

- **Biggest value → PayCare and any web target.** "Tests pass but the page is actually
  broken" is exactly the gap Felix is *supposed* to close but currently doesn't (see R1).
  Once it can drive a running app, it becomes a real safety net, not a criteria-checker.
- **Real side-benefit → the acceptance-criteria discipline.** Felix only verifies against
  falsifiable criteria, so it *forces* every PR to state observable behaviour. That habit
  is worth keeping even in repos where Felix can't do much.
- **Least value → docs/planning/tracker repos.** It correctly SKIPs these already.

The unlock is **R0 + R1 together**: prove it can catch a bad PR (ground truth) *and* let it
drive a web app. Until then it's an accurate-but-unproven yes-machine.

---

## 3. Code health — structure, naming, duplication, readability

You asked specifically about this. Short version: **this is above-average, outsider- and
AI-friendly code.** Keep the pattern.

**What's good (keep doing it):**

- **One concern per file**, all under `src/engine/`: `github` (API), `config`
  (detect/load), `spec` (criteria), `sandbox` (worktree), `isolation` (docker wrap),
  `tier1` (deterministic checks), `judge` (LLM), `verdict` (pure decision table), `gating`
  (policy), `calibration` (metrics), `outcomes` (revert parse), `comment` (render), `log`
  (Supabase), `util/{exec,logger}`. `bin/felix.js` is a thin CLI; `index.js` is a thin
  9-step pipeline. An outsider can read `index.js` top-to-bottom and understand the whole
  thing.
- **Pure functions separated from I/O.** `verdict.compose`, `calibration.computeMetrics`,
  `outcomes.parseRevertedPR`, `spec.*`, `isolation.wrapCommand` take data in and return data
  out — which is *why* all 68 tests run with zero network. This is the single best thing
  about the codebase.
- **Every file opens with a WHY docstring**, and the tricky lines explain rationale (the
  entropy-gate comment, the `MAX_DIFF_CHARS` note, the fork-secret reasoning). This is what
  makes it AI- and newcomer-legible.
- **Almost no duplication.** The one real copy is `github.js` mirroring
  `sampulse/integrations/github.js` — and that's *justified*: Felix is meant to be
  standalone/repo-agnostic and can't depend on sampulse internals.

**Small drift worth a cleanup pass (this is R5, cheap):**

- 🟡 **Version strings disagree.** `package.json` says `1.0.0`, but `comment.js` falls back
  to `'0.1.0'`, `github.js` sends `User-Agent: Felix/0.1`, and the README still says
  "26 unit tests" (it's **68**). The lockfile just got bumped to 1.0.0 and is sitting
  **uncommitted**. → single-source the version from `package.json`.
- 🟡 **"Tier 2" has no home.** The verdict flow is Tier 1 (hard) → Tier 3 (judge). "Tier 2"
  static signals (lint/typecheck) are emitted as *soft rows inside the tier1 results array*,
  and there's no `tier2` module — so the numbering confuses a newcomer. PR #11 already
  splits them in the comment; add one line of docs naming the taxonomy.
- 🟢 **One tiny dup:** `log.js` builds a Supabase client inline in `logVerdict` *and* in a
  `client()` helper. DRY it.

---

## 4. The v1.1 roadmap — ranked, with cost/benefit

Priority labels use **words + icons** (not colour): 🔴 **DO FIRST** · 🟡 **HIGH** ·
🟢 **MEDIUM** · ⚪ **LOW/DEFER**. Effort in half-session units.

| # | Item | Priority | Effort | Benefit | Depends on |
| --- | --- | --- | --- | --- | --- |
| **R0** | Light up ground truth (schema + fixtures) | 🔴 DO FIRST | ~1 | **Unblocks measuring everything else** | — |
| **R1** | Caveat (a): drive the running app | 🟡 HIGH | 2–4 | High for web (PayCare) | R0 to prove it |
| **R2** | Caveat (c): a *real* second opinion | 🟢 MEDIUM | 1–2 | Medium–High | R0 to prove it |
| **R3** | Caveat (b): make mapping earn its place | ⚪ LOW | 0.5–1 | Low | — |
| **R4** | Secrets: keep + document + defer | 🟢 MEDIUM | 0.5–1 | Scope clarity | — |
| **R5** | Housekeeping (version, tiers, README) | ⚪ LOW | 0.5 | Readability | — |

---

### R0 — Light up the ground truth 🔴 _(the foundation; do before R1/R2)_

**Why:** you can't tell whether a second judge or a drive-step *helps* if you can't measure
whether Felix currently catches anything. Right now it measures nothing.

**Do:**
1. Apply `sql/felix-schema.sql` + `sql/felix-calibration-schema.sql` to the SamPulse
   Supabase (the table is missing → verdict logging has been silently no-op'ing in CI). ~15 min.
2. **Build a tiny fixture corpus of known-BAD PRs** — the missing piece. Take 4–5 real
   merged PRs (known-good) and author 4–5 deliberately broken variants: a missing import, a
   criterion left unimplemented, a mock-hidden contract bug. Run Felix offline against them
   and see if the judge says NO. **This produces Felix's first real precision/recall number.**
3. Schedule the existing `felix scan-outcomes` (already built) so reverts auto-mark defects.

**Cost:** LOW (~1 half-session). **Benefit:** HIGH — turns every later item from "we think
it helps" into "we measured it." Also the honest answer to "how is Felix performing?": today,
*unmeasured*.

---

### R1 — Caveat (a): drive the running app 🟡 _(your #1; the biggest real gap)_

**The hole, precisely:** `tier1` runs install → build → test, but the "smoke" build is
**soft** (SamPulse's config sets `smoke.expect: ""`, so a build failure doesn't even gate),
and the judge only ever reads **diff + test text**. Nothing boots the app. Research confirms
your burned lessons: `vite build` catches a **missing file**, but a missing *named export*,
a broken dynamic-import route, or a runtime blank-page crash **only surface on an actual page
load** ([vite#11783](https://github.com/vitejs/vite/issues/11783),
[vite#11804](https://github.com/vitejs/vite/issues/11804)). And mocked unit tests pass while
the real integration is broken.

**Design options (cheapest → richest):**

- **A — Hard-gate build + boot + HTTP-200 / no-console-error on declared routes.**
  Promote the build to a *hard* check, boot the app (`vite preview`/serve), `wait-on` it,
  then load 1–3 declared routes and assert they render without console errors. Catches the
  missing-import-crash and blank-page classes — the exact ones you named. **Effort ~2, low
  flakiness.** Per-repo config: `start` command, port, routes.
- **B — Minimal Playwright smoke on criteria-linked routes.** Adds interaction-level checks
  tied to the PR's acceptance criteria; closes "mocks hide contract bugs" **only if run
  against a real test backend, not mocks**. Effort ~3, medium flakiness. Needs backend +
  seed/auth config.
- **C — Full preview-deploy (Vercel/Netlify) + user-flow suite.** Near-prod, but preview
  URLs cover the frontend only — a real backend/DB needs a service container or compose, or
  you're back to mocks. Effort high, medium-high flakiness/maintenance. **Not recommended
  yet.**

**Recommendation:** build **A**, gated behind opt-in config so non-web repos (sampulse
itself) are unaffected. Add **B** for PayCare specifically once A proves out. Skip **C**.
**Benefit:** HIGH for PayCare, LOW for pure-logic repos — hence opt-in.

---

### R2 — Caveat (c): a *real* second opinion 🟢 _(your #2 — but don't just merge #11)_

**Key finding:** PR #11 (opt-in multi-judge) is already built and Felix-verified — but it
pairs **two OpenAI models** (gpt-4.1 + gpt-4o). The research says that's the **weakest**
version of this idea:

- A diverse-family *jury* beats a single judge and costs less — but the win comes from
  **disjoint families**, not more judges ([PoLL, arXiv:2404.18796](https://arxiv.org/abs/2404.18796)).
- Even a 7-family panel is worth only **~2 effective votes** — correlated errors dominate,
  and the single best judge often matches the panel
  ([arXiv:2605.29800](https://arxiv.org/html/2605.29800)). Two **same-vendor** judges are
  likely closer to **1 effective vote** → they mostly launder sampling noise into false
  confidence, which is the opposite of what you want.
- The **best-evidenced** lever is **adversarial-refute** grading: forcing the judge to
  disprove a criterion (commit-then-grade) collapsed false-positive rate **0.719 → 0.012**
  in one study ([arXiv:2607.05904](https://arxiv.org/pdf/2607.05904)). *Changing the ask*
  beats *adding a similar grader*.

**Recommendation:** reuse #11's plumbing (`createJudges`/`mergeJudgeResults` is good), but
(i) make the second judge a **different vendor** (Gemini 2.5 Flash — which is also
**cheaper** than the gpt-4o design: ≈ $0.13/PR vs $0.25), and (ii) prompt **one judge
adversarially** ("find the strongest reason each criterion is NOT met"). Keep
unanimous-agreement → met. **Cost:** pennies/PR. **Benefit:** Medium-High — but only
*provable* once R0 exists. That dependency is the honest reason not to lead with this.

---

### R3 — Caveat (b): make the mapping earn its place ⚪ _(your #3, lowest — correctly)_

**Finding that reframes this:** the spec→file mapping is **cosmetic today**. `judge.js`
never reads `mappedFiles`; `verdict.js` never reads `mappedCount`. So improving the
keyword-overlap algorithm in isolation is pure over-engineering — it would make a prettier
number that still changes nothing.

**Two honest paths (pick one, keep it small):**
- **Make it *do* something:** feed the judge each criterion's "likely-relevant files" as a
  hint, and/or surface *unmapped* criteria as a low-confidence flag ("couldn't locate this
  in the diff"). Small, might sharpen the judge's focus on big diffs.
- **Or demote the metric:** stop showing a scary "1 mapped" that doesn't reflect quality;
  reword the comment.

**Recommendation:** light touch only — wire mapping into the judge prompt as a hint *or*
demote it. **Do not** build a symbol-extraction mapper. Defer entirely unless R0 shows
mapping correlates with real misses. **Effort:** LOW. **Benefit:** LOW.

---

### R4 — Secrets scan: keep, document, defer 🟢 _(your item 2 — the entropy gate is sound)_

The research **validated every choice you made** in PR #13:

- **3.5 bits/char is the right floor — keep it.** It's *identical* to gitleaks' own
  keyword-gated `generic-api-key` rule (3.5), and because Felix's pattern is also
  keyword-gated it doesn't need detect-secrets' more conservative base64 limit (4.5)
  ([gitleaks.toml](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml)).
- **The placeholder-veto is a standard technique — keep it.** It's gitleaks' ~1,479-word
  stopword allowlist at small scale. Your terms are word-boundary-anchored (`\btest`,
  `\bmock`, `your[-_]`), so they veto only literal placeholder-shaped values — a **narrow**
  false-negative widening, the same tradeoff gitleaks accepts.
- **The weak-password / short-token gap is correctly OUT OF SCOPE.** No static tool closes
  it for free — it's the entropy-math ceiling every scanner lives with. The one tool that
  solves it (trufflehog's **live verification**) does so by firing network requests using
  attacker-controlled PR content — real **SSRF / egress / credential-activation** risk that
  is exactly wrong for scanning untrusted diffs
  ([trufflehog SSRF hardening](https://trufflesecurity.com/blog/contributor-spotlight-strengthening-trufflehog-ssrf-protections)).

**Recommendation:** (1) **document the gap** in the README (Felix's scan is a *changed-files
backstop*, not an authoritative repo scanner). (2) Add an **opt-in hook** so security-
sensitive repos (PayCare) can run gitleaks or trufflehog-with-verification-off as the
authoritative gate and have Felix defer. (3) **Do not** build verification into Felix. Optional
nano-tune: only apply the placeholder-veto when the placeholder token is a large fraction of
the value (shrinks the FN hole slightly) — low priority. **Effort:** LOW. **Benefit:**
Medium (scope clarity + a real path for PayCare).

---

### R5 — Housekeeping ⚪

Single-source the version from `package.json` (kills the 0.1.0/1.0.0/`Felix/0.1` drift);
fix the README test count (26 → 68); add one line documenting the Tier 1/2/3 taxonomy; DRY
the duplicated Supabase client in `log.js`; commit the lockfile bump. **Effort:** LOW.

---

## 5. Recommended order

1. **R0 — ground truth** (half-session). Non-negotiable foundation; makes the rest measurable.
2. **R1(A) — drive the app** (hard-gate build + boot + route check), opt-in. Your #1, biggest
   real gap, immediately useful to PayCare.
3. **R2 — cross-vendor + adversarial judge** (reuse #11's plumbing, swap vendor, add refute).
   Now provable thanks to R0.
4. **R4 — secrets docs + opt-in gitleaks hook.** Cheap, closes the scope question honestly.
5. **R5 — housekeeping.** Fold into whichever PR touches those files.
6. **R1(B) — Playwright smoke for PayCare**, once A proves out.
7. **R3 — mapping**, only if R0 shows it matters. Otherwise leave it.

**What to do with open PR #11:** don't merge as-is. Either close it in favour of the R2
cross-vendor+adversarial design, or repurpose its `createJudges`/`mergeJudgeResults`
scaffolding as the base for R2.

---

## Appendix — research sources

- **LLM juries / panels:** PoLL [arXiv:2404.18796](https://arxiv.org/abs/2404.18796);
  "Nine Judges, Two Effective Votes" [arXiv:2605.29800](https://arxiv.org/html/2605.29800).
- **Adversarial / refute judging:** [arXiv:2607.05904](https://arxiv.org/pdf/2607.05904)
  (FP 0.719→0.012); Refute-or-Promote [arXiv:2604.19049](https://arxiv.org/html/2604.19049).
- **Same-family judge bias:** [Play Favorites, arXiv:2508.06709](https://arxiv.org/html/2508.06709v1).
- **Judge cost:** OpenAI + Gemini published pricing (Mar 2026): gpt-4.1 $2/$8, gpt-4o
  $2.5/$10, Gemini 2.5 Flash $0.30/$2.50 per 1M tok → **~$0.11/PR today**, ~$0.13–0.25 with
  a second judge.
- **Web-drive in CI:** [Vite static-deploy/troubleshooting](https://vite.dev/guide/troubleshooting),
  [vite#11783](https://github.com/vitejs/vite/issues/11783) (named-export misses),
  [Playwright CI](https://playwright.dev/docs/ci-intro), [start-server-and-test](https://github.com/bahmutov/start-server-and-test).
- **Secrets tools:** [gitleaks rules/config](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml),
  [trufflehog verification](https://trufflesecurity.com/blog/how-trufflehog-verifies-secrets)
  + [SSRF hardening](https://trufflesecurity.com/blog/contributor-spotlight-strengthening-trufflehog-ssrf-protections),
  [detect-secrets entropy plugin](https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/high_entropy_strings.py)
  (base64 4.5 / hex 3.0).
