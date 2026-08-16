-- 003_agent_versions.sql
-- Agent versioning: immutable snapshots of an agent's configuration.
--
-- Production conversations MUST use the PUBLISHED version. DRAFT/TESTING
-- versions are only usable from the authenticated simulator. Editing a draft
-- never changes the live agent until an explicit publish operation promotes
-- the draft to PUBLISHED (and archives the previously-published version).
--
-- Only one PUBLISHED version may exist per agent at a time; enforced at the
-- application layer inside a transaction (see routes.ts publish handler).
CREATE TABLE IF NOT EXISTS agent_versions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('DRAFT', 'TESTING', 'PUBLISHED', 'ARCHIVED')),
  system_prompt   TEXT NOT NULL,
  structured_config TEXT NOT NULL,               -- JSON blob
  model           TEXT NOT NULL,
  change_note     TEXT,
  created_at      TEXT NOT NULL,
  published_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_id ON agent_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_business_id ON agent_versions(business_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_versions_published
  ON agent_versions(agent_id) WHERE status = 'PUBLISHED';
CREATE INDEX IF NOT EXISTS idx_agent_versions_status ON agent_versions(status);
