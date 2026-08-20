-- 022_designer_provenance.sql (PostgreSQL)
-- PG parity for migrations/021_designer_provenance.sql (SQLite).
-- All columns nullable per the Collection nullability rule.

ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS generation_key TEXT;
ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS source_report_id TEXT;
ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS generator_model TEXT;
ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS rationale TEXT;
ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS uncertainty TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_design_proposals_generation_key
  ON design_proposals(generation_key)
  WHERE generation_key IS NOT NULL;
