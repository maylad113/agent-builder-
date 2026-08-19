-- 018_lead_research.sql (PostgreSQL)
-- PG parity for migrations/017_lead_research.sql (SQLite).
-- Nullable optional columns per the Collection nullability rule.

CREATE TABLE IF NOT EXISTS lead_research_reports (
  id                 TEXT PRIMARY KEY,
  prospect_id        TEXT NOT NULL REFERENCES prospects(id),
  status             TEXT NOT NULL,
  input_source       TEXT,
  input_text_excerpt TEXT,
  report             TEXT,
  llm_model          TEXT,
  score              INTEGER,
  score_band         TEXT,
  score_reasons      TEXT,
  error              TEXT,
  idempotency_key    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_research_idem ON lead_research_reports(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_lead_research_prospect ON lead_research_reports(prospect_id);
CREATE INDEX IF NOT EXISTS idx_lead_research_status ON lead_research_reports(status);
