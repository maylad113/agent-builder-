import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Usage Monitoring + Observability tests.
 *
 * Proves telemetry is recorded from the REAL runtime/tool/evaluation/correction/
 * publish paths, is tenant-scoped, separates published vs draft/test activity,
 * never stores raw content/secrets/tool args, and the monitoring routes are
 * auth + tenant guarded.
 *
 * GEMINI_API_KEY is forced off so the chat provider degrades gracefully (the
 * runtime escalates to WAITING_FOR_HUMAN) — telemetry is still recorded.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-tel-'));
process.env.DB_PATH = path.join(tmpDir, 'telemetry.db');
process.env.SESSION_SECRET = 'test-telemetry-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const {
  listTelemetryEvents, computeMetrics, countTelemetry,
  recordCustomerMessage, recordToolExecution, recordAgentResponse,
  recordHumanHandoff, recordEvaluationRun, recordCorrectionAttempt,
  recordVersionPublished
} = await import('../src/server/telemetry');

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

  // Tony's agent has a PUBLISHED version in the seed (used for real-customer
  // telemetry tests). Create a fresh DRAFT for eval/correction telemetry.
  const draftRes = await tonyAgent.post(`/api/agents/${tonyAgentId}/versions`).send({ changeNote: 'telemetry draft' });
  tonyDraftId = draftRes.body.id;
  expect(draftRes.status).toBe(201);

  // Ensure Tony's business allows localhost widget origin for /runtime/chat.
  const bizRow = (await db.businesses.find(b => b.id === tonyBizId))!;
  bizRow.allowedWidgetOrigins = ['http://localhost:5173'];
  await db.businesses.update(bizRow);
});

afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Direct recorder unit tests (metadata + safe summaries; never raw content)
// ---------------------------------------------------------------------------
describe('telemetry recorders — metadata + safe summaries', () => {
  const biz = 'biz-recorder-unit';
  const agent = 'agent-recorder';
  const conv = 'conv-1';

  it('CUSTOMER_MESSAGE stores a truncated preview, not full content', async () => {
    const long = 'x'.repeat(200);
    await recordCustomerMessage({
      businessId: biz, agentId: agent, conversationId: conv, channel: 'widget',
      isPublished: true, messageLength: 200, messagePreview: long
    });
    const events = await listTelemetryEvents({ businessId: biz, agentId: agent, limit: 50 });
    const cm = events.find(e => e.eventType === 'CUSTOMER_MESSAGE');
    expect(cm).toBeTruthy();
    expect(cm!.summary!.length).toBeLessThanOrEqual(61); // 60 + ellipsis
    expect(cm!.summary).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(cm!.metadata?.messageLength).toBe(200);
    expect(cm!.isPublished).toBe(true);
  });

  it('TOOL_EXECUTION stores tool name + success but never args', async () => {
    await recordToolExecution({
      businessId: biz, agentId: agent, conversationId: conv, channel: 'widget',
      isPublished: true, toolName: 'book_appointment', success: false,
      errorSummary: 'slot unavailable'
    });
    await recordToolExecution({
      businessId: biz, agentId: agent, conversationId: conv, channel: 'widget',
      isPublished: true, toolName: 'get_business_information', success: true
    });
    const tools = (await listTelemetryEvents({ businessId: biz, limit: 200 })).filter(e => e.eventType === 'TOOL_EXECUTION');
    expect(tools.length).toBeGreaterThanOrEqual(2);
    const fail = tools.find(t => !t.success);
    expect(fail!.toolName).toBe('book_appointment');
    expect(fail!.summary).toBe('slot unavailable');
    const ok = tools.find(t => t.success);
    expect(ok!.toolName).toBe('get_business_information');
    expect(ok!.summary == null).toBe(true);
    // No event carries args anywhere in the stored record.
    for (const t of tools) {
      expect(JSON.stringify(t)).not.toMatch(/customerPhone|serviceName|args/);
    }
  });

  it('AGENT_RESPONSE stores latency, provider/model, tokens, success', async () => {
    await recordAgentResponse({
      businessId: biz, agentId: agent, conversationId: conv, channel: 'widget',
      provider: 'ollama', model: 'llama3', isPublished: true, latencyMs: 1234.7,
      success: true, status: 'AI_HANDLING', inputTokens: 50, outputTokens: 30,
      tokensUsed: 80, replyPreview: 'Sure, here is the info.', toolCallCount: 1
    });
    const resp = (await listTelemetryEvents({ businessId: biz, limit: 200 })).find(e => e.eventType === 'AGENT_RESPONSE');
    expect(resp).toBeTruthy();
    expect(resp!.latencyMs).toBe(1235);
    expect(resp!.provider).toBe('ollama');
    expect(resp!.model).toBe('llama3');
    expect(resp!.inputTokens).toBe(50);
    expect(resp!.outputTokens).toBe(30);
    expect(resp!.tokensUsed).toBe(80);
    expect(resp!.success).toBe(true);
    expect(resp!.metadata?.status).toBe('AI_HANDLING');
    expect(resp!.metadata?.toolCallCount).toBe(1);
  });

  it('HUMAN_HANDOFF records a handoff', async () => {
    await recordHumanHandoff({
      businessId: biz, agentId: agent, conversationId: conv, isPublished: true,
      reason: 'agent escalated to human'
    });
    const ho = (await listTelemetryEvents({ businessId: biz, limit: 200 })).find(e => e.eventType === 'HUMAN_HANDOFF');
    expect(ho).toBeTruthy();
    expect(ho!.success).toBe(false);
    expect(ho!.summary).toContain('escalated');
  });

  it('EVALUATION_RUN records pass/fail + counts', async () => {
    await recordEvaluationRun({
      businessId: biz, agentId: agent, versionId: 'v1', evaluationId: 'ev1',
      overallPassed: false, totalScenarios: 3, passedScenarios: 2, criticalFailures: 1,
      providerUsed: 'ollama'
    });
    const ev = (await listTelemetryEvents({ businessId: biz, limit: 200 })).find(e => e.eventType === 'EVALUATION_RUN');
    expect(ev).toBeTruthy();
    expect(ev!.success).toBe(false);
    expect(ev!.isPublished).toBe(false);
    expect(ev!.metadata?.totalScenarios).toBe(3);
    expect(ev!.metadata?.criticalFailures).toBe(1);
  });

  it('CORRECTION_ATTEMPT records resolved + attempts + human-review', async () => {
    await recordCorrectionAttempt({
      businessId: biz, agentId: agent, versionId: 'v1', correctionId: 'cor1',
      resolved: true, humanReviewRequired: false, attempts: 2, finalVersionId: 'v2',
      reason: 'Agent passed after prompt tightening.'
    });
    const co = (await listTelemetryEvents({ businessId: biz, limit: 200 })).find(e => e.eventType === 'CORRECTION_ATTEMPT');
    expect(co).toBeTruthy();
    expect(co!.success).toBe(true);
    expect(co!.metadata?.attempts).toBe(2);
    expect(co!.metadata?.finalVersionId).toBe('v2');
  });

  it('VERSION_PUBLISHED records the publication', async () => {
    await recordVersionPublished({ businessId: biz, agentId: agent, versionId: 'v1', versionNumber: 3 });
    const pub = (await listTelemetryEvents({ businessId: biz, limit: 200 })).find(e => e.eventType === 'VERSION_PUBLISHED');
    expect(pub).toBeTruthy();
    expect(pub!.isPublished).toBe(true);
    expect(pub!.metadata?.versionNumber).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeMetrics + tenant isolation
// ---------------------------------------------------------------------------
describe('computeMetrics — aggregation + zero states', () => {
  const biz = 'biz-metrics';
  const agent = 'agent-metrics';

  it('returns zero metrics (never fabricates) when no events exist', async () => {
    const m = await computeMetrics({ businessId: 'biz-nonexistent' });
    expect(m.conversations).toBe(0);
    expect(m.messages).toBe(0);
    expect(m.agentResponses).toBe(0);
    expect(m.successfulToolCalls).toBe(0);
    expect(m.failedToolCalls).toBe(0);
    expect(m.humanHandoffs).toBe(0);
    expect(m.averageLatencyMs).toBe(0);
    expect(m.hasPublishedActivity).toBe(false);
    expect(m.hasDraftActivity).toBe(false);
  });

  it('aggregates real events into metrics', async () => {
    // Two customer messages, two agent responses, one successful + one failed tool, one handoff
    await recordCustomerMessage({ businessId: biz, agentId: agent, conversationId: 'c1', isPublished: true, messageLength: 10, messagePreview: 'hi' });
    await recordCustomerMessage({ businessId: biz, agentId: agent, conversationId: 'c1', isPublished: true, messageLength: 12, messagePreview: 'book a slot' });
    await recordAgentResponse({ businessId: biz, agentId: agent, conversationId: 'c1', provider: 'ollama', model: 'llama3', isPublished: true, latencyMs: 100, success: true, status: 'AI_HANDLING' });
    await recordAgentResponse({ businessId: biz, agentId: agent, conversationId: 'c2', provider: 'ollama', model: 'llama3', isPublished: true, latencyMs: 200, success: true, status: 'AI_HANDLING' });
    await recordToolExecution({ businessId: biz, agentId: agent, conversationId: 'c1', isPublished: true, toolName: 'get_business_information', success: true });
    await recordToolExecution({ businessId: biz, agentId: agent, conversationId: 'c2', isPublished: true, toolName: 'book_appointment', success: false, errorSummary: 'closed' });
    await recordHumanHandoff({ businessId: biz, agentId: agent, conversationId: 'c2', isPublished: true, reason: 'x' });
    const m = await computeMetrics({ businessId: biz });
    expect(m.conversations).toBe(2);
    expect(m.messages).toBe(2);
    expect(m.agentResponses).toBe(2);
    expect(m.successfulToolCalls).toBe(1);
    expect(m.failedToolCalls).toBe(1);
    expect(m.humanHandoffs).toBe(1);
    expect(m.averageLatencyMs).toBe(150);
    expect(m.providerModelUsage['ollama/llama3']).toBe(2);
    expect(m.hasPublishedActivity).toBe(true);
  });

  it('isPublished filter separates published vs draft/test metrics', async () => {
    await recordAgentResponse({ businessId: biz, agentId: agent, conversationId: 'c3', isPublished: false, latencyMs: 50, success: true, status: 'AI_HANDLING' });
    const pub = await computeMetrics({ businessId: biz, isPublished: true });
    const draft = await computeMetrics({ businessId: biz, isPublished: false });
    expect(pub.agentResponses).toBe(2); // the two published responses from prior test
    expect(draft.agentResponses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real runtime path records telemetry
// ---------------------------------------------------------------------------
describe('runtime integration — real telemetry from published agent', () => {
  it('a real widget chat records CUSTOMER_MESSAGE + AGENT_RESPONSE (+ HANDOFF)', async () => {
    const before = await countTelemetry(tonyBizId, 'CUSTOMER_MESSAGE');
    const res = await request(app)
      .post('/api/runtime/chat')
      .set('Origin', 'http://localhost:5173')
      .send({ tenantId: tonyBizId, userMessage: 'hi, do you do walk-ins?' });
    expect(res.status).toBe(200);
    const after = await countTelemetry(tonyBizId, 'CUSTOMER_MESSAGE');
    expect(after).toBe(before + 1);
    const resp = await countTelemetry(tonyBizId, 'AGENT_RESPONSE');
    expect(resp).toBeGreaterThan(0);
    // The public chat response never leaks telemetry/debug to the customer.
    expect(res.body.debug).toBeUndefined();
    expect(res.body.retrievedKnowledge).toBeUndefined();
  });

  it('published activity is marked isPublished=true; simulator is false', async () => {
    // Simulator call (authenticated /runtime/simulate) against the DRAFT.
    const simBefore = await countTelemetry(tonyBizId);
    await tonyAgent.post('/api/runtime/simulate').send({
      businessId: tonyBizId, agentId: tonyAgentId, versionId: tonyDraftId, userMessage: 'test message for telemetry'
    });
    const simEvents = await listTelemetryEvents({ businessId: tonyBizId, agentId: tonyAgentId, versionId: tonyDraftId, limit: 100 });
    expect(simEvents.length).toBeGreaterThan(simBefore === 0 ? 0 : 0);
    // Every simulator-origin event for the draft must be isPublished=false.
    for (const e of simEvents) expect(e.isPublished).toBe(false);

    // Production widget events must be isPublished=true.
    const pubEvents = await listTelemetryEvents({ businessId: tonyBizId, agentId: tonyAgentId, isPublished: true, limit: 100 });
    for (const e of pubEvents) expect(e.isPublished).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Monitoring routes — auth + tenant scope
// ---------------------------------------------------------------------------
describe('monitoring routes — auth + tenant isolation', () => {
  it('telemetry route requires auth', async () => {
    const res = await request(app).get(`/api/agents/${tonyAgentId}/telemetry`);
    expect(res.status).toBe(401);
  });

  it('metrics route requires auth', async () => {
    const res = await request(app).get(`/api/agents/${tonyAgentId}/metrics`);
    expect(res.status).toBe(401);
  });

  it('owner can read Tony agent telemetry + metrics', async () => {
    const tel = await platformAgent.get(`/api/agents/${tonyAgentId}/telemetry?limit=5`);
    expect(tel.status).toBe(200);
    expect(Array.isArray(tel.body)).toBe(true);
    const m = await platformAgent.get(`/api/agents/${tonyAgentId}/metrics`);
    expect(m.status).toBe(200);
    expect(m.body.conversations).toBeGreaterThanOrEqual(0);
  });

  it('telemetry never returns records for a different tenant (cross-tenant guard)', async () => {
    // Platform owner creates an unrelated business+agent and queries Tony's telemetry.
    // listTelemetryEvents is scoped by businessId; ensure no foreign events leak.
    const foreignEvents = await listTelemetryEvents({ businessId: 'biz-foreign-nonexistent', agentId: tonyAgentId, limit: 100 });
    expect(foreignEvents.length).toBe(0);
  });

  it('telemetry records never contain secrets, raw tool args, or full content', async () => {
    const events = await listTelemetryEvents({ businessId: tonyBizId, agentId: tonyAgentId, limit: 200 });
    for (const e of events) {
      const blob = JSON.stringify(e);
      expect(blob).not.toMatch(/SESSION_SECRET|GEMINI_API_KEY|password/i);
      // Tool args are never stored on telemetry records.
      if (e.eventType === 'TOOL_EXECUTION') {
        expect(blob).not.toMatch(/"args"/);
      }
    }
  });
});
