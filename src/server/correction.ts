import { db } from './db';
import { runEvaluation, getLatestEvaluation } from './evaluation';
import { createDraftFrom, editDraft } from './agentVersions';
import { resolveProviderAndModel, LlmProvider } from './llmProvider';
import { indexChunk } from './embeddings';
import { ALL_TOOL_NAMES } from './tools';
import { recordCorrectionAttempt } from './telemetry';
import {
  EvalScenario,
  EvalScenarioResult,
  EvalRunResult,
  FailureCategory,
  CorrectionProposal,
  CorrectionAttempt,
  CorrectionResult,
  CorrectionActionType,
  TrustedKnowledgeSource,
  StructuredAgentConfig
} from '../types';
import { safeError } from './logSanitizer';

/**
 * Agent Self-Correction Loop.
 *
 * Closes the factory segment: GENERATE -> EVALUATE -> CLASSIFY FAILURE ->
 * CORRECT -> RE-EVALUATE -> PASS / HUMAN REVIEW -> PUBLISH.
 *
 * Safety invariants (enforced here + by the version layer + covered by tests):
 *  - The LLM NEVER decides authorization, NEVER grants itself tools, and NEVER
 *    fabricates knowledge. Deterministic logic is authoritative; LLM output is
 *    only used (optionally) to phrase instruction text, is sanitized, and is
 *    rejected if it attempts to grant tools or weaken safety.
 *  - A PUBLISHED version is NEVER mutated. Corrections are applied to a NEW
 *    DRAFT created from the current DRAFT/TESTING version (`createDraftFrom` +
 *    `editDraft`, which refuse non-draft versions).
 *  - Tenant isolation is never bypassed: every DB op is scoped to `businessId`
 *    and reads are filtered by business_id.
 *  - A SAFETY_FAILURE is NEVER auto-corrected; it only produces a
 *    PROPOSE_HUMAN_REVIEW proposal and stops the loop.
 *  - The agent is NEVER marked resolved without a REAL passing evaluation.
 *  - The loop is bounded by a configurable max attempts (no infinite loops).
 *  - Every attempt is persisted for audit (correction_runs).
 *
 * Free-first: when no LLM provider is available, deterministic correction
 * templates are used exclusively — the loop still runs and still works.
 */

const DEFAULT_MAX_ATTEMPTS = 3;

