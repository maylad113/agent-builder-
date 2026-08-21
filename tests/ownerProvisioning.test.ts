import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Owner-account provisioning at delivery (Task 23).
 *
 * The delivered business owner must be able to log into the platform. The
 * platform owner provisions a BUSINESS_OWNER account for an EXISTING
 * delivery; the server generates a one-time temporary password, returns it
 * exactly once (initial response only), and stores only the existing scrypt
 * hash. Provisioning is idempotent per delivery (replay returns the existing
 * account WITHOUT a password and NEVER creates a second user), safe under
 * concurrency (delivery row lock + users.email UNIQUE backstop), rejects a
 * globally duplicate email without tenant disclosure, ignores all
 * client-supplied server-owned fields (businessId/tenantId/role/password/
 * createdAt), and preserves tenant isolation after the owner logs in.
 *
 * No mocks: real seeded DB, real routes, real login/session stack.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-prov-'));
process.env.DB_PATH = path.join(tmpDir, 'provisioning.db');
process.env.SESSION_SECRET = 'test-provisioning-secret';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { createBusinessTenant } = await import('../src/server/agentLifecycle');
const { createProspect } = await import('../src/server/orchestration/prospects');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const platformAgent = request.agent(app);
const tonyAgent = request.agent(app);
const unauthAgent = request.agent(app);

let seq = 0;
/** Build a real delivery row in the exact shape the factory submitter writes. */
async function makeDelivery(status: 'DELIVERED' | 'PENDING' | 'ACCEPTED' = 'DELIVERED') {
  seq += 1;
  const business = await createBusinessTenant({
    name: `Provision Co ${seq}`,
    type: 'barber_shop',
    description: 'A real local shop.'
  });
  const prospect = await createProspect({ businessName: business.name } as any);
  prospect.status = 'CONVERTED';
  prospect.businessId = business.id;
  await db.prospects.update(prospect);
  const now = new Date().toISOString();
  const delivery = {
    id: `del-prov-${Date.now()}-${seq}`,
    prospectId: prospect.id,
    businessId: business.id,
    agentId: `agent-prov-${seq}`,
    status,
    deliveryMethod: 'manual',
    deliveryPayload: {
      note: 'Agent activated and ready for handover to the business owner.',
      agentId: `agent-prov-${seq}`,
      businessId: business.id
    },
    deliveredAt: now,
    createdAt: now,
    updatedAt: now
  };
  await db.deliveries.push(delivery);
  return { business, delivery };
}

const url = (id: string) => `/api/orchestration/deliveries/${id}/provision-owner-account`;

