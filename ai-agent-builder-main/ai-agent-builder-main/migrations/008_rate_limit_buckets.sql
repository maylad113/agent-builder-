-- H1: Persistent rate-limit buckets (RATE_LIMIT_STORE=sqlite).
--
-- Rows are keyed by limiter prefix + client IP (e.g. 'login:1.2.3.4') and hold
-- the sliding-window state (window start epoch-ms + request count). Persisting
-- this state in SQLite means a server restart does NOT reset an attacker's
-- limit budget — the H1 persistent rate-limiting requirement.
--
-- The table is intentionally tiny (key/count/window_start) and written only by
-- the rate-limit middleware; expired rows are swept lazily from the store.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Sweeps delete by window_start; index keeps that DELETE cheap as the table
-- grows under attack.
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_window_start
  ON rate_limit_buckets(window_start);
