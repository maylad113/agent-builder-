-- 019_discovery_acceptance.sql (SQLite)
-- Discovery acceptance bridge (Phase C / Task 5): each discovery result can be
-- linked to AT MOST one prospect. The partial UNIQUE index is the database
-- backstop for concurrent acceptance (application checks alone race).
-- Rows without a discovery result (manually created prospects) are unaffected.

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_discovery_result
  ON prospects(discovery_result_id)
  WHERE discovery_result_id IS NOT NULL;
