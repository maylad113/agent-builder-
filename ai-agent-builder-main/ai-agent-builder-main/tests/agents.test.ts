import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Agent subsystem hardening tests.
 *
 * Covers:
 *  - the agent lifecycle (transition rules + exactly-one-ACTIVE per business),
 *  - the generator NEVER inventing business facts (NEEDS_INPUT fallback, and
 *    robust parsing of model JSON incl. markdown fences),
 *  - hard tool-enablement enforcement in executeAgentTool (backend refuses
 *    tools the agent does not have enabled, and the LLM never claims success),
 *  - public chat privacy (no system prompt / knowledge / tool results for
 *    unauthenticated callers; debug only for authenticated, tenant-scoped
 *    sessions),
 *  - public chat serving ONLY ACTIVE agents (honest "not available" reply,
 *    simulator can run any agent via agentId + session),
 *  - the search_knowledge tool returning tenant-scoped matches only.
 *
 * The LLM is fully mocked (vi.mock('@google/genai')) so no live GEMINI_API_KEY
 * is needed: a fake key value lets the runtime construct the (mocked) client,
 * and scripted responses drive every scenario deterministically.
 */
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-agents-')), 'agents.db');
process.env.GEMINI_API_KEY = 'test-key-not-real';

vi.mock('@google/genai', () => {
  const responses: any[] = [];
  return {
    __setModelResponses: (next: any[]) => {
      responses.length = 0;
      responses.push(...next);
    },
    GoogleGenAI: class {
      models = {
        generateContent: async () => {
          const r = responses.shift();
          if (r === undefined) {
            throw new Error('No scripted model response left.');
          }
          return r;
        }
      };
    },
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY', INTEGER: 'INTEGER' }
  };
});

// The mocked module exposes a scripting helper; cast through unknown because
// the real @google/genai types don't know about it.
import * as genai from '@google/genai';
const mockGenai = genai as unknown as { __setModelResponses: (next: any[]) => void };
const setModelResponses = mockGenai.__setModelResponses.bind(mockGenai);

const { router } = await import('../src/server/routes');
const { executeAgentTool } = await import('../src/server/tools');
const { db } = await import('../src/server/db');

// The async DB layer requires an explicit init() to run migrations + seed
// the demo users the login below authenticates against. Idempotent.
await db.init();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

const app = makeApp();
const platform = request.agent(app);
const tony = request.agent(app);

const tmpDir = path.dirname(process.env.DB_PATH as string);

// Second tenant ("Bella's Bakery") for cross-tenant checks.
let bizBId = '';
let agentBId = '';
const BELLA_SECRET = 'PISTACHIO-CROISSANT-SECRET';

beforeAll(async () => {
  const pLogin = await platform.post('/api/auth/login').send({
    email: 'owner@agentfactory.io',
    password: 'Password123!'
  });
  expect(pLogin.status).toBe(200);

  const tLogin = await tony.post('/api/auth/login').send({
    email: 'tony@tonysbarber.com',
    password: 'Password123!'
  });
  expect(tLogin.status).toBe(200);

  // Bella's Bakery + READY agent + a knowledge chunk with a unique marker.
  // The business is fully configured (service, default hours, connected
  // web_chat channel, default policies) and the agent gets a PUBLISHED version
  // so it can pass the readiness gate when e2 activates it.
  const bizRes = await platform.post('/api/businesses').send({
    name: "Bella's Bakery",
    type: 'restaurant',
    description: 'Second tenant used to prove isolation.',
    location: 'Baker Street 9',
    services: [{ name: 'Cake Tasting', price: 150000, durationMinutes: 45, description: 'Sample our cakes.' }],
    faqs: []
  });
  expect(bizRes.status).toBe(201);
  bizBId = bizRes.body.id;

  const agentRes = await platform.post('/api/agents').send({
    businessId: bizBId,
    name: "Bella's AI Assistant",
    description: 'Bakery assistant'
  });
  expect(agentRes.status).toBe(201);
  agentBId = agentRes.body.id;
  await publishInitialDraft(agentBId, platform);

  const kcRes = await platform.post('/api/knowledge').send({
    businessId: bizBId,
    title: 'Bella Secret Special',
    type: 'faq',
    content: `The secret special of the day is ${BELLA_SECRET}.`,
    tags: ['secret']
  });
  expect(kcRes.status).toBe(201);
});

/** Publish the agent's initial DRAFT version (readiness requires a PUBLISHED
 * version before ACTIVE; publishing snapshots the current config). */
