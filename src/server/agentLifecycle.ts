import { db } from './db';
import { Agent, AgentStatus, Business, StructuredAgentConfig } from '../types';
import { createInitialDraft } from './agentVersions';
import { resolveProviderAndModel, SUPPORTED_LLM_PROVIDERS } from './llmProvider';
import { assertActivatable } from './readiness';

/**
 * Authoritative factory lifecycle operations extracted (unchanged) from the
 * HTTP routes so both the route layer AND the orchestration layer call the
 * same implementation. The factory remains authoritative — the orchestrator
 * never reimplements these rules.
 *
 *  - createBusinessTenant     == POST /api/businesses (tenant + default rows)
 *  - createAgentWithInitialDraft == POST /api/agents (agent + v1 DRAFT)
 *  - transitionAgentStatus    == POST /api/agents/:id/status (transition map,
 *                                 ACTIVE gated by readiness, one-ACTIVE rule)
 */

// ---------------------------------------------------------------------------
// Business (tenant) creation
// ---------------------------------------------------------------------------

export interface CreateBusinessInput {
  name: string;
  type: string;
  description?: string;
  location?: string;
  language?: string;
  currency?: string;
  timezone?: string;
  hours?: Business['hours'];
  services?: any[];
  faqs?: any[];
  policies?: Business['policies'];
  communicationStyle?: string;
  allowedWidgetOrigins?: string[];
}

