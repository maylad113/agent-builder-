/**
 * Orchestration table DDL (single source of truth) + self-heal init.
 *
 * The migration files (migrations/016_orchestration.sql,
 * 017_lead_research.sql, 018_discovery.sql, 019_discovery_acceptance.sql,
 * 020_discovery_source_expiry.sql for SQLite; migrations/pg/017_orchestration.sql,
 * pg/018_lead_research.sql, pg/019_discovery.sql, pg/020_discovery_acceptance.sql,
 * pg/021_discovery_source_expiry.sql for PostgreSQL) embed the same statements; this
 * module's init function is the idempotent fallback the
 * database bootstrap calls so fresh/existing databases of either dialect get
 * the tables even if migration numbering races (same pattern as
 * telemetry/evaluation/correction).
 *
 * Column nullability rule (from the audit): the Collection layer INSERTs
 * explicit NULL for absent fields, so every column a Collection writes must
 * be nullable (DEFAULTs never fire). Only genuinely required strings and
 * counters are NOT NULL below.
 */

interface InitClient {
  execMany: (sql: string) => Promise<void>;
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
  dialect: 'sqlite' | 'postgres';
}

const BOOL_TYPE = {
  sqlite: 'INTEGER',
  postgres: 'BOOLEAN'
} as const;

function ddl(dialect: 'sqlite' | 'postgres'): string {
  const boolType = BOOL_TYPE[dialect === 'postgres' ? 'postgres' : 'sqlite'];
  return `
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
  discovery_result_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_prospects_business ON prospects(business_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_discovery_result ON prospects(discovery_result_id) WHERE discovery_result_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS design_proposals (
  id               TEXT PRIMARY KEY,
  prospect_id      TEXT NOT NULL REFERENCES prospects(id),
  title            TEXT NOT NULL,
  problem_statement TEXT NOT NULL,
  proposed_solution TEXT NOT NULL,
  agent_type       TEXT,
  capabilities     TEXT,
  channels         TEXT,
  integrations     TEXT,
  configuration    TEXT,
  status           TEXT NOT NULL,
  approved_at      TEXT,
  generation_key   TEXT,
  source_report_id TEXT,
  generator_model  TEXT,
  rationale        TEXT,
  uncertainty      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_proposals_prospect ON design_proposals(prospect_id);
CREATE INDEX IF NOT EXISTS idx_design_proposals_status ON design_proposals(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_design_proposals_generation_key ON design_proposals(generation_key) WHERE generation_key IS NOT NULL;

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
  dead_lettered      ${boolType},
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
  id                 TEXT PRIMARY KEY,
  delivery_id        TEXT NOT NULL REFERENCES deliveries(id),
  business_id        TEXT NOT NULL REFERENCES businesses(id),
  accepted_by        TEXT,
  acceptance_method  TEXT,
  accepted_at        TEXT NOT NULL,
  metadata           TEXT,
  created_at         TEXT NOT NULL,
  CONSTRAINT acceptances_delivery_id UNIQUE (delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_acceptances_business ON acceptances(business_id);

CREATE TABLE IF NOT EXISTS lead_research_reports (
  id                 TEXT PRIMARY KEY,
  prospect_id        TEXT NOT NULL REFERENCES prospects(id),
  status             TEXT NOT NULL,
  input_source       TEXT,
  input_text_excerpt TEXT,
  report             TEXT,
  llm_model          TEXT,
  score              INTEGER,
  score_band         TEXT,
  score_reasons      TEXT,
  error              TEXT,
  idempotency_key    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_research_idem ON lead_research_reports(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_lead_research_prospect ON lead_research_reports(prospect_id);
CREATE INDEX IF NOT EXISTS idx_lead_research_status ON lead_research_reports(status);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  params           TEXT,
  status           TEXT NOT NULL,
  result_count     INTEGER NOT NULL DEFAULT 0,
  duplicate_count  INTEGER NOT NULL DEFAULT 0,
  invalid_count    INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  idempotency_key  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_runs_idem ON discovery_runs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_status ON discovery_runs(status);

CREATE TABLE IF NOT EXISTS discovery_results (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES discovery_runs(id),
  prospect_id     TEXT REFERENCES prospects(id),
  source_provider TEXT NOT NULL,
  source_url      TEXT,
  source_type     TEXT NOT NULL,
  raw             TEXT,
  normalized      TEXT NOT NULL,
  verification    TEXT NOT NULL DEFAULT 'UNVERIFIED',
  source_expires_at TEXT,
  dismissed_at    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_results_run ON discovery_results(run_id);
CREATE INDEX IF NOT EXISTS idx_discovery_results_prospect ON discovery_results(prospect_id);

CREATE TABLE IF NOT EXISTS places_usage (
  id         TEXT PRIMARY KEY,
  bucket     TEXT NOT NULL UNIQUE,
  calls      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;
}

/** Idempotent bootstrap for orchestration tables (called from db.init). */
export async function initOrchestrationTables(client: InitClient): Promise<void> {
  await client.execMany(ddl(client.dialect));
  // Self-heal for pre-018 databases whose prospects table lacks the discovery
  // provenance column (migrations normally add it; this covers DBs that were
  // created before the migration existed).
  if (client.dialect === 'postgres') {
    await client.execMany(
      'ALTER TABLE prospects ADD COLUMN IF NOT EXISTS discovery_result_id TEXT REFERENCES discovery_results(id);\n' +
      'ALTER TABLE discovery_results ADD COLUMN IF NOT EXISTS source_expires_at TEXT;\n' +
      'ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS generation_key TEXT;\n' +
      'ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS source_report_id TEXT;\n' +
      'ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS generator_model TEXT;\n' +
      'ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS rationale TEXT;\n' +
      'ALTER TABLE design_proposals ADD COLUMN IF NOT EXISTS uncertainty TEXT;'
    );
  } else {
    const cols = await client.query("SELECT name FROM pragma_table_info('prospects')");
    if (!cols.rows.some((c: any) => c.name === 'discovery_result_id')) {
      await client.execMany(
        'ALTER TABLE prospects ADD COLUMN discovery_result_id TEXT REFERENCES discovery_results(id)'
      );
    }
    const dcols = await client.query("SELECT name FROM pragma_table_info('discovery_results')");
    if (!dcols.rows.some((c: any) => c.name === 'source_expires_at')) {
      await client.execMany('ALTER TABLE discovery_results ADD COLUMN source_expires_at TEXT');
    }
    const pcols = await client.query("SELECT name FROM pragma_table_info('design_proposals')");
    const names = new Set(pcols.rows.map((c: any) => c.name));
    const missing = ['generation_key', 'source_report_id', 'generator_model', 'rationale', 'uncertainty'].filter(c => !names.has(c));
    for (const col of missing) {
      await client.execMany(`ALTER TABLE design_proposals ADD COLUMN ${col} TEXT`);
    }
  }
}
