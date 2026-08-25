-- 025_sales_contacts.sql (PostgreSQL)
-- PG parity for migrations/024_sales_contacts.sql (PG sequence is independent).
-- Durable sales contact assignment + outreach attempt ledger. UNIQUE backstops
-- idempotent assignment and attempt-recording races. Collection nullability
-- rule applies (explicit NULL for absent fields).

CREATE TABLE IF NOT EXISTS sales_contacts (
  id            TEXT PRIMARY KEY,
  prospect_id   TEXT NOT NULL,
  worker_id     TEXT NOT NULL REFERENCES sales_workers(id),
  channel       TEXT NOT NULL,
  status        TEXT NOT NULL,
  assigned_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (prospect_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_sales_contacts_worker ON sales_contacts(worker_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_contacts_prospect ON sales_contacts(prospect_id);

CREATE TABLE IF NOT EXISTS sales_attempts (
  id            TEXT PRIMARY KEY,
  contact_id    TEXT NOT NULL REFERENCES sales_contacts(id),
  task_id       TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  outcome       TEXT NOT NULL,
  safe_summary  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (task_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_sales_attempts_contact ON sales_attempts(contact_id, created_at);
