-- 007_agent_paused_from.sql
-- Track which lifecycle state an agent was paused FROM so unpausing returns
-- to a sensible prior state (PAUSED -> pausedFrom, ACTIVE, or ARCHIVED).
ALTER TABLE agents ADD COLUMN paused_from TEXT;
