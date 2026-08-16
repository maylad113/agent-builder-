-- 005_usage_breakdown.sql
-- Track real per-request token usage from the model provider (Phase 19),
-- replacing the string-length estimate. Existing rows keep NULL for the new
-- columns (treated as 0 by aggregations).
ALTER TABLE usage_records ADD COLUMN input_tokens INTEGER DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN output_tokens INTEGER DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN agent_id TEXT;
ALTER TABLE usage_records ADD COLUMN model TEXT;
ALTER TABLE usage_records ADD COLUMN provider TEXT;
