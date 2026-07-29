-- Felix calibration columns (Phase 3)
-- Records the real post-merge outcome of each verified PR so precision/recall
-- can be computed over time. Apply by pasting this file into your Supabase SQL
-- editor (or psql) after felix-schema.sql.

-- RLS: inherited from felix_verdicts (enabled service-role-only in felix-schema.sql);
-- this migration only adds columns to that table, so no separate RLS statement is needed.

-- clean | defect | unknown  (unknown / NULL = not yet recorded)
ALTER TABLE felix_verdicts ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE felix_verdicts ADD COLUMN IF NOT EXISTS outcome_recorded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_felix_verdicts_outcome ON felix_verdicts (outcome);
