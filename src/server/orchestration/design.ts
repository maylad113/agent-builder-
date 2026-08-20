import { db } from '../db';
import { DesignProposal, DesignStatus, DesignConfiguration, Prospect } from '../../types';
import { recordOrchestrationEvent } from '../telemetry';
import { setProspectStatus } from './prospects';

/**
 * Design proposals. A proposal is DRAFT until an explicit HUMAN approval
 * action (POST .../designs/:id/approve). Only APPROVED proposals may be
 * submitted to the factory. No LLM/API path can approve itself — approval is
 * a route-local mutation invoked only by the platform owner.
 */

export const DESIGN_TRANSITIONS: Record<DesignStatus, DesignStatus[]> = {
  DRAFT: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUBMITTED', 'REJECTED'],
  SUBMITTED: [],
  REJECTED: []
};

const MAX_TITLE_LEN = 200;
const MAX_TEXT_LEN = 4000;

function genId(): string {
  return `des-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanStr(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function cleanStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string').map(x => x.slice(0, MAX_TITLE_LEN));
}

function asStrSet(v: unknown): string[] {
  if (v === undefined) return [];
  return cleanStrArray(v);
}

/** Create a design proposal for a prospect (status DRAFT). Moves the
 *  prospect to DESIGN_PROPOSED when it is still NEW. */
export async function createDesign(prospect: Prospect, input: {
  title?: unknown;
  problemStatement?: unknown;
  proposedSolution?: unknown;
  agentType?: unknown;
  capabilities?: unknown;
  channels?: unknown;
  integrations?: unknown;
  configuration?: unknown;
}, opts: {
  generationKey?: string;
  sourceReportId?: string;
  generatorModel?: string;
  rationale?: string;
  uncertainty?: string;
} = {}): Promise<DesignProposal> {
  const title = cleanStr(input.title, MAX_TITLE_LEN);
  const problemStatement = cleanStr(input.problemStatement, MAX_TEXT_LEN);
  const proposedSolution = cleanStr(input.proposedSolution, MAX_TEXT_LEN);
  if (!title || !problemStatement || !proposedSolution) {
    throw new Error('title, problemStatement and proposedSolution are required.');
  }
  const config = (input.configuration && typeof input.configuration === 'object'
    ? input.configuration
    : undefined) as DesignConfiguration | undefined;

  const now = new Date().toISOString();
  const design: DesignProposal = {
    id: genId(),
    prospectId: prospect.id,
    title,
    problemStatement,
    proposedSolution,
    agentType: cleanStr(input.agentType, MAX_TITLE_LEN) || 'receptionist',
    capabilities: asStrSet(input.capabilities),
    channels: asStrSet(input.channels),
    integrations: asStrSet(input.integrations),
    configuration: config,
    status: 'DRAFT',
    ...(opts.generationKey ? { generationKey: opts.generationKey } : {}),
    ...(opts.sourceReportId ? { sourceReportId: opts.sourceReportId } : {}),
    ...(opts.generatorModel ? { generatorModel: opts.generatorModel } : {}),
    ...(opts.rationale ? { rationale: cleanStr(opts.rationale, MAX_TEXT_LEN) } : {}),
    ...(opts.uncertainty ? { uncertainty: cleanStr(opts.uncertainty, MAX_TEXT_LEN) } : {}),
    createdAt: now,
    updatedAt: now
  };
  await db.designProposals.push(design);

  if (prospect.status === 'NEW') {
    await setProspectStatus(prospect, 'DESIGN_PROPOSED');
  }

  await recordOrchestrationEvent({
    eventType: 'DESIGN_CREATED',
    prospectId: prospect.id,
    businessId: prospect.businessId,
    metadata: { designId: design.id },
    summary: `Design created: ${design.title}`
  });
  return design;
}

export async function getDesign(id: string): Promise<DesignProposal | undefined> {
  return db.designProposals.find(d => d.id === id);
}

export async function listDesignsForProspect(prospectId: string): Promise<DesignProposal[]> {
  return db.designProposals.filter(d => d.prospectId === prospectId);
}

/** HUMAN approval — the only path to APPROVED. Idempotent on an already
 *  APPROVED design (returns unchanged). Explicitly rejected designs cannot be
 *  re-approved through this path. */
export async function approveDesign(prospect: Prospect, design: DesignProposal): Promise<DesignProposal> {
  if (design.status === 'APPROVED' || design.status === 'SUBMITTED') return design;
  if (!DESIGN_TRANSITIONS[design.status].includes('APPROVED')) {
    throw new Error(`Invalid design transition: ${design.status} -> APPROVED.`);
  }
  design.status = 'APPROVED';
  design.approvedAt = new Date().toISOString();
  design.updatedAt = design.approvedAt;
  await db.designProposals.update(design);

  if (prospect.status === 'DESIGN_PROPOSED') {
    await setProspectStatus(prospect, 'APPROVED');
  }

  await recordOrchestrationEvent({
    eventType: 'DESIGN_APPROVED',
    prospectId: prospect.id,
    businessId: prospect.businessId,
    metadata: { designId: design.id },
    summary: `Design approved: ${design.title}`
  });
  return design;
}

/** Mark a design SUBMITTED (called by the factory submitter). */
export async function markDesignSubmitted(prospect: Prospect, design: DesignProposal): Promise<DesignProposal> {
  if (!DESIGN_TRANSITIONS[design.status].includes('SUBMITTED')) {
    throw new Error(`Invalid design transition: ${design.status} -> SUBMITTED.`);
  }
  design.status = 'SUBMITTED';
  design.updatedAt = new Date().toISOString();
  await db.designProposals.update(design);
  return design;
}

/**
 * Validate the factory configuration BEFORE approval is meaningful. Returns
 * a list of client-safe problems; empty means submittable. Deterministic —
 * the submitter runs this again so draft edits cannot sneak past.
 */
export function validateDesignConfiguration(configuration: DesignConfiguration | undefined): string[] {
  const problems: string[] = [];
  if (!configuration || typeof configuration !== 'object') {
    return ['configuration is required.'];
  }
  const biz = configuration.business;
  if (!biz || typeof biz !== 'object') {
    problems.push('configuration.business is required.');
  } else {
    if (!biz.name || typeof biz.name !== 'string') problems.push('configuration.business.name is required.');
    if (!biz.type || typeof biz.type !== 'string') problems.push('configuration.business.type is required.');
  }
  const agent = configuration.agent;
  if (!agent || typeof agent !== 'object') {
    problems.push('configuration.agent is required.');
  } else {
    if (!agent.name || typeof agent.name !== 'string') problems.push('configuration.agent.name is required.');
    if (!agent.systemPrompt || typeof agent.systemPrompt !== 'string') problems.push('configuration.agent.systemPrompt is required.');
    if (!agent.structuredConfig || typeof agent.structuredConfig !== 'object') problems.push('configuration.agent.structuredConfig is required.');
  }
  const scenarios = configuration.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    problems.push('configuration.scenarios must be a non-empty array.');
  } else {
    for (const s of scenarios) {
      if (!s || !s.id || !s.name || !s.userMessage || !s.dimension) {
        problems.push('each scenario needs id, name, userMessage and dimension.');
        break;
      }
    }
  }
  return problems;
}
