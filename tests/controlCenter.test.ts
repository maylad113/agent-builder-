import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

/**
 * Factory Control Center UI behavior tests.
 *
 * The project has no DOM testing-library setup (vitest runs in the `node`
 * environment), so we test the important UI behavior two ways:
 *  1. Unit tests for the pure display helpers in controlCenterLogic.ts
 *     (the decision logic the view relies on — must mirror the server gates
 *      for DISPLAY only; the server remains authoritative).
 *  2. renderToStaticMarkup smoke tests of the presentational ControlCenterView
 *     with mock data, verifying it actually renders the score, failure
 *     categories, human-review banner, publish-blocked reason, and correction
 *     proposals — i.e. the UI surfaces the lifecycle state correctly.
 *
 * The UI never implements authorization or publish rules; these tests assert
 * the display mirrors server state and that the human-review + publish-blocked
 * states are surfaced (never bypassed).
 */
import {
  summarizeEvaluation,
  publishGateHint,
  summarizeCorrection,
  requiresHumanReview,
  correctionActionLabel,
  isAutoSafeProposal,
  failureCategoryBadge
} from '../src/components/controlCenterLogic';
import { ControlCenterView } from '../src/components/FactoryControlCenter';
import {
  Agent,
  EvalRunResult,
  CorrectionResult,
  AgentVersion
} from '../src/types';

// ---------------------------------------------------------------------------
// Mock fixtures
// ---------------------------------------------------------------------------
const mkAgent = (): Agent => ({
  id: 'agent-1', businessId: 'biz-1', name: 'Test Agent', description: 'x',
  version: 1, status: 'READY', systemPrompt: 'x',
  structuredConfig: {
    personality: { tone: 'friendly', behavior: 'concise', language: 'en' },
    goals: [], allowedActions: ['check_business_hours'], restrictedActions: [],
    escalationRules: [], bookingRules: 'Standard', orderRules: 'Standard',
    refundRules: 'Non-refundable', toolsEnabled: ['check_business_hours']
  },
  llmProvider: 'ollama', model: 'llama3.1',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'
});

const mkVersion = (status: AgentVersion['status'] = 'DRAFT'): AgentVersion => ({
  id: 'ver-1', agentId: 'agent-1', businessId: 'biz-1', versionNumber: 1,
  status, systemPrompt: 'x', structuredConfig: mkAgent().structuredConfig,
  model: 'llama3.1', changeNote: 'draft', createdAt: '2026-01-01T00:00:00Z'
});

const mkEval = (overrides: Partial<EvalRunResult> = {}): EvalRunResult => ({
  id: 'eval-1', businessId: 'biz-1', agentId: 'agent-1', versionId: 'ver-1',
  timestamp: '2026-01-01T00:00:00Z', overallPassed: false, totalScenarios: 2,
  passedScenarios: 1, criticalFailures: 1, providerUsed: 'ollama',
  scenarioResults: [
    { scenarioId: 's1', scenarioName: 'Hours', dimension: 'tool_selection', severity: 'critical', passed: true, checks: [], failureCategories: [], reply: 'We are open 9-5.', toolCalls: [{ toolName: 'check_business_hours', args: {}, success: true }], conversationId: 'c1', executionId: 'e1', status: 'COMPLETED', latencyMs: 10 },
    { scenarioId: 's2', scenarioName: 'Handoff', dimension: 'unknown_handling', severity: 'critical', passed: false, checks: [{ dimension: 'handoff', passed: false, detail: 'no handoff', category: 'MISSING_TOOL' }], failureCategories: ['MISSING_TOOL'], reply: 'sure I can book a flight', toolCalls: [], conversationId: 'c2', executionId: 'e2', status: 'COMPLETED', latencyMs: 12 }
  ],
  ...overrides
});