const DEFAULT_HOURS = [
  { day: 'monday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
  { day: 'tuesday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
  { day: 'wednesday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
  { day: 'thursday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
  { day: 'friday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
  { day: 'saturday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
  { day: 'sunday', isOpen: false, openTime: '09:00', closeTime: '20:00' }
] as const;

/** Create a tenant + its default channel/integration rows. Throws Error with
 *  a client-safe message on invalid input (callers map it to a 400). */
export async function createBusinessTenant(input: CreateBusinessInput): Promise<Business> {
  const { name, type } = input;
  if (!name || !type) {
    throw new Error('Business name and type are required.');
  }
  if (typeof name !== 'string' || name.length > 200) {
    throw new Error('Business name must be 1-200 characters.');
  }

  const newBiz: Business = {
    id: `biz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    type: type as Business['type'],
    description: input.description || '',
    location: input.location || 'Main Street',
    language: (input.language || 'en') as Business['language'],
    currency: input.currency || 'toman',
    timezone: input.timezone || 'Asia/Tehran',
    hours: input.hours || (DEFAULT_HOURS as unknown as Business['hours']),
    services: (input.services || []).map((s: any, idx: number) => ({
      id: s.id || `srv-${Date.now()}-${idx}`,
      name: s.name,
      price: Number(s.price) || 0,
      // Accept both durationMinutes (canonical) and duration (common shorthand)
      durationMinutes: Number(s.durationMinutes ?? s.duration) || 30,
      description: s.description || ''
    })),
    faqs: (input.faqs || []).map((f: any, idx: number) => ({
      id: f.id || `faq-${Date.now()}-${idx}`,
      question: f.question,
      answer: f.answer
    })),
    policies: input.policies || {
      cancellation: 'Cancel at least 2 hours in advance.',
      refund: 'No monetary refunds after service completed.',
      bookingNotice: 'Book up to 14 days in advance.'
    },
    communicationStyle: input.communicationStyle || 'Friendly, courteous, and efficient.',
    status: 'ACTIVE',
    allowedWidgetOrigins: Array.isArray(input.allowedWidgetOrigins) ? input.allowedWidgetOrigins : [],
    holidays: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await db.businesses.push(newBiz);

  // Initialize Default Channels & Integrations for the new tenant.
  const defaultChannels = ['web_chat', 'instagram', 'sms', 'voice'] as const;
  for (const chanType of defaultChannels) {
    await db.channels.push({
      id: `chan-${Date.now()}-${chanType}`,
      businessId: newBiz.id,
      type: chanType,
      status: chanType === 'web_chat' ? 'connected' : 'not_configured',
      details: chanType === 'web_chat' ? 'Widget ready to embed' : 'Not configured',
      updatedAt: new Date().toISOString()
    });
  }

  const providers = ['google_calendar', 'meta_instagram', 'twilio_sms', 'voice_ai'] as const;
  for (const prov of providers) {
    await db.integrations.push({
      id: `integ-${Date.now()}-${prov}`,
      businessId: newBiz.id,
      provider: prov,
      state: 'NOT_CONFIGURED',
      statusMessage: 'Not configured',
      credentialsSet: false
    });
  }

  await db.auditLogs.push({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    businessId: newBiz.id,
    action: 'BUSINESS_CREATED',
    details: `Business "${newBiz.name}" (${newBiz.type}) created.`,
    timestamp: new Date().toISOString()
  });

  return newBiz;
}

// ---------------------------------------------------------------------------
// Agent creation (agent + v1 DRAFT)
// ---------------------------------------------------------------------------

export interface CreateAgentInput {
  businessId: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  structuredConfig?: StructuredAgentConfig;
  llmProvider?: Agent['llmProvider'];
  model?: string;
  status?: AgentStatus;
}

const DEFAULT_STRUCTURED_CONFIG: StructuredAgentConfig = {
  personality: { tone: 'friendly', behavior: 'service', language: 'en' },
  goals: ['Answer FAQs', 'Book appointments'],
  allowedActions: ['check_business_hours', 'get_business_information', 'check_availability', 'book_appointment', 'search_knowledge', 'transfer_to_human'],
  restrictedActions: ['Do not make up fake information'],
  escalationRules: ['Customer requests human'],
  bookingRules: 'Require name and phone number',
  orderRules: 'Standard checkout',
  refundRules: 'Non-refundable',
  toolsEnabled: ['check_business_hours', 'get_business_information', 'check_availability', 'book_appointment', 'search_knowledge', 'transfer_to_human']
};

/** Create an agent and its first DRAFT version. Provider/model resolution is
 *  the authoritative free-first resolver (never duplicated). Throws with
 *  client-safe messages on invalid input. */
export async function createAgentWithInitialDraft(input: CreateAgentInput): Promise<Agent> {
  const status = input.status ?? 'READY';
  if (!AGENT_STATUSES.includes(status)) {
    throw new Error(`Invalid status. Must be one of: ${AGENT_STATUSES.join(', ')}.`);
  }
  const requestedProvider = input.llmProvider;
  if (requestedProvider && !SUPPORTED_LLM_PROVIDERS.includes(requestedProvider)) {
    throw new Error(`Unsupported llmProvider. Supported: ${SUPPORTED_LLM_PROVIDERS.join(', ')}.`);
  }
  const { provider: resolvedProvider, model: resolvedModel } = resolveProviderAndModel({
    llmProvider: requestedProvider,
    model: input.model
  });

  const newAgent: Agent = {
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    businessId: input.businessId,
    name: input.name,
    description: input.description || 'AI Receptionist & Assistant',
    version: 1,
    status,
    systemPrompt: input.systemPrompt || 'You are an AI assistant. Answer customer queries politely based on business context.',
    structuredConfig: input.structuredConfig || DEFAULT_STRUCTURED_CONFIG,
    llmProvider: resolvedProvider.type,
    model: resolvedModel,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await db.agents.push(newAgent);
  await createInitialDraft(newAgent);

  if (newAgent.status === 'ACTIVE') {
    await pauseOtherActiveAgents(input.businessId, newAgent.id);
  }

  await db.auditLogs.push({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    businessId: input.businessId,
    agentId: newAgent.id,
    action: 'AGENT_CREATED',
    details: `Created agent "${newAgent.name}" v1 (status ${newAgent.status}).`,
    timestamp: new Date().toISOString()
  });

  return newAgent;
}

// ---------------------------------------------------------------------------
// Agent status transitions (enforced map + ACTIVE gate + one-ACTIVE rule)
// ---------------------------------------------------------------------------

export const AGENT_STATUS_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  DRAFT: ['TESTING', 'PAUSED', 'ARCHIVED'],
  TESTING: ['READY', 'DRAFT', 'PAUSED', 'ARCHIVED'],
  READY: ['ACTIVE', 'TESTING', 'PAUSED', 'ARCHIVED'],
  ACTIVE: ['PAUSED', 'ARCHIVED'],
  PAUSED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: []
};

export const AGENT_STATUSES = Object.keys(AGENT_STATUS_TRANSITIONS) as AgentStatus[];

export async function pauseOtherActiveAgents(businessId: string, keepAgentId: string): Promise<void> {
  const others = await db.agents.filter(a => a.businessId === businessId && a.id !== keepAgentId && a.status === 'ACTIVE');
  for (const other of others) {
    other.status = 'PAUSED';
    other.pausedFrom = 'ACTIVE'; // unpausing this agent may resume it as ACTIVE
    other.updatedAt = new Date().toISOString();
    await db.agents.update(other);
    await db.auditLogs.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      businessId,
      agentId: other.id,
      action: 'AGENT_STATUS_CHANGED',
      details: `Agent "${other.name}" auto-paused because agent ${keepAgentId} became ACTIVE (one ACTIVE agent per business).`,
      timestamp: new Date().toISOString()
    });
  }
}

/** Transition an agent to a new status. Same status = idempotent no-op.
 *  ACTIVE is gated by the readiness checklist (throws with `readiness`
 *  attached for structured UI display, mirroring the route behavior). */
export async function transitionAgentStatus(agent: Agent, status: AgentStatus): Promise<Agent> {
  if (!AGENT_STATUSES.includes(status)) {
    throw new Error(`Invalid status. Must be one of: ${AGENT_STATUSES.join(', ')}.`);
  }

  if (status !== agent.status) {
    let allowed = AGENT_STATUS_TRANSITIONS[agent.status];
    // A PAUSED agent may also resume the exact state it was paused from.
    if (agent.status === 'PAUSED' && agent.pausedFrom && !allowed.includes(agent.pausedFrom)) {
      allowed = [...allowed, agent.pausedFrom];
    }
    if (!allowed.includes(status)) {
      throw new Error(`Invalid status transition: ${agent.status} -> ${status}. Allowed: ${[...allowed, agent.status].join(', ')}.`);
    }

    if (status === 'ACTIVE') {
      await assertActivatable(agent);
      const biz = await db.businesses.find(b => b.id === agent.businessId);
      if (!biz) throw new Error('Cannot activate agent: Business not found.');
      await pauseOtherActiveAgents(agent.businessId, agent.id);
    }

    if (status === 'PAUSED') {
      agent.pausedFrom = agent.status;
    } else if (agent.status === 'PAUSED') {
      delete agent.pausedFrom;
    }

    agent.status = status;
    agent.updatedAt = new Date().toISOString();
    await db.agents.update(agent);

    await db.auditLogs.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      businessId: agent.businessId,
      agentId: agent.id,
      action: 'AGENT_STATUS_CHANGED',
      details: `Agent "${agent.name}" state set to ${status}.`,
      timestamp: new Date().toISOString()
    });
  }

  return agent;
}
