-- 001_initial_schema.sql (PostgreSQL)
-- Full production schema for the AI Agent Factory on PostgreSQL 14+.
--
-- This is a single consolidated migration (not a 1:1 mirror of the six SQLite
-- migration files) because PostgreSQL lets us declare the complete schema —
-- including columns that SQLite added incrementally via ALTER TABLE (handoff
-- fields, usage breakdown, integration state, widget origins, holidays) — in
-- one idempotent CREATE TABLE IF NOT EXISTS block. The migration runner tracks
-- applied files by name, so this is treated as the first applied PG migration.
--
-- Type mapping (vs SQLite TEXT-everything):
--   - JSONB for structured/nested fields (queryable, validated)
--   - DOUBLE PRECISION for REAL
--   - INTEGER for ints
--   - TEXT for ISO timestamps and strings
-- pgvector is optional: knowledge_embeddings stores vectors as JSONB so the
-- app works without the extension; when pgvector is present the embeddings
-- module may use a vector column. (See embeddings.ts.)

-- schema_migrations: tracks applied migration files (mirrors SQLite runner).
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  applied_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE TABLE IF NOT EXISTS businesses (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  location            TEXT NOT NULL DEFAULT '',
  language            TEXT NOT NULL DEFAULT 'en',
  currency            TEXT NOT NULL DEFAULT 'toman',
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  hours               JSONB NOT NULL DEFAULT '[]',
  services            JSONB NOT NULL DEFAULT '[]',
  pricing_notes       TEXT,
  faqs                JSONB NOT NULL DEFAULT '[]',
  policies            JSONB NOT NULL DEFAULT '{}',
  communication_style TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  allowed_widget_origins JSONB,                       -- JSON string[] (nullable)
  holidays            JSONB,                           -- JSON Holiday[] (nullable)
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_members (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT '',
  services_handled  JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_staff_members_business_id ON staff_members(business_id);

CREATE TABLE IF NOT EXISTS agents (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  version            INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'DRAFT',
  system_prompt      TEXT NOT NULL DEFAULT '',
  structured_config  JSONB NOT NULL DEFAULT '{}',
  llm_provider       TEXT NOT NULL DEFAULT 'gemini',
  model              TEXT NOT NULL DEFAULT 'gemini-3.6-flash',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_business_id ON agents(business_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'text',
  content           TEXT NOT NULL DEFAULT '',
  tags              JSONB NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_business_id ON knowledge_chunks(business_id);

CREATE TABLE IF NOT EXISTS customers (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL,
  email             TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_business_id ON customers(business_id);
CREATE INDEX IF NOT EXISTS idx_customers_business_phone ON customers(business_id, phone);

CREATE TABLE IF NOT EXISTS conversations (
  id                     TEXT PRIMARY KEY,
  business_id            TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id            TEXT NOT NULL,
  customer_name          TEXT NOT NULL,
  customer_phone         TEXT,
  channel                TEXT NOT NULL DEFAULT 'web_chat',
  status                 TEXT NOT NULL DEFAULT 'AI_HANDLING',
  summary                TEXT,
  last_message_at        TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  handoff_reason         TEXT,
  handoff_requested_at   TEXT,
  handoff_started_at     TEXT,
  resolved_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_business_id ON conversations(business_id);
CREATE INDEX IF NOT EXISTS idx_conversations_business_status ON conversations(business_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(business_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender            TEXT NOT NULL,
  content           TEXT NOT NULL DEFAULT '',
  tool_calls        JSONB,
  channel           TEXT NOT NULL DEFAULT 'web_chat',
  timestamp         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(conversation_id, timestamp);

CREATE TABLE IF NOT EXISTS appointments (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_appointments_business_date_status ON appointments(business_id, date, status);
CREATE INDEX IF NOT EXISTS idx_appointments_staff_date ON appointments(business_id, staff_member_id, date);

CREATE TABLE IF NOT EXISTS products (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  sku               TEXT NOT NULL,
  price             DOUBLE PRECISION NOT NULL DEFAULT 0,
  inventory         INTEGER NOT NULL DEFAULT 0,
  description       TEXT NOT NULL DEFAULT '',
  category          TEXT NOT NULL DEFAULT 'General',
  image_url         TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id       TEXT NOT NULL,
  customer_name     TEXT NOT NULL,
  items             JSONB NOT NULL DEFAULT '[]',
  total_amount      DOUBLE PRECISION NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS channels (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'not_configured',
  details           TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL,
  config_data       JSONB
);
CREATE INDEX IF NOT EXISTS idx_channels_business_id ON channels(business_id);

CREATE TABLE IF NOT EXISTS integrations (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  status_message    TEXT NOT NULL DEFAULT '',
  credentials_set    INTEGER NOT NULL DEFAULT 0,
  last_sync         TEXT,
  last_validated_at TEXT,
  last_error        TEXT,
  config_data       JSONB
);
CREATE INDEX IF NOT EXISTS idx_integrations_business_id ON integrations(business_id);
CREATE INDEX IF NOT EXISTS idx_integrations_business_provider ON integrations(business_id, provider);

CREATE TABLE IF NOT EXISTS templates (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  business_type        TEXT NOT NULL,
  icon                 TEXT NOT NULL DEFAULT '',
  description          TEXT NOT NULL DEFAULT '',
  default_services     JSONB NOT NULL DEFAULT '[]',
  default_faqs         JSONB NOT NULL DEFAULT '[]',
  default_agent_config JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS usage_records (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date               TEXT NOT NULL,
  tokens_used        INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  requests_count     INTEGER NOT NULL DEFAULT 0,
  voice_minutes      INTEGER NOT NULL DEFAULT 0,
  sms_count          INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  agent_id           TEXT,
  model              TEXT,
  provider           TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_records_business_id ON usage_records(business_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_business_date ON usage_records(business_id, date);

CREATE TABLE IF NOT EXISTS audit_logs (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id          TEXT,
  action            TEXT NOT NULL,
  details           TEXT NOT NULL DEFAULT '',
  timestamp         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_business_id ON audit_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(business_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('PLATFORM_OWNER', 'BUSINESS_OWNER', 'BUSINESS_STAFF')),
  business_id   TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_business_id ON users(business_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS agent_versions (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version_number    INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('DRAFT', 'TESTING', 'PUBLISHED', 'ARCHIVED')),
  system_prompt     TEXT NOT NULL,
  structured_config JSONB NOT NULL,
  model             TEXT NOT NULL,
  change_note       TEXT,
  created_at        TEXT NOT NULL,
  published_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_id ON agent_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_business_id ON agent_versions(business_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_status ON agent_versions(status);
-- Only one PUBLISHED version per agent — enforced at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_versions_published
  ON agent_versions(agent_id) WHERE status = 'PUBLISHED';

-- Persistent encrypted integration secrets (P2). Only ciphertext + nonce are
-- stored; the plaintext encryption key lives in process memory (SECRET_KEY).
CREATE TABLE IF NOT EXISTS integration_secrets (
  integration_id TEXT PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  ciphertext     TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Persistent webhook idempotency ledger (P3). One row per processed event id,
-- scoped by source + business so duplicates are rejected across restarts.
CREATE TABLE IF NOT EXISTS webhook_processed_events (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  business_id  TEXT,
  processed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_event_source_id ON webhook_processed_events(source, event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_processed_business ON webhook_processed_events(business_id);
CREATE INDEX IF NOT EXISTS idx_webhook_processed_at ON webhook_processed_events(processed_at);

-- Vector embeddings for RAG. Stored as JSONB (array of floats) so the app
-- works without pgvector; the embeddings module computes cosine similarity
-- in-process. When pgvector is available an optional vector column can be
-- added in a later migration for DB-side ANN search.
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  chunk_id     TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  vector       JSONB NOT NULL,
  hash         TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT 'gemini:text-embedding-004',
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_embeddings_business ON knowledge_embeddings(business_id);

-- Agent evaluation results (evaluation engine + failure classification). The
-- per-scenario structured run is stored as JSONB; indexed columns support
-- tenant-scoped listing and the publish gate (latest result per version).
CREATE TABLE IF NOT EXISTS evaluation_results (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version_id      TEXT NOT NULL,
  overall_passed  BOOLEAN NOT NULL,
  critical_failures INTEGER NOT NULL DEFAULT 0,
  total_scenarios INTEGER NOT NULL DEFAULT 0,
  passed_scenarios INTEGER NOT NULL DEFAULT 0,
  provider_used   TEXT,
  scenario_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  timestamp       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_results_business ON evaluation_results(business_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_version ON evaluation_results(version_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_agent ON evaluation_results(agent_id, timestamp);

-- Self-correction loop audit records. Each row is one correction run; the
-- per-attempt audit trail is stored as JSONB in `attempts`.
CREATE TABLE IF NOT EXISTS correction_runs (
  id                    TEXT PRIMARY KEY,
  business_id           TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  start_version_id      TEXT NOT NULL,
  final_version_id      TEXT NOT NULL,
  resolved              BOOLEAN NOT NULL,
  human_review_required BOOLEAN NOT NULL,
  max_attempts          INTEGER NOT NULL,
  attempts              JSONB NOT NULL DEFAULT '[]'::jsonb,
  final_evaluation_id   TEXT,
  final_evaluation_passed BOOLEAN NOT NULL DEFAULT FALSE,
  reason                TEXT,
  timestamp             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_correction_runs_business ON correction_runs(business_id);
CREATE INDEX IF NOT EXISTS idx_correction_runs_agent ON correction_runs(agent_id, timestamp);

-- Usage Monitoring + Observability. Tenant-scoped event records from the real
-- runtime/tool/evaluation/correction/publish paths. Metadata in JSONB; never
-- secrets or tool args.
CREATE TABLE IF NOT EXISTS telemetry_events (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  agent_id        TEXT,
  version_id      TEXT,
  conversation_id TEXT,
  channel         TEXT,
  provider        TEXT,
  model           TEXT,
  is_published    BOOLEAN NOT NULL DEFAULT FALSE,
  tool_name       TEXT,
  success         BOOLEAN,
  latency_ms      INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  tokens_used     INTEGER,
  summary         TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_telemetry_business ON telemetry_events(business_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_agent ON telemetry_events(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_version ON telemetry_events(version_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry_events(business_id, event_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_conversation ON telemetry_events(business_id, conversation_id, timestamp);
