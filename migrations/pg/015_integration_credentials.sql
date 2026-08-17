-- 015_integration_credentials.sql (PostgreSQL)
-- P1: persist integration credentials encrypted at rest (AES-256-GCM).
-- One record per integration (UNIQUE), tenant-scoped (business_id), ciphertext
-- only — the encryption key never lives in this table.

CREATE TABLE IF NOT EXISTS integration_credentials (
  id               TEXT PRIMARY KEY,
  integration_id   TEXT NOT NULL UNIQUE,
  business_id      TEXT NOT NULL,
  provider         TEXT NOT NULL,
  encrypted_creds  TEXT NOT NULL,
  key_id           TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  updated_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_business
  ON integration_credentials(business_id);
