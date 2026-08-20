-- 020_discovery_source_expiry.sql (SQLite)
-- Google Places provider (Phase C / Task 7): retention bound for
-- provider-restricted source content (Google non-ID Places data may only be
-- cached ~30 days). Nullable per the Collection nullability rule. The
-- acceptance bridge refuses acceptance after source_expires_at, so
-- retention-restricted content cannot flow into a durable prospect.

ALTER TABLE discovery_results ADD COLUMN source_expires_at TEXT;
