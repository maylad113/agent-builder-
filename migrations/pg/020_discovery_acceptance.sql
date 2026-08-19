-- 020_discovery_acceptance.sql (PostgreSQL)
-- PG parity for migrations/019_discovery_acceptance.sql (SQLite).
-- Partial UNIQUE index: one prospect per discovery result, concurrency backstop.

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_discovery_result
  ON prospects(discovery_result_id)
  WHERE discovery_result_id IS NOT NULL;
