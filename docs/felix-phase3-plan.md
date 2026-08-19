# Felix — Phase 3 plan (sharper signals + authority)

Phase 1 made Felix work; Phase 2 hardened how it runs. Phase 3 makes its
verdicts **sharper** and lets it become **authoritative**.

## 1. Tier 2 static signals — _in progress (#5)_

Feed the cross-family judge more evidence than just build/test:

- **lint** and **typecheck** run as **soft** checks (never gate the verdict on
  their own) and are auto-detected for node (`scripts.lint`; `tsc --noEmit` when
  TypeScript/tsconfig is present). Their pass/fail + output flow into the judge
  prompt and the verdict comment automatically (both iterate the Tier 1 results).
- Opt-in/zero-config: omitted entirely when a repo defines none, so no new noise.

- ✅ Multi-language defaults: **go** (`go vet`), **rust** (`cargo clippy`), and
  **python** (`ruff`/`flake8` + `mypy`, gated on config presence so there's no
  noise). Node was the first cut.

**Next:** surface a distinct "static" section in the comment.

## 2. Calibration loop — _in progress (#6)_

- ✅ Schema: `outcome` (`clean|defect|unknown`) + `outcome_recorded_at` columns
  (`sql/felix-calibration-schema.sql`).
- ✅ `felix outcome <owner/repo#PR> <clean|defect>` records the real post-merge
  result on the PR's verdict rows.
- ✅ `felix metrics [--repo …]` reads the log and prints a confusion matrix +
  precision / recall / accuracy / escaped-defect count (`computeMetrics`, pure +
  tested). Felix is framed as a defect detector: NOT VERIFIED = positive.
- ✅ Auto-record: `felix scan-outcomes --repo …` scans recent commits for
  revert signals and marks the reverted PRs `defect` automatically.
- **Next:** trend over time, and use the metrics to tune hard-vs-soft weights +
  judge strictness.

## 3. Authoritative / gating mode — _done (#7)_

- ✅ `gating` config block: `enabled`, `blockOn` (default `["NOT VERIFIED"]`),
  `overrideLabel` (default `felix-override`). `gateDecision` is pure + tested.
- ✅ The decision shapes the **"Felix verdict" check-run conclusion**: blocks →
  `failure`, overridden → `neutral`, else the advisory mapping. Mark the check
  **Required** in branch protection to actually enforce.
- ✅ A maintainer PR label (`overrideLabel`) bypasses a block; the comment shows
  a gating / override note, and the CLI exit code follows the decision.
- Default stays advisory (`enabled: false`) — no behavior change unless opted in.
