-- 024_sales_workforce.sql (PostgreSQL)
-- PG parity for migrations/023_sales_workforce.sql (PG sequence is independent).
-- Durable sales-worker execution substrate. JSONB for structured schedule/limits/
-- payload. Idempotent CREATE statements; Collection nullability rule applies.

CREATE TABLE IF NOT EXISTS sales_workers (
  id                TEXT PRIMARY KEY,
  role              TEXT NOT NULL,
  status            TEXT NOT NULL,
  objective         TEXT,
  channel           TEXT NOT NULL,
  schedule          JSONB,
  limits            JSONB,
  strategy_version_id TEXT,
  current_task_id   TEXT,
  last_activity_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_workers_status ON sales_workers(status);

CREATE TABLE IF NOT EXISTS sales_tasks (
  id                TEXT PRIMARY KEY,
  worker_id         TEXT NOT NULL REFERENCES sales_workers(id),
  type              TEXT NOT NULL,
  payload           JSONB,
  status            TEXT NOT NULL,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  available_at      TEXT NOT NULL,
  claimed_at        TEXT,
  completed_at      TEXT,
  last_error        TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_tasks_worker_status ON sales_tasks(worker_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_tasks_runnable ON sales_tasks(status, available_at);
CREATE INDEX IF NOT EXISTS idx_sales_tasks_stale ON sales_tasks(status, claimed_at);
