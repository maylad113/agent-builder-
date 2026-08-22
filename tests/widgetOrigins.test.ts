import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Task 24 — customer website origin wiring for the delivered widget.
 *
 * The factory must derive the customer's website ORIGIN from the existing
 * prospect.website data, validate/normalize it (widget security conventions),
 * and store it on the created tenant's allowedWidgetOrigins with safe merge
 * semantics (never erase owner-added origins, dedupe, idempotent re-submit).
 * The onboarding artifact must emit an ABSOLUTE platform widget URL
 * (PLATFORM_PUBLIC_URL, dev localhost fallback) — never a relative one that
 * the browser would resolve against the customer's own domain.
 *
 * No mocks: real DB, real routes, real factory submitter. The LLM provider
 * stays unconfigured; the runtime degrades deterministically (graceful
 * handoff), which does not affect origin/CORS behavior.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-worigin-'));
process.env.DB_PATH = path.join(tmpDir, 'worigin.db');
process.env.SESSION_SECRET = 'test-worigin-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;
delete process.env.PLATFORM_PUBLIC_URL;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { normalizeWidgetOrigin, normalizeWidgetOriginList, deriveOriginFromWebsite, platformPublicOrigin } = await import('../src/server/widgetSecurity');
const { createBusinessTenant, createAgentWithInitialDraft } = await import('../src/server/agentLifecycle');
const { createProspect, getProspect } = await import('../src/server/orchestration/prospects');
const { createDesign, approveDesign } = await import('../src/server/orchestration/design');
const { submitDesignToFactory } = await import('../src/server/orchestration/factorySubmitter');
const { buildOnboardingArtifact } = await import('../src/server/orchestration/deliveries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const platformAgent = request.agent(app);

beforeAll(async () => {
  await db.init({ seed: true });
  const login = await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  expect(login.status).toBe(200);
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Origin normalization (unit)
// ---------------------------------------------------------------------------

describe('normalizeWidgetOrigin', () => {
  it('accepts a plain HTTPS domain', () => {
    expect(normalizeWidgetOrigin('https://example.com')).toBe('https://example.com');
    expect(normalizeWidgetOrigin('https://www.example.com')).toBe('https://www.example.com');
  });
  it('accepts an HTTPS domain with a port', () => {
    expect(normalizeWidgetOrigin('https://example.com:8443')).toBe('https://example.com:8443');
  });
  it('strips a trailing slash', () => {
    expect(normalizeWidgetOrigin('https://example.com/')).toBe('https://example.com');
  });
  it('normalizes case and default ports', () => {
    expect(normalizeWidgetOrigin('https://EXAMPLE.com:443/')).toBe('https://example.com');
  });
  it('accepts localhost over HTTP and HTTPS (dev loop convention)', () => {
    expect(normalizeWidgetOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeWidgetOrigin('https://localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeWidgetOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
  });
  it('rejects plain HTTP for external domains', () => {
    expect(normalizeWidgetOrigin('http://example.com')).toBeNull();
  });
  it('derives the origin from a website URL is NOT allowed — a path must be rejected at the origin layer', () => {
    expect(normalizeWidgetOrigin('https://example.com/services')).toBeNull();
    expect(normalizeWidgetOrigin('https://example.com/?x=1')).toBeNull();
    expect(normalizeWidgetOrigin('https://example.com/#frag')).toBeNull();
  });
  it('rejects credentials inside the URL', () => {
    expect(normalizeWidgetOrigin('https://user:password@example.com')).toBeNull();
  });
  it('rejects wildcards and never introduces "*"', () => {
    expect(normalizeWidgetOrigin('*')).toBeNull();
    expect(normalizeWidgetOrigin('https://*.example.com')).toBeNull();
  });
  it('rejects non-http(s) schemes', () => {
    expect(normalizeWidgetOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeWidgetOrigin('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(normalizeWidgetOrigin('file:///etc/passwd')).toBeNull();
    expect(normalizeWidgetOrigin('ftp://example.com')).toBeNull();
  });
  it('rejects malformed and empty values without guessing', () => {
    expect(normalizeWidgetOrigin('not a url')).toBeNull();
    expect(normalizeWidgetOrigin('example.com')).toBeNull();
    expect(normalizeWidgetOrigin('')).toBeNull();
    expect(normalizeWidgetOrigin('   ')).toBeNull();
    expect(normalizeWidgetOrigin(undefined)).toBeNull();
    expect(normalizeWidgetOrigin(null)).toBeNull();
    expect(normalizeWidgetOrigin(42)).toBeNull();
  });
});

describe('deriveOriginFromWebsite', () => {
  it('derives the origin from a full website URL deterministically', () => {
    expect(deriveOriginFromWebsite('https://tonysbarber.com/services')).toBe('https://tonysbarber.com');
    expect(deriveOriginFromWebsite('https://example.com/about?ref=ig#top')).toBe('https://example.com');
    expect(deriveOriginFromWebsite('https://shop.example.com:8443/x')).toBe('https://shop.example.com:8443');
  });
  it('rejects unsafe/malformed websites without guessing', () => {
    expect(deriveOriginFromWebsite('javascript:alert(1)')).toBeNull();
    expect(deriveOriginFromWebsite('data:text/html,x')).toBeNull();
    expect(deriveOriginFromWebsite('http://example.com/page')).toBeNull();
    expect(deriveOriginFromWebsite('https://*.example.com/x')).toBeNull();
    expect(deriveOriginFromWebsite('not a url')).toBeNull();
    expect(deriveOriginFromWebsite('')).toBeNull();
    expect(deriveOriginFromWebsite(undefined)).toBeNull();
  });
  it('still accepts plain origins (idempotent)', () => {
    expect(deriveOriginFromWebsite('https://example.com')).toBe('https://example.com');
  });
});

describe('normalizeWidgetOriginList', () => {
  it('normalizes, dedupes, and drops invalid entries, preserving order', () => {
    expect(normalizeWidgetOriginList([
      'https://owner-added.example/',
      'https://customer.example',
      'https://owner-added.example',
      'javascript:alert(1)',
      'https://customer.example'
    ])).toEqual(['https://owner-added.example', 'https://customer.example']);
  });
  it('returns an empty list for non-array input (never guesses)', () => {
    expect(normalizeWidgetOriginList(undefined)).toEqual([]);
    expect(normalizeWidgetOriginList('https://example.com')).toEqual([]);
    expect(normalizeWidgetOriginList(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Factory wiring: prospect.website -> business.allowedWidgetOrigins
// ---------------------------------------------------------------------------

const PASSING_SCENARIOS = [
  { id: 'sc-handoff', name: 'escalates', userMessage: 'hello', dimension: 'handoff', severity: 'critical', expectHandoff: true },
  { id: 'sc-nofab', name: 'no fabrication', userMessage: 'hello', dimension: 'hallucination', severity: 'critical', mustNotContain: ['zz-fabricated-claim-0001'] }
];

function fullConfig() {
  return {
    business: {
      name: 'Widget Test Cuts',
      type: 'barbershop',
      description: 'Local barbershop.',
      services: [{ name: 'Haircut', price: 20, durationMinutes: 30 }]
    },
    agent: {
      name: 'Front Desk AI',
      systemPrompt: 'You are the receptionist. Never invent facts.',
      structuredConfig: {
        personality: { tone: 'friendly', behavior: 'service', language: 'en' },
        goals: ['Answer FAQs'],
        allowedActions: ['get_business_information', 'transfer_to_human'],
        restrictedActions: ['Do not invent facts'],
        escalationRules: ['Customer asks for human'],
        bookingRules: 'name+phone required',
        orderRules: 'standard',
        refundRules: 'none',
        toolsEnabled: ['get_business_information', 'transfer_to_human']
      }
    },
    scenarios: PASSING_SCENARIOS,
    knowledge: [{ title: 'FAQ', content: 'Open 9-5.' }]
  };
}

async function runFactoryToDelivery(opts: { website?: string; existingBusinessId?: string; configOrigins?: string[] } = {}) {
  const prospect = await createProspect({
    businessName: 'Widget Test Cuts',
    ...(opts.website ? { website: opts.website } : {})
  });
  if (opts.existingBusinessId) {
    // Simulate a previously-converted prospect (businessId is set by the
    // factory on conversion, never by createProspect input).
    prospect.businessId = opts.existingBusinessId;
    await db.prospects.update(prospect);
  }
  const config = fullConfig();
  if (opts.configOrigins) (config.business as any).allowedWidgetOrigins = opts.configOrigins;
  const design = await createDesign(prospect, {
    title: 'Widget test design', problemStatement: 'P', proposedSolution: 'S', configuration: config
  } as any);
  await approveDesign(prospect, design);
  const job = await submitDesignToFactory(design.id, `key-${Date.now()}-${Math.random()}`);
  const reloaded = await getProspect(prospect.id);
  const business = await db.businesses.find(b => b.id === reloaded!.businessId);
  return { prospect: reloaded!, design, job, business: business! };
}

describe('factory derives the customer website origin', () => {
  it('creates the tenant with the normalized origin derived from prospect.website', async () => {
    const { job, business } = await runFactoryToDelivery({ website: 'https://tonysbarber.com/services' });
    expect(job.status).toBe('COMPLETED');
    expect(business.allowedWidgetOrigins).toEqual(['https://tonysbarber.com']);
  });

  it('keeps the allow-list EMPTY when the prospect has no website (never guesses)', async () => {
    const { job, business } = await runFactoryToDelivery({});
    expect(job.status).toBe('COMPLETED');
    expect(business.allowedWidgetOrigins).toEqual([]);
  });

  it('keeps the allow-list EMPTY when the website is invalid (never salvages garbage)', async () => {
    const { business } = await runFactoryToDelivery({ website: 'javascript:alert(1)' });
    expect(business.allowedWidgetOrigins).toEqual([]);
  });

  it('combines design-config origins with the derived website origin (deduped)', async () => {
    const { business } = await runFactoryToDelivery({
      website: 'https://customer.example/about',
      configOrigins: ['https://booking.example/', 'javascript:alert(1)', 'https://customer.example']
    });
    expect(business.allowedWidgetOrigins).toEqual(['https://booking.example', 'https://customer.example']);
  });

  it('MERGES into an existing business: owner-added origin preserved + factory origin appended', async () => {
    const existing = await createBusinessTenant({
      name: 'Existing Owner Co.', type: 'barbershop',
      allowedWidgetOrigins: ['https://owner-added.com']
    });
    const { business } = await runFactoryToDelivery({
      website: 'https://customer.com',
      existingBusinessId: existing.id
    });
    expect(business.id).toBe(existing.id);
    expect(business.allowedWidgetOrigins).toEqual(['https://owner-added.com', 'https://customer.com']);
  });

  it('does NOT duplicate an origin the business already has', async () => {
    const existing = await createBusinessTenant({
      name: 'Dup Co.', type: 'barbershop',
      allowedWidgetOrigins: ['https://customer.com']
    });
    const { business } = await runFactoryToDelivery({
      website: 'https://customer.com/path',
      existingBusinessId: existing.id
    });
    expect(business.allowedWidgetOrigins).toEqual(['https://customer.com']);
  });

  it('does NOT erase existing origins when the new design has no website', async () => {
    const existing = await createBusinessTenant({
      name: 'Keep Co.', type: 'barbershop',
      allowedWidgetOrigins: ['https://owner-added.com']
    });
    const { business } = await runFactoryToDelivery({ existingBusinessId: existing.id });
    expect(business.allowedWidgetOrigins).toEqual(['https://owner-added.com']);
  });

  it('idempotent re-submit returns the same job and does not duplicate origins', async () => {
    const prospect = await createProspect({ businessName: 'Widget Test Cuts', website: 'https://idem.example' });
    const design = await createDesign(prospect, {
      title: 'Widget test design', problemStatement: 'P', proposedSolution: 'S', configuration: fullConfig()
    } as any);
    await approveDesign(prospect, design);
    const j1 = await submitDesignToFactory(design.id, 'same-key');
    const j2 = await submitDesignToFactory(design.id, 'same-key');
    expect(j2.id).toBe(j1.id);
    const reloaded = await getProspect(prospect.id);
    const business = await db.businesses.find(b => b.id === reloaded!.businessId);
    expect(business!.allowedWidgetOrigins).toEqual(['https://idem.example']);
  });
});

// ---------------------------------------------------------------------------
// Widget runtime: production origin enforcement is PRESERVED
// ---------------------------------------------------------------------------

describe('widget origin enforcement (production mode)', () => {
  it('allows the allow-listed customer origin, rejects foreign and missing origins', async () => {
    const biz = await createBusinessTenant({
      name: 'Widget Co.', type: 'barbershop',
      allowedWidgetOrigins: ['https://customer.com']
    });
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const allowed = await request(app)
        .post('/api/runtime/chat')
        .set('Origin', 'https://customer.com')
        .send({ tenantId: biz.id, userMessage: 'hi' });
      expect(allowed.status).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('https://customer.com');

      const foreign = await request(app)
        .post('/api/runtime/chat')
        .set('Origin', 'https://evil.example')
        .send({ tenantId: biz.id, userMessage: 'hi' });
      expect(foreign.status).toBe(403);

      const missing = await request(app)
        .post('/api/runtime/chat')
        .send({ tenantId: biz.id, userMessage: 'hi' });
      expect(missing.status).toBe(403);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Onboarding artifact: absolute platform widget URL
// ---------------------------------------------------------------------------

describe('buildOnboardingArtifact (absolute widget URL)', () => {
  async function makeDeliveryWithOrigins(origins: string[]) {
    const business = await createBusinessTenant({
      name: 'Artifact Co.', type: 'barbershop',
      allowedWidgetOrigins: origins
    });
    const agent = await createAgentWithInitialDraft({
      businessId: business.id,
      name: 'Artifact AI',
      systemPrompt: 'You are the receptionist.',
      structuredConfig: {
        personality: { tone: 'friendly', behavior: 'service', language: 'en' },
        goals: ['Answer FAQs'],
        allowedActions: ['get_business_information'], restrictedActions: [], escalationRules: ['Escalate when unsure.'],
        bookingRules: '', orderRules: '', refundRules: '',
        toolsEnabled: ['get_business_information', 'transfer_to_human']
      },
      status: 'READY'
    });
    agent.status = 'ACTIVE';
    await db.agents.update(agent);
    const prospect = await createProspect({ businessName: 'Artifact Co.', businessId: business.id } as any);
    prospect.status = 'CONVERTED';
    await db.prospects.update(prospect);
    const delivery: any = {
      id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      prospectId: prospect.id,
      businessId: business.id,
      agentId: agent.id,
      status: 'DELIVERED',
      deliveryMethod: 'manual',
      deliveryPayload: { note: 'ready', businessId: business.id },
      deliveredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await db.deliveries.push(delivery);
    return { business, delivery };
  }

  it('emits an ABSOLUTE snippet from PLATFORM_PUBLIC_URL with the tenant id and normalized origins', async () => {
    const prev = process.env.PLATFORM_PUBLIC_URL;
    process.env.PLATFORM_PUBLIC_URL = 'https://factory-platform.example/';
    try {
      const { business, delivery } = await makeDeliveryWithOrigins(['https://customer.com/']);
      const art = await buildOnboardingArtifact(delivery.id);
      const web: any = art.channels.find((c: any) => c.type === 'web_chat');
      expect(web.embedSnippet).toBe(
        `<script src="https://factory-platform.example/widget.js" data-business-id="${business.id}"></script>`
      );
      expect(web.allowedOrigins).toEqual(['https://customer.com']);
      // deterministic: repeated assembly is equivalent
      const again = await buildOnboardingArtifact(delivery.id);
      const web2: any = again.channels.find((c: any) => c.type === 'web_chat');
      expect(web2.embedSnippet).toBe(web.embedSnippet);
      // no secrets / credentials in the snippet
      expect(web.embedSnippet).not.toMatch(/SECRET|KEY|TOKEN|password/i);
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_PUBLIC_URL;
      else process.env.PLATFORM_PUBLIC_URL = prev;
    }
  });

  it('falls back to an absolute localhost dev URL when PLATFORM_PUBLIC_URL is unset', async () => {
    delete process.env.PLATFORM_PUBLIC_URL;
    const { business, delivery } = await makeDeliveryWithOrigins([]);
    const art = await buildOnboardingArtifact(delivery.id);
    const web: any = art.channels.find((c: any) => c.type === 'web_chat');
    expect(web.embedSnippet).toMatch(new RegExp(`^<script src="http://localhost:\\d+/widget\\.js" data-business-id="${business.id}"></script>$`));
    expect(web.embedSnippet).not.toContain('src="/widget.js"');
    expect(platformPublicOrigin()).toMatch(/^http:\/\/localhost:\d+$/);
  });
});
