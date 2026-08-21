-- 023_places_usage.sql (PostgreSQL)
-- PG parity for migrations/022_places_usage.sql (SQLite).

CREATE TABLE IF NOT EXISTS places_usage (
  id         TEXT PRIMARY KEY,
  bucket     TEXT NOT NULL UNIQUE,
  calls      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
