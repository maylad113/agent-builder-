-- 004_conversation_handoff.sql
-- Human-handoff state machine fields on conversations.
-- Captures the reason and timestamps for each phase of handoff so the
-- dashboard can surface a full handoff timeline:
--   AI_HANDLING -> WAITING_FOR_HUMAN (handoff_reason/requested_at set)
--   WAITING_FOR_HUMAN -> HUMAN_HANDLING (handoff_started_at set)
--   HUMAN_HANDLING -> RESOLVED (resolved_at set)
--   RESOLVED -> AI_HANDLING (resume)
ALTER TABLE conversations ADD COLUMN handoff_reason TEXT;
ALTER TABLE conversations ADD COLUMN handoff_requested_at TEXT;
ALTER TABLE conversations ADD COLUMN handoff_started_at TEXT;
ALTER TABLE conversations ADD COLUMN resolved_at TEXT;
