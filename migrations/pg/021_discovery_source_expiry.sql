-- 021_discovery_source_expiry.sql (PostgreSQL)
-- PG parity for migrations/020_discovery_source_expiry.sql (SQLite).
-- Nullable per the Collection nullability rule.

ALTER TABLE discovery_results ADD COLUMN IF NOT EXISTS source_expires_at TEXT;
