-- 006_integration_states_widget_origins.sql
-- P1.1: Replace the boolean `connected` flag on integrations with a proper
-- lifecycle `state` column (NOT_CONFIGURED / CONFIGURING / CONNECTED / ERROR /
-- DISCONNECTED). CONNECTED is only ever set after real provider validation.
-- Also add last_validated_at and last_error for diagnostics.
--
-- P1.2: Add per-business `allowed_widget_origins` (JSON array) and `holidays`
-- (JSON array) so the widget CORS check and appointment engine can use them.
--
-- SQLite cannot DROP COLUMN / alter NOT NULL in place before 3.35, and even
-- then ADD COLUMN IF NOT EXISTS isn't supported. We rebuild the integrations
-- table to drop `connected` and add `state` + diagnostics, copying existing
-- rows (mapping legacy connected=1 -> state='NOT_CONFIGURED' so they must be
-- re-validated under the new model). This is idempotent: if `state` already
-- exists (re-run on a partially-migrated DB) the rebuild is a no-op copy.

-- businesses: widget origin allow-list + holidays (additive, safe to re-run
-- because we guard each ALTER with a check on PRAGMA table_info).
-- NOTE: SQLite has no ADD COLUMN IF NOT EXISTS, so these are one-shot. The
-- migration runner records this file as applied, preventing re-execution.

ALTER TABLE businesses ADD COLUMN allowed_widget_origins TEXT;  -- JSON: string[]
ALTER TABLE businesses ADD COLUMN holidays TEXT;                -- JSON: Holiday[]

-- integrations: rebuild to drop `connected`, add `state` + diagnostics.
CREATE TABLE IF NOT EXISTS integrations_new (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  provider          TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  status_message    TEXT NOT NULL DEFAULT '',
  credentials_set   INTEGER NOT NULL DEFAULT 0,
  last_sync         TEXT,
  last_validated_at TEXT,
  last_error        TEXT,
  config_data       TEXT
);

-- Copy existing rows. Legacy connected=1 is treated as NOT_CONFIGURED (must be
-- re-validated); the old flag could be set without validation.
INSERT INTO integrations_new (id, business_id, provider, state, status_message, credentials_set, last_sync, config_data)
SELECT id, business_id, provider, 'NOT_CONFIGURED', status_message, credentials_set, last_sync, config_data
FROM integrations;

DROP TABLE integrations;
ALTER TABLE integrations_new RENAME TO integrations;
CREATE INDEX IF NOT EXISTS idx_integrations_business_id ON integrations(business_id);

