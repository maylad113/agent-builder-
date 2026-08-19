-- 016_orchestration.sql (SQLite)
-- Sales & Delivery Orchestrator MVP core: prospects, design proposals,
-- factory jobs, deliveries, acceptances.
--
-- These tables are also self-healing-created in
-- src/server/orchestration/tables.ts (initOrchestrationTables) so fresh and
-- existing databases get them idempotently, mirroring the established
-- pattern for telemetry/evaluation/correction. Column nullability follows
-- the rule that the Collection layer INSERTs explicit NULL for absent
-- fields — every Collection-written column is nullable unless truly required.

CREATE TABLE IF NOT EXISTS prospects (
  id                TEXT PRIMARY KEY,
  business_id       TEXT REFERENCES businesses(id),
  business_name     TEXT NOT NULL,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  website           TEXT,
  instagram_handle  TEXT,
  location          TEXT,
  notes             TEXT,
  status            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_prospects_business ON prospects(business_id);

CREATE TABLE IF NOT EXISTS design_proposals (
  id                TEXT PRIMARY KEY,
  prospect_id       TEXT NOT NULL REFERENCES prospects(id),
  title             TEXT NOT NULL,
  problem_statement TEXT NOT NULL,
  proposed_solution TEXT NOT NULL,
  agent_type        TEXT,
  capabilities      TEXT,
  channels          TEXT,
  integrations      TEXT,
  configuration     TEXT,
  status            TEXT NOT NULL,
  approved_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_proposals_prospect ON design_proposals(prospect_id);
CREATE INDEX IF NOT EXISTS idx_design_proposals_status ON design_proposals(status);

CREATE TABLE IF NOT EXISTS factory_jobs (
  id                 TEXT PRIMARY KEY,
  prospect_id        TEXT NOT NULL REFERENCES prospects(id),
  design_proposal_id TEXT NOT NULL REFERENCES design_proposals(id),
  business_id        TEXT,
  agent_id           TEXT,
  status             TEXT NOT NULL,
  current_step       TEXT,
  idempotency_key    TEXT NOT NULL,
  attempt_count      INTEGER,
  last_error         TEXT,
  dead_lettered      INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CONSTRAINT factory_jobs_idempotency_key UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_factory_jobs_prospect ON factory_jobs(prospect_id);
CREATE INDEX IF NOT EXISTS idx_factory_jobs_status ON factory_jobs(status);
CREATE INDEX IF NOT EXISTS idx_factory_jobs_design ON factory_jobs(design_proposal_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id               TEXT PRIMARY KEY,
  prospect_id      TEXT NOT NULL REFERENCES prospects(id),
  business_id      TEXT NOT NULL REFERENCES businesses(id),
  agent_id         TEXT NOT NULL,
  status           TEXT NOT NULL,
  delivery_method  TEXT,
  delivery_payload TEXT,
  delivered_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_prospect ON deliveries(prospect_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_business ON deliveries(business_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);

CREATE TABLE IF NOT EXISTS acceptances (
  id                TEXT PRIMARY KEY,
  delivery_id       TEXT NOT NULL REFERENCES deliveries(id),
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  accepted_by       TEXT,
  acceptance_method TEXT,
  accepted_at       TEXT NOT NULL,
  metadata          TEXT,
  created_at        TEXT NOT NULL,
  CONSTRAINT acceptances_delivery_id UNIQUE (delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_acceptances_business ON acceptances(business_id);
