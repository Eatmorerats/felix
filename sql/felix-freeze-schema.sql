-- Felix spec-freeze + judge attempt cap (adds to felix_verdicts)
--
-- Apply by pasting this file into your Supabase SQL editor (or psql), after
-- felix-schema.sql. There is no SUPABASE_DB_PASSWORD in .env, so nothing in this
-- repo can apply it for you — it is a deliberate hand step.
--
-- RLS: inherited from felix_verdicts, which felix-schema.sql created with RLS
-- ENABLED and no policies (service-role-only). This migration only ADDS COLUMNS to
-- that table, so it needs no RLS statement of its own and grants no new access.
-- Felix reads/writes with the service-role key, which bypasses RLS; every anon or
-- publishable-key request stays denied. Do not add a policy here.

-- ---------------------------------------------------------------------------
-- cause — the machine-readable WHY behind the verdict (verdict.js CAUSES).
--
-- The verdict text alone cannot distinguish the lanes a PR can drive from the one
-- it cannot: "INSUFFICIENT EVIDENCE" is six different situations wearing one label,
-- and gating.js keys its exemptions on the cause, not the verdict. Logging the
-- verdict without the cause records the label and discards the contract.
-- ---------------------------------------------------------------------------
ALTER TABLE felix_verdicts ADD COLUMN IF NOT EXISTS cause TEXT;

-- ---------------------------------------------------------------------------
-- spec_fingerprint — SHA-256 of the deduped, sorted criteria texts this run was
-- graded against (spec.js specFingerprint).
--
-- This is the pin behind the `spec_changed` cause. Criteria are read out of the PR
-- body, which the author keeps write access to, and Felix runs once per PUSH and
-- never on `pull_request: edited` — so without a recorded baseline a PR can be
-- graded against one criteria set and merged displaying another. The EARLIEST
-- non-null value for a (repo, pr_number) is the baseline; later rows are compared
-- against it, never promoted over it.
-- ---------------------------------------------------------------------------
ALTER TABLE felix_verdicts ADD COLUMN IF NOT EXISTS spec_fingerprint TEXT;

-- ---------------------------------------------------------------------------
-- judge_attempted — did this run actually spend a cross-family judge call?
--
-- The bound behind `attempts_exhausted`. The judge is stochastic, so re-running an
-- unchanged diff is a resampling attack; the cap counts LIFETIME attempts per
-- (repo, pr_number) so a fresh push cannot reset it. Runs that skipped the judge
-- (triage, no spec, fork, over-limit spec) rolled no dice and must not be charged,
-- which is why this is a distinct column and not a count of rows.
-- ---------------------------------------------------------------------------
ALTER TABLE felix_verdicts ADD COLUMN IF NOT EXISTS judge_attempted BOOLEAN NOT NULL DEFAULT FALSE;

-- The freeze/cap read filters on (repo, pr_number) and orders by created_at; the
-- existing idx_felix_verdicts_repo_pr covers the filter. This one is for analysis
-- ("how often does spec_changed fire?"), not for the hot path.
CREATE INDEX IF NOT EXISTS idx_felix_verdicts_cause ON felix_verdicts (cause);
