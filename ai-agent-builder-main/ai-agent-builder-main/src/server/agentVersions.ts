import { db } from './db';
import { Agent, AgentVersion, AgentVersionStatus, StructuredAgentConfig } from '../types';

/**
 * Agent versioning service.
 *
 * Invariants enforced here (inside transactions):
 *  - Only ONE PUBLISHED version per agent at any time (DB partial unique index
 *    backs this; we also archive the prior published version on publish).
 *  - Editing a DRAFT never mutates the live (PUBLISHED) agent config.
 *  - Publishing copies the version snapshot onto the agent row so the runtime
 *    (which reads the agent row) immediately serves the new config.
 *  - Version numbers are monotonic per agent.
 *
 * The runtime loads config for production conversations from the PUBLISHED
 * version; the simulator may use a DRAFT/TESTING version via `getVersionForSim`.
 */

function snapshotConfig(v: AgentVersion): { systemPrompt: string; structuredConfig: StructuredAgentConfig; model: string } {
  return { systemPrompt: v.systemPrompt, structuredConfig: v.structuredConfig, model: v.model };
}

/** Return the currently PUBLISHED version for an agent, or null. */
export function getPublishedVersion(agentId: string): AgentVersion | undefined {
  return db.agentVersions.find(v => v.agentId === agentId && v.status === 'PUBLISHED');
}

/** The most recent version of any status (for "current draft" display). */
export function getLatestVersion(agentId: string): AgentVersion | undefined {
  const all = db.agentVersions.filter(v => v.agentId === agentId);
  if (all.length === 0) return undefined;
  return all.reduce((max, v) => (v.versionNumber > max.versionNumber ? v : max), all[0]);
}

export function nextVersionNumber(agentId: string): number {
  const all = db.agentVersions.filter(v => v.agentId === agentId);
  if (all.length === 0) return 1;
  return all.reduce((m, v) => (v.versionNumber > m ? v.versionNumber : m), 0) + 1;
}

/** Create the first DRAFT version for a freshly-created agent. */
export function createInitialDraft(agent: Agent): AgentVersion {
  const v: AgentVersion = {
    id: `ver-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    agentId: agent.id,
    businessId: agent.businessId,
    versionNumber: 1,
    status: 'DRAFT',
    systemPrompt: agent.systemPrompt,
    structuredConfig: agent.structuredConfig,
    model: agent.model,
    changeNote: 'Initial draft',
    createdAt: new Date().toISOString()
  };
  db.agentVersions.push(v);
  return v;
}

/** Create a new DRAFT from an existing version (defaults to the published one). */
export function createDraftFrom(sourceVersionId: string, changeNote?: string): AgentVersion {
  const source = db.agentVersions.find(v => v.id === sourceVersionId);
  if (!source) throw new Error('Source version not found.');

  const num = nextVersionNumber(source.agentId);
  const draft: AgentVersion = {
    id: `ver-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    agentId: source.agentId,
    businessId: source.businessId,
    versionNumber: num,
    status: 'DRAFT',
    systemPrompt: source.systemPrompt,
    structuredConfig: source.structuredConfig,
    model: source.model,
    changeNote: changeNote || `Draft from v${source.versionNumber}`,
    createdAt: new Date().toISOString()
  };
  db.agentVersions.push(draft);
  return draft;
}

/** Edit a DRAFT version's config. Refuses to touch non-draft versions. */
export function editDraft(versionId: string, patch: Partial<Pick<AgentVersion, 'systemPrompt' | 'structuredConfig' | 'model' | 'changeNote'>>): AgentVersion {
  const v = db.agentVersions.find(x => x.id === versionId);
  if (!v) throw new Error('Version not found.');
  if (v.status !== 'DRAFT') {
    throw new Error(`Cannot edit a ${v.status} version. Create a new draft from it instead.`);
  }
  if (patch.systemPrompt !== undefined) v.systemPrompt = patch.systemPrompt;
  if (patch.structuredConfig !== undefined) v.structuredConfig = patch.structuredConfig;
  if (patch.model !== undefined) v.model = patch.model;
  if (patch.changeNote !== undefined) v.changeNote = patch.changeNote;
  db.agentVersions.update(v);
  return v;
}

