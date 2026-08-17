-- Per-conversation drill-down: index for efficient (business_id, conversation_id)
-- lookups. The conversation_id is the durable session identifier shared by all
-- related telemetry events. Tenant-scoped (business_id) on every lookup.
-- Idempotent — initTelemetryTable also creates this index for fresh DBs / PG.
CREATE INDEX IF NOT EXISTS idx_telemetry_conversation
  ON telemetry_events(business_id, conversation_id, timestamp);
