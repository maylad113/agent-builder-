import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os'; import path from 'path'; import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Security regression tests for two production hardening fixes:
 *
 *  1. Mass-assignment on PUT /api/appointments/:id — the handler must NOT
 *     honor arbitrary body fields. A caller must not be able to overwrite
 *     businessId/id/serviceId (which would break tenant isolation) or forge
 *     an invalid status.
 *
 *  2. Widget Origin-header bypass — in production, a request with NO Origin
 *     header to /api/runtime/chat must be rejected (403), so a non-browser
 *     client cannot target an arbitrary tenantId to consume its LLM quota.
 *
 * GEMINI_API_KEY is forced off so the runtime uses its graceful fallback path.
 */
delete process.env.GEMINI_API_KEY;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-sec-'));
process.env.DB_PATH = path.join(tmpDir, 'sec.db');

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

let bizBId = '';
let apptBId = '';
let apptBServiceId = '';

beforeAll(async () => {
  const login = await owner.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  expect(login.status).toBe(200);

  // Create a second tenant with a real service.
  const bizRes = await owner.post('/api/businesses').send({
    name: 'Sec Test Bakery', type: 'restaurant',
    description: 'tenant for security regressions', location: 'x',
    services: [{ name: 'Tasting', price: 1000, durationMinutes: 30, description: 'd' }],
    faqs: []
  });
  expect(bizRes.status).toBe(201);
  bizBId = bizRes.body.id;
  apptBServiceId = bizRes.body.services[0].id;

  // Book an appointment (near-term, open weekday, within 14-day policy).
  const d = new Date(); d.setDate(d.getDate() + 1);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  const date = d.toISOString().split('T')[0];
  const apptRes = await owner.post('/api/appointments').send({
    businessId: bizBId, serviceId: apptBServiceId,
    customerName: 'Pat', customerPhone: '+1', date, startTime: '10:00'
  });
  expect(apptRes.status).toBe(201);
  apptBId = apptRes.body.id;
});

afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('PUT /api/appointments/:id mass-assignment guard', () => {
  it('ignores attempts to overwrite businessId / id / serviceId', async () => {
    const otherBiz = 'biz-tonys-barber';
    const r = await owner.put(`/api/appointments/${apptBId}`).send({
      businessId: otherBiz,      // attempt to move into another tenant
      id: 'forged-id',           // attempt to change primary key
      serviceId: 'forged-svc',   // attempt to change the booked service
      status: 'CANCELLED'         // legitimate field
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(apptBId);
    expect(r.body.businessId).toBe(bizBId);
    expect(r.body.serviceId).toBe(apptBServiceId);
    expect(r.body.status).toBe('CANCELLED');
    // The DB record must not have moved tenants.
    const stored = db.appointments.find(a => a.id === apptBId);
    expect(stored?.businessId).toBe(bizBId);
  });

  it('rejects an invalid status value', async () => {
    const r = await owner.put(`/api/appointments/${apptBId}`).send({ status: 'FORGED_STATUS' });
    expect(r.status).toBe(200);
    expect(r.body.status).not.toBe('FORGED_STATUS');
  });
});

describe('widget Origin-header bypass (production)', () => {
  it('rejects a no-Origin request in production mode', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      // No Origin header at all (non-browser client). Must be 403.
      const r = await request(app).post('/api/runtime/chat')
        .set('Content-Type', 'application/json')
        .send({ tenantId: bizBId, userMessage: 'hi' });
      expect(r.status).toBe(403);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('product input validation', () => {
  it('rejects a product with a negative price', async () => {
    const r = await owner.post('/api/products').send({ businessId: bizBId, name: 'Bad', price: -5, inventory: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/price/i);
  });

  it('rejects a product with negative inventory', async () => {
    const r = await owner.post('/api/products').send({ businessId: bizBId, name: 'Bad2', price: 10, inventory: -3 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/inventory/i);
  });

  it('rejects a product with no name', async () => {
    const r = await owner.post('/api/products').send({ businessId: bizBId, price: 10, inventory: 1 });
    expect(r.status).toBe(400);
  });

  it('accepts a valid product and audits it', async () => {
    const r = await owner.post('/api/products').send({ businessId: bizBId, name: 'Valid Product', price: 199, inventory: 50 });
    expect(r.status).toBe(201);
    expect(r.body.price).toBe(199);
    expect(r.body.inventory).toBe(50);
    const audited = db.auditLogs.find(l => l.action === 'PRODUCT_CREATED' && l.businessId === bizBId);
    expect(audited).toBeTruthy();
  });
});

describe('templates endpoint requires authentication', () => {
  it('returns 401 without a session cookie', async () => {
    const r = await request(app).get('/api/templates');
    expect(r.status).toBe(401);
  });
});

describe('health endpoint reports DB connectivity', () => {
  it('returns 200 and db:connected when the DB is reachable', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.db).toBe('connected');
    expect(r.body.status).toBe('ok');
  });
});
