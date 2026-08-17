-- 012_correction.sql
-- Self-correction loop audit records (Phase: self-correction engine).
-- Each row is one correction RUN (GENERATE -> EVALUATE -> CLASSIFY -> CORRECT
-- -> RE-EVALUATE). The full per-attempt audit (proposal, action, affected
-- version, resulting version, re-evaluation id, attempt number, timestamp) is
-- stored as JSON in `attempts`. Indexed columns support tenant-scoped listing.

CREATE TABLE IF NOT EXISTS correction_runs (
  id                    TEXT PRIMARY KEY,
  business_id           TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  start_version_id      TEXT NOT NULL,
  final_version_id      TEXT NOT NULL,
  resolved              INTEGER NOT NULL,
  human_review_required INTEGER NOT NULL,
  max_attempts          INTEGER NOT NULL,
  attempts              TEXT NOT NULL DEFAULT '[]',
  final_evaluation_id   TEXT,
  final_evaluation_passed INTEGER NOT NULL DEFAULT 0,
  reason                TEXT,
  timestamp             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_correction_runs_business ON correction_runs(business_id);
CREATE INDEX IF NOT EXISTS idx_correction_runs_agent ON correction_runs(agent_id, timestamp);
