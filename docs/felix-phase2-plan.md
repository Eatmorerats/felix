# Felix — Phase 2 plan (hardening)

Phase 1 shipped a working, repo-agnostic behavioral PR-verifier running on every
PR via GitHub Actions. Phase 2 hardens the two areas flagged as follow-ups:
**sandbox isolation** and **auto-trigger robustness**.

## 1. Sandbox isolation — _done (#2)_

Tier 1 runs untrusted PR scripts. Phase 1 ran them on the host with a clean env
and hard timeouts. Phase 2 adds an **opt-in container jail** (`isolation.mode:
"docker"`):

- **No network** for every step except `install` (which needs the registry).
- **Resource caps** — `--memory`, `--cpus`, `--pids-limit`.
- **Least privilege** — non-root (`-u $(id -u)`), `--cap-drop ALL`,
  `--security-opt no-new-privileges`, `--read-only` root FS with only the
  mounted worktree + a `tmpfs /tmp` writable.
- **Language-aware image** — defaults to `node:20` / `python:3.12` /
  `golang:1.22` / `rust:1` based on auto-detection; override via `isolation.image`.

Default stays `mode: "none"` so existing repos are unaffected. Implemented in
`src/engine/isolation.js`, wired through `tier1.js`; the command-wrapping is
unit-tested without requiring Docker.

**Remaining:** an Actions runner image with Docker (ubuntu-latest has it); a CI
matrix or example repo proving a docker-isolated run end to end; egress
allow-list for installs that need private registries.

## 2. Auto-trigger hardening — _done_

- ✅ **Fork PRs:** `triggerGate` detects forks (`head.repo.fork` or a differing
  repo name); the judge is skipped with a clear "judge skipped on fork" note,
  and comment posting is best-effort (fork tokens are read-only).
- ✅ **Drafts:** skipped at the workflow level (`if: draft == false`) and
  deferred in the engine (SKIPPED with a reason); `ready_for_review` re-runs.
- ✅ **Path filters:** workflow `paths-ignore` for docs/markdown/text so pure-docs
  PRs don't spin a runner (complements the in-engine `skipGlobs` triage).
- ✅ **Self-error reporting:** if Felix itself throws, `reportError` posts a
  diagnostic comment instead of a silent CI red.
- ✅ **Real check run:** _done (#4)_ — the verdict is published via the Checks API
  (`createCheckRun`, idempotent per head SHA) as a first-class,
  branch-protection-gateable status: VERIFIED→success, NOT VERIFIED→failure,
  INSUFFICIENT→neutral, SKIPPED→skipped.
- ✅ **Least-privilege token:** _done (#4)_ — workflow `permissions` scoped to
  exactly `contents:read`, `pull-requests:write`, `issues:write`, `checks:write`.

## 3. Stretch

- Tier 2 static signals (lint/typecheck) feeding the judge.
- Calibration: store escaped-defect outcomes to tune the verdict thresholds
  (the schema already reserves room for this).
