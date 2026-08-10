import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Authentication + HARD multi-tenant isolation tests.
 *
 * Fresh temp DB per suite (never data/agentforge.db). The suite proves:
 *  - real login/logout/me with server-side sessions,
 *  - platform owner sees every business, business users see ONLY their own,
 *  - Business A can never read OR write Business B's data (404 on reads that
 *    would leak existence, 403 on writes across tenants),
 *  - staff is scoped exactly like the owner,
 *  - the public widget endpoint still works unauthenticated and is isolated,
 *  - logout invalidates the session.
 *
 * GEMINI_API_KEY is forced off so /api/runtime/chat uses its graceful
 * fallback path (deterministic 200) instead of hitting a real LLM.
 */
delete process.env.GEMINI_API_KEY;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-auth-'));
process.env.DB_PATH = path.join(tmpDir, 'auth.db');

const { router } = await import('../src/server/routes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

const app = makeApp();
const platformAgent = request.agent(app);
const tonyAgent = request.agent(app);
const staffAgent = request.agent(app);

// Business B ("Bella's Bakery") + its resources, created as the platform owner.
let bizBId = '';
let agentBId = '';
let knowledgeBId = '';
let apptBId = '';
let convBId = '';
const BELLA_SECRET = 'ONLY-BELLA-KNOWS-SECRET';

beforeAll(async () => {
  // Platform owner login.
  const login = await platformAgent.post('/api/auth/login').send({
    email: 'owner@agentfactory.io',
    password: 'Password123!'
  });
  expect(login.status).toBe(200);

  // Create a second tenant.
  const bizRes = await platformAgent.post('/api/businesses').send({
    name: "Bella's Bakery",
    type: 'restaurant',
    description: 'Second tenant used to prove isolation.',
    location: 'Baker Street 9',
    services: [],
    faqs: []
  });
  expect(bizRes.status).toBe(201);
  bizBId = bizRes.body.id;

  // Agent for B.
  const agentRes = await platformAgent.post('/api/agents').send({
    businessId: bizBId,
    name: "Bella's AI Assistant",
    description: 'Bakery assistant'
  });
  expect(agentRes.status).toBe(201);
  agentBId = agentRes.body.id;

  // Knowledge for B with a unique marker.
  const kcRes = await platformAgent.post('/api/knowledge').send({
    businessId: bizBId,
    title: 'Bella Secret Special',
    type: 'faq',
    content: `The secret special of the day is ${BELLA_SECRET}: a pistachio croissant.`,
    tags: ['secret']
  });
  expect(kcRes.status).toBe(201);
  knowledgeBId = kcRes.body.id;

  // Appointment for B.
  const apptRes = await platformAgent.post('/api/appointments').send({
    businessId: bizBId,
    customerName: 'Gina',
    customerPhone: '+98 900 111 2222',
    date: '2030-01-15',
    startTime: '10:00',
    notes: 'Bella appointment'
  });
  expect(apptRes.status).toBe(201);
  apptBId = apptRes.body.id;

  // A conversation for B via the public runtime (B has an agent now).
  const chatRes = await platformAgent.post('/api/runtime/chat').send({
    tenantId: bizBId,
    userMessage: 'hello'
  });
  expect(chatRes.status).toBe(200);
  convBId = chatRes.body.conversationId;

  // Tony (owner of A) and staff logins.
  const tonyLogin = await tonyAgent.post('/api/auth/login').send({
    email: 'tony@tonysbarber.com',
    password: 'Password123!'
  });
  expect(tonyLogin.status).toBe(200);

  const staffLogin = await staffAgent.post('/api/auth/login').send({
    email: 'staff@tonysbarber.com',
    password: 'Password123!'
  });
  expect(staffLogin.status).toBe(200);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('auth: sessions and login', () => {
  it('a: unauthenticated business routes return 401', async () => {
    const fresh = request(makeApp());
    const res = await fresh.get('/api/businesses');
    expect(res.status).toBe(401);
    const agents = await fresh.get('/api/agents');
    expect(agents.status).toBe(401);
    const apps = await fresh.get('/api/appointments');
    expect(apps.status).toBe(401);
  });

  it('b: login with wrong password -> 401; correct -> 200 + signed HttpOnly cookie', async () => {
    const fresh = request(makeApp());

    const bad = await fresh.post('/api/auth/login').send({
      email: 'tony@tonysbarber.com',
      password: 'wrong-password'
    });
    expect(bad.status).toBe(401);

    const good = await fresh.post('/api/auth/login').send({
      email: 'tony@tonysbarber.com',
      password: 'Password123!'
    });
    expect(good.status).toBe(200);
    expect(good.body.user).toMatchObject({
      email: 'tony@tonysbarber.com',
      role: 'BUSINESS_OWNER',
      businessId: 'biz-tonys-barber'
    });
    expect(good.body.user.passwordHash).toBeUndefined();

    const setCookie = good.headers['set-cookie'] as unknown as string[];
    expect(Array.isArray(setCookie)).toBe(true);
    const cookie = setCookie.join(';');
    expect(cookie).toContain('af_session=');
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
  });

  it('/api/auth/me returns the real session user or 401', async () => {
    const fresh = request(makeApp());
    const unauth = await fresh.get('/api/auth/me');
    expect(unauth.status).toBe(401);

    const authed = await tonyAgent.get('/api/auth/me');
    expect(authed.status).toBe(200);
    expect(authed.body.user).toMatchObject({
      id: 'usr-tony-1',
      name: 'Tony (Owner)',
      email: 'tony@tonysbarber.com',
      role: 'BUSINESS_OWNER',
      businessId: 'biz-tonys-barber'
    });
    expect(authed.body.user.passwordHash).toBeUndefined();
  });

  it('h: logout invalidates the session (subsequent authed call -> 401)', async () => {
    const freshAgent = request.agent(makeApp());
    await freshAgent.post('/api/auth/login').send({
      email: 'tony@tonysbarber.com',
      password: 'Password123!'
    });
    expect((await freshAgent.get('/api/auth/me')).status).toBe(200);

    const logout = await freshAgent.post('/api/auth/logout');
    expect(logout.status).toBe(200);

    expect((await freshAgent.get('/api/auth/me')).status).toBe(401);
    expect((await freshAgent.get('/api/businesses')).status).toBe(401);

    // Logout with no session still returns 200.
    const fresh2 = request(makeApp());
    expect((await fresh2.post('/api/auth/logout')).status).toBe(200);
  });
});

describe('multi-tenant isolation: businesses list', () => {
  it('c: platform owner sees all businesses (seed + Bella)', async () => {
    const res = await platformAgent.get('/api/businesses');
    expect(res.status).toBe(200);
    const ids = res.body.map((b: any) => b.id);
    expect(ids).toContain('biz-tonys-barber');
    expect(ids).toContain(bizBId);
    expect(res.body.length).toBe(2);
  });

  it('d: Tony (business owner of A) sees ONLY Tony\'s in GET /api/businesses', async () => {
    const res = await tonyAgent.get('/api/businesses');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('biz-tonys-barber');
    expect(res.body[0].name).toBe("Tony's Barber Shop");
  });

  it('f: staff reads own business, blocked from others', async () => {
    const own = await staffAgent.get('/api/businesses');
    expect(own.status).toBe(200);
    expect(own.body).toHaveLength(1);
    expect(own.body[0].id).toBe('biz-tonys-barber');

    const ownAgents = await staffAgent.get('/api/agents?businessId=biz-tonys-barber');
    expect(ownAgents.status).toBe(200);
    expect(ownAgents.body.every((a: any) => a.businessId === 'biz-tonys-barber')).toBe(true);

    const other = await staffAgent.get('/api/agents?businessId=' + bizBId);
    expect(other.status).toBe(404);
    const otherBiz = await staffAgent.get('/api/businesses/' + bizBId);
    expect(otherBiz.status).toBe(404);
  });
});

describe('multi-tenant isolation: Business A cannot read or write Business B', () => {
  it('e1: reads of B by id or tenant-scope return 404 (no existence leak)', async () => {
    // GET by id (business record of B).
    expect((await tonyAgent.get('/api/businesses/' + bizBId)).status).toBe(404);
    // Tenant-scoped collection reads.
    expect((await tonyAgent.get('/api/agents?businessId=' + bizBId)).status).toBe(404);
    expect((await tonyAgent.get('/api/knowledge?businessId=' + bizBId)).status).toBe(404);
    expect((await tonyAgent.get('/api/appointments?businessId=' + bizBId)).status).toBe(404);
    expect((await tonyAgent.get('/api/products?businessId=' + bizBId)).status).toBe(404);
    expect((await tonyAgent.get('/api/orders?businessId=' + bizBId)).status).toBe(404);
    expect((await tonyAgent.get('/api/channels?businessId=' + bizBId)).status).toBe(404);
    expect((await tonyAgent.get('/api/integrations?businessId=' + bizBId)).status).toBe(404);
    expect((await tonyAgent.get('/api/conversations?businessId=' + bizBId)).status).toBe(404);
    expect((await tonyAgent.get('/api/audit-logs?businessId=' + bizBId)).status).toBe(404);
    // Conversation messages of B.
    expect((await tonyAgent.get(`/api/conversations/${convBId}/messages`)).status).toBe(404);
  });

  it('e2: writes to B\'s resources return 403', async () => {
    // POSTs carrying B's businessId in the body.
    expect((await tonyAgent.post('/api/agents').send({ businessId: bizBId, name: 'evil' })).status).toBe(403);
    expect((await tonyAgent.post('/api/knowledge').send({ businessId: bizBId, title: 'evil', content: 'evil' })).status).toBe(403);
    expect(
      (await tonyAgent.post('/api/appointments').send({
        businessId: bizBId,
        customerName: 'X',
        customerPhone: '1',
        date: '2030-02-01',
        startTime: '09:00'
      })).status
    ).toBe(403);
    expect((await tonyAgent.post('/api/products').send({ businessId: bizBId, name: 'evil' })).status).toBe(403);

    // By-id writes to B's records.
    expect((await tonyAgent.put('/api/agents/' + agentBId).send({ name: 'evil' })).status).toBe(403);
    expect((await tonyAgent.post('/api/agents/' + agentBId + '/status').send({ status: 'PAUSED' })).status).toBe(403);
    expect((await tonyAgent.delete('/api/knowledge/' + knowledgeBId)).status).toBe(403);
    expect((await tonyAgent.put('/api/appointments/' + apptBId).send({ status: 'CANCELLED' })).status).toBe(403);
    expect((await tonyAgent.put('/api/businesses/' + bizBId).send({ name: 'hijacked' })).status).toBe(403);
  });

  it('e3: platform owner can still read and write B (positive control)', async () => {
    const biz = await platformAgent.get('/api/businesses/' + bizBId);
    expect(biz.status).toBe(200);
    expect(biz.body.id).toBe(bizBId);

    const agents = await platformAgent.get('/api/agents?businessId=' + bizBId);
    expect(agents.status).toBe(200);
    expect(agents.body.some((a: any) => a.id === agentBId)).toBe(true);
  });

  it('e4: Tony can read and write his own resources (positive control)', async () => {
    const agents = await tonyAgent.get('/api/agents?businessId=biz-tonys-barber');
    expect(agents.status).toBe(200);
    expect(agents.body).toHaveLength(1);

    const update = await tonyAgent.put('/api/agents/agent-tonys-1').send({ description: 'Updated by owner' });
    expect(update.status).toBe(200);
    expect(update.body.version).toBe(2);

    const apps = await tonyAgent.get('/api/appointments?businessId=biz-tonys-barber');
    expect(apps.status).toBe(200);
    expect(apps.body).toHaveLength(2);
  });

  it('role restrictions: analytics is platform-owner only', async () => {
    expect((await tonyAgent.get('/api/analytics/overview')).status).toBe(403);
    expect((await request(makeApp()).get('/api/analytics/overview')).status).toBe(401);
    expect((await platformAgent.get('/api/analytics/overview')).status).toBe(200);
  });
});

describe('public widget + tenant isolation at runtime', () => {
  it('g: /api/runtime/chat answers UNAUTHENTICATED and never leaks B knowledge', async () => {
    const fresh = request(makeApp());
    const res = await fresh.post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber',
      userMessage: `What is the ${BELLA_SECRET} special?`
    });

    // Public by design: an unauthenticated customer gets a real answer (the
    // graceful fallback reply when no LLM key is configured), never 401/403.
    expect(res.status).toBe(200);
    expect(typeof res.body.reply).toBe('string');
    expect(res.body.reply.length).toBeGreaterThan(0);

    // Tenant B's knowledge must not appear anywhere in tenant A's response.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(BELLA_SECRET);
    expect(raw).not.toContain('pistachio croissant');

    // The retrieval is server-scoped to tenant A: no B chunks in context.
    const retrieved = (res.body.debug?.retrievedKnowledge ?? []) as string[];
    expect(retrieved.every((chunk: string) => !chunk.includes(BELLA_SECRET))).toBe(true);
  });

  it('runtime chat with an unknown tenant still errors honestly (no cross-tenant write)', async () => {
    const fresh = request(makeApp());
    const res = await fresh.post('/api/runtime/chat').send({
      tenantId: 'biz-does-not-exist',
      userMessage: 'hello'
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
  });
});
