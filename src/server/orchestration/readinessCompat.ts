import { DesignConfiguration } from '../../types';

/**
 * Designer→Factory readiness compatibility (Phase C / Task 16).
 *
 * A PURE, deterministic pre-flight for the canonical DesignConfiguration. It
 * answers ONE question: "can this configuration satisfy the Factory's
 * ACTIVATING readiness gate?" — BEFORE a Factory job is created. It mirrors
 * the semantics of src/server/readiness.ts (computeAgentReadiness) but ONLY
 * for the subset provable from configuration alone. It does NOT replace the
 * Factory gate, which stays authoritative and runs its own full check.
 *
 * Deliberately NOT evaluated here (runtime/tenant state the config cannot
 * prove): 'Channel connected' (web_chat auto-connects at tenant creation),
 * 'Model configured' (resolved free-first at agent creation), 'Published
 * version' (the factory publishes), 'Business information' name (the submit
 * engine backfills from prospect.businessName).
 */

export interface CompatibilityGap {
  code:
    | 'MISSING_SERVICES'
    | 'MISSING_HOURS'
    | 'MISSING_CANCELLATION'
    | 'MISSING_DESCRIPTION'
    | 'MISSING_ALLOWED_ACTIONS'
    | 'MISSING_TOOLS'
    | 'MISSING_KNOWLEDGE'
    | 'MISSING_SCENARIOS'
    | 'MALFORMED_CONFIGURATION';
  requirement: string;
  detail: string;
}

export interface CompatibilityResult {
  compatible: boolean;
  gaps: CompatibilityGap[];
}

const GAP_META: Record<CompatibilityGap['code'], { requirement: string; detail: string }> = {
  MISSING_SERVICES: {
    requirement: 'Services',
    detail: 'configuration.business.services must include at least one service (price + duration).'
  },
  MISSING_HOURS: {
    requirement: 'Operating hours',
    detail: 'configuration.business.hours was provided but has no open day; omit it or include an open day.'
  },
  MISSING_CANCELLATION: {
    requirement: 'Cancellation policy',
    detail: 'configuration.business.policies.cancellation was provided but is empty.'
  },
  MISSING_DESCRIPTION: {
    requirement: 'Business information',
    detail: 'configuration.business.description was provided but is empty.'
  },
  MISSING_ALLOWED_ACTIONS: {
    requirement: 'Tool permissions',
    detail: 'configuration.agent.structuredConfig.allowedActions must include at least one permitted action.'
  },
  MISSING_TOOLS: {
    requirement: 'Tools enabled',
    detail: 'configuration.agent.structuredConfig.toolsEnabled must include at least one tool.'
  },
  MISSING_KNOWLEDGE: {
    requirement: 'Knowledge base',
    detail: 'configuration.knowledge must include at least one knowledge item (tenant grounding).'
  },
  MISSING_SCENARIOS: {
    requirement: 'Evaluation scenarios',
    detail: 'configuration.scenarios must be a non-empty array.'
  },
  MALFORMED_CONFIGURATION: {
    requirement: 'Configuration',
    detail: 'configuration is missing or malformed.'
  }
};

function gap(code: CompatibilityGap['code']): CompatibilityGap {
  return { code, ...GAP_META[code] };
}

/**
 * Pure deterministic check. Never mutates input; no DB/network/LLM/env
 * access; stable gap ordering (fixed evaluation order).
 */
export function checkFactoryReadinessCompatibility(configuration: unknown): CompatibilityResult {
  const gaps: CompatibilityGap[] = [];
  if (!configuration || typeof configuration !== 'object') {
    return { compatible: false, gaps: [gap('MALFORMED_CONFIGURATION')] };
  }
  const config = configuration as DesignConfiguration;
  const biz = config.business as any;
  const sc = config.agent?.structuredConfig as any;

  // --- business (tenant-provable) ------------------------------------------
  const services = Array.isArray(biz?.services) ? biz.services : [];
  if (services.length === 0) gaps.push(gap('MISSING_SERVICES'));
  if (Array.isArray(biz?.hours) && !biz.hours.some((h: any) => h && h.isOpen === true)) {
    gaps.push(gap('MISSING_HOURS')); // present-but-broken only (absent = tenant default)
  }
  if (biz?.policies !== undefined && !biz?.policies?.cancellation) gaps.push(gap('MISSING_CANCELLATION'));
  if (biz?.description !== undefined && !String(biz.description || '').trim()) gaps.push(gap('MISSING_DESCRIPTION'));

  // --- agent permissions / tools (config-provable) --------------------------
  const allowedActions = Array.isArray(sc?.allowedActions) ? sc.allowedActions.filter((a: any) => typeof a === 'string' && a.trim()) : [];
  if (allowedActions.length === 0) gaps.push(gap('MISSING_ALLOWED_ACTIONS'));
  const tools = Array.isArray(sc?.toolsEnabled) ? sc.toolsEnabled.filter((t: any) => typeof t === 'string' && t.trim()) : [];
  if (tools.length === 0) gaps.push(gap('MISSING_TOOLS'));

  // --- grounding + evaluation (config-provable) -----------------------------
  const knowledge = Array.isArray(config.knowledge) ? config.knowledge : [];
  if (knowledge.length === 0) gaps.push(gap('MISSING_KNOWLEDGE'));
  const scenarios = Array.isArray(config.scenarios) ? config.scenarios : [];
  if (scenarios.length === 0) gaps.push(gap('MISSING_SCENARIOS'));

  return { compatible: gaps.length === 0, gaps };
}

/** Stable, client-safe one-line summary of gaps (no config values echoed). */
export function summarizeCompatibilityGaps(gaps: CompatibilityGap[]): string {
  return gaps.map(g => `${g.requirement}: ${g.detail}`).join(' ');
}
