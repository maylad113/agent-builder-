-- 022_places_usage.sql (SQLite)
-- Google Places usage protection (Phase C / Task 20): global (project-level)
-- daily attempt counter. One row per UTC day; atomic increment in the run
-- transaction. NOT billing — an operator safety guard only.

CREATE TABLE IF NOT EXISTS places_usage (
  id         TEXT PRIMARY KEY,
  bucket     TEXT NOT NULL UNIQUE,
  calls      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
