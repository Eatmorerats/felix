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
| ❌ `NOT VERIFIED` | A hard check failed, or the judge found a criterion unmet. |
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

**Action inputs:** `judge-family` (`openai` default / `gemini`), `openai-api-key`
**or** `gemini-api-key` (set the one matching `judge-family`), `github-token`,
`judge-model`, `supabase-url`, `supabase-service-role-key`, `repo-path`, `post`,
`node-version` — see [`action.yml`](./action.yml).

To run Felix on this repo's own PRs, add a `.github/workflows/felix.yml` — see [`examples/felix.yml`](examples/felix.yml).

## Configuration

`felix.config.json` at the target repo root is authoritative; anything it omits
is auto-detected. See [`felix.config.example.json`](./felix.config.example.json).
Auto-detection currently covers **node/ts, python, go, rust**.

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
| `FELIX_JUDGE_MAX_PROMPT_TOKENS` | per-vendor (openai 30k, gemini 200k) | Override every seat's prompt budget. Raise it if your account's TPM allows. |
| `FELIX_JUDGE_MAX_CHUNKS` | `6` | Max judge calls per seat per PR. Higher = better coverage on huge PRs, more CI minutes. |

## Safety

Felix runs untrusted PR scripts. Phase 1 mitigations: hand-run on trusted repos,
no secrets injected into the sandbox, hard per-command timeouts with process-group
kill. Stronger isolation (container/VM, egress limits) is a later phase.

## Tests

```bash
npm test        # 191 offline unit tests, no network
npm run test:crap   # end-to-end: real c8 + escomplex prove the CRAP criteria
npm run test:live   # end-to-end: drives a real browser against a real app (needs Playwright)
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
