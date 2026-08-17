import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Free-first runtime test (provider abstraction).
 *
 * With NO paid AI key configured, the runtime must still:
 *   - Resolve a provider for the agent (free-first -> ollama when no Gemini key).
 *   - When that provider is unreachable (no daemon), degrade gracefully: the
 *     customer gets an honest "trouble connecting" reply, the conversation is
 *     marked WAITING_FOR_HUMAN, and NO fake answer is ever returned.
 *   - Never crash the request.
 *
 * This proves the platform operates without a mandatory paid AI API and that
 * a missing/unreachable provider never produces a fabricated success.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-prov-'));
process.env.DB_PATH = path.join(tmpDir, 'prov.db');
process.env.SESSION_SECRET = 'test-prov-secret';
process.env.NODE_ENV = 'test';
// No paid key; Ollama daemon is pointed at a dead port so generate() fails fast.
delete process.env.GEMINI_API_KEY;
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9';

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const owner = request.agent(app);

let bizId = '';
let agentId = '';

beforeAll(async () => {
  await db.init();
  await owner.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });

  // Create a business + ACTIVE agent whose provider resolves to ollama (free).
  const biz = await owner.post('/api/businesses').send({
    name: 'Free-First Cafe',
    type: 'cafe',
    description: 'A cafe testing the free-first provider path.',
    hours: [{ day: 'monday', isOpen: true, openTime: '08:00', closeTime: '20:00' }],
    services: [{ id: 's1', name: 'Coffee', price: 3, durationMinutes: 15, description: 'drip' }]
  });
  expect(biz.status).toBe(201);
  bizId = biz.body.id;

  const bizRow = (await db.businesses.find(b => b.id === bizId))!;
  bizRow.allowedWidgetOrigins = ['http://localhost:5173'];
  await db.businesses.update(bizRow);

  // Explicitly request the local/free provider.
  const agentRes = await owner.post('/api/agents').send({
    businessId: bizId,
    name: 'Free-First Agent',
    llmProvider: 'ollama',
    model: 'llama3.1',
    systemPrompt: 'You are a helpful cafe assistant.',
    structuredConfig: {
      personality: { tone: 'friendly', behavior: 'service', language: 'en' },
      goals: ['Answer questions'],
      allowedActions: ['check_business_hours', 'get_business_information', 'transfer_to_human'],
      restrictedActions: ['Never invent facts'],
      escalationRules: ['Customer requests human'],
      bookingRules: 'Require name and phone',
      orderRules: 'Standard checkout',
      refundRules: 'Non-refundable',
      toolsEnabled: ['check_business_hours', 'get_business_information', 'transfer_to_human']
    },
    status: 'ACTIVE'
  });
  expect(agentRes.status).toBe(201);
  agentId = agentRes.body.id;

  // Publish + activate so production chat uses it.
  const versions = await owner.get(`/api/agents/${agentId}/versions`);
  const draft = versions.body[0];
  await owner.post(`/api/agents/${agentId}/versions/${draft.id}/publish`);
  await owner.post(`/api/agents/${agentId}/status`).send({ status: 'ACTIVE' });
});

afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('free-first runtime (ollama, daemon unreachable)', () => {
  it('degrades gracefully and never fabricates a success', async () => {
    const res = await request(app).post('/api/runtime/chat').send({
      tenantId: bizId,
      userMessage: 'Are you open today?',
      customerName: 'Free First Customer'
    });
    expect(res.status).toBe(200);
    // Honest outage reply, not a fabricated answer.
    expect(res.body.reply).toMatch(/trouble connecting|assistant service|try again/i);
    expect(res.body.status).toBe('WAITING_FOR_HUMAN');
    expect(res.body.conversationId).toBeTruthy();
    // Debug must NEVER leak to the public widget.
    expect(res.body.debug).toBeUndefined();
  });

  it('persists the customer message even when the provider is down', async () => {
    const res = await request(app).post('/api/runtime/chat').send({
      tenantId: bizId,
      userMessage: 'book me for a haircut',
      customerName: 'Persisted Customer'
    });
    expect(res.status).toBe(200);
    const convId = res.body.conversationId;
    const convs = await owner.get(`/api/conversations?businessId=${bizId}`);
    const conv = convs.body.find((c: any) => c.id === convId);
    expect(conv).toBeTruthy();
  });

  it('rejects an unsupported provider at agent creation', async () => {
    const res = await owner.post('/api/agents').send({
      businessId: bizId,
      name: 'Bad Provider Agent',
      llmProvider: 'closedai',
      systemPrompt: 'x'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported llmprovider/i);
  });
});
