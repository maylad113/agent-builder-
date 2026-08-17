-- 013_telemetry.sql
-- Usage Monitoring + Observability (Phase: telemetry).
-- Durable, tenant-scoped event records emitted from the REAL agent runtime,
-- tool execution, evaluation, correction, and publish paths. The table is
-- also self-healing created in src/server/telemetry.ts (initTelemetryTable)
-- so fresh DBs and PG get it idempotently. Records prefer metadata + safe
-- summaries over raw conversation content; never store secrets or tool args.

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
  is_published    INTEGER NOT NULL DEFAULT 0,
  tool_name       TEXT,
  success         INTEGER,
  latency_ms      INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  tokens_used     INTEGER,
  summary         TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_telemetry_business ON telemetry_events(business_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_agent ON telemetry_events(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_version ON telemetry_events(version_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry_events(business_id, event_type, timestamp);
