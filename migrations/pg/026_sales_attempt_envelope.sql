-- 026_sales_attempt_envelope.sql (PostgreSQL)
-- PG parity for migrations/025_sales_attempt_envelope.sql (PG sequence independent).
-- Idempotent ALTER (PG supports IF NOT EXISTS). Legacy rows remain readable.

ALTER TABLE sales_attempts ADD COLUMN IF NOT EXISTS provider_id TEXT;
ALTER TABLE sales_attempts ADD COLUMN IF NOT EXISTS conversation_id TEXT;
