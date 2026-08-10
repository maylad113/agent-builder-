import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * API-level smoke test: the Express routes must serve the exact JSON shapes
 * they always did, now backed by SQLite. Writes made through the API are
 * verified to land on disk (read back via a separate database connection).
 *
 * Business routes are now protected by real server-side auth, so the suite
 * first logs in as the seeded platform owner and reuses the session cookie.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-api-'));
process.env.DB_PATH = path.join(tmpDir, 'api.db');

const { router } = await import('../src/server/routes');
const { AppDatabase } = await import('../src/server/db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

const app = makeApp();
const agent = request.agent(app);

beforeAll(async () => {
  const res = await agent.post('/api/auth/login').send({
    email: 'owner@agentfactory.io',
    password: 'Password123!'
  });
  expect(res.status).toBe(200);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('API over SQLite', () => {
  it('GET /api/businesses returns the seeded tenant with the exact shape', async () => {
    const res = await agent.get('/api/businesses');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const biz = res.body.find((b: any) => b.id === 'biz-tonys-barber');
    expect(biz.name).toBe("Tony's Barber Shop");
    expect(biz.type).toBe('barbershop');
    expect(biz.createdAt).toBeDefined();
    expect(biz.updatedAt).toBeDefined();
    expect(Array.isArray(biz.services)).toBe(true);
    expect(Array.isArray(biz.faqs)).toBe(true);
    expect(Array.isArray(biz.hours)).toBe(true);
    expect(typeof biz.policies?.cancellation).toBe('string');
  });

  it('GET /api/agents, /api/appointments and /api/health keep their shapes', async () => {
    const agents = await agent.get('/api/agents?businessId=biz-tonys-barber');
    expect(agents.status).toBe(200);
    expect(agents.body).toHaveLength(1);
    expect(agents.body[0].structuredConfig.toolsEnabled).toContain('book_appointment');

    const apps = await agent.get('/api/appointments?businessId=biz-tonys-barber');
    expect(apps.status).toBe(200);
    expect(apps.body).toHaveLength(2);
    expect(apps.body[0].customerName).toBe('Reza Ahmadi');

    const health = await request(makeApp()).get('/api/health');
    expect(health.body.status).toBe('ok');
  });

  it('POST /api/businesses writes through to disk (readable by a new connection)', async () => {
    const postRes = await agent.post('/api/businesses').send({
      name: 'API Created Shop',
      type: 'restaurant',
      description: 'Created via API',
      location: 'Main Street',
      services: [{ name: 'Dinner', price: 25, durationMinutes: 60 }],
      faqs: [{ question: 'Q?', answer: 'A!' }],
    });
    expect(postRes.status).toBe(201);
    expect(postRes.body.status).toBe('ACTIVE');
    const newId = postRes.body.id;

    // Auto-created channels & integrations for the new tenant.
    const chans = await agent.get(`/api/channels?businessId=${newId}`);
    expect(chans.body).toHaveLength(4);
    const ints = await agent.get(`/api/integrations?businessId=${newId}`);
    expect(ints.body).toHaveLength(4);

    // Prove the write landed on disk: open a fresh connection to the same file.
    const fresh = new AppDatabase({ dbPath: process.env.DB_PATH, seed: false });
    const onDisk = fresh.businesses.find(b => b.id === newId);
    expect(onDisk?.name).toBe('API Created Shop');
    expect(onDisk?.services).toHaveLength(1);
    expect(fresh.channels.filter(c => c.businessId === newId)).toHaveLength(4);
    fresh.close();

    // PUT persists too.
    const putRes = await agent.put(`/api/businesses/${newId}`).send({ name: 'API Created Shop v2' });
    expect(putRes.status).toBe(200);
    const fresh2 = new AppDatabase({ dbPath: process.env.DB_PATH, seed: false });
    expect(fresh2.businesses.find(b => b.id === newId)?.name).toBe('API Created Shop v2');
    fresh2.close();
  });

  it('tenant filtering is applied server-side (businessId scoping)', async () => {
    const all = await agent.get('/api/agents');
    expect(all.body.length).toBeGreaterThanOrEqual(1);
    const scoped = await agent.get('/api/agents?businessId=biz-tonys-barber');
    expect(scoped.body.every((a: any) => a.businessId === 'biz-tonys-barber')).toBe(true);
  });
});
