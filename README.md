# Felix

**Repo-agnostic, behavioral PR verification.** Felix builds and *runs* a pull
request's code in a sandbox, then verifies it against a human-authored spec.
It runs **parallel to CodeRabbit** — CodeRabbit reasons over the diff text;
Felix executes the code and asks *"does the running result satisfy what a human
asked for?"*

## Verdicts

| Verdict | Meaning |
| --- | --- |
| ✅ `VERIFIED` | All hard Tier 1 checks pass **and** every mapped criterion is met. |
| ❌ `NOT VERIFIED` | A hard check failed, the judge found a criterion unmet, or the acceptance criteria are too large to grade ([see below](#the-acceptance-criteria-are-capped)). |
| ⚠️ `INSUFFICIENT EVIDENCE` | No spec found, install/build broke, or the judge was unavailable. |
| ⏭️ `SKIPPED` | Only non-behavioral files changed (docs, lockfiles, images). |

## Pipeline

1. **Resolve PR** — metadata, changed files, diff, head/base SHA (`github.js`).
2. **Learn/load config** — `felix.config.json`, or **auto-detect** the project
   type from its manifests (`config.js`). This is what makes Felix agnostic:
   drop it on a new repo and it figures out install/test/build itself.
3. **Triage** — all-`skipGlobs` PRs short-circuit to `SKIPPED`.
4. **Spec** — extract acceptance criteria from the PR body + linked issues, map
   each to changed files (`spec.js`).
5. **Sandbox** — `git worktree` the PR head into a disposable, secret-free dir (`sandbox.js`).
6. **Tier 1** — install → build/smoke → test → targeted re-run → secrets scan (`tier1.js`).
   Opt-in: also **boot and drive the app** — HTTP-probe declared routes, a headless
   page-load that catches "200 but blank screen", and **interaction flows** that click and
   assert like a user — see [Driving the app](#driving-the-app-opt-in) and
   [Interaction flows](#interaction-flows-opt-in). Opt-in **CRAP** flags changed functions
   that are complex *and* under-tested — see [CRAP](#crap--complex-and-under-tested-changed-functions-opt-in).
7. **Tier 3 judge** — a **cross-family** LLM (OpenAI **or** Google Gemini — pick
   the vendor with `FELIX_JUDGE_FAMILY`) rules each criterion met/unmet. Felix
   **refuses to run with an Anthropic judge** so the code generator never grades
   its own output (`judge.js`). Opt-in **adversarial**
   mode (`FELIX_JUDGE_ADVERSARIAL=true`, or `judge.adversarial` in config) makes
   the judge argue the strongest reason each criterion is *not* met before
   deciding — a refute-first pass that cuts over-eager "met" verdicts.
   Large PRs are **split across several calls** and merged — see
   [Large PRs and rate limits](#large-prs-and-rate-limits).
8. **Compose verdict** — deterministic decision table (`verdict.js`).
9. **Log + report** — best-effort `felix_verdicts` row + an idempotent PR
   comment (`comment.js`, `log.js`).

**Tiers:** **Tier 1** = hard deterministic checks that gate the verdict (install/build/test/
drive/secrets). **Tier 2** = soft *static* signals (lint, typecheck) — emitted as advisory
rows within the Tier 1 results, never gating on their own. **Tier 3** = the cross-family LLM
judge. (There is no separate `tier2` module; the split is by `hard` flag, not by file.)

## Architecture at a glance

One PR flows top-to-bottom through `src/engine/`. Each module owns one job — Felix is
opinionated about keeping the dependencies between them small (it verifies that property on
other people's PRs, so it holds itself to it):

| Module | Responsibility |
| --- | --- |
| `index.js` | **Orchestrator** — runs the 9-step pipeline above for one PR |
| `github.js` | Minimal GitHub REST client — PR metadata, changed files, diff, head/base SHA, the comment |
| `config.js` | Load the per-repo `felix.config.json`, or **auto-learn** the project type from its manifests |
| `spec.js` | Find the *human* spec (PR body + linked issues) and turn it into checkable criteria |
| `sandbox.js` | Check out the PR head into a disposable, secret-free `git worktree` |
| `isolation.js` | Stronger sandbox isolation for untrusted PR commands (later phase) |
| `tier1.js` | The deterministic, non-LLM checks against the running code (install / build / test / secrets) |
| `drive.js` | Boot and **drive** the running app — HTTP-probe routes + a headless page-load render |
| `flows.js` | Drive the app like a **user** — named click-and-assert interaction flows |
| `gating.js` | Turn advisory results into an authoritative gate (later phase) |
| `judge.js` | The **Tier 3 cross-family LLM judge** — rules each criterion met/unmet |
| `budget.js` | Size the judge prompt against the account's rate limit; split a large diff into paced passes |
| `verdict.js` | Combine triage + Tier 1 + Tier 3 into one verdict via a deterministic decision table |
| `comment.js` | Render the verdict as a compact, idempotent markdown PR comment |
| `log.js` | Best-effort write of one `felix_verdicts` row to Supabase (never blocks a verdict) |
| `calibration.js` / `outcomes.js` | Turn logged verdicts + real post-merge outcomes into precision/recall metrics |

## Run it by hand (Phase 1)

```bash
cp .env.example .env   # fill in GITHUB_TOKEN, OPENAI_API_KEY, …
npm install

# dry-run (default): compute + print, never comment
node bin/felix.js owner/repo#42 --repo-path /path/to/clone

# post/update the verdict comment
node bin/felix.js owner/repo#42 --post --repo-path /path/to/clone
```

Exit codes: `0` VERIFIED/SKIPPED · `1` NOT VERIFIED · `2` INSUFFICIENT EVIDENCE · `3` error.

## Pre-flight: run Felix before the PR exists

`felix preflight` verifies your **working tree** — uncommitted and untracked changes included —
against a local criteria file. It is meant for the loop an agent runs *before* opening a PR, so
that CI's single independent verdict is spent once, on finished work.

```bash
# write the acceptance criteria you intend to put in the PR description
mkdir -p .felix && $EDITOR .felix/preflight-criteria.md

# Tier 1 only — free, no API calls. This is the loop you want 90% of the time.
node bin/felix.js preflight

# also grade the criteria with the cross-family judge (costs money)
node bin/felix.js preflight --judge

# machine-readable, for a loop driver
node bin/felix.js preflight --json
```

Exit codes match the PR path (`0` clean · `1` NOT VERIFIED · `2` INSUFFICIENT · `3` error), plus
`4` for a refused loop attempt. Whether a failure is worth **retrying** is a separate field,
`retryable`, in `--json`.

### The loop

`--loop` makes the run one counted attempt in a bounded session. The *fix* step is the agent's own
work, not Felix's — Felix does not shell out to a model — so the protocol the agent follows lives
in [`skills/felix-preflight-loop/SKILL.md`](skills/felix-preflight-loop/SKILL.md), and what has to
be machine-checked lives here.

```bash
node bin/felix.js preflight --loop --json          # attempt N of 5
node bin/felix.js preflight --loop --max-attempts 8
node bin/felix.js preflight --loop --reset-loop    # new budget, new criteria pin
```

Two things are enforced in code rather than asked for in prose, because a protocol document is
followed by exactly the entity it is supposed to bound:

- **A ceiling.** Five attempts per session by default, charged on entry, keyed on the repo path.
  Past it Felix refuses: nothing is installed, run or judged, `verdict` is `null` and the exit code
  is `4`. It bounds thrash, and it bounds rolling an unconverged diff against a non-deterministic
  judge until a green comes up. Durable state also survives an agent whose context was compacted
  mid-loop and no longer remembers it is on attempt four.
- **A criteria pin.** Attempt 1 records the criteria fingerprint; any later attempt that moves it
  halts the loop with `spec_changed` — including deleting the file, which would otherwise report as
  `no_spec` and tell the wrong story. Editing away a criterion the code fails is a cheaper route to
  green than fixing the code, and a loop that can rewrite its own rubric makes the verifier
  decorative. Relief is `--reset-loop`, which is a deliberate act a human can see.

Both are **tripwires, not walls**, and both say so in their own refusal text: `--loop` is a flag the
caller can omit and the state is a file the caller can delete. The achievable goal is that skipping
them is an *act* that appears in the agent's transcript. A plain `felix preflight` during a live
session runs uncounted and prints one line saying it did.

### What it will and will not do

**It publishes nothing.** No `felix_verdicts` row, no PR comment, no check run. It does not need
`GITHUB_TOKEN` or any `SUPABASE_*` variable, and `scripts/probe-preflight-containment.js` asserts
all of that — including a control leg proving the CI path *does* load what pre-flight does not.
This is not politeness. The freeze baseline is the earliest `spec_fingerprint` logged for a PR, so
a single local row would let an agent pin its own rubric; and `judge_attempted` rows are what the
ten-attempt cap counts, so a local loop could drain CI's budget from outside.

**Only two causes are retryable by a loop:** `criteria_unmet` and `install_failed` — the two states
where the fix is in the code. Everything else is terminal, and two of them are the hard line:

> `no_spec` and `spec_too_large` stay terminal for any agent. The moment a loop can author or trim
> the rubric, the verifier grades a spec written by the thing being graded, and it is decorative.

**There is deliberately no CI auto-repair.** `required_to_pass` and the judge's reasons are derived
from head content, so piping them to an agent that holds push credentials is a prompt-injection
channel. Locally the same text is not a channel — the agent already owns the tree it is reading
back — which is the whole reason the loop belongs here and not there.

### Spend, honestly

The judge is **off** unless you pass `--judge`. Beyond that:

- pre-flight refuses to re-grade a tree that is byte-identical to the last one it graded (the
  snapshot SHA is deterministic in tree + HEAD), because a re-roll buys judge variance, not
  information;
- a per-day counter (`FELIX_PREFLIGHT_JUDGE_CAP`, default 20) lives outside your repo in the
  system temp directory;
- set **`OPENAI_API_KEY_PREFLIGHT`** to a key with a hard spend limit at the vendor. Pre-flight
  prefers it over `OPENAI_API_KEY` and warns when it has to fall back.

Only that last one is a real limit. The counter is a file, and the process invoking the CLI can
delete it — its value is that doing so is a visible act rather than silent overspend.

### Criteria provenance

Pre-flight prints the fingerprint of the criteria it graded. CI pins the fingerprint of whatever
the **PR description** says. Same text, same hash — so if the two differ, the criteria moved
between your last local green and the PR you opened. Nothing enforces this locally; it is there so
a human can see it, in the same place CI shows its own hash.

### Calibration

Record real post-merge outcomes and see how Felix is doing over time:

```bash
node bin/felix.js outcome owner/repo#42 defect      # or: clean (manual)
node bin/felix.js scan-outcomes --repo owner/repo   # auto-mark reverted PRs as defects
node bin/felix.js metrics --repo owner/repo         # confusion matrix + precision/recall
```

Apply the calibration columns once by pasting `sql/felix-calibration-schema.sql` into your Supabase SQL editor (or `psql`).

## Use it in ANY repo (one step)

Felix is published as a reusable composite GitHub Action. In any repository, add
`.github/workflows/felix.yml`:

```yaml
name: Felix PR Verification
on:
  pull_request:
    types: [opened, synchronize, reopened, edited, ready_for_review]
permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write
jobs:
  felix:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: Eatmorerats/felix@main    # the Felix action
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

That's it. Add the `OPENAI_API_KEY` repo secret (and optionally `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY`), and Felix runs on every PR — it **learns your repo**
automatically (node/python/go/rust) or reads a `felix.config.json` at your root.
A ready-to-copy template lives at [`examples/felix.yml`](./examples/felix.yml).
Pin to a tag/SHA instead of `@main` for stability.

**Action inputs:** `mode` (`verify` default / `spec-sentinel`), `judge-family` (`openai` default
/ `gemini`), `openai-api-key` **or** `gemini-api-key` (set the one matching `judge-family`),
`github-token`, `judge-model`, `supabase-url`, `supabase-service-role-key`, `repo-path`, `post`,
`node-version` — see [`action.yml`](./action.yml).

If you turn gating on, add the second workflow too —
[`examples/felix-spec-sentinel.yml`](./examples/felix-spec-sentinel.yml) re-checks the
acceptance-criteria pin when the PR description is edited, without re-running the pipeline. See
[the criteria freeze](#the-criteria-freeze-and-the-judge-attempt-cap).

To run Felix on this repo's own PRs, add a `.github/workflows/felix.yml` — see [`examples/felix.yml`](examples/felix.yml).

## Configuration

`felix.config.json` at the target repo root is authoritative; anything it omits
is auto-detected. See [`felix.config.example.json`](./felix.config.example.json).
Auto-detection currently covers **node/ts, python, go, rust**.

### Which half of the config a pull request can change

This file is written by whoever opens the PR, so it is split at a trust boundary. **A pull
request cannot change the policy it is judged by.**

| | Fields | Read from |
|---|---|---|
| **Policy** | `skipGlobs` · `workdir` · `gating` · `isolation` · `secrets` · `timeouts` · `smoke` · `crap` · `deps` · `drive` · `judge` | the **base ref** — the PR's own copy is ignored |
| **Mechanics** | `language` · `commands` · `test` | the **PR head** |

Policy is read from `felix.config.json` at `pull_request.base.sha`. Change it the way you
change any other protected thing: open a PR, get it reviewed, merge it. It takes effect for
PRs opened *after* it lands. If the base ref has no config, policy is the built-in defaults —
never the PR's values. If the base ref can't be read at all, Felix **refuses to verify** rather
than fall back to head.

Mechanics come from head on purpose: a PR that adds a test runner, renames a script or
switches tooling has to be verified with *its* commands. Note this means `commands.test` is
still PR-controlled — but so is the `package.json` script it usually points at, so locking it
to base would buy nothing. What covers that is the rule below.

**Felix's own control surface is never skipped.** `felix.config.json`, `package.json` (at any
depth) and `.github/workflows/**` are always treated as behavioural, whatever `skipGlobs` says
— the default globs would otherwise let a PR touching only those merge unverified and change
the base that everything above trusts. The practical effect: **dependency-bump PRs now get
fully verified instead of skipped.** That is intended; a lockfile bump is behavioural.

> **Marking the check Required?** Just turn gating on in the base config:
>
> ```json
> "gating": { "enabled": true }
> ```
>
> which resolves to `blockOn: ["NOT VERIFIED", "INSUFFICIENT EVIDENCE"]` and
> `insufficientExempt: ["judge_unconfigured"]`.
>
> Insufficiency is in the default `blockOn` because GitHub counts `neutral` and `skipped`
> as *passing*, and INSUFFICIENT EVIDENCE maps to `neutral` — so a gate that ignores it
> lets a PR with no acceptance criteria, a broken install, or a fork PR merge unverified.
> A gate that passes on "I could not verify this" is not a gate.
>
> **Gating is still off by default**, so this changes nothing for advisory adopters. To keep
> the older, looser behaviour on a repo that already gates, write it out explicitly —
> `"blockOn": ["NOT VERIFIED"]` — and an explicit value is always preserved verbatim.

#### Why insufficiency is not one thing

INSUFFICIENT EVIDENCE has several causes and they are not equally safe to let through.
Every verdict carries a machine-readable `cause`, and `insufficientExempt` names the ones a
gated repo will still pass on. The axis is **can head content reach this state**, not "can
the contributor fix it":

| cause | reachable from the PR? | default |
| --- | --- | --- |
| `install_failed` | ✅ yes — `"preinstall": "exit 1"` | 🔒 blocks |
| `no_spec` | ✅ yes — and cheapest of all: write no acceptance criteria | 🔒 blocks |
| `fork` | ✅ yes — *selectable*: open the PR from a fork and the judge is skipped | 🔒 blocks |
| `judge_error` | ✅ yes — the judge call itself failed ([the cheapest levers are now closed up front](#the-acceptance-criteria-are-capped)) | 🔒 blocks |
| `judge_unconfigured` | ❌ no — it is your own missing key | 🔓 exempt |
| `judge_unavailable_unknown` | ⚠️ residual — the judge returned nothing and recorded no reason | 🔒 blocks |

`fork` blocks even though an outside contributor cannot un-fork their PR. That is
deliberate: it is the cheapest bypass in the whole system, so leaving it open would make
every other row decorative. The relief valve is the `overrideLabel`, which needs write
access an outside contributor does not have. A fork-heavy project that accepts the trade
can add `"fork"` to `insufficientExempt` — one reviewable line, in the base config.

`insufficientExempt` is an **exemption** list rather than an inclusion list so that a cause
added by a future Felix version blocks by default instead of silently passing. Unrecognized
values in either array are a **hard config error** — previously a typo like
`"INSUFFICENT EVIDENCE"` matched nothing and silently left the repo with no gate at all.

`judge_unavailable_unknown` is that principle applied inside the engine: it is a live branch,
not dead code, reached whenever the judge yields no result and none of the named reasons
applies. It blocks, so a state nobody anticipated costs a red check and a bug report rather
than a quiet green.

### The criteria freeze and the judge attempt cap

Felix grades criteria the **author** writes, in the PR description, using a judge that is **not
deterministic**. A green check therefore says "*this* set was met, *once*" — and both of those
words need pinning. Two `NOT VERIFIED` causes do it, and neither can be added to
`insufficientExempt`: nobody should be able to configure "a PR that rewrites its own rubric
passes my gate".

| cause | what it catches | relief |
| --- | --- | --- |
| `spec_changed` | the acceptance criteria moved after Felix graded them | put the criteria back — the hash matches again and grading resumes, no push and no human. Or the maintainer `overrideLabel`. |
| `attempts_exhausted` | the PR has used all `judge.maxJudgeRuns` (default 10) lifetime judge calls | maintainer `overrideLabel`, or split the remaining work into a new PR with its own budget |

The pin is a SHA-256 of the deduped, normalised, **sorted** criteria texts, so reordering bullets
is free and any add, delete or reword trips it. No algorithm can tell a typo fix from a
weakening, so both trip it and both route through the relief valve above — that is the intended
trade, not a gap. The baseline is the **earliest** fingerprint recorded for the PR, so a drifted
spec cannot re-pin itself just by being logged. The attempt count is **lifetime per PR**, read
from the verdict log before the spend, so pushing again does not buy a fresh roll of the dice.

**Both require the verdict log** (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) — they are not
features computed from the log, they *are* the log. So when the store does not answer:

- **advisory** (the default): Felix warns, says "❓ not enforced" on the comment, and proceeds.
  Nothing it reports can block a merge, so an unproven control changes no outcome.
- **`gating.enabled: true`**: Felix **refuses** — it publishes a `failure` check run and exits
  non-zero rather than a verdict that silently rests on two checks that did not run. **This is a
  behaviour change: a gated repo with no verdict store will refuse every non-fork PR that has real
  criteria.** Set the two secrets, or apply the `overrideLabel`.

Two limits worth knowing, neither hidden:

- `gating.enabled` is a **proxy** for "the Felix checks are marked Required in branch protection",
  and the two can disagree. If you mark the checks Required but leave `gating.enabled` false, you
  forfeit the store-outage refusal above.
- Criteria may live in a **linked issue**, and editing an issue fires no pull-request event at
  all. Nothing re-checks the pin until the next run on that PR.

#### The number 10, measured — 2026-08-14

**`maxJudgeRuns: 10` is no longer a guess.** The frozen reference case was rolled **600 times**
through the real OpenAI seat at temperature 0: **600 valid rolls, 0 errors, ZERO false greens.**
Exact Clopper-Pearson one-sided 95% upper bound on the per-roll false-green rate: **0.498%**. The
bar for a cap of 10 at a 5% ceiling is 0.5116%, so it clears — and it clears under the **union
bound** as well (10 × 0.498% = 4.98% < 5%), which needs no independence assumption between rolls.
Record: `variance-2026-08-openai-solo.json`.

What that does **not** license, and the distinction is the whole point:

- It is **one case, and a decisively-unmet one.** The cap exists for *borderline* cases, where the
  flip rate is highest and where a resubmitting agent actually operates. This result supports
  **keeping** 10. It does not support **raising** it. A borderline fixture is the missing measurement.
- It is the **solo OpenAI seat**. That still bounds the two-vendor jury, because `mergeJuryResults`
  requires unanimity for a criterion to be met — a jury false green needs the OpenAI seat to have
  flipped too. It bounds nothing about a **gemini-only** seat.
- **Temperature 0 did not make the judge deterministic.** A 30-roll probe returned **26 distinct
  judge texts**. Had the outputs been byte-identical the bound would have been fiction — one
  computation replayed 600 times, not 600 draws. The JSON record now stores a `textDigest` per roll
  so this is checkable rather than assumed.

⚠️ **Known defect, not yet fixed:** the script prescribes its k with the rule of three
(`3/p` → 587) but reports the achieved bound with **Wilson**, which at zero events is ≈ `z²/n`
(3.84/n). Two different estimators, so the k it tells you to run can never pass the bar it then
applies — Wilson needs 748. The measurement above is graded with Clopper-Pearson by hand. The fix is
to report CP and prescribe k by inverting *the same* estimator.

#### How to re-check it

`scripts/smoke-judge-variance.js` re-rolls one **frozen** diff + spec (`test/fixtures/judge-variance-case.js`) through
the real judge and reports how much the answer moved. Both shipped providers already send
`temperature: 0`, so it measures production config — temp 0 bounds the sampler, it does not make a
vendor's kernels deterministic.

```bash
npm run measure:variance                                   # plan + cost, calls nothing
node scripts/smoke-judge-variance.js --spend --k 600       # a result with actual power
npm run test:variance                                      # rehearse the maths offline, free
```

**It does not spend by default.** Every roll is a live billed call, so without `--spend` it prints
the measured prompt size, the call count and a cost estimate, and exits having called nothing. It is
not part of `npm test`.

The result to be careful with is the *clean* one. Zero flips in 20 rolls reads like determinism and
is not: zero events at k=20 still allows a per-roll rate near 15%, and at 15% ten rolls find a false
green more often than not. The report says so on every run rather than leaving you to remember it,
and names the k a real conclusion needs — **~587 rolls** to defend a cap of 10 at a 5% ceiling,
roughly a dollar at current prices (587 is the *rule-of-three* k; see the estimator defect above —
grading with Wilson instead needs 748, and with Clopper-Pearson 585). Under-powered null results are the failure mode this script is
shaped around, which is why `npm run test:variance` drives the whole report against a *seeded* judge
at a known flip rate and asserts the arithmetic recovers it. Rehearsals are stamped `synthetic` in
both the report and the JSON record so one can never be filed as a measurement.

#### Re-checking the pin when the description is edited

The freeze only fires when Felix runs, and Felix runs on the events *your* workflow lists. A
workflow that omits `edited` sees nothing when the body changes — and "edit the criteria after
the final green, then merge" needs no push. Adding `edited` to the main workflow works, but pays
for a full checkout, install and test suite on every typo fix, which is why people trim it.

[`examples/felix-spec-sentinel.yml`](./examples/felix-spec-sentinel.yml) is the cheap version. It
recomputes **only** the fingerprint from the PR body and its linked issues, and publishes its own
check run:

| | |
| --- | --- |
| 🔒 **frozen** | unchanged since Felix graded it |
| 📌 **not pinned** | Felix has not graded these criteria yet |
| ⚠️ **CHANGED** | the criteria moved. Restore them and this goes green on its own. |

It checks out nothing, installs nothing, runs no PR code and never calls the judge — which is
what makes `pull_request_target` (needed so the sentinel also works on fork PRs) safe here.
`scripts/smoke-spec-sentinel.js` asserts that against the actual request log; it runs in CI.

It deliberately does **not** write the `Felix verdict` check: sharing the name would let the
sentinel overwrite a verdict it did not make, and after a revert there would be no drift and so
nothing to write — leaving the verdict stuck red until someone pushed. **If you gate on Felix,
mark both `Felix verdict` and `Felix spec pin` Required.**

### Driving the app (opt-in)

Building and testing a PR can pass while the running app is broken. When `drive.enabled`,
Felix boots the app's start command, waits for it to answer, and probes each declared route
as **hard** Tier 1 checks — an HTTP 404/500 or no-boot fails the verdict. With
`drive.pageLoad.enabled` it also does a **headless render** (Playwright) that catches the
"200 but blank screen" class the HTTP probe can't: a blank `<body>` or an uncaught page error
is a hard fail. Auto-detect pre-fills a disabled `drive` block with a preview `startCommand`
for vite/next apps — flip `enabled: true` and list your routes. Default off, so non-web repos
are unaffected. Playwright is opt-in (a soft skip if it isn't installed — a missing dev tool
never flips a verdict). See the `drive` block in
[`felix.config.example.json`](./felix.config.example.json).

### Interaction flows (opt-in)

A page that loads is not a page that *works*. "The button does nothing", "the form submits and
nothing happens", "login accepts a wrong password" all pass an HTTP probe **and** a headless
render — and they're usually exactly what the PR is claiming. `drive.flows` adds named
click-and-assert sequences run against the running app; a failed flow is a **hard** Tier 1
check:

```json
"flows": [{
  "name": "login rejects a bad password",
  "path": "/login",
  "steps": [
    { "fill": "#email", "value": "test@example.com" },
    { "fill": "#password", "valueEnv": "FELIX_FLOW_BAD_PASSWORD" },
    { "click": "button[type=submit]" },
    { "expectText": "Invalid credentials" },
    { "expectNoText": "Welcome back" }
  ]
}]
```

Verbs: `goto` `click` `fill` `select` `press` `waitFor` `waitMs` `expectText` `expectNoText`
`expectSelector` `expectNoSelector` `expectUrl`.

This config is **attacker-controlled** — whoever opens the PR writes it — so the driver is
fenced on purpose:

| Guard | Why |
|---|---|
| Steps are data, not code — fixed verb table, no `evaluate` passthrough | A flow can only do what a user could do |
| `goto` takes a same-origin **path**, absolute URLs rejected | CI can't be turned into a beacon or an SSRF hop |
| `valueEnv` may only name `FELIX_FLOW_*` vars | A PR can't type `OPENAI_API_KEY` into a page it controls |
| Typed values are redacted everywhere (`fill #password ***`) | Credentials never reach the PR comment |
| A malformed flow is a hard **fail**, not a skip | A smoke test that quietly does nothing is worse than none |
| Browser missing ⇒ soft **skip** | A missing dev tool must never flip a verdict |

### CRAP — complex-and-under-tested changed functions (opt-in)

A suite that's green can still leave a tangled function with no tests behind it — exactly where
the next regression hides. CRAP (Change Risk Anti-Patterns) is the one signal only a tool that
*runs* the code can produce: it fuses **real coverage** with **cyclomatic complexity** on the
functions this PR actually changed.

```
CRAP(fn) = complexity² · (1 − coverage)³ + complexity
```

Fully covered ⇒ the score collapses to raw complexity; fully uncovered ⇒ `complexity² +
complexity` (it explodes). Any changed function scoring over `crap.threshold` (default **30**;
crap4j convention — Uncle Bob drives to <6) is flagged. When `crap.enabled`, Felix runs the
suite once more under [`c8`](https://github.com/bcoe/c8) coverage and measures complexity with
`typhonjs-escomplex` on the changed `.js`/`.mjs`/`.cjs` files.

It is a **soft, advisory** row — it appears in the Tier 1 output and feeds the judge, but it
**never gates the verdict**. Off by default (the extra coverage run is opt-in). The design rule
that keeps it honest: **a data problem may only ever reduce the number of flags, never create
one.** Missing coverage, a parse failure, a path mismatch, or all-zero instrumentation each
downgrade to a labeled `skip` with a reason — never a false `cov=0` alarm. v1 is JS-only
(non-JS changed files are listed and skipped) and unsupported under `docker` isolation.

```json
"crap": { "enabled": true, "threshold": 30 }
```

### Secrets scanning

Felix's built-in secrets scan is a **changed-files backstop**, not an authoritative repo
scanner: it flags high-signal vendor shapes and high-entropy generic assignments in the PR's
changed files. For security-sensitive repos, set `secrets.externalScan` to a real scanner
(e.g. `gitleaks detect --no-git --redact`) — it runs as the **hard** gate and Felix demotes its
own scan to advisory. Use gitleaks, or trufflehog with verification **off** — never live
verification, which fires network requests using attacker-controlled PR content (SSRF/egress
risk on untrusted diffs).

**Both scanners run BEFORE `install`, on the pristine checkout.** Every later Tier 1 step
executes the PR's own scripts, and any of them can rewrite the file the scan is about to
read — so evidence gathered after them is evidence the PR was allowed to edit. One consequence
for adopters: **a scanner that arrives via the PR's own `npm install` no longer works**, and it
never really did. If the gate is installed by the party being gated, that party can pin its
version, shadow its binary, or overwrite it in `postinstall`. Install your scanner on the
runner instead — a workflow step, or a preinstalled binary. (In `isolation.mode: "docker"`
this was already true: the external scan runs with the network denied, so a fetch-on-demand
`npx <scanner>` has never worked there.)

The scan reads changed files from the **repo root**, not from `workdir`. Paths from the GitHub
API are repo-root-relative, so under a `workdir` the two disagreed and every read silently
missed — a repo with a workdir set got `no secrets in changed files` without a single file
being opened. If Felix cannot determine the root it now refuses the run rather than scanning
blind.

### Dependency direction (opt-in)

Building and testing a PR tells you nothing about the *shape* of its import graph. When
`deps.enabled`, Felix cruises the module graph of the **head** commit and the **base** commit
with [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) and flags what the PR
**newly** introduces: a new **circular import** (`a → b → a`), or a new edge that crosses a
**forbidden layer** you declared (e.g. "the engine must not import from `bin/`"). Both graphs
are built by the same cruiser, same version, same temp ruleset — so any fidelity gap degrades
both sides identically and cancels in the diff. A violation is only reported when it is (a)
absent from the base graph **and** (b) touches a file this PR changed, so a **pre-existing**
cycle the PR merely keeps is never re-flagged. It is **soft/advisory** in v1 — the row reads
`FLAG` / `ok` in words (never colour) and it never gates a verdict.

```json
"deps": {
  "enabled": true,
  "layers": [
    { "name": "engine-no-cli", "from": "src/engine/**", "to": "bin/**",
      "comment": "engine code must not reach the CLI entrypoints" }
  ]
}
```

`layers` is optional — with just `"enabled": true` you get full cycle detection and nothing
else. `node_modules` is always excluded; set `includeOnly` (a regex) to scope one package of a
monorepo. Both commits are cruised from **pristine detached worktrees** (never the just-built
sandbox), so the head and base graphs stay symmetric and a pre-existing structure never reads as
new. A missing base/head commit, a cruiser failure, a timeout, or a PR whose file list GitHub
truncated (>3000 files) **skips** with a labeled reason — a data problem may only ever *reduce*
the flags, never manufacture one.

v1 detects cycles and forbidden edges via **static relative-import analysis**; because both
sides are cruised without `node_modules`, a cycle mediated *only* through an installed workspace
package (a `@scope/pkg` symlink) is not resolved on either side — a deliberate symmetric miss, so
it under-reports rather than crying wolf. See the `deps` block in
[`felix.config.example.json`](./felix.config.example.json).

## Large PRs and rate limits

A judge prompt is sized against the **account's tokens-per-minute (TPM) rate limit**, not the
model's context window. These are different ceilings and the smaller one wins — gpt-4.1 has a
~1M-token window, but an org on a 30,000 TPM plan cannot send a 61,000-token request no matter
how well it would fit in context. Felix learned this the hard way on a large PR:

```
429 Request too large for gpt-4.1 … on tokens per min (TPM): Limit 30000, Requested 61227
```

When a PR's diff (plus criteria, Tier 1 output and instructions) doesn't fit the seat's budget,
Felix **splits the diff at file boundaries and judges it in several passes**, pacing the calls
so the run stays under the per-minute ceiling, then merges the results:

- a **concrete violation** in any part fails the criterion for the whole PR;
- otherwise **positive evidence** in any part carries it;
- if **no part** showed anything either way, the criterion is not met — silence is never a pass.

Each part is told it is seeing part *i* of *n* and can answer `not_shown`, so a judge never
reports "not met" for code it simply wasn't shown. If a PR is so large it exceeds the chunk
cap, the leftover files are **named in the verdict** and the coverage percentage is stated —
Felix degrades to *partial* evidence, never to a silent pass.

Budgets are **per vendor**, since each seat has its own quota (a funded Gemini key typically
judges in one pass while the OpenAI seat chunks the same diff).

| Variable | Default | What it does |
| --- | --- | --- |
| `FELIX_JUDGE_MAX_PROMPT_TOKENS` | per-vendor (openai 30k, gemini 200k) | Override every seat's prompt budget. Raise it if your account's TPM allows. Also lowers the criteria cap below. |
| `FELIX_JUDGE_MAX_CHUNKS` | `6` | Max judge calls per seat per PR. Higher = better coverage on huge PRs, more CI minutes. |

### The acceptance criteria are capped

Everything in a judge prompt that isn't the diff is **written by the pull request under
review** — the criteria come from its body and the issues it links, the Tier 1 rows carry its
changed-file paths, and the failing-check output is the stdout of its own code. Left unbounded,
any one of them can push the prompt past the seat budget on its own, and Felix reports
`judge_error`.

So the non-diff regions are budgeted as fractions of the **smallest seat Felix ships** — the
strictest one, regardless of which vendor keys your repo holds, so adding a second key never
silently changes whether a PR is gradeable:

| Region | Share of the seat budget | On overflow |
| --- | --- | --- |
| Acceptance criteria | 40% (~40,800 chars) | ❌ **blocks** — `spec_too_large` |
| Failing-check output | 15% | ✂️ truncated, with a marker the judge can read |
| Tier 1 result rows | 5% | ✂️ truncated, with a marker the judge can read |

**Why criteria block instead of truncating.** The criteria are *the question being asked*.
Grading a subset and reporting the result as complete isn't a degradation, it's a bypass: an
author pushes the one criterion their code violates past the cutoff and collects a pass on the
survivors. Tier 1 output is *evidence*, so showing less of it is honest as long as the judge can
see that it happened.

The cap applies to the **merged** set, after linked issues are folded in — Felix fetches up to
ten, each with its own 65,536-char GitHub body, so a cap on the PR body alone would defend
nothing. It is deliberately tighter than the failure it prevents: a maxed-out body alone could
never break the judge, but it still leaves no room for the diff.

An honest PR has enormous headroom — ten linked issues carrying twenty ~100-char criteria each
lands at about half the cap. If you do hit it, the check names the criterion count, the
character count and the limit; split the PR so each part carries its own spec.

`spec_too_large` is `NOT VERIFIED`, not insufficiency, and is **not** exemptable — it is the one
state that is entirely author-caused *and* entirely author-fixable, so no repo can configure it
to pass. Measured end-to-end by `npm run test:induction`.

## Safety

Felix runs untrusted PR scripts. Baseline mitigations: no secrets injected into the sandbox,
hard per-command timeouts with process-group kill, and the policy half of `felix.config.json`
read from the base ref so a PR cannot choose the rules it is judged by.

### `isolation.mode: "docker"`

Opt-in container jail for every Tier 1 command: no network except install, memory/CPU/pid caps,
a non-root user, `--cap-drop ALL`, and a read-only root with only the mounted worktree and `/tmp`
writable.

**It is now fail-closed, and that is adopter-visible.** Three configurations that used to run
anyway now stop the build with an error naming the exact line to change:

| Config | Was | Now |
| --- | --- | --- |
| `mode` not exactly `"none"` or `"docker"` — e.g. `"Docker"` | ran on the **host**, no warning | hard error |
| a misspelled key — e.g. `{"Mode": "docker"}` | ignored, so `mode` stayed `"none"` | hard error |
| `mode: "docker"` **and** `drive.startCommand` set | drive booted the app on the **host**, outside the jail | hard error — pick one |
| `mode: "docker"` where the runner has no docker | install "failed" → INSUFFICIENT EVIDENCE, which **passes** a Required check | hard error, before any PR code runs |

If a repo is running one of these today it is not jailed, whatever its config says. The fix is
one line; the error message tells you which.

Docker mode also sets `HOME`, `XDG_CACHE_HOME`, `npm_config_cache`, `GOPATH` and `CARGO_HOME`
into the `/tmp` tmpfs. Without that, the read-only root left `HOME=/` and `npm ci` died on `mkdir '/.npm'` — so docker
mode had never once completed a Node install. That is measured, not assumed: `npm run test:jail`
runs a real install in a real container *and* runs the pre-fix shape as a control that must fail. Two consequences
worth knowing: a test that reads `HOME` sees `/tmp`, and the package caches now count against
`isolation.tmpfsSize` (default raised `512m` → `1g`; raise it further for a heavy install).

**Python note:** under `--read-only`, `pip install` into the image's global `site-packages` fails.
Use a venv inside the worktree — `python -m venv .venv && .venv/bin/pip install -r requirements.txt`.

Known gap: a jailed `drive` does not exist. It needs a container lifecycle with orphan cleanup,
and publishing a port would force `--network bridge` — handing untrusted code the runtime egress
the net-deny test steps withhold. Felix's own browser would still render attacker-served pages on
the host. Refusing the combination is honest; a half-jail would not be.

### Untrusted content in the judge prompt

Everything variable in a judge prompt is attacker-controlled: the PR title and acceptance
criteria come from a PR body anyone can write, the diff is the submission itself, and a failing
Tier 1 check contributes up to 4 KB of **the PR's own stdout**. So each of those is wrapped in
marker lines carrying a fixed boundary token, and the token is **stripped from the content
before it is wrapped** — content that cannot contain the token cannot close its own fence. The
section headings around the blocks stay unfenced, so the judge can always tell operator
structure from submitted data, and the response schema is the last thing it reads.

This matters most on the cheapest channel, not the obvious one. `lint`, `typecheck`, `crap` and
`deps` are all `hard:false` — failing one costs a PR nothing — so a PR gets a free, deterministic
write into the judge's context, positioned *above* the diff, simply by making its own linter
print something.

### What the sandbox and the deps check pass to git

`git worktree add` performs a checkout, and a checkout runs the repository's `post-checkout`
hook. Both `sandbox.js` and `deps.js` call it, and both now pass an **allowlisted, secret-free
environment** (`src/engine/util/env.js`) rather than inheriting Felix's — which holds
`GITHUB_TOKEN` and every judge key.

Hooks are neither tracked by git nor transferred by clone, so a PR cannot ship one; Felix's own
ordering is what supplies the write. The sandbox is created, **then** the PR's install/build/test
runs with write access to the parent clone's `.git`, **then** the deps check calls
`git worktree add` twice more. `scripts/probe-hook-env-leak.js` reproduces the leak against real
git and fails loudly if its own pre-fix control stops leaking.

The two `git fetch` calls deliberately keep the parent environment: they are the only networked
git calls, credentials ride in the environment on some setups, and fetch runs no checkout hook.

Not closed by this: `actions/checkout` defaults to `persist-credentials: true`, which leaves a
usable `GITHUB_TOKEN` in `.git/config` where the untrusted step can simply read it. Cleaning the
environment does not touch that — it needs a workflow change.

## Tests

```bash
npm test        # 300 offline unit tests + 23 golden judge cases, no network
npm run test:crap   # end-to-end: real c8 + escomplex prove the CRAP criteria
npm run test:live   # end-to-end: drives a real browser against a real app (needs Playwright)
npm run test:jail   # end-to-end: a real npm install inside a real container (needs docker)
npm run test:hooks  # end-to-end: does `git worktree add` leak the env to a post-checkout hook?
```

`npm test` covers the pure/deterministic surface (config detection, spec parsing, the verdict
decision table, secret scanning, the CRAP fusion math, drive/page-load/flow grading).

`npm run test:crap` proves the CRAP check against the *real* toolchain, not mocks: it builds a
throwaway fixture, runs the actual suite under actual c8 coverage, measures complexity with the
actual escomplex, and asserts the three falsifiable criteria — an uncovered complexity-7
function flags with score **56**, the same function fully covered scores **7** (== its
complexity) and doesn't flag, and with the check disabled no coverage runs and no row appears.

`npm run test:live` proves the *driver* works, which unit tests structurally cannot: it boots a
real HTTP server with a real form and drives it in a real browser, asserting that a true
assertion passes **and that a false one actually fails**. A flow engine whose clicks silently
did nothing would pass every unit test while verifying nothing — the exact failure mode Felix
exists to catch. It skips cleanly (exit 0) when Playwright isn't installed:

```bash
npm i --no-save playwright-core && npx playwright install chromium
```
