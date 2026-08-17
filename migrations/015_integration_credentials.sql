-- 015_integration_credentials.sql
-- P1: persist integration credentials encrypted at rest.
--
-- Previously credentials lived only in process memory and were lost on every
-- server restart. This table stores the AES-256-GCM ciphertext (never
-- plaintext) keyed by integration, scoped by tenant (business_id).
--
-- Invariants enforced at the DB level:
--  - One credential record per integration (UNIQUE on integration_id) so a
--    tenant cannot accidentally create conflicting duplicate records.
--  - business_id is NOT NULL and indexed so tenant scoping is enforced in the
--    query (WHERE business_id = ?) even if an integration id leaked.
--  - encrypted_creds holds ONLY the ciphertext envelope; the encryption key is
--    NEVER stored here (it comes from environment configuration).
--  - key_id records which logical key encrypted the row (for rotation tracking).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS integration_credentials (
  id               TEXT PRIMARY KEY,
  integration_id   TEXT NOT NULL UNIQUE,
  business_id      TEXT NOT NULL,
  provider         TEXT NOT NULL,
  encrypted_creds  TEXT NOT NULL,
  key_id           TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_business
  ON integration_credentials(business_id);
