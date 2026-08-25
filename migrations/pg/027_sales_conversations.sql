-- 027_sales_conversations.sql (PostgreSQL)
-- PG parity for migrations/026_sales_conversations.sql (PG sequence is
-- independent). Platform-level sales conversation + escalation substrate.
-- Nullable columns follow the Collection rule (explicit NULL for absent).

CREATE TABLE IF NOT EXISTS sales_conversations (
  id                      TEXT PRIMARY KEY,
  contact_id              TEXT NOT NULL REFERENCES sales_contacts(id) UNIQUE,
  channel                 TEXT NOT NULL,
  provider_conversation_id TEXT,
  status                  TEXT NOT NULL,
  escalation_reason       TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_conversations_provider ON sales_conversations(provider_conversation_id);
CREATE INDEX IF NOT EXISTS idx_sales_conversations_contact ON sales_conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_sales_conversations_status ON sales_conversations(status);

CREATE TABLE IF NOT EXISTS sales_conversation_turns (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES sales_conversations(id),
  direction       TEXT NOT NULL,
  actor           TEXT NOT NULL,
  safe_content    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_turns_conversation ON sales_conversation_turns(conversation_id, created_at);

