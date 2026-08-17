-- 011_evaluation.sql
-- Agent evaluation results (Phase: evaluation engine + failure classification).
-- Each row is one evaluation RUN against a DRAFT/TESTING agent version. The
-- per-scenario structured result (checks + failure categories + captured
-- reply/tool calls) is stored as JSON in `scenario_results`; the indexed
-- columns support tenant-scoped listing and the publish gate (latest result
-- per version).

CREATE TABLE IF NOT EXISTS evaluation_results (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version_id      TEXT NOT NULL,
  overall_passed  INTEGER NOT NULL,
  critical_failures INTEGER NOT NULL DEFAULT 0,
  total_scenarios INTEGER NOT NULL DEFAULT 0,
  passed_scenarios INTEGER NOT NULL DEFAULT 0,
  provider_used   TEXT,
  scenario_results TEXT NOT NULL DEFAULT '[]',
  timestamp       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_results_business ON evaluation_results(business_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_version ON evaluation_results(version_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_agent ON evaluation_results(agent_id, timestamp);
