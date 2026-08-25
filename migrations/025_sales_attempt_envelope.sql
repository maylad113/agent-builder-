-- 025_sales_attempt_envelope.sql (SQLite)
-- Task 38: structured channel-result envelope on the outreach attempt ledger.
-- provider_id (attempt-scoped provider request/result id) and conversation_id
-- (future channel conversation binder) are NULLABLE per the Collection rule;
-- legacy rows remain valid/readable. Idempotent ALTER (SQLite has no
-- ADD COLUMN IF NOT EXISTS; guarded via pragma table info at init too).

ALTER TABLE sales_attempts ADD COLUMN provider_id TEXT;
ALTER TABLE sales_attempts ADD COLUMN conversation_id TEXT;
