-- 026_sales_conversations.sql (SQLite)
-- Task 42: platform-level sales conversation + human-escalation substrate.
-- sales_conversations is the durable conversation identity bound to a contact
-- (UNIQUE(contact_id) → exactly one conversation per contact; concurrent first
-- binds resolve to one row). provider_conversation_id is the future provider
-- thread/call id — separate from the internal id, UNIQUE when present.
-- sales_conversation_turns is append-only (never deleted/updated by app code).
-- Conversation status is application-enforced (OPEN → NEEDS_HUMAN → CLOSED).
-- sales_attempts.conversation_id already exists (Task 38, migration 025) and
-- now stores the INTERNAL conversation id — no ALTER needed here.

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

