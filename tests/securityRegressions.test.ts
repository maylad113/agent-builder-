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
// Credential encryption requires a key (INTEGRATION_ENCRYPTION_KEY or
// SESSION_SECRET); without it storage refuses (never stores plaintext).
process.env.SESSION_SECRET = 'test-security-regressions-credential-key';

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { rateLimit, setRateLimitStore, MemoryRateLimitStore } = await import('../src/server/security');

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
  await db.init();
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

afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

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
    const stored = await db.appointments.find(a => a.id === apptBId);
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
    const audited = await db.auditLogs.find(l => l.action === 'PRODUCT_CREATED' && l.businessId === bizBId);
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

describe('debug-found regressions', () => {
  it('rejects an oversized business name (>200 chars)', async () => {
    const r = await owner.post('/api/businesses').send({ name: 'A'.repeat(500), type: 'general' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/name/i);
  });

  it('returns JSON 404 for unknown /api/* routes (not SPA HTML)', async () => {
    const r = await owner.get('/api/this-endpoint-does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body).toHaveProperty('error');
    expect(typeof r.body.error).toBe('string');
  });

  it('accepts allowedWidgetOrigins on business create', async () => {
    const r = await owner.post('/api/businesses').send({
      name: 'Origin Test Biz', type: 'general',
      allowedWidgetOrigins: ['https://my-site.example']
    });
    expect(r.status).toBe(201);
    expect(r.body.allowedWidgetOrigins).toEqual(['https://my-site.example']);
  });

  it('can create a draft from an agent with no published version', async () => {
    // New agent only has its initial DRAFT. createDraftFrom must fall back to
    // the latest version instead of erroring "No source version".
    const biz = await owner.post('/api/businesses').send({ name: 'Draft Fallbk', type: 'general' });
    const agent = await owner.post('/api/agents').send({ businessId: biz.body.id, name: 'DF Agent' });
    const r = await owner.post(`/api/agents/${agent.body.id}/versions`).send({});
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('DRAFT');
  });

  it('duplicates a business with its knowledge (correct tenant on clone)', async () => {
    const biz = await owner.post('/api/businesses').send({ name: 'Dup Knowledge Src', type: 'general' });
    await owner.post('/api/knowledge').send({
      businessId: biz.body.id, title: 'K1', type: 'faq', content: 'hello', tags: []
    });
    const dup = await owner.post(`/api/businesses/${biz.body.id}/duplicate`).send({ newName: 'Dup Knowledge Copy' });
    expect(dup.status).toBe(201);
    const newId = dup.body.newBusiness.id;
    const knowledge = await owner.get(`/api/knowledge?businessId=${newId}`);
    expect(knowledge.status).toBe(200);
    expect(knowledge.body.length).toBeGreaterThanOrEqual(1);
    // cloned knowledge must belong to the NEW tenant, not the source
    expect(knowledge.body[0].businessId).toBe(newId);
  });
});

describe('tool permission enforcement (defense-in-depth)', () => {
  it('rejects an LLM-hallucinated tool not in the agent\'s allowed set', async () => {
    const { executeAgentTool, agentToolDeclarations } = await import('../src/server/tools');
    const { db } = await import('../src/server/db');
    const biz = await db.businesses.find(b => b.id === 'biz-tonys-barber');
    expect(biz).toBeTruthy();
    // Simulate the LLM calling 'book_appointment' when the agent only allows
    // 'check_business_hours' — the backend must refuse to execute it.
    const result = await executeAgentTool('book_appointment', {
      serviceId: 'svc-haircut', date: '2025-01-15', time: '10:00'
    }, {
      tenantId: 'biz-tonys-barber',
      toolsEnabled: ['check_business_hours'],
      allowedToolNames: ['check_business_hours', 'get_business_information']
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not enabled');
  });

  it('executes a permitted tool normally', async () => {
    const { executeAgentTool } = await import('../src/server/tools');
    const { db } = await import('../src/server/db');
    const biz = await db.businesses.find(b => b.id === 'biz-tonys-barber');
    expect(biz).toBeTruthy();
    const result = await executeAgentTool('check_business_hours', {}, {
      tenantId: 'biz-tonys-barber',
      toolsEnabled: ['check_business_hours'],
      allowedToolNames: ['check_business_hours']
    });
    expect(result.success).toBe(true);
    expect(result.data).toBeTruthy();
  });

  it('rejects a tool call for an unknown tenant (IDOR guard)', async () => {
    const { executeAgentTool } = await import('../src/server/tools');
    const result = await executeAgentTool('check_business_hours', {}, {
      tenantId: 'biz-does-not-exist',
      toolsEnabled: ['check_business_hours'],
      allowedToolNames: ['check_business_hours']
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unauthorized');
  });
});

// ---------------------------------------------------------------------------
// P2.11 — integration credential input validation (audit hardening).
// Submitting credentials to an integration must reject:
//   - non-string values
//   - empty / whitespace-only values
//   - oversize values (storage/log-blowup prevention)
// A valid submission still stores and flips the integration to CONFIGURING.
// Uses the seeded demo integration `integ-1` (google_calendar) on
// biz-tonys-barber, owned by the platform owner.
// ---------------------------------------------------------------------------
describe('P2.11 integration credential validation', () => {
  it('rejects a non-string credential value', async () => {
    const r = await owner.post('/api/integrations/integ-1/credentials')
      .send({ credentials: { client_secret: 12345 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/must be a string/i);
  });

  it('rejects an empty / whitespace credential value', async () => {
    const r = await owner.post('/api/integrations/integ-1/credentials')
      .send({ credentials: { client_secret: '   ' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/must not be empty/i);
  });

  it('rejects an oversize credential value', async () => {
    const r = await owner.post('/api/integrations/integ-1/credentials')
      .send({ credentials: { client_secret: 'x'.repeat(5000) } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/maximum length/i);
  });

  it('rejects when credentials is not an object', async () => {
    const r = await owner.post('/api/integrations/integ-1/credentials')
      .send({ credentials: 'not-an-object' });
    expect(r.status).toBe(400);
  });

  it('stores valid credentials and flips the integration to CONFIGURING', async () => {
    const r = await owner.post('/api/integrations/integ-1/credentials')
      .send({ credentials: { client_id: 'abc', client_secret: 'shh' } });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('CONFIGURING');
    // Credentials themselves must NEVER be echoed back to the client.
    expect(JSON.stringify(r.body)).not.toContain('shh');
    // Re-fetch the integration list (sanitized) and confirm the persisted state.
    const list = await owner.get('/api/integrations?businessId=biz-tonys-barber');
    const integ = list.body.find((i: any) => i.id === 'integ-1');
    expect(integ.state).toBe('CONFIGURING');
    expect(integ.credentialsSet).toBe(true);
    expect(JSON.stringify(integ)).not.toContain('shh');
  });
});

// ---------------------------------------------------------------------------
// P2.8 — per-tenant widget rate limit (audit hardening).
// The public /runtime/chat limiter must key on (tenantId, ip) so that hammering
// Business A does not exhaust the IP budget for Business B on the same NAT IP.
// We exercise the limiter directly with RATE_LIMIT_TEST=1 and a tiny window.
// ---------------------------------------------------------------------------
describe('P2.8 per-tenant widget rate limit', () => {

  function makeKeyedLimiter() {
    return rateLimit({
      windowMs: 60_000, max: 2, prefix: 'chat',
      keyFn: (req: any) => String(req.body?.tenantId ?? '')
    });
  }

  function fakeReq(tenantId: string, ip = '1.2.3.4') {
    const req: any = { body: { tenantId }, ip, socket: { remoteAddress: ip } };
    return req;
  }
  function fakeRes() {
    const headers: Record<string, string> = {};
    let status = 200;
    let body: any = null;
    return {
      setHeader(k: string, v: string) { headers[k] = v; },
      status(s: number) { status = s; return this; },
      json(b: any) { body = b; return this; },
      get state() { return status; },
      get body() { return body; },
      get headers() { return headers; }
    } as any;
  }

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.RATE_LIMIT_TEST = '1';
    setRateLimitStore(new MemoryRateLimitStore());
  });
  afterAll(() => { delete process.env.RATE_LIMIT_TEST; });

  it('limits per (tenantId, ip): tenant B keeps its budget after tenant A is throttled', () => {
    const limiter = makeKeyedLimiter();
    const ip = '203.0.113.7';
    // Exhaust tenant A's budget (max=2).
    for (let i = 0; i < 2; i++) {
      const res = fakeRes();
      limiter(fakeReq('biz-A', ip), res, () => {});
      expect(res.state).toBe(200);
    }
    // 3rd request for tenant A from the same IP -> 429.
    const resA = fakeRes();
    limiter(fakeReq('biz-A', ip), resA, () => {});
    expect(resA.state).toBe(429);

    // Same IP, but tenant B, must still be allowed (separate bucket).
    const resB = fakeRes();
    limiter(fakeReq('biz-B', ip), resB, () => {});
    expect(resB.state).toBe(200);
  });

  it('a missing tenantId falls back to per-IP keying (still bounded)', () => {
    const limiter = makeKeyedLimiter();
    const ip = '198.51.100.9';
    for (let i = 0; i < 2; i++) {
      const res = fakeRes();
      limiter(fakeReq('', ip), res, () => {});
      expect(res.state).toBe(200);
    }
    const res = fakeRes();
    limiter(fakeReq('', ip), res, () => {});
    expect(res.state).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// P2.9 — DB-side pagination returns the right page + total without loading
// the whole table (white-box: paginateWhere returns {rows, total}).
// ---------------------------------------------------------------------------
describe('P2.9 DB-side pagination helper', () => {
  it('returns a bounded page and an accurate total for a tenant query', async () => {
    const { rows, total } = await db.appointments.paginateWhere(
      'business_id = ?',
      [bizBId],
      { orderBy: 'date', limit: 1, offset: 0 }
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(typeof total).toBe('number');
    expect(total).toBeGreaterThanOrEqual(1);
  });
});
