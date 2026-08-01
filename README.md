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
| `judge_error` | ✅ yes — criteria come from the PR body and can be sized to break the judge | 🔒 blocks |
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
| `FELIX_JUDGE_MAX_PROMPT_TOKENS` | per-vendor (openai 30k, gemini 200k) | Override every seat's prompt budget. Raise it if your account's TPM allows. |
| `FELIX_JUDGE_MAX_CHUNKS` | `6` | Max judge calls per seat per PR. Higher = better coverage on huge PRs, more CI minutes. |

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
