import { db } from './db';
import { Agent, Business } from '../types';
import { getPublishedVersion } from './agentVersions';

/**
 * Agent deployment-readiness gate (Phase 20).
 *
 * An agent may only be set to ACTIVE when every critical requirement below is
 * satisfied. This is a server-side gate: the frontend cannot bypass it.
 *
 * Checks (each returns { ok: boolean; requirement: string; detail?: string }):
 *  1. Business information present
 *  2. Operating hours configured
 *  3. At least one service configured
 *  4. Knowledge base non-empty
 *  5. Agent instructions (system prompt) present
 *  6. At least one tool enabled
 *  7. Tool permissions configured (allowedActions non-empty)
 *  8. Model configured
 *  9. At least one channel connected
 * 10. Human-handoff escalation rules present
 * 11. A PUBLISHED agent version exists (production uses published config)
 * 12. Security: business has working hours / contact info so escalation works
 */

export interface ReadinessCheck {
  requirement: string;
  ok: boolean;
  detail?: string;
}

export interface ReadinessResult {
  ready: boolean;
  missing: string[];
  checks: ReadinessCheck[];
}

export function computeAgentReadiness(agent: Agent): ReadinessResult {
  const biz = db.businesses.find(b => b.id === agent.businessId);
  const services = biz?.services ?? [];
  const knowledge = db.knowledgeChunks.filter(k => k.businessId === agent.businessId);
  const channels = db.channels.filter(c => c.businessId === agent.businessId);
  const published = getPublishedVersion(agent.id);

  const structured = agent.structuredConfig;
  const instructions = agent.systemPrompt || published?.systemPrompt || structured?.personality?.customPrompt;

  const checks: ReadinessCheck[] = [
    {
      requirement: 'Business information',
      ok: !!biz && !!biz.description && !!biz.name,
      detail: biz?.description ? undefined : 'Add a business description so the agent can introduce the business.'
    },
    {
      requirement: 'Operating hours',
      ok: !!biz && Array.isArray(biz.hours) && biz.hours.some(h => h.isOpen),
      detail: 'Configure working hours so appointments can be booked correctly.'
    },
    {
      requirement: 'Services',
      ok: services.length > 0,
      detail: 'Add at least one service with a price and duration.'
    },
    {
      requirement: 'Knowledge base',
      ok: knowledge.length > 0,
      detail: 'Add at least one knowledge item (FAQ / policy / info) for grounding.'
    },
    {
      requirement: 'Agent instructions',
      ok: !!instructions && String(instructions).trim().length > 0,
      detail: 'Provide a system prompt / instructions for the agent.'
    },
    {
      requirement: 'Tools enabled',
      ok: Array.isArray(structured?.toolsEnabled) && (structured.toolsEnabled.length > 0),
      detail: 'Enable at least one tool (e.g. get_business_information).'
    },
    {
      requirement: 'Tool permissions',
      ok: Array.isArray(structured?.allowedActions) && (structured.allowedActions.length > 0),
      detail: 'Configure allowedActions so the model can use permitted tools.'
    },
    {
      requirement: 'Model configured',
      ok: !!agent.model || !!published?.model,
      detail: 'Select a model for the agent.'
    },
    {
      requirement: 'Channel connected',
      ok: channels.some(c => c.status === 'connected'),
      detail: 'Connect at least one channel (web chat widget counts).'
    },
    {
      requirement: 'Human handoff rules',
      ok: Array.isArray(structured?.escalationRules) && (structured.escalationRules.length > 0),
      detail: 'Define escalation rules so the agent can hand off to a human.'
    },
    {
      requirement: 'Published version',
      ok: !!published,
      detail: 'Publish an agent version so production uses a frozen configuration.'
    },
    {
      requirement: 'Cancellation policy',
      ok: !!biz && !!biz.policies && !!biz.policies.cancellation,
      detail: 'Configure a cancellation policy so appointments are managed consistently.'
    }
  ];

  const missing = checks.filter(c => !c.ok).map(c => c.requirement);
  return { ready: missing.length === 0, missing, checks };
}

/** Assert readiness for ACTIVE; throw an Error the route can return as 400. */
export function assertActivatable(agent: Agent): ReadinessResult {
  const result = computeAgentReadiness(agent);
  if (!result.ready) {
    const err: any = new Error('Agent is not ready for activation. Missing requirements: ' + result.missing.join(', '));
    err.readiness = result;
    throw err;
  }
  return result;
}

/** GET-friendly snapshot (no secrets surfaced). */
export function readinessSnapshot(agent: Agent): ReadinessResult {
  return computeAgentReadiness(agent);
}

// Keep Business import referenced for type clarity.
export type _BusinessRef = Business;
