-- 010_query_indexes.sql
-- Composite / covering indexes for the hot tenant-scoped list queries
-- (audit P2.10). The PG schema already carries these (migrations/pg/001); this
-- migration brings SQLite to parity so the DB-side pagination added in P2.9
-- is index-backed on both dialects. All statements are idempotent.

-- Conversations: list-by-business ordered by last_message_at (dashboard inbox).
CREATE INDEX IF NOT EXISTS idx_conversations_business_status
  ON conversations(business_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_business_last_message
  ON conversations(business_id, last_message_at);

-- Messages: per-conversation chronological read (already had single-col index).
CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp
  ON messages(conversation_id, timestamp);

-- Appointments: availability overlap check + status filter.
CREATE INDEX IF NOT EXISTS idx_appointments_business_date_status
  ON appointments(business_id, date, status);
CREATE INDEX IF NOT EXISTS idx_appointments_staff_date
  ON appointments(business_id, staff_member_id, date);

-- Orders: list-by-business ordered by created_at.
CREATE INDEX IF NOT EXISTS idx_orders_business_created
  ON orders(business_id, created_at);

-- Customers: lookup by business + phone (dedup on booking/order).
CREATE INDEX IF NOT EXISTS idx_customers_business_phone
  ON customers(business_id, phone);

-- Usage records: per-business aggregation by date (column is `date`, not
-- `timestamp`, in 001/005).
CREATE INDEX IF NOT EXISTS idx_usage_records_business_date
  ON usage_records(business_id, date);

-- Products: lookup by business + sku.
CREATE INDEX IF NOT EXISTS idx_products_business_sku
  ON products(business_id, sku);

-- Persistent webhook idempotency table (audit P1.5). Self-provisioned at
-- runtime too, but declared here so fresh DBs have it from the start.
CREATE TABLE IF NOT EXISTS processed_webhooks (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_webhooks_created_at
  ON processed_webhooks(created_at);
