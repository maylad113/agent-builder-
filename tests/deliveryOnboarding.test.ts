import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Delivery onboarding artifact tests (Phase C / Task 19).
 *
 * The artifact is a DETERMINISTIC, LLM-free representation assembled from
 * persisted platform state (delivery + business + agent + channels +
 * acceptance). It never activates channels, never contacts customers, never
 * fabricates capabilities, and never leaks credentials. GET-based assembly —
 * repeated retrieval returns an equivalent artifact, no duplicates.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-onb-'));
process.env.DB_PATH = path.join(tmpDir, 'onboarding.db');
process.env.SESSION_SECRET = 'test-onboarding-secret';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { createBusinessTenant, createAgentWithInitialDraft } = await import('../src/server/agentLifecycle');
const { createProspect } = await import('../src/server/orchestration/prospects');
const { buildOnboardingArtifact } = await import('../src/server/orchestration/deliveries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const platformAgent = request.agent(app);
const tenantAgent = request.agent(app);

let delivery: any;
let business: any;
let agent: any;

beforeAll(async () => {
  await db.init({ seed: true });
  business = await createBusinessTenant({ name: 'Onboard Cuts', type: 'barber_shop', description: 'A real barber shop.' });
  agent = await createAgentWithInitialDraft({
    businessId: business.id,
    name: 'Onboard Cuts Assistant',
    systemPrompt: 'You are the receptionist.',
    structuredConfig: {
      personality: { tone: 'friendly', behavior: 'service', language: 'en' },
      goals: ['Answer FAQs', 'Help with bookings'],
      allowedActions: ['get_business_information'], restrictedActions: [], escalationRules: ['Escalate when unsure.'],
      bookingRules: '', orderRules: '', refundRules: '',
      toolsEnabled: ['get_business_information', 'transfer_to_human']
    },
    status: 'READY'
  });
  // Simulate successful activation (as the factory submitter does).
  agent.status = 'ACTIVE';
  await db.agents.update(agent);
  const prospect = await createProspect({ businessName: 'Onboard Cuts', businessId: business.id } as any);
  prospect.status = 'CONVERTED';
  prospect.businessId = business.id;
  await db.prospects.update(prospect);
  delivery = {
    id: `del-${Date.now()}-t1`,
    prospectId: prospect.id,
    businessId: business.id,
    agentId: agent.id,
    status: 'DELIVERED',
    deliveryMethod: 'manual',
    deliveryPayload: { note: 'Agent activated and ready for handover to the business owner.', agentId: agent.id, businessId: business.id },
    deliveredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await db.deliveries.push(delivery);
});
afterAll(async () => {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Deterministic artifact (module level)
// ---------------------------------------------------------------------------

describe('buildOnboardingArtifact (deterministic, LLM-free)', () => {
  it('assembles a complete artifact from persisted state', async () => {
    const art = await buildOnboardingArtifact(delivery.id);
    expect(art.deliveryId).toBe(delivery.id);
    expect(art.deliveryStatus).toBe('DELIVERED');
    expect(art.deliveryMethod).toBe('manual');
    expect(art.agent.id).toBe(agent.id);
    expect(art.agent.name).toBe('Onboard Cuts Assistant');
    expect(art.agent.status).toBe('ACTIVE');
    expect(art.business.id).toBe(business.id);
    expect(art.business.name).toBe('Onboard Cuts');
    expect(Array.isArray(art.agent.capabilities)).toBe(true);
    expect(art.agent.capabilities).toContain('Answer FAQs');
    expect(Array.isArray(art.instructions)).toBe(true);
    expect(art.instructions.length).toBeGreaterThan(2);
    // web_chat: the only configured channel → REAL snippet with the tenant id,
    // never invented URLs, only the platform widget.js route.
    const web = art.channels.find((c: any) => c.type === 'web_chat');
    expect(web.status).toBe('connected');
    expect(web.embedSnippet).toContain('<script src="/widget.js"');
    expect(web.embedSnippet).toContain(`data-business-id="${business.id}"`);
    // Others remain honestly NOT CONFIGURED with NO snippet.
    for (const other of ['instagram', 'sms', 'voice']) {
      const c = art.channels.find((x: any) => x.type === other);
      expect(c.status).toBe('not_configured');
      expect(c.embedSnippet).toBeUndefined();
    }
    // No acceptance before it happens.
    expect(art.acceptance).toBeUndefined();
  });

  it('is deterministic and never mutates persisted state on repeat', async () => {
    const before = JSON.stringify(await db.deliveries.toJSON());
    const a = await buildOnboardingArtifact(delivery.id);
    const b = await buildOnboardingArtifact(delivery.id);
    expect(a).toEqual(b);
    expect(JSON.stringify(await db.deliveries.toJSON())).toBe(before); // read-only assembly
    expect((await db.deliveries.toJSON()).length).toBe((await db.deliveries.toJSON()).length);
  });

  it('honest NOT AVAILABLE state when web_chat is not configured', async () => {
    const otherBiz = await createBusinessTenant({ name: 'No Web Co', type: 'gym' });
    await db.channels.update({ ...(await db.channels.find(c => c.businessId === otherBiz.id && c.type === 'web_chat'))!, status: 'not_configured', details: 'Not configured' } as any);
    const otherAgent = await createAgentWithInitialDraft({
      businessId: otherBiz.id, name: 'No Web Assistant', status: 'READY'
    });
    const otherProspect = await createProspect({ businessName: 'No Web Co', businessId: otherBiz.id } as any);
    const d2 = {
      id: `del-${Date.now()}-t2`, prospectId: otherProspect.id, businessId: otherBiz.id, agentId: otherAgent.id,
      status: 'DELIVERED' as const, deliveryMethod: 'manual', deliveryPayload: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await db.deliveries.push(d2 as any);
    const art = await buildOnboardingArtifact(d2.id);
    const web = art.channels.find((c: any) => c.type === 'web_chat');
    expect(web.status).toBe('not_configured');
    expect(web.embedSnippet).toBeUndefined();
    expect(art.instructions.some((i: string) => /not configured/i.test(i))).toBe(true);
  });

  it('reflects acceptance AFTER it occurs (read of existing acceptance)', async () => {
    await db.acceptances.push({
      id: `acc-${Date.now()}-t1`, deliveryId: delivery.id, businessId: business.id,
      acceptedBy: 'Owner Test', acceptanceMethod: 'manual', acceptedAt: new Date().toISOString(), createdAt: new Date().toISOString()
    });
    delivery.status = 'ACCEPTED';
    await db.deliveries.update(delivery);
    const art = await buildOnboardingArtifact(delivery.id);
    expect(art.deliveryStatus).toBe('ACCEPTED');
    expect(art.acceptance?.acceptedBy).toBe('Owner Test');
    expect(art.acceptance?.acceptedAt).toBeTruthy();
  });

  it('never leaks credentials/secrets/internal details', async () => {
    process.env.GOOGLE_PLACES_API_KEY_SHADOW_TEST = 'sk-live-abc123';
    const art = await buildOnboardingArtifact(delivery.id);
    const blob = JSON.stringify(art);
    expect(blob).not.toContain('sk-live-abc123');
    expect(blob).not.toMatch(/SESSION_SECRET|GEMINI_API_KEY|password/i);
    delete process.env.GOOGLE_PLACES_API_KEY_SHADOW_TEST;
  });

  it('treats malicious business text as inert data (no executable interpolation)', async () => {
    const evilBiz = await createBusinessTenant({ name: '<script>alert(1)</script>', type: 'x' });
    const evilAgent = await createAgentWithInitialDraft({ businessId: evilBiz.id, name: 'E', status: 'READY' });
    const evilProspect = await createProspect({ businessName: 'E', businessId: evilBiz.id } as any);
    const d = {
      id: `del-${Date.now()}-t3`, prospectId: evilProspect.id, businessId: evilBiz.id, agentId: evilAgent.id,
      status: 'DELIVERED' as const, deliveryMethod: 'manual', deliveryPayload: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    await db.deliveries.push(d as any);
    const art = await buildOnboardingArtifact(d.id);
    expect(art.business.name).toBe('<script>alert(1)</script>'); // stored as DATA
    const web = art.channels.find((c: any) => c.type === 'web_chat');
    // The only interpolated value in the snippet is the tenant id (safe id chars).
    expect(web.embedSnippet).not.toContain('<script>alert');
    expect(web.embedSnippet).toContain('data-business-id');
  });

  it('performs no network access and no customer communication', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('no network'); });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await buildOnboardingArtifact(delivery.id);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws a safe error for a nonexistent delivery', async () => {
    await expect(buildOnboardingArtifact('del-nope')).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// API routes (owner-gated)
// ---------------------------------------------------------------------------

describe('onboarding API routes', () => {
  it('GET /deliveries/:id/onboarding returns the deterministic artifact', async () => {
    await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
    const res = await platformAgent.get(`/api/orchestration/deliveries/${delivery.id}/onboarding`);
    expect(res.status).toBe(200);
    expect(res.body.deliveryId).toBe(delivery.id);
    expect(res.body.agent.status).toBe('ACTIVE');
    const repeat = await platformAgent.get(`/api/orchestration/deliveries/${delivery.id}/onboarding`);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toEqual(res.body); // identical repeat retrieval
  });

  it('401 unauthenticated; 403 tenant role; 404 unknown (no leak)', async () => {
    expect((await request(app).get(`/api/orchestration/deliveries/${delivery.id}/onboarding`)).status).toBe(401);
    await tenantAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
    expect((await tenantAgent.get(`/api/orchestration/deliveries/${delivery.id}/onboarding`)).status).toBe(403);
    await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
    expect((await platformAgent.get('/api/orchestration/deliveries/del-nope/onboarding')).status).toBe(404);
  });
});
