/**
 * Pure presentation helpers for the Factory Control Center UI.
 *
 * IMPORTANT: these functions are DISPLAY-ONLY. They never implement
 * authorization, publish rules, or business logic — the server-side
 * evaluation/publish gates remain authoritative. The UI uses these only to
 * surface evaluation/correction state to the owner. Every actual state change
 * (evaluate, correct, publish) is performed by calling the real API, and the
 * server's response is what the UI displays.
 *
 * Kept pure (no React, no fetch) so they are unit-testable in the existing
 * node vitest environment.
 */
import {
  EvalRunResult,
  EvalScenarioResult,
  CorrectionResult,
  CorrectionProposal,
  FailureCategory
} from '../types';

export interface EvalSummary {
  passed: number;
  total: number;
  criticalFailures: number;
  overallPassed: boolean;
  providerUsed: string;
  /** Unique failure categories across failed scenarios (display order). */
  failureCategories: FailureCategory[];
  failedScenarios: EvalScenarioResult[];
}

/** Summarize an evaluation run for display. Returns null when no run exists. */
export function summarizeEvaluation(run: EvalRunResult | null | undefined): EvalSummary | null {
  if (!run) return null;
  const failedScenarios = run.scenarioResults.filter(s => !s.passed);
  const cats = Array.from(new Set(failedScenarios.flatMap(s => s.failureCategories))) as FailureCategory[];
  return {
    passed: run.passedScenarios,
    total: run.totalScenarios,
    criticalFailures: run.criticalFailures,
    overallPassed: run.overallPassed,
    providerUsed: run.providerUsed,
    failureCategories: cats,
    failedScenarios
  };
}

/**
 * Display hint for the publish gate. This MIRRORS the server's blocked message
 * format for display only — it does NOT decide whether publish is allowed. The
 * Publish button always calls the server; if the server blocks, its error is
 * shown. This hint lets the UI show "why" before the owner clicks.
 */
export function publishGateHint(run: EvalRunResult | null | undefined): {
  blocked: boolean;
  reason: string | null;
} {
  if (!run) return { blocked: false, reason: null };
  if (run.criticalFailures > 0) {
    const cats = Array.from(new Set(
      run.scenarioResults
        .filter(s => !s.passed && s.severity === 'critical')
        .flatMap(s => s.failureCategories)
    ));
    return {
      blocked: true,
      reason: `Publish blocked: ${run.criticalFailures} critical failure(s). Categories: ${cats.join(', ')}.`
    };
  }
  return { blocked: false, reason: null };
}

export interface CorrectionSummary {
  resolved: boolean;
  humanReviewRequired: boolean;
  attempts: number;
  finalVersionId: string;
  startVersionId: string;
  reason: string;
  /** The proposals applied/considered across attempts (for display). */
  proposals: CorrectionProposal[];
}

export function summarizeCorrection(result: CorrectionResult | null | undefined): CorrectionSummary | null {
  if (!result) return null;
  return {
    resolved: result.resolved,
    humanReviewRequired: result.humanReviewRequired,
    attempts: result.attempts.length,
    finalVersionId: result.finalVersionId,
    startVersionId: result.startVersionId,
    reason: result.reason,
    proposals: result.attempts.map(a => a.proposal)
  };
}

/** Whether a correction result requires human review (safety / unresolved). */
export function requiresHumanReview(result: CorrectionResult | null | undefined): boolean {
  return !!result && result.humanReviewRequired && !result.resolved;
}

/** Human-readable label for a correction action type. */
export function correctionActionLabel(actionType: CorrectionProposal['actionType']): string {
  switch (actionType) {
    case 'ENABLE_TOOL': return 'Enable required tool';
    case 'ADD_KNOWLEDGE_FROM_SOURCE': return 'Add knowledge from trusted source';
    case 'STRENGTHEN_GROUNDING_INSTRUCTIONS': return 'Strengthen grounding instructions';
    case 'CORRECT_TOOL_ARGUMENT_INSTRUCTIONS': return 'Correct tool-argument instructions';
    case 'CORRECT_BUSINESS_RULE_INSTRUCTIONS': return 'Correct business-rule instructions';
    case 'CORRECT_HANDOFF_INSTRUCTIONS': return 'Correct handoff instructions';
    case 'PROPOSE_HUMAN_REVIEW': return 'Human review required';
    default: return actionType;
  }
}

/** Whether a proposal is safe to auto-apply (the backend already enforces this;
 *  this is a display flag so the UI can show "auto-applied" vs "needs review"). */
export function isAutoSafeProposal(proposal: CorrectionProposal): boolean {
  return !proposal.humanReviewRequired && proposal.actionType !== 'PROPOSE_HUMAN_REVIEW';
}

/** Badge color class for a failure category (Tailwind classes). */
export function failureCategoryBadge(category: FailureCategory): string {
  if (category === 'SAFETY_FAILURE') return 'bg-red-100 text-red-800';
  if (category === 'MISSING_TOOL' || category === 'MISSING_KNOWLEDGE' || category === 'MISSING_INTEGRATION') return 'bg-amber-100 text-amber-800';
  if (category === 'GROUNDING_FAILURE' || category === 'BAD_INSTRUCTION') return 'bg-orange-100 text-orange-800';
  return 'bg-slate-100 text-slate-700';
}