const mkCorrection = (overrides: Partial<CorrectionResult> = {}): CorrectionResult => ({
  id: 'corr-1', businessId: 'biz-1', agentId: 'agent-1', startVersionId: 'ver-1',
  finalVersionId: 'ver-2', resolved: false, humanReviewRequired: true, maxAttempts: 3,
  attempts: [{
    attemptNumber: 1,
    proposal: { category: 'SAFETY_FAILURE', actionType: 'PROPOSE_HUMAN_REVIEW', reason: 'safety', humanReviewRequired: true, targetScenarioIds: ['s2'] },
    appliedToVersionId: 'ver-1', resultingVersionId: 'ver-1', originalEvaluationId: 'eval-1',
    resultingEvaluationId: 'eval-1', status: 'HUMAN_REVIEW', timestamp: '2026-01-01T00:00:00Z'
  }],
  finalEvaluationId: 'eval-1', finalEvaluationPassed: false, reason: 'safety failure', timestamp: '2026-01-01T00:00:00Z',
  ...overrides
});

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------
describe('controlCenterLogic — summarizeEvaluation', () => {
  it('returns null when no run exists', () => {
    expect(summarizeEvaluation(null)).toBeNull();
    expect(summarizeEvaluation(undefined)).toBeNull();
  });

  it('summarizes score, critical failures, and unique failure categories', () => {
    const s = summarizeEvaluation(mkEval())!;
    expect(s.passed).toBe(1);
    expect(s.total).toBe(2);
    expect(s.criticalFailures).toBe(1);
    expect(s.overallPassed).toBe(false);
    expect(s.failureCategories).toEqual(['MISSING_TOOL']);
    expect(s.failedScenarios).toHaveLength(1);
    expect(s.failedScenarios[0].scenarioId).toBe('s2');
  });

  it('reports overallPassed with no failure categories on a clean pass', () => {
    const s = summarizeEvaluation(mkEval({ overallPassed: true, criticalFailures: 0, passedScenarios: 2, scenarioResults: [
      { scenarioId: 's1', scenarioName: 'Hours', dimension: 'tool_selection', severity: 'critical', passed: true, checks: [], failureCategories: [], reply: 'ok', toolCalls: [], conversationId: 'c1', executionId: 'e1', status: 'COMPLETED', latencyMs: 10 },
      { scenarioId: 's2', scenarioName: 'Handoff', dimension: 'unknown_handling', severity: 'critical', passed: true, checks: [], failureCategories: [], reply: 'ok', toolCalls: [], conversationId: 'c2', executionId: 'e2', status: 'COMPLETED', latencyMs: 12 }
    ] }))!;
    expect(s.overallPassed).toBe(true);
    expect(s.failureCategories).toEqual([]);
  });
});

describe('controlCenterLogic — publishGateHint (display only)', () => {
  it('is NOT blocked when no evaluation exists (backward compat; server allows)', () => {
    expect(publishGateHint(null).blocked).toBe(false);
    expect(publishGateHint(null).reason).toBeNull();
  });

  it('is blocked with a reason mirroring the server message when critical failures exist', () => {
    const hint = publishGateHint(mkEval());
    expect(hint.blocked).toBe(true);
    expect(hint.reason).toContain('1 critical failure(s)');
    expect(hint.reason).toContain('MISSING_TOOL');
  });

  it('is NOT blocked when the evaluation passed', () => {
    const hint = publishGateHint(mkEval({ overallPassed: true, criticalFailures: 0 }));
    expect(hint.blocked).toBe(false);
    expect(hint.reason).toBeNull();
  });
});

describe('controlCenterLogic — summarizeCorrection + human review', () => {
  it('summarizes an unresolved, human-review correction', () => {
    const s = summarizeCorrection(mkCorrection())!;
    expect(s.resolved).toBe(false);
    expect(s.humanReviewRequired).toBe(true);
    expect(s.attempts).toBe(1);
    expect(s.proposals[0].actionType).toBe('PROPOSE_HUMAN_REVIEW');
  });

  it('requiresHumanReview is true for unresolved human-review results', () => {
    expect(requiresHumanReview(mkCorrection())).toBe(true);
  });

  it('requiresHumanReview is false when resolved (even if a safety attempt occurred earlier)', () => {
    expect(requiresHumanReview(mkCorrection({ resolved: true, humanReviewRequired: false }))).toBe(false);
  });

  it('requiresHumanReview is false for null', () => {
    expect(requiresHumanReview(null)).toBe(false);
  });
});

describe('controlCenterLogic — correction action labels + safety flags', () => {
  it('labels each action type', () => {
    expect(correctionActionLabel('ENABLE_TOOL')).toBe('Enable required tool');
    expect(correctionActionLabel('ADD_KNOWLEDGE_FROM_SOURCE')).toBe('Add knowledge from trusted source');
    expect(correctionActionLabel('PROPOSE_HUMAN_REVIEW')).toBe('Human review required');
  });

  it('isAutoSafeProposal is false for SAFETY_FAILURE / human-review proposals', () => {
    expect(isAutoSafeProposal({ category: 'SAFETY_FAILURE', actionType: 'PROPOSE_HUMAN_REVIEW', reason: 'r', humanReviewRequired: true, targetScenarioIds: [] })).toBe(false);
  });

  it('isAutoSafeProposal is true for safe ENABLE_TOOL', () => {
    expect(isAutoSafeProposal({ category: 'MISSING_TOOL', actionType: 'ENABLE_TOOL', reason: 'r', humanReviewRequired: false, targetScenarioIds: [] })).toBe(true);
  });

  it('failureCategoryBadge returns a red badge for SAFETY_FAILURE', () => {
    expect(failureCategoryBadge('SAFETY_FAILURE')).toContain('red');
  });
});

