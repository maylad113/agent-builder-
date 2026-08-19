-- 018_discovery.sql (SQLite)
-- Lead discovery foundation (Phase C / Task 4): durable discovery runs and
-- untrusted candidate results. Platform-owner scope (pre-tenant) — results
-- carry no business_id; tenant assignment happens only at human accept time.

CREATE TABLE IF NOT EXISTS discovery_runs (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  params           TEXT,
  status           TEXT NOT NULL,
  result_count     INTEGER NOT NULL DEFAULT 0,
  duplicate_count  INTEGER NOT NULL DEFAULT 0,
  invalid_count    INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  idempotency_key  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_runs_idem ON discovery_runs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_status ON discovery_runs(status);

CREATE TABLE IF NOT EXISTS discovery_results (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES discovery_runs(id),
  prospect_id     TEXT REFERENCES prospects(id),
  source_provider TEXT NOT NULL,
  source_url      TEXT,
  source_type     TEXT NOT NULL,
  raw             TEXT,
  normalized      TEXT NOT NULL,
  verification    TEXT NOT NULL DEFAULT 'UNVERIFIED',
  dismissed_at    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_results_run ON discovery_results(run_id);
CREATE INDEX IF NOT EXISTS idx_discovery_results_prospect ON discovery_results(prospect_id);

ALTER TABLE prospects ADD COLUMN discovery_result_id TEXT REFERENCES discovery_results(id);