/**
 * Promote a DRAFT (or TESTING) version to PUBLISHED. Atomic: archives the
 * previous PUBLISHED version and copies the config onto the agent row so the
 * runtime serves it immediately. Returns the published version.
 */
export function publishVersion(versionId: string): AgentVersion {
  const v = db.agentVersions.find(x => x.id === versionId);
  if (!v) throw new Error('Version not found.');
  if (v.status !== 'DRAFT' && v.status !== 'TESTING') {
    throw new Error(`Only DRAFT or TESTING versions can be published (this is ${v.status}).`);
  }

  const nowIso = new Date().toISOString();
  // Single transaction: archive prior published + mark this published + sync agent.
  const txn = db.sqlite.transaction(() => {
    const prior = db.agentVersions.find(p => p.agentId === v.agentId && p.status === 'PUBLISHED' && p.id !== v.id);
    if (prior) {
      prior.status = 'ARCHIVED';
      db.agentVersions.update(prior);
    }
    v.status = 'PUBLISHED';
    v.publishedAt = nowIso;
    db.agentVersions.update(v);

    const agent = db.agents.find(a => a.id === v.agentId);
    if (agent) {
      const snap = snapshotConfig(v);
      agent.systemPrompt = snap.systemPrompt;
      agent.structuredConfig = snap.structuredConfig;
      agent.model = snap.model;
      agent.version = v.versionNumber;
      agent.updatedAt = nowIso;
      db.agents.update(agent);
    }
  });
  txn();

  return v;
}

/** Roll back to a previously published/archived version by creating a new
 * PUBLISHED version with that config. (Keeps history intact.) */
export function rollbackToVersion(versionId: string): AgentVersion {
  const target = db.agentVersions.find(x => x.id === versionId);
  if (!target) throw new Error('Version not found.');

  const num = nextVersionNumber(target.agentId);
  const nowIso = new Date().toISOString();
  const reissue: AgentVersion = {
    id: `ver-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    agentId: target.agentId,
    businessId: target.businessId,
    versionNumber: num,
    status: 'DRAFT',
    systemPrompt: target.systemPrompt,
    structuredConfig: target.structuredConfig,
    model: target.model,
    changeNote: `Rollback to v${target.versionNumber}`,
    createdAt: nowIso
  };
  db.agentVersions.push(reissue);
  return publishVersion(reissue.id);
}

/** Archive a version (only DRAFT/TESTING may be archived). */
export function archiveVersion(versionId: string): AgentVersion {
  const v = db.agentVersions.find(x => x.id === versionId);
  if (!v) throw new Error('Version not found.');
  if (v.status === 'PUBLISHED') throw new Error('Cannot archive the currently published version.');
  v.status = 'ARCHIVED';
  db.agentVersions.update(v);
  return v;
}

/** Move a DRAFT to TESTING (for simulator staging). */
export function moveToTesting(versionId: string): AgentVersion {
  const v = db.agentVersions.find(x => x.id === versionId);
  if (!v) throw new Error('Version not found.');
  if (v.status !== 'DRAFT') throw new Error('Only DRAFT versions can move to TESTING.');
  v.status = 'TESTING';
  db.agentVersions.update(v);
  return v;
}

/** List all versions for an agent, newest first. */
export function listVersions(agentId: string): AgentVersion[] {
  return db.agentVersions
    .filter(v => v.agentId === agentId)
    .sort((a, b) => b.versionNumber - a.versionNumber);
}

/**
 * Resolve which config the simulator should run with.
 *  - If `versionId` is given and is a DRAFT/TESTING for the agent, use it.
 *  - Otherwise use the PUBLISHED version (falling back to the agent row).
 */
export function getVersionForSim(agentId: string, versionId?: string): { systemPrompt: string; structuredConfig: StructuredAgentConfig; model: string } {
  if (versionId) {
    const v = db.agentVersions.find(x => x.id === versionId && x.agentId === agentId);
    if (v && (v.status === 'DRAFT' || v.status === 'TESTING')) {
      return snapshotConfig(v);
    }
  }
  const pub = getPublishedVersion(agentId);
  if (pub) return snapshotConfig(pub);
  const agent = db.agents.find(a => a.id === agentId);
  if (agent) return { systemPrompt: agent.systemPrompt, structuredConfig: agent.structuredConfig, model: agent.model };
  throw new Error('No agent config available.');
}
