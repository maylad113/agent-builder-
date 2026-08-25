import type { DbClient } from '../dbClient';

/**
 * Self-healing DDL for the sales-workforce substrate (Phase A / Task 34).
 * Mirrors initOrchestrationTables: idempotent CREATE IF NOT EXISTS so fresh
 * and existing databases get the tables on boot (the migrations in
 * migrations/023_sales_workforce.sql + migrations/pg/024_sales_workforce.sql
 * are the source of truth; this is the self-heal backstop). Both dialects.
 */
export async function initSalesWorkforceTables(client: DbClient): Promise<void> {
  const isPg = client.dialect === 'postgres';
  const jsonType = isPg ? 'JSONB' : 'TEXT';

  await client.exec(`CREATE TABLE IF NOT EXISTS sales_workers (
    id                TEXT PRIMARY KEY,
    role              TEXT NOT NULL,
    status            TEXT NOT NULL,
    objective         TEXT,
    channel           TEXT NOT NULL,
    schedule          ${jsonType},
    limits            ${jsonType},
    strategy_version_id TEXT,
    current_task_id   TEXT,
    last_activity_at  TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )`);
  await client.exec('CREATE INDEX IF NOT EXISTS idx_sales_workers_status ON sales_workers(status)');

  await client.exec(`CREATE TABLE IF NOT EXISTS sales_tasks (
    id                TEXT PRIMARY KEY,
    worker_id         TEXT NOT NULL REFERENCES sales_workers(id),
    type              TEXT NOT NULL,
    payload           ${jsonType},
    status            TEXT NOT NULL,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    available_at      TEXT NOT NULL,
    claimed_at        TEXT,
    completed_at      TEXT,
    last_error        TEXT,
    idempotency_key   TEXT NOT NULL UNIQUE,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )`);
  await client.exec('CREATE INDEX IF NOT EXISTS idx_sales_tasks_worker_status ON sales_tasks(worker_id, status)');
  await client.exec('CREATE INDEX IF NOT EXISTS idx_sales_tasks_runnable ON sales_tasks(status, available_at)');
  await client.exec('CREATE INDEX IF NOT EXISTS idx_sales_tasks_stale ON sales_tasks(status, claimed_at)');

  // Task 37: contact assignment + outreach attempt ledger.
  await client.exec(`CREATE TABLE IF NOT EXISTS sales_contacts (
    id            TEXT PRIMARY KEY,
    prospect_id   TEXT NOT NULL,
    worker_id     TEXT NOT NULL REFERENCES sales_workers(id),
    channel       TEXT NOT NULL,
    status        TEXT NOT NULL,
    assigned_at   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (prospect_id, channel)
  )`);
  await client.exec('CREATE INDEX IF NOT EXISTS idx_sales_contacts_worker ON sales_contacts(worker_id, status)');
  await client.exec('CREATE INDEX IF NOT EXISTS idx_sales_contacts_prospect ON sales_contacts(prospect_id)');

  await client.exec(`CREATE TABLE IF NOT EXISTS sales_attempts (
    id            TEXT PRIMARY KEY,
    contact_id    TEXT NOT NULL REFERENCES sales_contacts(id),
    task_id       TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    outcome       TEXT NOT NULL,
    provider_id   TEXT,
    conversation_id TEXT,
    safe_summary  TEXT,
    created_at    TEXT NOT NULL,
    UNIQUE (task_id, attempt_number)
  )`);
  await client.exec('CREATE INDEX IF NOT EXISTS idx_sales_attempts_contact ON sales_attempts(contact_id, created_at)');

  // Self-heal for pre-Task-38 databases (migration 025/pg-026 equivalent).
  const attemptCols = await client.getColumns('sales_attempts');
  if (!attemptCols.includes('provider_id')) {
    await client.exec('ALTER TABLE sales_attempts ADD COLUMN provider_id TEXT');
  }
  if (!attemptCols.includes('conversation_id')) {
    await client.exec('ALTER TABLE sales_attempts ADD COLUMN conversation_id TEXT');
  }
}