async function publishInitialDraft(agentId: string, requester: any) {
  const versions = await requester.get(`/api/agents/${agentId}/versions`);
  expect(versions.status).toBe(200);
  const draft = versions.body.find((v: any) => v.status === 'DRAFT');
  expect(draft).toBeTruthy();
  const pub = await requester.post(`/api/agents/${agentId}/versions/${draft.id}/publish`);
  expect(pub.status).toBe(200);
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Generator: auth required, honest fallback (NEEDS_INPUT), JSON parsing
// ---------------------------------------------------------------------------

describe('agent generator hardening', () => {
  it('b1: generate-config requires authentication (401 without session)', async () => {
    const fresh = request(makeApp());
    const res = await fresh.post('/api/agents/generate-config').send({
      name: 'X',
      type: 'barbershop',
      description: 'desc'
    });
    expect(res.status).toBe(401);
  });

  it('b2: fallback (no model output) returns NEEDS_INPUT and ZERO invented facts', async () => {
    setModelResponses([undefined]); // model returns nothing -> honest fallback
    const res = await tony.post('/api/agents/generate-config').send({
      name: 'Needs Data Shop',
      type: 'barbershop',
      description: 'A barbershop that has not provided prices or hours yet.'
    });
    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.agentName).toBe('Needs Data Shop AI Assistant');
    expect(body.systemPrompt).toBeTruthy();
    expect(Array.isArray(body.suggestedServices)).toBe(true);
    expect(Array.isArray(body.suggestedFaqs)).toBe(true);
    expect(body.suggestedServices).toHaveLength(0);
    expect(body.suggestedFaqs).toHaveLength(0);
    expect(Array.isArray(body.allowedActions)).toBe(true);
    expect(body.allowedActions).toContain('search_knowledge');

    // NEEDS_INPUT markers for everything missing.
    const fields = (body.needsInput as Array<{ field: string; label: string }>).map(n => n.field);
    expect(fields).toContain('hours');
    expect(fields).toContain('services');

    // No fabricated numeric prices or hours anywhere in the proposal.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('300000');
    expect(raw).not.toContain('200000');
    expect(raw).not.toMatch(/"price"\s*:\s*\d+/);
    expect(raw).not.toMatch(/09:00/);
    expect(raw).not.toMatch(/open during regular business hours/);
  });

  it('b3: fallback with hours/services provided reflects them and drops those NEEDS_INPUT entries', async () => {
    setModelResponses([undefined]);
    const res = await tony.post('/api/agents/generate-config').send({
      name: 'Full Data Shop',
      type: 'barbershop',
      description: 'Has full data.',
      hours: 'Mon-Sat 09:00 - 20:00',
      services: 'Haircut: 250000 toman (30 mins); Beard trim: 150000 toman (20 mins)'
    });
    expect(res.status).toBe(200);
    const body = res.body;

    const fields = (body.needsInput as Array<{ field: string; label: string }>).map(n => n.field);
    expect(fields).not.toContain('hours');
    expect(fields).not.toContain('services');

    // The provided facts appear in the proposal (they were given, not invented).
    expect(body.systemPrompt).toContain('Mon-Sat 09:00 - 20:00');
    expect(body.systemPrompt).toContain('Haircut: 250000 toman');
  });

  it('b4: markdown-fenced JSON from the model parses correctly (no crash, shape preserved)', async () => {
    const proposal = {
      agentName: 'Fancy Assistant',
      systemPrompt: 'Be helpful and never invent facts.',
      personality: { tone: 'luxury', behavior: 'service', language: 'en' },
      goals: ['Book appointments'],
      allowedActions: ['check_business_hours', 'get_business_information', 'book_appointment', 'search_knowledge'],
      restrictedActions: ['Never invent prices'],
      escalationRules: ['Customer requests human'],
      suggestedFaqs: [{ question: 'Q?', answer: 'A!' }],
      suggestedServices: [{ name: 'Cut', price: 120, durationMinutes: 30, description: 'd' }],
      needsInput: [{ field: 'policies', label: 'Cancellation policy' }]
    };
    const fenced = '```json\n' + JSON.stringify(proposal) + '\n```';

    setModelResponses([{ text: fenced }]);
    const res = await tony.post('/api/agents/generate-config').send({
      name: 'Fenced Shop',
      type: 'barbershop',
      description: 'desc',
      hours: 'Mon-Fri 10:00 - 18:00',
      services: 'Cut: 120 toman'
    });
    expect(res.status).toBe(200);
    expect(res.body.agentName).toBe('Fancy Assistant');
    expect(res.body.personality.tone).toBe('luxury');
    expect(res.body.suggestedServices).toHaveLength(1);
    expect(res.body.needsInput).toEqual([{ field: 'policies', label: 'Cancellation policy' }]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: transition rules + exactly one ACTIVE per business
// ---------------------------------------------------------------------------

describe('agent lifecycle enforcement', () => {
  async function createDraft(name: string) {
    const res = await tony.post('/api/agents').send({
      name,
      status: 'DRAFT',
      description: 'draft agent'
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    return res.body.id as string;
  }

  it('a1: invalid transitions are rejected with 400', async () => {
    // DRAFT -> ACTIVE (skips TESTING/READY)
    const draftId = await createDraft('Jump Agent');
    const jump = await tony.post(`/api/agents/${draftId}/status`).send({ status: 'ACTIVE' });
    expect(jump.status).toBe(400);
    expect(String(jump.body.error)).toContain('Invalid status transition');

    // ARCHIVED is terminal.
    const arcId = await createDraft('Archive Me');
    expect((await tony.post(`/api/agents/${arcId}/status`).send({ status: 'ARCHIVED' })).status).toBe(200);
    const resurrect = await tony.post(`/api/agents/${arcId}/status`).send({ status: 'ACTIVE' });
    expect(resurrect.status).toBe(400);

    // Status changes via PUT are refused (single authoritative endpoint).
    const put = await tony.put(`/api/agents/${draftId}`).send({ status: 'READY' });
    expect(put.status).toBe(400);
  });

  it('a2: DRAFT -> TESTING -> READY -> ACTIVE works end to end', async () => {
    const id = await createDraft('Happy Path Agent');

    expect((await tony.post(`/api/agents/${id}/status`).send({ status: 'TESTING' })).status).toBe(200);
    expect((await tony.post(`/api/agents/${id}/status`).send({ status: 'READY' })).status).toBe(200);
    // Readiness gate: a PUBLISHED version must exist before the agent can go
    // ACTIVE (production serves the frozen published config).
    await publishInitialDraft(id, tony);
    const act = await tony.post(`/api/agents/${id}/status`).send({ status: 'ACTIVE' });
    expect(act.status).toBe(200);
    expect(act.body.status).toBe('ACTIVE');
  });

  it('a3: activating an agent auto-pauses the previously ACTIVE agent (exactly one ACTIVE)', async () => {
    async function activeCount(): Promise<number> {
      const res = await tony.get('/api/agents?businessId=biz-tonys-barber');
      expect(res.status).toBe(200);
      return res.body.filter((a: any) => a.status === 'ACTIVE').length;
    }

    // Seed agent ("agent-tonys-1") was ACTIVE at startup but a2 activated
    // another agent, which auto-paused it. Create one more READY agent and
    // activate it — exactly one ACTIVE must remain and the previous ACTIVE
    // must be PAUSED.
    const created = await tony.post('/api/agents').send({
      name: 'Rotation Agent',
      description: 'ready to deploy'
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('READY');
    await publishInitialDraft(created.body.id, tony);

    const act = await tony.post(`/api/agents/${created.body.id}/status`).send({ status: 'ACTIVE' });
    expect(act.status).toBe(200);
    expect(act.body.status).toBe('ACTIVE');
    expect(await activeCount()).toBe(1);

    // The agent that was ACTIVE before is now PAUSED.
    const agents = await tony.get('/api/agents?businessId=biz-tonys-barber');
    const active = agents.body.filter((a: any) => a.status === 'ACTIVE');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(created.body.id);

    // Re-activating the seed (PAUSED -> ACTIVE) pauses the rotation agent.
    const reseed = await tony.post('/api/agents/agent-tonys-1/status').send({ status: 'ACTIVE' });
    expect(reseed.status).toBe(200);
    expect(await activeCount()).toBe(1);
    const after = await tony.get('/api/agents?businessId=biz-tonys-barber');
    const seed = after.body.find((a: any) => a.id === 'agent-tonys-1');
    expect(seed.status).toBe('ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// Tool enablement: backend refuses tools not enabled for the agent
// ---------------------------------------------------------------------------

describe('tool enablement enforcement', () => {
  let limitedAgentId = '';

  beforeAll(async () => {
    // Agent with ONLY get_business_information enabled.
    const created = await tony.post('/api/agents').send({
      name: 'Limited Agent',
      description: 'only information tool',
      structuredConfig: {
        personality: { tone: 'friendly', behavior: 'service', language: 'en' },
        goals: ['Answer questions'],
        allowedActions: ['get_business_information'],
        restrictedActions: ['Never invent facts'],
        escalationRules: ['Customer requests human'],
        bookingRules: 'Require name and phone',
        orderRules: 'Standard checkout',
        refundRules: 'Non-refundable',
        toolsEnabled: ['get_business_information']
      }
    });
    expect(created.status).toBe(201);
    limitedAgentId = created.body.id as string;

    // Publish the initial draft so the agent satisfies the readiness gate
    // (ACTIVE requires a PUBLISHED version).
    await publishInitialDraft(limitedAgentId, tony);

    const act = await tony.post(`/api/agents/${limitedAgentId}/status`).send({ status: 'ACTIVE' });
    expect(act.status).toBe(200);
  });

  it('c1: book_appointment called by the LLM is refused (not enabled) and no booking is made', async () => {
    setModelResponses([
      {
        functionCalls: [
          {
            name: 'book_appointment',
            args: {
              customerName: 'Ann',
              customerPhone: '+1 555 0100',
              serviceIdOrName: 'Haircut',
              date: '2030-06-01',
              startTime: '10:00'
            }
          }
        ]
      },
      {
        text: "I could not complete the booking because the booking tool is not available for this assistant. Please try again later."
      }
    ]);

    // Authenticated (Tony, own tenant) so debug is available for assertions.
    const res = await tony.post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber',
      userMessage: 'please book a haircut'
    });
    expect(res.status).toBe(200);
    expect(res.body.agentAvailable).toBe(true);

    // The tool was attempted but the backend refused it.
    const toolCalls = res.body.debug?.toolCalls ?? [];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe('book_appointment');
    expect(toolCalls[0].result.success).toBe(false);
    expect(String(toolCalls[0].result.error)).toContain('not enabled');

    // The final reply must NOT claim the booking succeeded.
    expect(res.body.reply).toMatch(/could not/i);
    expect(res.body.reply).not.toMatch(/booked|confirmed|successful/i);

    // No appointment was actually created (seed has exactly 2).
    const apps = await tony.get('/api/appointments?businessId=biz-tonys-barber');
    expect(apps.body).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Public chat privacy: no system prompts / knowledge / tool results
// ---------------------------------------------------------------------------

describe('public chat privacy (debug gating)', () => {
  it('d1: unauthenticated response contains NO systemPrompt, knowledge, or tool results', async () => {
    setModelResponses([{ text: 'Sure! Here is the info.' }]);
    const fresh = request(makeApp());
    const res = await fresh.post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber',
      userMessage: 'what do you offer?'
    });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Sure! Here is the info.');

    // Debug is entirely absent for public callers (no debug key at all).
    expect(res.body.debug).toBeUndefined();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('systemPrompt');
    expect(raw).not.toContain('retrievedKnowledge');
    expect(raw).not.toContain('toolCalls');
    expect(raw).not.toContain('BUSINESS CONTEXT');
    expect(raw).not.toContain("Tony's Barber Shop");
  });

  it('d2: authenticated tenant-scoped caller receives debug (simulator use case)', async () => {
    setModelResponses([{ text: 'Sure! Here is the info.' }]);
    const res = await tony.post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber',
      userMessage: 'what do you offer?'
    });
    expect(res.status).toBe(200);
    expect(res.body.debug).toBeTruthy();
    expect(typeof res.body.debug.systemPrompt).toBe('string');
    expect(res.body.debug.systemPrompt).toContain('BUSINESS CONTEXT');
    expect(Array.isArray(res.body.debug.retrievedKnowledge)).toBe(true);
    expect(Array.isArray(res.body.debug.toolCalls)).toBe(true);
  });

  it('d3: agentId (simulator) requires an authenticated session; works for non-ACTIVE agents with one', async () => {
    // Create a DRAFT agent for Tony.
    const created = await tony.post('/api/agents').send({
      name: 'Draft Sim Target',
      status: 'DRAFT',
      description: 'for simulator'
    });
    expect(created.status).toBe(201);
    const draftAgentId = created.body.id as string;

    // Unauthenticated -> 401.
    const fresh = request(makeApp());
    const unauth = await fresh.post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber',
      agentId: draftAgentId,
      userMessage: 'hi'
    });
    expect(unauth.status).toBe(401);

    // Authenticated Tony simulating his own DRAFT agent -> works + debug.
    setModelResponses([{ text: 'Draft agent says hi!' }]);
    const ok = await tony.post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber',
      agentId: draftAgentId,
      userMessage: 'hi'
    });
    expect(ok.status).toBe(200);
    expect(ok.body.reply).toBe('Draft agent says hi!');
    expect(ok.body.debug).toBeTruthy();

    // A foreign tenant's agent cannot be simulated (403).
    const evil = await tony.post('/api/runtime/chat').send({
      tenantId: bizBId,
      agentId: agentBId,
      userMessage: 'hi'
    });
    expect(evil.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Public chat serves ONLY ACTIVE agents
// ---------------------------------------------------------------------------

describe('public chat uses only ACTIVE agents', () => {
  it('e1: business with only a READY agent -> honest "not available", no fake answer', async () => {
    const fresh = request(makeApp());
    const res = await fresh.post('/api/runtime/chat').send({
      tenantId: bizBId,
      userMessage: 'hello?'
    });
    expect(res.status).toBe(200);
    expect(res.body.agentAvailable).toBe(false);
    expect(res.body.reply).toContain('not available');
    expect(res.body.debug).toBeUndefined();
    // It still records a conversation (honest audit trail).
    expect(res.body.conversationId).toBeTruthy();
  });

  it('e2: after activation the same business serves customers normally', async () => {
    const act = await platform.post(`/api/agents/${agentBId}/status`).send({ status: 'ACTIVE' });
    expect(act.status).toBe(200);
    expect(act.body.status).toBe('ACTIVE');

    setModelResponses([{ text: 'Hello! How can I help you today?' }]);
    const fresh = request(makeApp());
    const res = await fresh.post('/api/runtime/chat').send({
      tenantId: bizBId,
      userMessage: 'hello?'
    });
    expect(res.status).toBe(200);
    expect(res.body.agentAvailable).toBe(true);
    expect(res.body.reply).toBe('Hello! How can I help you today?');
    expect(res.body.debug).toBeUndefined(); // still public
  });
});

// ---------------------------------------------------------------------------
// search_knowledge: tenant-scoped structured matches
// ---------------------------------------------------------------------------

describe('search_knowledge tool', () => {
  it('f1: returns tenant-scoped matches only (nothing from another tenant)', async () => {
    // Tony's tenant: "pomade" hits the Grooming Products chunk.
    const hit = await executeAgentTool('search_knowledge', { query: 'pomade' }, {
      tenantId: 'biz-tonys-barber',
      toolsEnabled: ['search_knowledge']
    });
    expect(hit.success).toBe(true);
    const data = hit.data as any;
    expect(data.count).toBeGreaterThan(0);
    const titles = data.matches.map((m: any) => m.title);
    expect(titles).toContain('Grooming Products');
    expect(data.matches[0].snippet).toContain('Matte Clay Pomade');

    // Bella's secret is NOT reachable from Tony's tenant.
    const secret = await executeAgentTool('search_knowledge', { query: 'PISTACHIO' }, {
      tenantId: 'biz-tonys-barber',
      toolsEnabled: ['search_knowledge']
    });
    expect(secret.success).toBe(true);
    expect((secret.data as any).count).toBe(0);

    // And Bella's own tenant CAN find it.
    const bella = await executeAgentTool('search_knowledge', { query: BELLA_SECRET }, {
      tenantId: bizBId,
      toolsEnabled: ['search_knowledge']
    });
    expect(bella.success).toBe(true);
    expect((bella.data as any).count).toBe(1);
    expect((bella.data as any).matches[0].title).toBe('Bella Secret Special');

    // A disabled tool is refused even with a valid query.
    const refused = await executeAgentTool('search_knowledge', { query: 'pomade' }, {
      tenantId: 'biz-tonys-barber',
      toolsEnabled: ['get_business_information']
    });
    expect(refused.success).toBe(false);
    expect(String(refused.error)).toContain('not enabled');
  });

  it('f2: end-to-end — LLM calls search_knowledge and receives structured results', async () => {
    // Re-activate the seed agent (has search_knowledge enabled).
    const reseed = await tony.post('/api/agents/agent-tonys-1/status').send({ status: 'ACTIVE' });
    expect(reseed.status).toBe(200);

    setModelResponses([
      { functionCalls: [{ name: 'search_knowledge', args: { query: 'beard oil' } }] },
      { text: 'We have Organic Cedarwood Beard Oil in stock.' }
    ]);

    const res = await tony.post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber',
      userMessage: 'do you sell beard oil?'
    });
    expect(res.status).toBe(200);
    const calls = res.body.debug?.toolCalls ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('search_knowledge');
    expect(calls[0].result.success).toBe(true);
    const matches = calls[0].result.data.matches as Array<{ title: string; tags: string[] }>;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].title).toBe('Grooming Products');
    expect(res.body.reply).toBe('We have Organic Cedarwood Beard Oil in stock.');
  });
});
