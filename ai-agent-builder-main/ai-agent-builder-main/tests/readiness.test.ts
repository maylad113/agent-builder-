import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Agent readiness gate (Phase 20):
 *  - A freshly generated agent (DRAFT, no published version, no knowledge,
 *    no services, no hours) cannot be activated -> 400 with missing list.
 *  - The readiness snapshot endpoint lists every unmet requirement.
 *  - Cross-tenant access to another business's agent readiness is blocked.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-ready-'));
process.env.DB_PATH = path.join(tmpDir, 'ready.db');
process.env.SESSION_SECRET = 'test-ready-secret';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');

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
  await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
});
afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('agent readiness gate', () => {
  it('blocks ACTIVE when critical requirements are missing and reports them', async () => {
    // A business with no hours/services, and an agent that is never published.
    const biz = await platformAgent.post('/api/businesses').send({ name: 'Empty Shop', type: 'retail' });
    const bizId = biz.body.id;
    const agent = await platformAgent.post('/api/agents').send({
      businessId: bizId,
      name: 'Empty Agent',
      type: 'retail',
      description: 'test'
    });
    const agentId = agent.body.id;

    // Attempt to activate -> must be rejected.
    const activate = await platformAgent.post(`/api/agents/${agentId}/status`).send({ status: 'ACTIVE' });
    expect(activate.status).toBe(400);
    expect(activate.body.readiness).toBeTruthy();
    expect(activate.body.readiness.ready).toBe(false);
    const missing: string[] = activate.body.readiness.missing;
    // A never-published agent with no services/hours/knowledge should miss several.
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toEqual(expect.arrayContaining(['Published version']));

    // Readiness snapshot mirrors the gate.
    const snap = await platformAgent.get(`/api/agents/${agentId}/readiness`);
    expect(snap.status).toBe(200);
    expect(snap.body.ready).toBe(false);
    expect(snap.body.checks.length).toBeGreaterThan(0);
  });

  it('allows other non-ACTIVE transitions even when not ready', async () => {
    const biz = await platformAgent.post('/api/businesses').send({ name: 'State Shop', type: 'retail' });
    const agent = await platformAgent.post('/api/agents').send({
      businessId: biz.body.id, name: 'State Agent', type: 'retail', description: 'x'
    });
    // PAUSED and TESTING must be allowed regardless of readiness.
    const toTesting = await platformAgent.post(`/api/agents/${agent.body.id}/status`).send({ status: 'TESTING' });
    expect(toTesting.status).toBe(200);
    expect(toTesting.body.status).toBe('TESTING');

    const toPaused = await platformAgent.post(`/api/agents/${agent.body.id}/status`).send({ status: 'PAUSED' });
    expect(toPaused.status).toBe(200);
    expect(toPaused.body.status).toBe('PAUSED');
  });

  it('cross-tenant readiness access is blocked', async () => {
    // Tony's agent belongs to biz-tonys-barber; create a separate business+agent.
    const bizB = await platformAgent.post('/api/businesses').send({ name: 'Other Shop', type: 'retail' });
    const agent = await platformAgent.post('/api/agents').send({
      businessId: bizB.body.id, name: 'Other Agent', type: 'retail', description: 'x'
    });
    // Tony attempts to read Biz B's agent readiness -> blocked.
    const cross = await tonyAgent.get(`/api/agents/${agent.body.id}/readiness`);
    expect([403, 404]).toContain(cross.status);
  });
});
