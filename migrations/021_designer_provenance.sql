-- 021_designer_provenance.sql (SQLite)
-- Designer proposal generation (Phase C / Task 11): provenance metadata on the
-- existing design_proposals table (no new table) + generation idempotency.
-- All columns nullable per the Collection nullability rule. The partial
-- UNIQUE index backstops concurrent identical generation; manual designs
-- (no generation key) are unaffected.

ALTER TABLE design_proposals ADD COLUMN generation_key TEXT;
ALTER TABLE design_proposals ADD COLUMN source_report_id TEXT;
ALTER TABLE design_proposals ADD COLUMN generator_model TEXT;
ALTER TABLE design_proposals ADD COLUMN rationale TEXT;
ALTER TABLE design_proposals ADD COLUMN uncertainty TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_design_proposals_generation_key
  ON design_proposals(generation_key)
  WHERE generation_key IS NOT NULL;