// ---------------------------------------------------------------------------
// Presentational view — renderToStaticMarkup smoke tests
// ---------------------------------------------------------------------------
function renderView(overrides: any = {}) {
  const agent = mkAgent();
  const versions = [mkVersion()];
  const evalRun = mkEval();
  const correction = mkCorrection();
  const props = {
    agent,
    versions,
    published: null,
    selectedVersionId: 'ver-1',
    onSelectVersion: () => {},
    selectedVersion: versions[0],
    latestEval: evalRun,
    evalSummary: summarizeEvaluation(evalRun),
    gateHint: publishGateHint(evalRun),
    latestCorrection: correction,
    corrSummary: summarizeCorrection(correction),
    humanReview: requiresHumanReview(correction),
    scenarios: [{ id: 's1', name: 'Hours', userMessage: 'hours?', dimension: 'tool_selection' as const, severity: 'critical' as const }],
    onScenariosChange: undefined,
    knowledgeSources: [],
    onKnowledgeSourcesChange: undefined,
    busy: 'idle' as const,
    error: null,
    publishResult: null,
    onEvaluate: () => {},
    onCorrect: () => {},
    onCreateDraft: () => {},
    onPublish: () => {},
    isPublishedVersion: false,
    ...overrides
  };
  return renderToStaticMarkup(React.createElement(ControlCenterView, props as any));
}

describe('ControlCenterView — renders lifecycle state (renderToStaticMarkup)', () => {
  it('renders the agent name, version status, and provider', () => {
    const html = renderView();
    expect(html).toContain('Test Agent');
    expect(html).toContain('ollama');
    expect(html).toContain('Factory Control Center');
  });

  it('renders the evaluation score and PASSED/FAILED badge', () => {
    const html = renderView();
    expect(html).toContain('1/2');
    expect(html).toContain('FAILED');
    expect(html).toContain('Critical failures');
  });

  it('renders failure categories from the evaluation', () => {
    const html = renderView();
    expect(html).toContain('MISSING_TOOL');
  });

  it('renders the publish-blocked reason when the gate hint is blocked', () => {
    const html = renderView();
    expect(html).toContain('Publishing is blocked');
    expect(html).toContain('1 critical failure(s)');
    expect(html).toContain('server-side gate enforces this');
  });

  it('renders the human-review banner when correction requires it', () => {
    const html = renderView();
    expect(html).toContain('Human review required');
    expect(html).toContain('never auto-approve a safety correction');
  });

  it('renders correction attempts + the safety proposal', () => {
    const html = renderView();
    expect(html).toContain('Self-Correction');
    expect(html).toContain('Attempt 1');
    expect(html).toContain('Human review required');
    expect(html).toContain('Needs human review');
  });

  it('does NOT show a human-review banner when the correction is resolved', () => {
    const correction = mkCorrection({ resolved: true, humanReviewRequired: false, reason: 'passed after 1 attempt' });
    const html = renderView({
      latestCorrection: correction,
      corrSummary: summarizeCorrection(correction),
      humanReview: requiresHumanReview(correction)
    });
    expect(html).toContain('RESOLVED');
    // The human-review BANNER (data-testid) must be absent; the attempt-row
    // label "Human review required" may still appear for a past safety attempt.
    expect(html).not.toContain('data-testid="human-review-banner"');
    expect(html).not.toContain('never auto-approve a safety correction');
  });

  it('does NOT show publish-blocked when the evaluation passed', () => {
    const evalRun = mkEval({ overallPassed: true, criticalFailures: 0, passedScenarios: 2, scenarioResults: [] });
    const html = renderView({
      latestEval: evalRun,
      evalSummary: summarizeEvaluation(evalRun),
      gateHint: publishGateHint(evalRun),
      latestCorrection: null,
      corrSummary: null,
      humanReview: false
    });
    expect(html).toContain('PASSED');
    expect(html).not.toContain('Publishing is blocked');
  });

  it('shows the published version as LIVE when one exists', () => {
    const pub = mkVersion('PUBLISHED');
    pub.versionNumber = 3;
    pub.publishedAt = '2026-01-02T00:00:00Z';
    const html = renderView({ published: pub });
    expect(html).toContain('LIVE');
  });

  it('disables lifecycle actions on a PUBLISHED version', () => {
    const pub = mkVersion('PUBLISHED');
    const html = renderView({ selectedVersion: pub, selectedVersionId: pub.id, isPublishedVersion: true });
    expect(html).toContain('PUBLISHED version');
    expect(html).toContain('Create a new draft');
  });

  it('shows the server publish result (blocked) when the server rejected publish', () => {
    const html = renderView({ publishResult: { ok: false, message: 'Publish blocked: 1 critical failure(s).' } });
    expect(html).toContain('Publish blocked by server');
  });
});
