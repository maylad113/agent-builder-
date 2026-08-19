-- 016_dialect_parity.sql (PostgreSQL)
-- Fix schema drift between the SQLite and PostgreSQL schemas (audit P1):
-- the PG schema was missing columns that SQLite gained in later migrations,
-- which made Collection.push() SILENTLY DROP those fields on PostgreSQL
-- (pause-resume state and staff availability data), and declared two
-- usage_records columns NOT NULL where SQLite has them nullable, which made
-- fresh-database seeding crash on PG.
--
-- SQLite (for reference):
--   007: ALTER TABLE agents ADD COLUMN paused_from TEXT;
--   009: ALTER TABLE staff_members ADD COLUMN time_off TEXT DEFAULT '[]';
--        ALTER TABLE staff_members ADD COLUMN working_hours TEXT DEFAULT '[]';
--   005: usage_records.input_tokens / output_tokens INTEGER DEFAULT 0 (nullable)

ALTER TABLE agents ADD COLUMN IF NOT EXISTS paused_from TEXT;

-- Nullable, matching SQLite: Collection.push() writes explicit NULL for
-- absent fields, so NOT NULL here would break staff inserts that omit
-- schedules (the JSON mapping layer treats NULL as empty).
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS working_hours JSONB DEFAULT '[]';
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS time_off JSONB DEFAULT '[]';

-- Match the SQLite nullability (005 added these as nullable; aggregations
-- treat NULL as 0). Collection.push() inserts explicit NULL for absent
-- fields, so a NOT NULL constraint here breaks inserts that omit them.
ALTER TABLE usage_records ALTER COLUMN input_tokens DROP NOT NULL;
ALTER TABLE usage_records ALTER COLUMN output_tokens DROP NOT NULL;
