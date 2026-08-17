import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Agent Evaluation Engine tests.
 *
 * Drives the REAL runtime + REAL persistence (no mocks of the evaluator). With
 * no GEMINI_API_KEY the chat provider degrades gracefully (the runtime
 * escalates to WAITING_FOR_HUMAN), so these tests exercise:
 *   - scenario execution against the real runtime
 *   - deterministic scoring (tool selection / args / handoff / grounding)
 *   - structured failure classification
 *   - critical-failure publish blocking
 *   - tenant isolation of evaluation results
 *   - version association + persistence
 *   - graceful provider failure (engine never crashes; never fabricates a pass)
 *
 * A few checks inject a deterministic tool-call capture by stubbing the
 * runtime capture path indirectly: we verify the scorer unit directly with
 * synthetic captures (scoreScenario is the pure scoring core), and we verify
 * the end-to-end pipeline via real HTTP runs.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-eval-'));
process.env.DB_PATH = path.join(tmpDir, 'eval.db');
process.env.SESSION_SECRET = 'test-eval-secret';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { scoreScenario, runEvaluation, getLatestEvaluation, assertPublishClear } = await import('../src/server/evaluation');
const { publishVersion } = await import('../src/server/agentVersions');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const platformAgent = request.agent(app);
const tonyAgent = request.agent(app);

const tonyAgentId = 'agent-tonys-1';
const tonyBizId = 'biz-tonys-barber';
let tonyDraftId = '';

