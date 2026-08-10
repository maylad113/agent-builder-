-- 001_initial_schema.sql
-- Initial schema for the AI Agent Factory MVP.
-- Structured/nested fields (objects/arrays) are stored as JSON TEXT and
-- serialized/parsed by the repository layer in src/server/db.ts.

CREATE TABLE IF NOT EXISTS businesses (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  location           TEXT NOT NULL DEFAULT '',
  language           TEXT NOT NULL DEFAULT 'en',
  currency           TEXT NOT NULL DEFAULT 'toman',
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  hours              TEXT NOT NULL DEFAULT '[]',        -- JSON: BusinessHours[]
  services           TEXT NOT NULL DEFAULT '[]',        -- JSON: ServiceItem[]
  pricing_notes      TEXT,
  faqs               TEXT NOT NULL DEFAULT '[]',        -- JSON: FAQItem[]
  policies           TEXT NOT NULL DEFAULT '{}',        -- JSON: {cancellation, refund, bookingNotice}
  communication_style TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_members (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT '',
  services_handled  TEXT NOT NULL DEFAULT '[]'          -- JSON: string[] (service IDs)
);
CREATE INDEX IF NOT EXISTS idx_staff_members_business_id ON staff_members(business_id);

CREATE TABLE IF NOT EXISTS agents (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id),
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  version            INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'DRAFT',
  system_prompt      TEXT NOT NULL DEFAULT '',
  structured_config  TEXT NOT NULL DEFAULT '{}',        -- JSON: StructuredAgentConfig
  llm_provider       TEXT NOT NULL DEFAULT 'gemini',
  model              TEXT NOT NULL DEFAULT 'gemini-3.6-flash',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_business_id ON agents(business_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  title             TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'text',
  content           TEXT NOT NULL DEFAULT '',
  tags              TEXT NOT NULL DEFAULT '[]',         -- JSON: string[]
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_business_id ON knowledge_chunks(business_id);

CREATE TABLE IF NOT EXISTS customers (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL,
  email             TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_business_id ON customers(business_id);

CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  customer_id       TEXT NOT NULL,
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT,
  channel           TEXT NOT NULL DEFAULT 'web_chat',
  status            TEXT NOT NULL DEFAULT 'AI_HANDLING',
  summary           TEXT,
  last_message_at   TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_business_id ON conversations(business_id);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  sender            TEXT NOT NULL,
  content           TEXT NOT NULL DEFAULT '',
  tool_calls        TEXT,                                -- JSON: ToolCallRecord[] (nullable)
  channel           TEXT NOT NULL DEFAULT 'web_chat',
  timestamp         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS appointments (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  service_id        TEXT NOT NULL,
  service_name      TEXT NOT NULL,
  staff_member_id   TEXT,
  staff_name        TEXT,
  customer_id       TEXT NOT NULL,
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,
  date              TEXT NOT NULL,
  start_time        TEXT NOT NULL,
  end_time          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  notes             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_business_id ON appointments(business_id);
CREATE INDEX IF NOT EXISTS idx_appointments_business_date ON appointments(business_id, date);

CREATE TABLE IF NOT EXISTS products (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  name              TEXT NOT NULL,
  sku               TEXT NOT NULL,
  price             REAL NOT NULL DEFAULT 0,
  inventory         INTEGER NOT NULL DEFAULT 0,
  description       TEXT NOT NULL DEFAULT '',
  category          TEXT NOT NULL DEFAULT 'General',
  image_url         TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  customer_id       TEXT NOT NULL,
  customer_name     TEXT NOT NULL,
  items             TEXT NOT NULL DEFAULT '[]',          -- JSON: OrderItem[]
  total_amount      REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders(business_id);

CREATE TABLE IF NOT EXISTS channels (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  type              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'not_configured',
  details           TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL,
  config_data       TEXT                                 -- JSON: Record<string,string> (nullable)
);
CREATE INDEX IF NOT EXISTS idx_channels_business_id ON channels(business_id);

CREATE TABLE IF NOT EXISTS integrations (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  provider          TEXT NOT NULL,
  connected         INTEGER NOT NULL DEFAULT 0,          -- 0/1 boolean
  status_message    TEXT NOT NULL DEFAULT '',
  credentials_set   INTEGER NOT NULL DEFAULT 0,          -- 0/1 boolean
  last_sync         TEXT,
  config_data       TEXT                                 -- JSON: Record<string,string> (nullable)
);
CREATE INDEX IF NOT EXISTS idx_integrations_business_id ON integrations(business_id);

CREATE TABLE IF NOT EXISTS templates (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  business_type        TEXT NOT NULL,
  icon                 TEXT NOT NULL DEFAULT '',
  description          TEXT NOT NULL DEFAULT '',
  default_services     TEXT NOT NULL DEFAULT '[]',       -- JSON: ServiceItem[]
  default_faqs         TEXT NOT NULL DEFAULT '[]',       -- JSON: FAQItem[]
  default_agent_config TEXT NOT NULL DEFAULT '{}'        -- JSON: Partial<StructuredAgentConfig>
);

CREATE TABLE IF NOT EXISTS usage_records (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id),
  date               TEXT NOT NULL,
  tokens_used        INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  requests_count     INTEGER NOT NULL DEFAULT 0,
  voice_minutes      INTEGER NOT NULL DEFAULT 0,
  sms_count          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_records_business_id ON usage_records(business_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  agent_id          TEXT,
  action            TEXT NOT NULL,
  details           TEXT NOT NULL DEFAULT '',
  timestamp         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_business_id ON audit_logs(business_id);
