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
}
