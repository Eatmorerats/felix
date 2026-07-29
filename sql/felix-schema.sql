-- Felix Schema v0.1 (Phase 1)
-- One row per PR verification run. Calibration / escaped-defect columns
-- come in Phase 4/5. Apply by pasting this file into your Supabase SQL editor (or psql).

CREATE TABLE IF NOT EXISTS felix_verdicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_title TEXT,
  head_sha TEXT,
  base_sha TEXT,

  -- VERIFIED | NOT VERIFIED | INSUFFICIENT EVIDENCE | SKIPPED
  verdict TEXT NOT NULL,

  -- Where the spec came from (e.g. "GitHub issue #123") or null if none found
  spec_source TEXT,
  criteria_total INTEGER DEFAULT 0,
  criteria_mapped INTEGER DEFAULT 0,

  -- Per-check Tier 1 results [{name, tier, status, hard, detail}]
  tier1_results JSONB,
  -- Cross-family judge output {family, model, assessment, criteria:[{text,met}]}
  tier3 JSONB,
  -- Actionable "Required to pass" bullets shown in the comment
  required_to_pass JSONB,

  judge_family TEXT,
  judge_model TEXT,
  duration_ms INTEGER,
  felix_version TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_felix_verdicts_repo_pr ON felix_verdicts (repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_felix_verdicts_created ON felix_verdicts (created_at DESC);

-- Row-Level Security: ON, with NO policies (service-role-only).
-- Felix reads/writes this table with the Supabase SERVICE-ROLE key (see log.js), which
-- BYPASSES RLS — so enabling it does not affect Felix. But with RLS on and no policies,
-- every anon/publishable-key request is denied. This is an internal CI verdict log; nothing
-- client-side should ever read or write it, so service-role-only is the correct posture.
-- (Supabase creates tables with RLS OFF by default — this line is required, not optional.)
-- Idempotent: re-running ENABLE on an already-enabled table is a no-op.
ALTER TABLE felix_verdicts ENABLE ROW LEVEL SECURITY;