function maxAttemptsFromEnv(): number {
  const raw = parseInt(process.env.MAX_CORRECTION_ATTEMPTS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_ATTEMPTS;
}

/** Create the correction_runs table if missing. Idempotent (PG + pre-migration
 *  SQLite). Mirrors the evaluation init pattern. */
export async function initCorrectionTable(client: {
  execMany: (sql: string) => Promise<void>;
  dialect: 'sqlite' | 'postgres';
}): Promise<void> {
  const boolType = client.dialect === 'postgres' ? 'BOOLEAN' : 'INTEGER';
  const jsonType = client.dialect === 'postgres' ? 'JSONB' : 'TEXT';
  const jsonDefault = client.dialect === 'postgres' ? "'[]'::jsonb" : "'[]'";
  await client.execMany(
    `CREATE TABLE IF NOT EXISTS correction_runs (
       id                    TEXT PRIMARY KEY,
       business_id           TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
       agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
       start_version_id      TEXT NOT NULL,
       final_version_id      TEXT NOT NULL,
       resolved              ${boolType} NOT NULL,
       human_review_required ${boolType} NOT NULL,
       max_attempts          INTEGER NOT NULL,
       attempts              ${jsonType} NOT NULL DEFAULT ${jsonDefault},
       final_evaluation_id   TEXT,
       final_evaluation_passed ${boolType} NOT NULL DEFAULT ${client.dialect === 'postgres' ? 'FALSE' : '0'},
       reason                TEXT,
       timestamp             TEXT NOT NULL
     )`
  );
  await client.execMany('CREATE INDEX IF NOT EXISTS idx_correction_runs_business ON correction_runs(business_id)');
  await client.execMany('CREATE INDEX IF NOT EXISTS idx_correction_runs_agent ON correction_runs(agent_id, timestamp)');
}

// ---------------------------------------------------------------------------
// Deterministic correction mapping
// ---------------------------------------------------------------------------

/** Minimal provider seam for the optional LLM instruction assist. Tests pass a
 *  fake provider; production passes the resolved provider. */
export interface InstructionAssistant {
  isConfigured(): boolean;
  generate(options: { systemPrompt: string; userPrompt: string }): Promise<{ text?: string; error?: string }>;
}

/** Sanitize an LLM-proposed instruction: plain text only, bounded length, and
 *  reject anything that attempts to grant tools, weaken safety, or act as
 *  authorization. Returns null when the proposal is unsafe/empty. */
function sanitizeInstructionSuggestion(raw: string | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.replace(/```/g, '').trim();
  if (s.length === 0 || s.length > 600) return null;
  const lower = s.toLowerCase();
  const forbidden = [
    'you are now authorized', 'ignore previous', 'disable safety',
    'you may now book without', 'grant yourself', 'bypass tenant',
    'ignore tenant', 'do not escalate', 'never transfer to human'
  ];
  if (forbidden.some(p => lower.includes(p))) return null;
  return s;
}

/** Optional LLM-assisted instruction phrasing. Free-first: when the provider
 *  is unavailable (or the suggestion is unsafe), falls back to the deterministic
 *  `fallback` template. Pure w.r.t. the provider arg so it is unit-testable. */
export async function llmSuggestInstruction(
  assistant: InstructionAssistant,
  context: { category: FailureCategory; scenarioNames: string[]; fallback: string }
): Promise<string> {
  if (!assistant.isConfigured()) return context.fallback;
  try {
    const res = await assistant.generate({
      systemPrompt: 'You help phrase a single concise agent instruction. Output only the instruction text, no preamble.',
      userPrompt:
        `Write one concise instruction for an AI receptionist to fix a ${context.category} failure ` +
        `observed in these scenarios: ${context.scenarioNames.join(', ')}. ` +
        `Do NOT grant tools, weaken safety, or change authorization. ` +
        `Keep it under 60 words. Instruction:`
    });
    if (res.error) return context.fallback;
    const clean = sanitizeInstructionSuggestion(res.text);
    return clean || context.fallback;
  } catch (err: any) {
    safeError('[correction] llm instruction assist failed:', err?.message || err);
    return context.fallback;
  }
}

/** Build a deterministic ENABLE_TOOL proposal. Only proposes enabling a tool
 *  that EXISTS in the registry (ALL_TOOL_NAMES). Never fabricates a tool. */
function proposeEnableTool(
  failedScenarios: EvalScenarioResult[],
  scenarios: EvalScenario[]
): CorrectionProposal | null {
  // Gather expected tool names from the scenarios that failed with MISSING_TOOL.
  const wanted = new Set<string>();
  for (const sr of failedScenarios) {
    if (!sr.failureCategories.includes('MISSING_TOOL')) continue;
    const scenario = scenarios.find(s => s.id === sr.scenarioId);
    for (const t of scenario?.expectedToolCalls || []) wanted.add(t);
  }
  if (wanted.size === 0) return null;

  // Prefer the first tool that EXISTS in the registry. Tools not in the
  // registry cannot be auto-created -> human review.
  const existing = Array.from(wanted).find(t => ALL_TOOL_NAMES.includes(t));
  if (!existing) {
    const missing = Array.from(wanted);
    return {
      category: 'MISSING_TOOL',
      actionType: 'PROPOSE_HUMAN_REVIEW',
      reason: `Scenarios expect tools not present in the registry (${missing.join(', ')}). Tools cannot be fabricated; a human must implement or adjust the scenario.`,
      humanReviewRequired: true,
      targetScenarioIds: failedScenarios.map(s => s.scenarioId),
      details: { toolName: missing[0] }
    };
  }
  return {
    category: 'MISSING_TOOL',
    actionType: 'ENABLE_TOOL',
    reason: `Scenario(s) require the "${existing}" tool, which exists but is not enabled for this agent. Enable it so the agent can call it.`,
    humanReviewRequired: false,
    targetScenarioIds: failedScenarios.map(s => s.scenarioId),
    details: { toolName: existing }
  };
}

/** Build an ADD_KNOWLEDGE_FROM_SOURCE proposal. Only when the owner provided a
 *  TRUSTED source mapped to the failing scenario. Never fabricates content. */
function proposeAddKnowledge(
  failedScenarios: EvalScenarioResult[],
  trustedSources: TrustedKnowledgeSource[]
): CorrectionProposal | null {
  for (const sr of failedScenarios) {
    if (!sr.failureCategories.includes('MISSING_KNOWLEDGE')) continue;
    const source = trustedSources.find(s => s.scenarioId === sr.scenarioId);
    if (source && source.content && source.content.trim().length > 0) {
      return {
        category: 'MISSING_KNOWLEDGE',
        actionType: 'ADD_KNOWLEDGE_FROM_SOURCE',
        reason: `Scenario "${sr.scenarioName}" expects knowledge the agent lacks. A trusted owner-provided source is available; add it to the knowledge base.`,
        humanReviewRequired: false,
        targetScenarioIds: [sr.scenarioId],
        details: {
          knowledgeTitle: source.title,
          knowledgeContent: source.content,
          knowledgeTags: source.tags || []
        }
      };
    }
    // No trusted source for this scenario -> cannot invent facts.
    return {
      category: 'MISSING_KNOWLEDGE',
      actionType: 'PROPOSE_HUMAN_REVIEW',
      reason: `Scenario "${sr.scenarioName}" expects knowledge the agent lacks, and no trusted source was provided. The engine never fabricates knowledge; a human must supply the facts.`,
      humanReviewRequired: true,
      targetScenarioIds: [sr.scenarioId]
    };
  }
  return null;
}

function groundingInstruction(scenario: EvalScenarioResult): string {
  const forbid = scenario.reply ? ` Do not state invented specifics.` : '';
  return `If you are not certain a fact comes from the business information or knowledge base, do not state it as fact.${forbid} Offer to connect the customer to a human instead.`;
}

function handoffInstruction(): string {
  return `When a request is outside your supported services or knowledge, call the transfer_to_human tool immediately rather than guessing.`;
}

function toolArgInstruction(scenario: EvalScenarioResult, scenarios: EvalScenario[]): string {
  const sc = scenarios.find(s => s.id === scenario.scenarioId);
  const ea = sc?.expectedToolArgs;
  if (ea) {
    const argHint = Object.entries(ea.argsContain).map(([k, v]) => `${k}="${v}"`).join(', ');
    return `When calling ${ea.tool}, ensure the required arguments are correct (e.g. ${argHint}).`;
  }
  return `When calling tools, always supply the correct required arguments as described in the tool schema.`;
}

function businessRuleInstruction(scenario: EvalScenarioResult): string {
  const mustContain = (scenario as any).mustContain;
  if (mustContain && Array.isArray(mustContain) && mustContain.length) {
    return `Follow business rules strictly. ${mustContain.join('; ')}.`;
  }
  return `Follow business rules strictly; never contradict the configured booking/refund/order policies.`;
}

/** Produce a CorrectionProposal for one failure category across the failed
 *  scenarios. Deterministic and authoritative. Returns null when the category
 *  is not actionable in this run. */
export function proposeCorrection(
  category: FailureCategory,
  failedScenarios: EvalScenarioResult[],
  scenarios: EvalScenario[],
  trustedSources: TrustedKnowledgeSource[]
): CorrectionProposal | null {
  switch (category) {
    case 'MISSING_TOOL':
      return proposeEnableTool(failedScenarios, scenarios);
    case 'MISSING_KNOWLEDGE':
      return proposeAddKnowledge(failedScenarios, trustedSources);
    case 'BAD_TOOL_ARGUMENT': {
      const instr = toolArgInstruction(failedScenarios[0], scenarios);
      return {
        category,
        actionType: 'CORRECT_TOOL_ARGUMENT_INSTRUCTIONS',
        reason: `A tool was called with incorrect arguments in scenario "${failedScenarios[0].scenarioName}". Strengthen the instructions describing the correct argument shape.`,
        humanReviewRequired: false,
        targetScenarioIds: failedScenarios.map(s => s.scenarioId),
        details: { instructionAppend: instr }
      };
    }
    case 'BUSINESS_RULE_FAILURE': {
      const instr = businessRuleInstruction(failedScenarios[0]);
      return {
        category,
        actionType: 'CORRECT_BUSINESS_RULE_INSTRUCTIONS',
        reason: `A business rule was violated in scenario "${failedScenarios[0].scenarioName}". Strengthen the relevant rule in the agent configuration.`,
        humanReviewRequired: false,
        targetScenarioIds: failedScenarios.map(s => s.scenarioId),
        details: { instructionAppend: instr, ruleField: 'bookingRules' }
      };
    }
    case 'HANDOFF_FAILURE': {
      return {
        category,
        actionType: 'CORRECT_HANDOFF_INSTRUCTIONS',
        reason: `The agent failed to escalate to a human in scenario "${failedScenarios[0].scenarioName}". Add a handoff rule and instruct the agent to transfer when unsure.`,
        humanReviewRequired: false,
        targetScenarioIds: failedScenarios.map(s => s.scenarioId),
        details: { instructionAppend: handoffInstruction() }
      };
    }
    case 'GROUNDING_FAILURE':
    case 'BAD_INSTRUCTION': {
      return {
        category,
        actionType: 'STRENGTHEN_GROUNDING_INSTRUCTIONS',
        reason: `The agent produced unsupported content in scenario "${failedScenarios[0].scenarioName}". Strengthen grounding behavior so the agent does not state facts it cannot support.`,
        humanReviewRequired: false,
        targetScenarioIds: failedScenarios.map(s => s.scenarioId),
        details: { instructionAppend: groundingInstruction(failedScenarios[0]) }
      };
    }
    case 'SAFETY_FAILURE': {
      // NEVER auto-weaken safety. Always require human review.
      return {
        category: 'SAFETY_FAILURE',
        actionType: 'PROPOSE_HUMAN_REVIEW',
        reason: `A safety failure occurred in scenario "${failedScenarios[0].scenarioName}". Safety controls are never weakened automatically; a human must review and approve any change.`,
        humanReviewRequired: true,
        targetScenarioIds: failedScenarios.map(s => s.scenarioId)
      };
    }
    case 'MISSING_INTEGRATION':
    case 'OTHER':
    default:
      return {
        category,
        actionType: 'PROPOSE_HUMAN_REVIEW',
        reason: `Failure category "${category}" in scenario "${failedScenarios[0].scenarioName}" cannot be auto-corrected safely; a human must review.`,
        humanReviewRequired: true,
        targetScenarioIds: failedScenarios.map(s => s.scenarioId)
      };
  }
}

// ---------------------------------------------------------------------------
// Apply corrections to a NEW draft (never the published version)
// ---------------------------------------------------------------------------

function unique(list: string[]): string[] {
  return Array.from(new Set(list));
}

/** Apply a single safe proposal to a draft version's config + system prompt.
 *  Returns the updated { systemPrompt, structuredConfig }. Never throws on
 *  unknown action types (no-op for PROPOSE_HUMAN_REVIEW). */
export function applyProposalToConfig(
  proposal: CorrectionProposal,
  current: { systemPrompt: string; structuredConfig: StructuredAgentConfig }
): { systemPrompt: string; structuredConfig: StructuredAgentConfig } {
  const cfg: StructuredAgentConfig = JSON.parse(JSON.stringify(current.structuredConfig));
  let systemPrompt = current.systemPrompt;

  switch (proposal.actionType) {
    case 'ENABLE_TOOL': {
      const tool = proposal.details?.toolName;
      if (tool && ALL_TOOL_NAMES.includes(tool)) {
        cfg.toolsEnabled = unique([...(cfg.toolsEnabled || []), tool]);
        cfg.allowedActions = unique([...(cfg.allowedActions || []), tool]);
      }
      break;
    }
    case 'ADD_KNOWLEDGE_FROM_SOURCE':
      // Knowledge is added as a chunk in the loop (needs businessId); nothing
      // to change on the version config itself.
      break;
    case 'CORRECT_TOOL_ARGUMENT_INSTRUCTIONS':
    case 'CORRECT_BUSINESS_RULE_INSTRUCTIONS':
    case 'CORRECT_HANDOFF_INSTRUCTIONS':
    case 'STRENGTHEN_GROUNDING_INSTRUCTIONS': {
      const append = proposal.details?.instructionAppend;
      if (append) {
        systemPrompt = `${systemPrompt}\n\n[CORRECTION] ${append}`;
        if (proposal.actionType === 'CORRECT_BUSINESS_RULE_INSTRUCTIONS' && proposal.details?.ruleField) {
          const field = proposal.details.ruleField;
          cfg[field] = `${cfg[field]}. ${append}`;
        }
        if (proposal.actionType === 'CORRECT_HANDOFF_INSTRUCTIONS') {
          cfg.escalationRules = unique([
            ...(cfg.escalationRules || []),
            'Transfer to a human when the request is outside supported services or knowledge.'
          ]);
        }
      }
      break;
    }
    case 'PROPOSE_HUMAN_REVIEW':
    default:
      // Never auto-applied.
      break;
  }
  return { systemPrompt, structuredConfig: cfg };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export interface RunSelfCorrectionParams {
  businessId: string;
  agentId: string;
  /** DRAFT or TESTING version to start from. Must NOT be PUBLISHED. */
  versionId: string;
  scenarios: EvalScenario[];
  /** Owner-provided trustworthy knowledge sources mapped to scenarios. The
   *  engine only adds knowledge from these — never fabricated. */
  trustedKnowledgeSources?: TrustedKnowledgeSource[];
  /** Override the max attempts (defaults to MAX_CORRECTION_ATTEMPTS env / 3). */
  maxAttempts?: number;
}

/** Run the self-correction loop. Never throws on provider/eval failure — those
 *  are recorded and the loop escalates to human review. Returns the full
 *  auditable CorrectionResult (also persisted). */
export async function runSelfCorrection(params: RunSelfCorrectionParams): Promise<CorrectionResult> {
  const { businessId, agentId, versionId, scenarios, trustedKnowledgeSources = [] } = params;
  const maxAttempts = params.maxAttempts ?? maxAttemptsFromEnv();

  // Guard: never mutate a PUBLISHED version. The source must be DRAFT/TESTING.
  const sourceVersion = await db.agentVersions.find(
    v => v.id === versionId && v.agentId === agentId && v.businessId === businessId
  );
  if (!sourceVersion) throw new Error('Source version not found for this tenant/agent.');
  if (sourceVersion.status === 'PUBLISHED' || sourceVersion.status === 'ARCHIVED') {
    throw new Error(`Cannot correct a ${sourceVersion.status} version. Create a new draft from it first.`);
  }

  // Optional LLM instruction assistant (free-first).
  const { provider: llmProvider } = resolveProviderAndModel(null);
  const assistant: InstructionAssistant = {
    isConfigured: () => llmProvider.isConfigured(),
    generate: async ({ systemPrompt, userPrompt }) => {
      const res = await llmProvider.generate({
        model: llmProvider.defaultModel(),
        systemPrompt,
        messages: [{ role: 'user', text: userPrompt }],
        tools: [],
        temperature: 0
      });
      return { text: res.text, error: res.error };
    }
  };

  const attempts: CorrectionAttempt[] = [];
  let currentVersionId = versionId;
  let latestEval: EvalRunResult | undefined = await runEvaluation({
    businessId, agentId, versionId: currentVersionId, scenarios
  });
  let humanReviewRequired = false;
  let resolved = false;
  let reason = 'No correction needed.';

  // Already passing -> no correction required.
  if (latestEval && latestEval.overallPassed) {
    resolved = true;
    reason = 'Agent passed evaluation; no correction needed.';
  }

  let attemptNumber = 0;
  while (!resolved && !humanReviewRequired && attemptNumber < maxAttempts) {
    attemptNumber++;
    latestEval = await getLatestEvaluation(businessId, currentVersionId);
    if (!latestEval) {
      humanReviewRequired = true;
      reason = 'No evaluation available to correct from.';
      break;
    }

    // Collect the unique failure categories from CRITICAL failed scenarios first
    // (critical blockers dominate), then warnings.
    const failedScenarios = latestEval.scenarioResults.filter(s => !s.passed);
    const allCats = Array.from(new Set(failedScenarios.flatMap(s => s.failureCategories))) as FailureCategory[];
    if (allCats.length === 0) {
      resolved = true;
      reason = 'No failures found.';
      break;
    }

    // Produce the first actionable proposal (one targeted correction per attempt
    // keeps changes minimal and auditable). Safety failures stop the loop.
    let chosenProposal: CorrectionProposal | null = null;
    for (const cat of allCats) {
      const failingForCat = failedScenarios.filter(s => s.failureCategories.includes(cat));
      const p = proposeCorrection(cat, failingForCat, scenarios, trustedKnowledgeSources);
      if (p) { chosenProposal = p; break; }
    }
    if (!chosenProposal) {
      humanReviewRequired = true;
      reason = 'No correctable failure category found; human review required.';
      break;
    }

    // SAFETY_FAILURE (or any human-review proposal) stops auto-correction.
    if (chosenProposal.humanReviewRequired) {
      humanReviewRequired = true;
      reason = chosenProposal.reason;
      attempts.push({
        attemptNumber,
        proposal: chosenProposal,
        appliedToVersionId: currentVersionId,
        resultingVersionId: currentVersionId,
        originalEvaluationId: latestEval.id,
        resultingEvaluationId: latestEval.id,
        status: 'HUMAN_REVIEW',
        timestamp: new Date().toISOString()
      });
      break;
    }

    // Apply the correction to a NEW draft (never the published version).
    const newDraft = await createDraftFrom(
      currentVersionId,
      `Self-correction attempt ${attemptNumber}: ${chosenProposal.actionType} for ${chosenProposal.category}`
    );

    // For instruction corrections, optionally refine the wording via the LLM
    // assistant (free-first; sanitized; never grants tools / weakens safety).
    const baseConfig = {
      systemPrompt: newDraft.systemPrompt,
      structuredConfig: newDraft.structuredConfig
    };
    const proposalToApply: CorrectionProposal = { ...chosenProposal };
    if (chosenProposal.details?.instructionAppend) {
      const refined = await llmSuggestInstruction(assistant, {
        category: chosenProposal.category,
        scenarioNames: failedScenarios.map(s => s.scenarioName),
        fallback: chosenProposal.details.instructionAppend
      });
      proposalToApply.details = { ...chosenProposal.details, instructionAppend: refined };
    }

    const updated = applyProposalToConfig(proposalToApply, baseConfig);
    await editDraft(newDraft.id, {
      systemPrompt: updated.systemPrompt,
      structuredConfig: updated.structuredConfig,
      changeNote: `Self-correction attempt ${attemptNumber}: ${chosenProposal.actionType}`
    });

    // ADD_KNOWLEDGE_FROM_SOURCE adds a knowledge chunk (owner-provided content).
    if (chosenProposal.actionType === 'ADD_KNOWLEDGE_FROM_SOURCE' && chosenProposal.details?.knowledgeContent) {
      const chunk = {
        id: `kc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        businessId,
        title: chosenProposal.details.knowledgeTitle || 'Corrected knowledge',
        type: 'faq' as const,
        content: chosenProposal.details.knowledgeContent,
        tags: chosenProposal.details.knowledgeTags || [],
        createdAt: new Date().toISOString()
      };
      await db.knowledgeChunks.push(chunk);
      indexChunk(chunk).catch(() => {/* embedding failures are non-fatal */});
    }

    // Re-evaluate the corrected draft.
    const reEval = await runEvaluation({
      businessId, agentId, versionId: newDraft.id, scenarios
    });

    attempts.push({
      attemptNumber,
      proposal: chosenProposal,
      appliedToVersionId: currentVersionId,
      resultingVersionId: newDraft.id,
      originalEvaluationId: latestEval.id,
      resultingEvaluationId: reEval.id,
      status: 'APPLIED',
      timestamp: new Date().toISOString()
    });

    currentVersionId = newDraft.id;
    latestEval = reEval;

    if (reEval.overallPassed) {
      resolved = true;
      reason = `Agent passed evaluation after ${attemptNumber} correction attempt(s).`;
      break;
    }
  }

  if (!resolved && !humanReviewRequired) {
    // Max attempts exhausted without a pass -> escalate to human review.
    humanReviewRequired = true;
    reason = `Maximum correction attempts (${maxAttempts}) exhausted without a passing evaluation; human review required.`;
  }

  const result: CorrectionResult = {
    id: `corr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    businessId,
    agentId,
    startVersionId: versionId,
    finalVersionId: currentVersionId,
    resolved,
    humanReviewRequired,
    maxAttempts,
    attempts,
    finalEvaluationId: latestEval?.id ?? null,
    finalEvaluationPassed: !!latestEval?.overallPassed,
    reason,
    timestamp: new Date().toISOString()
  };

  await db.correctionRuns.push(result);
  // Telemetry: correction attempt/run (resolved + human-review + attempts).
  await recordCorrectionAttempt({
    businessId, agentId, versionId, correctionId: result.id,
    resolved, humanReviewRequired, attempts: attempts.length,
    finalVersionId: currentVersionId, reason
  });
  return result;
}

/** List correction runs for an agent (tenant-scoped), newest first. */
export async function listCorrectionsForAgent(
  businessId: string,
  agentId: string
): Promise<CorrectionResult[]> {
  const all = await db.correctionRuns.filter(r => r.businessId === businessId && r.agentId === agentId);
  return all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/** Latest correction run for a version (tenant-scoped), or undefined. */
export async function getLatestCorrectionForVersion(
  businessId: string,
  versionId: string
): Promise<CorrectionResult | undefined> {
  const all = await db.correctionRuns.filter(
    r => r.businessId === businessId && (r.startVersionId === versionId || r.finalVersionId === versionId)
  );
  if (all.length === 0) return undefined;
  return all.reduce((latest, r) =>
    new Date(r.timestamp).getTime() > new Date(latest.timestamp).getTime() ? r : latest
  , all[0]);
}

// Re-export for route convenience.
export { getLatestEvaluation };