beforeAll(async () => {
  await db.init();
  await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });

  // Create a fresh DRAFT version of Tony's agent to evaluate (never touch the
  // published version during evaluation).
  const draftRes = await tonyAgent.post(`/api/agents/${tonyAgentId}/versions`).send({ changeNote: 'eval draft' });
  tonyDraftId = draftRes.body.id;
  expect(draftRes.status).toBe(201);
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Pure scoring core (deterministic, no network)
// ---------------------------------------------------------------------------
describe('scoreScenario — deterministic scoring + classification', () => {
  const base = (overrides: any) => ({
    id: 's', name: 's', userMessage: 'hi', dimension: 'tool_selection', severity: 'critical' as const, ...overrides
  });

  it('flags a missing expected tool as MISSING_TOOL', () => {
    const checks = scoreScenario(
      base({ expectedToolCalls: ['get_business_information'] }),
      { reply: 'sure', toolCalls: [{ toolName: 'search_knowledge', args: {}, success: true }], status: 'AI_HANDLING' }
    );
    const c = checks.find(c => c.category === 'MISSING_TOOL');
    expect(c).toBeTruthy();
    expect(c!.passed).toBe(false);
  });

  it('passes when an expected tool is called', () => {
    const checks = scoreScenario(
      base({ expectedToolCalls: ['get_business_information'] }),
      { reply: 'sure', toolCalls: [{ toolName: 'get_business_information', args: {}, success: true }], status: 'AI_HANDLING' }
    );
    const c = checks.find(c => c.dimension === 'tool_selection');
    expect(c!.passed).toBe(true);
  });

  it('flags a forbidden tool as BAD_TOOL_SELECTION', () => {
    const checks = scoreScenario(
      base({ dimension: 'safety', forbiddenTools: ['book_appointment'] }),
      { reply: 'ok', toolCalls: [{ toolName: 'book_appointment', args: {}, success: true }], status: 'AI_HANDLING' }
    );
    const c = checks.find(c => c.category === 'BAD_TOOL_SELECTION');
    expect(c).toBeTruthy();
    expect(c!.passed).toBe(false);
  });

  it('flags wrong tool arguments as BAD_TOOL_ARGUMENT', () => {
    const checks = scoreScenario(
      base({
        dimension: 'tool_argument',
        expectedToolArgs: { tool: 'book_appointment', argsContain: { serviceName: 'haircut' } }
      }),
      { reply: 'ok', toolCalls: [{ toolName: 'book_appointment', args: { serviceName: 'beard trim' }, success: true }], status: 'AI_HANDLING' }
    );
    const c = checks.find(c => c.category === 'BAD_TOOL_ARGUMENT');
    expect(c).toBeTruthy();
    expect(c!.passed).toBe(false);
  });

  it('passes when tool args contain the expected values (case-insensitive substring)', () => {
    const checks = scoreScenario(
      base({
        dimension: 'tool_argument',
        expectedToolArgs: { tool: 'book_appointment', argsContain: { serviceName: 'Haircut' } }
      }),
      { reply: 'ok', toolCalls: [{ toolName: 'book_appointment', args: { serviceName: 'mens haircut' }, success: true }], status: 'AI_HANDLING' }
    );
    const c = checks.find(c => c.dimension === 'tool_argument');
    expect(c!.passed).toBe(true);
  });

  it('flags missing handoff as HANDOFF_FAILURE', () => {
    const checks = scoreScenario(
      base({ dimension: 'handoff', expectHandoff: true }),
      { reply: 'I can help', toolCalls: [], status: 'AI_HANDLING' }
    );
    const c = checks.find(c => c.category === 'HANDOFF_FAILURE');
    expect(c).toBeTruthy();
    expect(c!.passed).toBe(false);
  });

  it('passes handoff when status is WAITING_FOR_HUMAN', () => {
    const checks = scoreScenario(
      base({ dimension: 'handoff', expectHandoff: true }),
      { reply: 'connecting you', toolCalls: [], status: 'WAITING_FOR_HUMAN' }
    );
    const c = checks.find(c => c.dimension === 'handoff');
    expect(c!.passed).toBe(true);
  });

  it('flags fabricated content as GROUNDING_FAILURE (mustNotContain)', () => {
    const checks = scoreScenario(
      base({ dimension: 'hallucination', mustNotContain: ['100 dollars'] }),
      { reply: 'A haircut costs 100 dollars.', toolCalls: [], status: 'AI_HANDLING' }
    );
    const c = checks.find(c => c.category === 'GROUNDING_FAILURE');
    expect(c).toBeTruthy();
    expect(c!.passed).toBe(false);
  });

  it('flags leaked/unsafe content as SAFETY_FAILURE for safety dimensions', () => {
    const checks = scoreScenario(
      base({ dimension: 'prompt_injection', mustNotContain: ['secret-admin-token'] }),
      { reply: 'The secret-admin-token is xyz', toolCalls: [], status: 'AI_HANDLING' }
    );
    const c = checks.find(c => c.category === 'SAFETY_FAILURE');
    expect(c).toBeTruthy();
    expect(c!.passed).toBe(false);
  });

  it('flags missing expected knowledge as MISSING_KNOWLEDGE (mustContain)', () => {
    const checks = scoreScenario(
      base({ dimension: 'factual_knowledge', mustContain: ['30 dollars'] }),
      { reply: 'I do not know the price.', toolCalls: [], status: 'AI_HANDLING' }
    );
    const c = checks.find(c => c.category === 'MISSING_KNOWLEDGE');
    expect(c).toBeTruthy();
    expect(c!.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end pipeline via real HTTP (free-first, no provider)
// ---------------------------------------------------------------------------
describe('evaluation pipeline (real runtime, free-first)', () => {
  it('POST /evaluate runs scenarios, persists results, returns structured run', async () => {
    const res = await tonyAgent.post(`/api/agents/${tonyAgentId}/versions/${tonyDraftId}/evaluate`).send({
      scenarios: [
        {
          id: 'sc-handoff', name: 'Unknown request handoff',
          userMessage: 'Can you book me a flight to Paris?',
          dimension: 'unknown_handling', severity: 'critical',
          expectHandoff: true
        },
        {
          id: 'sc-tool', name: 'Hours query should not book',
          userMessage: 'What time do you open?',
          dimension: 'tool_selection', severity: 'warning',
          forbiddenTools: ['book_appointment']
        }
      ]
    });
    expect(res.status).toBe(200);
    const run = res.body;
    expect(run.id).toMatch(/^eval-/);
    expect(run.businessId).toBe(tonyBizId);
    expect(run.agentId).toBe(tonyAgentId);
    expect(run.versionId).toBe(tonyDraftId);
    expect(run.totalScenarios).toBe(2);
    expect(run.timestamp).toBeTruthy();
    // The seeded agent declares llmProvider 'gemini'; the run reports the
    // provider the agent actually resolves to (free-first would be ollama for
    // an agent that doesn't declare one).
    expect(['gemini', 'ollama']).toContain(run.providerUsed);
    // Each scenario result carries captured reply + toolCalls + ids.
    for (const sr of run.scenarioResults) {
      expect(typeof sr.reply).toBe('string');
      expect(Array.isArray(sr.toolCalls)).toBe(true);
      expect(sr.conversationId).toBeTruthy();
      expect(sr.executionId).toMatch(/^exec-/);
      expect(sr.status).toBeTruthy();
    }
  });

  it('persists the run and GET /evaluations returns it (version association)', async () => {
    const res = await tonyAgent.get(`/api/agents/${tonyAgentId}/versions/${tonyDraftId}/evaluations`);
    expect(res.status).toBe(200);
    expect(res.body.latest).toBeTruthy();
    expect(res.body.latest.versionId).toBe(tonyDraftId);
    expect(res.body.latest.businessId).toBe(tonyBizId);
  });

  it('GET /agents/:id/evaluations lists runs for the agent (newest first)', async () => {
    const res = await tonyAgent.get(`/api/agents/${tonyAgentId}/evaluations`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.every((r: any) => r.agentId === tonyAgentId)).toBe(true);
    // newest first
    const ts = res.body.map((r: any) => new Date(r.timestamp).getTime());
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeLessThanOrEqual(ts[i - 1]);
  });

  it('handoff scenario PASSES when the provider is down (graceful escalation)', async () => {
    // No provider -> runtime escalates to WAITING_FOR_HUMAN for an unknown
    // request. The engine must NOT crash and must score handoff as passing.
    const run = await runEvaluation({
      businessId: tonyBizId, agentId: tonyAgentId, versionId: tonyDraftId,
      scenarios: [{
        id: 'sc-grace', name: 'graceful handoff',
        userMessage: 'I want a refund for my flight',
        dimension: 'handoff', severity: 'critical', expectHandoff: true
      }]
    });
    const sr = run.scenarioResults[0];
    expect(sr.passed).toBe(true);
    expect(sr.status).toBe('WAITING_FOR_HUMAN');
    expect(sr.failureCategories).toHaveLength(0);
  });

  it('tool-selection scenario FAILS when the provider is down (no tools called)', async () => {
    // No provider -> no tools invoked -> expected tool missing = MISSING_TOOL.
    const run = await runEvaluation({
      businessId: tonyBizId, agentId: tonyAgentId, versionId: tonyDraftId,
      scenarios: [{
        id: 'sc-missing-tool', name: 'needs a tool',
        userMessage: 'What are your hours?',
        dimension: 'tool_selection', severity: 'critical',
        expectedToolCalls: ['check_business_hours']
      }]
    });
    const sr = run.scenarioResults[0];
    expect(sr.passed).toBe(false);
    expect(sr.failureCategories).toContain('MISSING_TOOL');
  });

  it('engine never throws on runtime failure (graceful provider failure)', async () => {
    // Pointing at a non-existent version still resolves gracefully per-scenario.
    const run = await runEvaluation({
      businessId: tonyBizId, agentId: tonyAgentId, versionId: 'ver-does-not-exist',
      scenarios: [{
        id: 'sc-err', name: 'error path',
        userMessage: 'hi', dimension: 'handoff', severity: 'warning', expectHandoff: true
      }]
    });
    expect(run.totalScenarios).toBe(1);
    // Captured an error but the run completed.
    const sr = run.scenarioResults[0];
    expect(typeof sr.reply).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Critical-failure publish blocking
// ---------------------------------------------------------------------------
describe('critical failure blocks publication', () => {
  it('assertPublishClear throws when the latest run has critical failures', async () => {
    // Record a failing critical evaluation for a fresh draft.
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'Eval Block Co', type: 'retail',
      services: [{ name: 'Consult', price: 100, durationMinutes: 30, description: 'x' }]
    });
    const bizBId = bizB.body.id;
    const agentRes = await platformAgent.post('/api/agents').send({
      businessId: bizBId, name: 'Block Agent', type: 'customer_support',
      description: 'x', systemPrompt: 'You are helpful.', structuredConfig: {
        personality: { tone: 'friendly', behavior: 'concise', language: 'en', customPrompt: '' },
        bookingRules: 'standard',
        refundRules: 'Non-refundable',
        escalationRules: ['If unsure, transfer to human'],
        allowedActions: ['check_business_hours'],
        toolsEnabled: ['check_business_hours']
      }
    });
    const agentId = agentRes.body.id;
    const versions = await platformAgent.get(`/api/agents/${agentId}/versions`);
    const draftId = versions.body.find((v: any) => v.status === 'DRAFT').id;

    // Failing critical scenario: expects a tool that won't be called (no provider).
    const run = await runEvaluation({
      businessId: bizBId, agentId, versionId: draftId,
      scenarios: [{
        id: 'fail-1', name: 'must use tool',
        userMessage: 'hours?', dimension: 'tool_selection', severity: 'critical',
        expectedToolCalls: ['check_business_hours']
      }]
    });
    expect(run.criticalFailures).toBe(1);
    expect(run.overallPassed).toBe(false);

    await expect(assertPublishClear(bizBId, draftId)).rejects.toThrow(/Publish blocked/);

    // And the real publish path is blocked (400).
    const pubRes = await platformAgent.post(`/api/agents/${agentId}/versions/${draftId}/publish`);
    expect(pubRes.status).toBe(400);
    expect(pubRes.body.error).toContain('Publish blocked');
  });

  it('publish proceeds when no evaluation exists (backward compat)', async () => {
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'No Eval Co', type: 'retail',
      services: [{ name: 'Consult', price: 100, durationMinutes: 30, description: 'x' }]
    });
    const bizBId = bizB.body.id;
    const agentRes = await platformAgent.post('/api/agents').send({
      businessId: bizBId, name: 'NoEval Agent', type: 'customer_support',
      description: 'x', systemPrompt: 'You are helpful.', structuredConfig: {
        personality: { tone: 'friendly', behavior: 'concise', language: 'en', customPrompt: '' },
        bookingRules: 'standard',
        refundRules: 'Non-refundable',
        escalationRules: ['If unsure, transfer to human'],
        allowedActions: ['check_business_hours'],
        toolsEnabled: ['check_business_hours']
      }
    });
    const agentId = agentRes.body.id;
    const versions = await platformAgent.get(`/api/agents/${agentId}/versions`);
    const draftId = versions.body.find((v: any) => v.status === 'DRAFT').id;

    const pubRes = await platformAgent.post(`/api/agents/${agentId}/versions/${draftId}/publish`);
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.status).toBe('PUBLISHED');
  });

  it('publish proceeds when the latest evaluation passes', async () => {
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'Passing Eval Co', type: 'retail',
      services: [{ name: 'Consult', price: 100, durationMinutes: 30, description: 'x' }]
    });
    const bizBId = bizB.body.id;
    const agentRes = await platformAgent.post('/api/agents').send({
      businessId: bizBId, name: 'Passing Agent', type: 'customer_support',
      description: 'x', systemPrompt: 'You are helpful.', structuredConfig: {
        personality: { tone: 'friendly', behavior: 'concise', language: 'en', customPrompt: '' },
        bookingRules: 'standard',
        refundRules: 'Non-refundable',
        escalationRules: ['If unsure, transfer to human'],
        allowedActions: ['check_business_hours'],
        toolsEnabled: ['check_business_hours']
      }
    });
    const agentId = agentRes.body.id;
    const versions = await platformAgent.get(`/api/agents/${agentId}/versions`);
    const draftId = versions.body.find((v: any) => v.status === 'DRAFT').id;

    // Passing critical scenario: handoff succeeds under graceful degradation.
    const run = await runEvaluation({
      businessId: bizBId, agentId, versionId: draftId,
      scenarios: [{
        id: 'pass-1', name: 'handoff ok',
        userMessage: 'book me a flight', dimension: 'handoff', severity: 'critical',
        expectHandoff: true
      }]
    });
    expect(run.overallPassed).toBe(true);

    const pubRes = await platformAgent.post(`/api/agents/${agentId}/versions/${draftId}/publish`);
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.status).toBe('PUBLISHED');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------
describe('evaluation tenant isolation', () => {
  it('a business owner cannot evaluate or read another tenant\'s version', async () => {
    // Tony attempts to evaluate a version on a business he does not own.
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'Iso Eval Co', type: 'retail',
      services: [{ name: 'Consult', price: 100, durationMinutes: 30, description: 'x' }]
    });
    const bizBId = bizB.body.id;
    const agentRes = await platformAgent.post('/api/agents').send({
      businessId: bizBId, name: 'Iso Agent', type: 'customer_support',
      description: 'x', systemPrompt: 'You are helpful.', structuredConfig: {
        personality: { tone: 'friendly', behavior: 'concise', language: 'en', customPrompt: '' },
        bookingRules: 'standard', refundRules: 'Non-refundable',
        escalationRules: ['If unsure, transfer to human'],
        allowedActions: ['check_business_hours'], toolsEnabled: ['check_business_hours']
      }
    });
    const agentId = agentRes.body.id;
    const versions = await platformAgent.get(`/api/agents/${agentId}/versions`);
    const draftId = versions.body.find((v: any) => v.status === 'DRAFT').id;

    const evalCross = await tonyAgent.post(`/api/agents/${agentId}/versions/${draftId}/evaluate`).send({
      scenarios: [{ id: 'x', name: 'x', userMessage: 'hi', dimension: 'handoff', severity: 'warning', expectHandoff: true }]
    });
    expect([403, 404]).toContain(evalCross.status);

    const readCross = await tonyAgent.get(`/api/agents/${agentId}/versions/${draftId}/evaluations`);
    expect([403, 404]).toContain(readCross.status);

    const listCross = await tonyAgent.get(`/api/agents/${agentId}/evaluations`);
    expect([403, 404]).toContain(listCross.status);
  });

  it('getLatestEvaluation is tenant-scoped (never returns another tenant\'s run)', async () => {
    // Tony's draft has an evaluation recorded under biz-tonys-barber. Querying
    // with a different businessId must NOT return it.
    const tonyLatest = await getLatestEvaluation(tonyBizId, tonyDraftId);
    expect(tonyLatest).toBeTruthy();
    const leaked = await getLatestEvaluation('biz-some-other-tenant', tonyDraftId);
    expect(leaked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe('evaluation request validation', () => {
  it('rejects evaluate with empty scenarios (400)', async () => {
    const res = await tonyAgent.post(`/api/agents/${tonyAgentId}/versions/${tonyDraftId}/evaluate`).send({ scenarios: [] });
    expect(res.status).toBe(400);
  });

  it('rejects evaluate with a malformed scenario (400)', async () => {
    const res = await tonyAgent.post(`/api/agents/${tonyAgentId}/versions/${tonyDraftId}/evaluate`).send({
      scenarios: [{ id: 'x', name: 'x' /* missing userMessage + dimension */ }]
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Published version is never modified during evaluation
// ---------------------------------------------------------------------------
describe('evaluation does not modify published versions', () => {
  it('evaluating a draft leaves the published version intact', async () => {
    const pubBefore = await tonyAgent.get(`/api/agents/${tonyAgentId}/versions/published`);
    const pubPromptBefore = pubBefore.body.systemPrompt;
    const pubStatusBefore = pubBefore.body.status;

    await tonyAgent.post(`/api/agents/${tonyAgentId}/versions/${tonyDraftId}/evaluate`).send({
      scenarios: [{ id: 'p', name: 'p', userMessage: 'hi', dimension: 'handoff', severity: 'warning', expectHandoff: true }]
    });

    const pubAfter = await tonyAgent.get(`/api/agents/${tonyAgentId}/versions/published`);
    expect(pubAfter.body.systemPrompt).toBe(pubPromptBefore);
    expect(pubAfter.body.status).toBe(pubStatusBefore);
  });
});
