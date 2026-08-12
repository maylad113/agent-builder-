import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Human-handoff state-machine tests (Phase 18):
 *   AI_HANDLING -> WAITING_FOR_HUMAN (AI escalates via transfer_to_human tool)
 *   WAITING_FOR_HUMAN -> HUMAN_HANDLING (owner takeover — AI must be paused)
 *   HUMAN_HANDLING -> RESOLVED (owner resolves)
 *   RESOLVED -> AI_HANDLING (owner resumes — AI re-enabled)
 *
 * Also asserts the public widget endpoint respects the pause: when a
 * conversation is in HUMAN_HANDLING/RESOLVED, /api/runtime/chat returns a
 * "human is handling this" reply instead of invoking the model.
 *
 * No external LLM calls (GEMINI_API_KEY is off).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-handoff-'));
process.env.DB_PATH = path.join(tmpDir, 'handoff.db');
process.env.SESSION_SECRET = 'test-handoff-secret';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { executeAgentTool } = await import('../src/server/tools');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

const app = makeApp();
const platformAgent = request.agent(app);
const tonyAgent = request.agent(app);

beforeAll(async () => {
  await db.init();
  await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('human handoff lifecycle', () => {
  it('transfer_to_human sets WAITING_FOR_HUMAN and captures reason + timestamp', async () => {
    // Start a conversation via the public widget.
    const start = await request(app).post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber', userMessage: 'hi', customerName: 'Handoff Tester'
    });
    expect(start.status).toBe(200);
    const convId = start.body.conversationId;

    // Simulate the AI escalating via the tool engine (same path the runtime uses).
    const res = await executeAgentTool('transfer_to_human', { reason: 'Angry customer, refund dispute' }, {
      tenantId: 'biz-tonys-barber', conversationId: convId
    });
    expect(res.success).toBe(true);

    const convs = await tonyAgent.get('/api/conversations?businessId=biz-tonys-barber');
    const conv = convs.body.find((c: any) => c.id === convId);
    expect(conv.status).toBe('WAITING_FOR_HUMAN');
    expect(conv.handoffReason).toContain('refund dispute');
    expect(conv.handoffRequestedAt).toBeTruthy();
  });

  it('takeover moves to HUMAN_HANDLING and pauses the AI on the public widget', async () => {
    const start = await request(app).post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber', userMessage: 'second conversation', customerName: 'Pause Tester'
    });
    const convId = start.body.conversationId;

    await executeAgentTool('transfer_to_human', { reason: 'needs human' }, {
      tenantId: 'biz-tonys-barber', conversationId: convId
    });

    // Owner takes over.
    const takeover = await tonyAgent.post(`/api/conversations/${convId}/takeover`);
    expect(takeover.status).toBe(200);
    expect(takeover.body.conversation.status).toBe('HUMAN_HANDLING');
    expect(takeover.body.conversation.handoffStartedAt).toBeTruthy();

    // Public widget must NOT invoke the AI while a human is handling it.
    const duringHuman = await request(app).post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber', userMessage: 'are you there?', conversationId: convId
    });
    expect(duringHuman.status).toBe(200);
    expect(duringHuman.body.status).toBe('HUMAN_HANDLING');
    // The reply must indicate a human is handling it (no model call attempted).
    expect(duringHuman.body.reply).toMatch(/human|team|agent|take over|assist/i);
  });

  it('resolve then resume re-enables the AI', async () => {
    const start = await request(app).post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber', userMessage: 'third conversation', customerName: 'Resume Tester'
    });
    const convId = start.body.conversationId;

    await tonyAgent.post(`/api/conversations/${convId}/takeover`);
    const resolved = await tonyAgent.post(`/api/conversations/${convId}/resolve`);
    expect(resolved.body.status).toBe('RESOLVED');
    expect(resolved.body.resolvedAt).toBeTruthy();

    // While RESOLVED, the widget is still paused.
    const duringResolved = await request(app).post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber', userMessage: 'still there?', conversationId: convId
    });
    expect(duringResolved.body.status).toBe('RESOLVED');

    // Owner resumes AI.
    const resume = await tonyAgent.post(`/api/conversations/${convId}/resume`);
    expect(resume.status).toBe(200);
    expect(resume.body.conversation.status).toBe('AI_HANDLING');

    // The next widget message is now allowed to reach the AI again. With no
    // API key configured the runtime degrades (auto-escalates), which is the
    // correct production behavior — we only assert that the message was
    // accepted (no longer blocked by RESOLVED).
    const after = await request(app).post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber', userMessage: 'welcome back', conversationId: convId
    });
    expect(after.status).toBe(200);
    expect(after.body.reply).toBeTruthy();
  });

  it('cross-tenant takeover is blocked', async () => {
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'Handoff Isolation Co', type: 'retail',
      services: [{ name: 'X', price: 10, durationMinutes: 15, description: 'x' }]
    });
    // Create a conversation under Biz B via the platform owner.
    const bChat = await request(app).post('/api/runtime/chat').send({
      tenantId: bizB.body.id, userMessage: 'hello', customerName: 'B Customer'
    });
    const bConvId = bChat.body.conversationId;

    // Tony (biz-tonys-barber) tries to take over Biz B's conversation -> blocked.
    const cross = await tonyAgent.post(`/api/conversations/${bConvId}/takeover`);
    expect([403, 404]).toContain(cross.status);
  });
});