beforeAll(async () => {
  await db.init({ seed: true });
  const p = await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  expect(p.status).toBe(200);
  const t = await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
  expect(t.status).toBe(200);
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ===========================================================================
// Authorization
// ===========================================================================

describe('authorization', () => {
  it('unauthenticated request is rejected 401', async () => {
    const { delivery } = await makeDelivery();
    const res = await unauthAgent.post(url(delivery.id)).send({ email: 'a@b.co', name: 'A' });
    expect(res.status).toBe(401);
  });

  it('tenant BUSINESS_OWNER is rejected 403', async () => {
    const { delivery } = await makeDelivery();
    const res = await tonyAgent.post(url(delivery.id)).send({ email: 'a@b.co', name: 'A' });
    expect(res.status).toBe(403);
  });

  it('nonexistent delivery returns 404 without leaking', async () => {
    const res = await platformAgent.post(url('del-does-not-exist')).send({ email: 'a@b.co', name: 'A' });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('biz-');
  });
});

// ===========================================================================
// Input validation
// ===========================================================================

describe('input validation', () => {
  it('rejects a malformed email (400)', async () => {
    const { delivery } = await makeDelivery();
    const res = await platformAgent.post(url(delivery.id)).send({ email: 'not-an-email', name: 'Owner' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing/empty email (400)', async () => {
    const { delivery } = await makeDelivery();
    expect((await platformAgent.post(url(delivery.id)).send({ name: 'Owner' })).status).toBe(400);
    expect((await platformAgent.post(url(delivery.id)).send({ email: '   ', name: 'Owner' })).status).toBe(400);
  });

  it('rejects an over-long email (400)', async () => {
    const { delivery } = await makeDelivery();
    const email = `${'x'.repeat(300)}@example.com`;
    const res = await platformAgent.post(url(delivery.id)).send({ email, name: 'Owner' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing/empty name (400)', async () => {
    const { delivery } = await makeDelivery();
    expect((await platformAgent.post(url(delivery.id)).send({ email: 'owner@shop.co' })).status).toBe(400);
    expect((await platformAgent.post(url(delivery.id)).send({ email: 'owner@shop.co', name: ' ' })).status).toBe(400);
  });

  it('rejects an over-long name (400)', async () => {
    const { delivery } = await makeDelivery();
    const res = await platformAgent.post(url(delivery.id)).send({ email: 'owner@shop.co', name: 'n'.repeat(500) });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Delivery-state eligibility
// ===========================================================================

describe('delivery-state eligibility', () => {
  it('rejects a PENDING delivery (not ready)', async () => {
    const { delivery } = await makeDelivery('PENDING');
    const res = await platformAgent.post(url(delivery.id)).send({ email: 'owner@shop.co', name: 'Owner' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not ready/i);
  });
});

// ===========================================================================
// Happy path + one-time password semantics
// ===========================================================================

describe('owner account provisioning', () => {
  let deliveryId = '';
  let businessId = '';
  let oneTimePassword = '';
  let createdUserId = '';

  it('provisions a BUSINESS_OWNER account and returns a one-time password (201)', async () => {
    const { business, delivery } = await makeDelivery('ACCEPTED');
    deliveryId = delivery.id;
    businessId = business.id;
    const res = await platformAgent.post(url(delivery.id)).send({
      email: '  Owner@ProvisionCo.co  ',
      name: '  Sam the Owner  '
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.role).toBe('BUSINESS_OWNER');
    expect(res.body.user.businessId).toBe(business.id);
    // Email is normalized/lowercased; name is trimmed.
    expect(res.body.user.email).toBe('owner@provisionco.co');
    expect(res.body.user.name).toBe('Sam the Owner');
    // No hash ever leaves the server; the one-time password is present once.
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(typeof res.body.temporaryPassword).toBe('string');
    expect(res.body.temporaryPassword.length).toBeGreaterThanOrEqual(16);
    oneTimePassword = res.body.temporaryPassword;
    createdUserId = res.body.user.id;
  });

  it('stores the password ONLY as the existing scrypt hash (never plaintext)', async () => {
    const user = await db.users.find((u: any) => u.id === createdUserId);
    expect(user).toBeTruthy();
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.passwordHash).not.toBe(oneTimePassword);
    // The plaintext password appears NOWHERE on the persisted user row.
    expect(JSON.stringify(user)).not.toContain(oneTimePassword);
  });

  it('the one-time password authenticates through the existing login', async () => {
    const ownerAgent = request.agent(app);
    const login = await ownerAgent.post('/api/auth/login').send({
      email: 'owner@provisionco.co', password: oneTimePassword
    });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('BUSINESS_OWNER');
    expect(login.body.user.businessId).toBe(businessId);
    const me = await ownerAgent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('BUSINESS_OWNER');
    expect(me.body.user.businessId).toBe(businessId);

    // Tenant isolation after login: the new owner sees ONLY its own business
    // and cannot read another tenant's data (foreign read → 404).
    const businesses = await ownerAgent.get('/api/businesses');
    expect(businesses.status).toBe(200);
    expect(businesses.body.map((b: any) => b.id)).toEqual([businessId]);
    const foreignAgents = await ownerAgent.get('/api/agents?businessId=biz-tonys-barber');
    expect(foreignAgents.status).toBe(404);
    const foreignWrite = await ownerAgent.post('/api/knowledge').send({ businessId: 'biz-tonys-barber', title: 'x', content: 'y' });
    expect(foreignWrite.status).toBe(403);
  });

  it('the one-time password never appears in telemetry or audit records', async () => {
    const telemetry = JSON.stringify(await db.telemetry.toJSON());
    expect(telemetry).not.toContain(oneTimePassword);
    const audits = JSON.stringify((await db.auditLogs.toJSON()));
    expect(audits).not.toContain(oneTimePassword);
  });

  it('replay is idempotent: same account, NO password, NO second user (200)', async () => {
    const before = await db.users.length();
    const res = await platformAgent.post(url(deliveryId)).send({
      email: 'a-completely-different@address.co', name: 'Someone Else'
    });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(createdUserId);
    expect('temporaryPassword' in res.body).toBe(false);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(await db.users.length()).toBe(before);
    const owners = await db.users.filter((u: any) => u.businessId === businessId);
    expect(owners.length).toBe(1);
  });

  it('ignores every client-supplied server-owned field', async () => {
    const { business, delivery } = await makeDelivery();
    const res = await platformAgent.post(url(delivery.id)).send({
      email: 'second@provisionco.co',
      name: 'Second Owner',
      businessId: 'biz-tonys-barber',
      tenantId: 'biz-tonys-barber',
      role: 'PLATFORM_OWNER',
      password: 'ClientSupplied123!',
      passwordHash: 'plaintext',
      createdAt: '1970-01-01T00:00:00.000Z',
      dismissedAt: '1970-01-01T00:00:00.000Z'
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('BUSINESS_OWNER');
    expect(res.body.user.businessId).toBe(business.id);
    expect(res.body.user.createdAt).not.toBe('1970-01-01T00:00:00.000Z');
    // The client-supplied password was NOT used (server-generated one was).
    const badLogin = await request.agent(app).post('/api/auth/login').send({
      email: 'second@provisionco.co', password: 'ClientSupplied123!'
    });
    expect(badLogin.status).toBe(401);
    const goodLogin = await request.agent(app).post('/api/auth/login').send({
      email: 'second@provisionco.co', password: res.body.temporaryPassword
    });
    expect(goodLogin.status).toBe(200);
  });
});

// ===========================================================================
// Duplicate email (global uniqueness — no tenant disclosure, no reassignment)
// ===========================================================================

describe('duplicate email', () => {
  it('rejects an email that already belongs to another account, without disclosure', async () => {
    const { delivery } = await makeDelivery();
    const tonyBefore = await db.users.find((u: any) => u.email === 'tony@tonysbarber.com');
    const res = await platformAgent.post(url(delivery.id)).send({
      email: '  TONY@tonysbarber.com ', // case/whitespace normalization must catch it
      name: 'Impersonator'
    });
    expect(res.status).toBe(400);
    // Safe, generic client-facing error — no other tenant/business info.
    expect(JSON.stringify(res.body)).not.toContain('biz-tonys-barber');
    expect(JSON.stringify(res.body)).not.toContain('Tony');
    // Existing account untouched, NOT reassigned; delivery NOT provisioned.
    const tonyAfter = await db.users.find((u: any) => u.email === 'tony@tonysbarber.com');
    expect(tonyAfter.businessId).toBe(tonyBefore.businessId);
    expect(tonyAfter.role).toBe(tonyBefore.role);
    const fresh = await db.deliveries.find((d: any) => d.id === delivery.id);
    expect(fresh.deliveryPayload?.ownerAccountUserId).toBeUndefined();
  });
});

// ===========================================================================
// Concurrency — exactly one account even when requests race
// ===========================================================================

describe('concurrency', () => {
  it('concurrent provisioning produces exactly ONE owner account', async () => {
    const { business, delivery } = await makeDelivery();
    const a1 = request.agent(app);
    const a2 = request.agent(app);
    await a1.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
    await a2.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
    const [r1, r2] = await Promise.all([
      a1.post(url(delivery.id)).send({ email: 'race-one@shop.co', name: 'Racer One' }),
      a2.post(url(delivery.id)).send({ email: 'race-two@shop.co', name: 'Racer Two' })
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const created = r1.status === 201 ? r1 : r2;
    const replay = r1.status === 201 ? r2 : r1;
    expect(typeof created.body.temporaryPassword).toBe('string');
    expect('temporaryPassword' in replay.body).toBe(false);
    expect(replay.body.user.id).toBe(created.body.user.id);
    const owners = await db.users.filter((u: any) => u.businessId === business.id);
    expect(owners.length).toBe(1);
  });
});
