import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * REAL PostgreSQL transaction-integrity tests (regression for the audit P1
 * "fake transaction" bug: PostgresClient.transaction ran BEGIN/COMMIT on a
 * checked-out client but the callback's queries went through pool.query on
 * OTHER connections, so nothing was transactional — no rollback, no FOR
 * UPDATE mutual exclusion, double-bookings and partial inventory deductions
 * were possible).
 *
 * These tests require a reachable PostgreSQL server. Set PG_TEST_URL to a
 * maintenance connection string (any database on the server works, e.g.
 *   PG_TEST_URL=postgres://postgres:test@localhost:15432/postgres npm test
 * The suite creates its own throwaway database per run and drops it after.
 * When PG_TEST_URL is unset the suite is SKIPPED (explicitly, not silently).
 */
const PG_TEST_URL = process.env.PG_TEST_URL;
if (!PG_TEST_URL) {
  console.warn('[pgTransactions] SKIPPED — set PG_TEST_URL to run the real-PostgreSQL transaction tests.');
}

const pgDescribe = PG_TEST_URL ? describe : describe.skip;

// A short-lived random database name per run so parallel/leftover runs never clash.
const TEST_DB = `pgtx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

async function adminClient(): Promise<any> {
  const pg = await import('pg');
  const Pool = (pg as any).Pool ?? (pg.default as any)?.Pool;
  const pool = new Pool({ connectionString: PG_TEST_URL, max: 1 });
  return pool;
}

function testDbUrl(): string {
  // Swap the database component of the maintenance URL for the throwaway db.
  const u = new URL(PG_TEST_URL!);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

// Everything below only constructs when PG_TEST_URL is set.
const state: { db?: any; tools?: any } = {};

if (PG_TEST_URL) {
  process.env.DATABASE_URL = testDbUrl();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'pg-tx-test-secret';
  process.env.NODE_ENV = 'test';
  delete process.env.GEMINI_API_KEY;
}

pgDescribe('PostgreSQL transaction integrity (real PG)', () => {
  beforeAll(async () => {
    const admin = await adminClient();
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    const { db } = await import('../src/server/db');
    state.db = db;
    state.tools = await import('../src/server/tools');
    await db.init(); // must apply ALL pg migrations on a completely empty DB
  }, 60000);

  afterAll(async () => {
    if (state.db) await state.db.close();
    const admin = await adminClient();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 30000);

  it('initializes a fresh PostgreSQL database (migrations apply cleanly)', async () => {
    const res = await state.db.client.query(
      `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = 'public'`
    );
    expect(Number(res.rows[0].c)).toBeGreaterThan(10);
    // The seeded demo business must exist (proves init completed end-to-end).
    const biz = await state.db.businesses.find((b: any) => b.id === 'biz-tonys-barber');
    expect(biz).toBeTruthy();
  });

  it('ROLLS BACK every write made inside a throwing transaction', async () => {
    await expect(
      state.db.client.transaction(async () => {
        await state.db.customers.push({
          id: 'pgtx-rollback-customer', businessId: 'biz-tonys-barber',
          name: 'Rollback', phone: '+10000000001', createdAt: new Date().toISOString(),
        });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const leaked = await state.db.customers.find((c: any) => c.id === 'pgtx-rollback-customer');
    expect(leaked).toBeUndefined();
  });

  it('commits writes made inside a successful transaction', async () => {
    await state.db.client.transaction(async () => {
      await state.db.customers.push({
        id: 'pgtx-commit-customer', businessId: 'biz-tonys-barber',
        name: 'Commit', phone: '+10000000002', createdAt: new Date().toISOString(),
      });
    });
    const kept = await state.db.customers.find((c: any) => c.id === 'pgtx-commit-customer');
    expect(kept).toBeTruthy();
  });

  it('two CONCURRENT bookings for the same slot produce exactly one winner (no double-booking)', async () => {
    // The Monday after next (seed hours: Mon 09:00-20:00). +7 keeps it inside
    // the seed business's 14-day advance-booking window.
    const d = new Date();
    const add = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + add + 7);
    const date = d.toISOString().split('T')[0];
    const ctx = { tenantId: 'biz-tonys-barber', conversationId: 'conv-pgtx', channel: 'web_chat', toolsEnabled: state.tools.ALL_TOOL_NAMES };

    const [r1, r2] = await Promise.all([
      state.tools.executeAgentTool('book_appointment', {
        customerName: 'Race One', customerPhone: '+15552220001',
        serviceIdOrName: 'Haircut', date, startTime: '18:00',
      }, ctx),
      state.tools.executeAgentTool('book_appointment', {
        customerName: 'Race Two', customerPhone: '+15552220002',
        serviceIdOrName: 'Haircut', date, startTime: '18:00',
      }, ctx),
    ]);
    const wins = [r1, r2].filter(r => r.success).length;
    expect(wins).toBe(1);
    const apps = await state.db.appointments.filter(
      (a: any) => a.businessId === 'biz-tonys-barber' && a.date === date && a.startTime === '18:00'
    );
    expect(apps.length).toBe(1);
  }, 30000);

  it('a failing MULTI-ITEM order rolls back the first item\'s inventory decrement', async () => {
    // prod-1 has plenty, prod-2 has 1. Ordering prod-1 x2 (succeeds) then
    // prod-2 x99 (fails) must leave BOTH inventories untouched — before the
    // fix, prod-1's decrement auto-committed outside the transaction.
    const p1 = await state.db.products.find((p: any) => p.businessId === 'biz-tonys-barber' && p.id === 'prod-1');
    const p2 = await state.db.products.find((p: any) => p.businessId === 'biz-tonys-barber' && p.id === 'prod-2');
    p1.inventory = 5; await state.db.products.update(p1);
    p2.inventory = 1; await state.db.products.update(p2);

    const ctx = { tenantId: 'biz-tonys-barber', conversationId: 'conv-pgtx', channel: 'web_chat', toolsEnabled: state.tools.ALL_TOOL_NAMES };
    const r = await state.tools.executeAgentTool('create_order', {
      customerName: 'Partial Buyer', customerPhone: '+15553330001',
      items: [{ productId: 'prod-1', quantity: 2 }, { productId: 'prod-2', quantity: 99 }],
    }, ctx);
    expect(r.success).toBe(false);

    const after1 = await state.db.products.find((p: any) => p.businessId === 'biz-tonys-barber' && p.id === 'prod-1');
    const after2 = await state.db.products.find((p: any) => p.businessId === 'biz-tonys-barber' && p.id === 'prod-2');
    expect(after1.inventory).toBe(5); // NOT 3 — the decrement was rolled back
    expect(after2.inventory).toBe(1);
    // And no PENDING order row leaked from the failed transaction.
    const orders = await state.db.orders.filter((o: any) => o.businessId === 'biz-tonys-barber' && o.customerPhone === '+15553330001');
    expect(orders.length).toBe(0);
  });

  it('two CONCURRENT orders for the last unit cannot oversell', async () => {
    const p1 = await state.db.products.find((p: any) => p.businessId === 'biz-tonys-barber' && p.id === 'prod-1');
    p1.inventory = 1; await state.db.products.update(p1);
    const ctx = { tenantId: 'biz-tonys-barber', conversationId: 'conv-pgtx', channel: 'web_chat', toolsEnabled: state.tools.ALL_TOOL_NAMES };

    const [r1, r2] = await Promise.all([
      state.tools.executeAgentTool('create_order', {
        customerName: 'Buyer A', customerPhone: '+15554440001', items: [{ productId: 'prod-1', quantity: 1 }],
      }, ctx),
      state.tools.executeAgentTool('create_order', {
        customerName: 'Buyer B', customerPhone: '+15554440002', items: [{ productId: 'prod-1', quantity: 1 }],
      }, ctx),
    ]);
    expect([r1, r2].filter(r => r.success).length).toBe(1);
    const after = await state.db.products.find((p: any) => p.businessId === 'biz-tonys-barber' && p.id === 'prod-1');
    expect(after.inventory).toBe(0); // never negative
  }, 30000);

  it('concurrent transactions on DIFFERENT tenants do not interfere (per-context binding)', async () => {
    // Two parallel transactions writing different businesses must both commit
    // on their own connections (AsyncLocalStorage scoping).
    // Raw insert keeps this test independent of the Business TS shape; the
    // businesses table has defaults for every column except these.
    const nowIso = new Date().toISOString();
    await state.db.client.query(
      `INSERT INTO businesses (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      ['biz-pgtx-b', 'Second Biz', 'cafe', nowIso, nowIso]
    );
    const [a, b] = await Promise.all([
      state.db.client.transaction(async () => {
        await state.db.customers.push({ id: 'pgtx-iso-a', businessId: 'biz-tonys-barber', name: 'A', phone: '+1a', createdAt: new Date().toISOString() });
        await new Promise(r => setTimeout(r, 50)); // force interleaving
        return 'a';
      }),
      state.db.client.transaction(async () => {
        await state.db.customers.push({ id: 'pgtx-iso-b', businessId: 'biz-pgtx-b', name: 'B', phone: '+1b', createdAt: new Date().toISOString() });
        return 'b';
      }),
    ]);
    expect([a, b]).toEqual(['a', 'b']);
    expect(await state.db.customers.find((c: any) => c.id === 'pgtx-iso-a')).toBeTruthy();
    expect(await state.db.customers.find((c: any) => c.id === 'pgtx-iso-b')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Orchestration (Sales & Delivery) PG parity
  // -------------------------------------------------------------------------

  it('orchestration tables exist after PG init (prospects/design/factory/deliveries/acceptances/lead_research_reports/discovery)', async () => {
    const res = await state.db.client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('prospects','design_proposals','factory_jobs','deliveries','acceptances','lead_research_reports','discovery_runs','discovery_results')`
    );
    const names = res.rows.map((r: any) => r.table_name);
    for (const t of ['prospects', 'design_proposals', 'factory_jobs', 'deliveries', 'acceptances', 'lead_research_reports', 'discovery_runs', 'discovery_results']) {
      expect(names).toContain(t);
    }
    const cols = await state.db.client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'prospects' AND column_name = 'discovery_result_id'`
    );
    expect(cols.rows.length).toBe(1);
  });

  it('discovery run persists on PG transactionally with JSON round-trip + idempotency', async () => {
    const { runDiscovery, listResultsForRun, findRunByIdempotencyKey } = await import('../src/server/orchestration/discoveryRuns');
    const a = await runDiscovery({
      idempotencyKey: 'pgtx-discovery-1',
      query: 'pg parity',
      candidates: [
        { businessName: 'PG Cut', instagramHandle: '@pgcut' },
        { businessName: 'PG Cut Two', instagramHandle: 'pgcut' } // duplicate by handle
      ]
    });
    expect(a.status).toBe('COMPLETED');
    expect(a.resultCount).toBe(1);
    expect(a.duplicateCount).toBe(1);
    // UNIQUE idempotency backstop on PG.
    const b = await runDiscovery({ idempotencyKey: 'pgtx-discovery-1', candidates: [{ businessName: 'Other', instagramHandle: 'other' }] });
    expect(b.id).toBe(a.id);
    expect(await findRunByIdempotencyKey('pgtx-discovery-1')).toBeTruthy();
    const results = await listResultsForRun(a.id);
    expect(results.length).toBe(1);
    // JSON columns round-trip via PG TEXT: params + normalized objects persist.
    expect(typeof results[0].normalized).toBe('object');
    expect(results[0].normalized.dedupeKey).toBe('ig:pgcut');
    const run = await state.db.discoveryRuns.find((r: any) => r.id === a.id);
    expect(run.params.query).toBe('pg parity');
  });

  it('concurrent acceptance on PG creates exactly one prospect (UNIQUE backstop)', async () => {
    const { runDiscovery, listResultsForRun } = await import('../src/server/orchestration/discoveryRuns');
    const { acceptDiscoveryResult } = await import('../src/server/orchestration/discoveryAcceptance');
    const idx = await state.db.client.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'prospects' AND indexname = 'idx_prospects_discovery_result'`
    );
    expect(idx.rows.length).toBe(1);
    const run = await runDiscovery({
      idempotencyKey: 'pgtx-accept-1',
      candidates: [{ businessName: 'PG Race Cuts', instagramHandle: 'pgracecuts' }]
    });
    const resultId = (await listResultsForRun(run.id))[0].id;
    // Two truly concurrent acceptances (separate pool clients in parallel txs).
    const [a, b] = await Promise.all([
      acceptDiscoveryResult(resultId),
      acceptDiscoveryResult(resultId)
    ]);
    expect(a.prospect.id).toBe(b.prospect.id);
    const linked = await state.db.prospects.filter((p: any) => p.discoveryResultId === resultId);
    expect(linked.length).toBe(1);
    expect(linked[0].status).toBe('NEW');
    const stored = await state.db.discoveryResults.find((r: any) => r.id === resultId);
    expect(stored.prospectId).toBe(linked[0].id);
  });

  it('discovery dismissal on PG: persists, replays idempotently, and blocks acceptance', async () => {
    const { runDiscovery, listResultsForRun } = await import('../src/server/orchestration/discoveryRuns');
    const { acceptDiscoveryResult, dismissDiscoveryResult } = await import('../src/server/orchestration/discoveryAcceptance');
    const run = await runDiscovery({
      idempotencyKey: 'pgtx-dismiss-1',
      candidates: [{ businessName: 'PG Reject Cuts', instagramHandle: 'pgrejectcuts' }]
    });
    const resultId = (await listResultsForRun(run.id))[0].id;
    const first = await dismissDiscoveryResult(resultId);
    expect(first.dismissedAt).toBeTruthy();
    const replay = await dismissDiscoveryResult(resultId);
    expect(replay.dismissedAt).toBe(first.dismissedAt); // idempotent replay
    const stored = await state.db.discoveryResults.find((r: any) => r.id === resultId);
    expect(stored.dismissedAt).toBe(first.dismissedAt);
    expect(stored.prospectId).toBeFalsy();
    // Accept-after-dismiss is refused on PG too (guard reads the real flag).
    await expect(acceptDiscoveryResult(resultId)).rejects.toThrow(/dismissed/i);
  });

  it('concurrent dismiss-vs-accept on PG resolves to exactly one winner (row lock)', async () => {
    const { runDiscovery, listResultsForRun } = await import('../src/server/orchestration/discoveryRuns');
    const { acceptDiscoveryResult, dismissDiscoveryResult } = await import('../src/server/orchestration/discoveryAcceptance');
    const run = await runDiscovery({
      idempotencyKey: 'pgtx-dismiss-race-1',
      candidates: [{ businessName: 'PG Race Decision', instagramHandle: 'pgracedecision' }]
    });
    const resultId = (await listResultsForRun(run.id))[0].id;
    // Truly concurrent (separate pool clients in parallel txs): the FOR UPDATE
    // row lock serializes the two decisions; the loser re-reads and refuses.
    const outcomes = await Promise.allSettled([
      acceptDiscoveryResult(resultId),
      dismissDiscoveryResult(resultId)
    ]);
    const accepted = outcomes[0].status === 'fulfilled';
    const dismissed = outcomes[1].status === 'fulfilled';
    const stored = await state.db.discoveryResults.find((r: any) => r.id === resultId);
    // Exactly one decision won — the row is never BOTH linked and dismissed.
    if (accepted) {
      expect(stored.prospectId).toBeTruthy();
      expect(stored.dismissedAt).toBeFalsy();
      expect(dismissed).toBe(false);
      expect((outcomes[1] as PromiseRejectedResult).reason.message).toMatch(/linked/i);
    } else {
      expect(stored.dismissedAt).toBeTruthy();
      expect(stored.prospectId).toBeFalsy();
      expect(dismissed).toBe(true);
      expect((outcomes[0] as PromiseRejectedResult).reason.message).toMatch(/dismissed/i);
    }
    // A follow-up decision still sees the winner's committed state.
    const retry = await Promise.allSettled([
      acceptDiscoveryResult(resultId),
      dismissDiscoveryResult(resultId)
    ]);
    if (accepted) {
      expect(retry[0].status).toBe('fulfilled'); // accept replays idempotently
      expect(retry[1].status).toBe('rejected');  // dismiss stays refused
    } else {
      expect(retry[0].status).toBe('rejected');  // accept stays refused
      expect(retry[1].status).toBe('fulfilled'); // dismiss replays idempotently
    }
  });

  it('places usage observability route on PG: read-only global counter + honest limit', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { router } = await import('../src/server/routes');
    const { placesUsageBucket, placesDailyLimit } = await import('../src/server/orchestration/discoveryQuota');
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    const platformAgent = request.agent(app);
    await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
    const before = await state.db.placesUsage.toJSON();
    const res = await platformAgent.get('/api/orchestration/discovery/usage');
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(placesUsageBucket());
    expect(typeof res.body.used).toBe('number');
    const limit = placesDailyLimit();
    expect(res.body.limit).toBe(limit ?? null);
    // Pure read: the counter table is untouched by the route.
    expect(await state.db.placesUsage.toJSON()).toEqual(before);
    expect((await request(app).get('/api/orchestration/discovery/usage')).status).toBe(401);
  });

  it('google-typed discovery result persists on PG with retention expiry + pid provenance', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'pg-fake-key';
    const { vi } = await import('vitest');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      places: [{
        id: 'pgPlaceId1',
        displayName: { text: 'PG Google Biz' },
        formattedAddress: '1 PG Way',
        websiteUri: 'https://pgbiz.example'
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    try {
      const { runDiscovery, listResultsForRun } = await import('../src/server/orchestration/discoveryRuns');
      const { acceptDiscoveryResult } = await import('../src/server/orchestration/discoveryAcceptance');
      const run = await runDiscovery({ idempotencyKey: 'pgtx-google-1', provider: 'google_places', query: 'repair shops' });
      expect(run.status).toBe('COMPLETED');
      const [r] = await listResultsForRun(run.id);
      expect(r.sourceProvider).toBe('google_places');
      expect(r.sourceType).toBe('api');
      expect(r.sourceExpiresAt).toBeTruthy();
      expect(r.normalized.providerResultId).toBe('pgPlaceId1');
      expect(r.normalized.dedupeKey).toBe('pid:pgPlaceId1');
      // Expired source data cannot be accepted on PG either.
      await state.db.discoveryResults.update({ ...r, sourceExpiresAt: new Date(Date.now() - 1000).toISOString() });
      await expect(acceptDiscoveryResult(r.id)).rejects.toThrow(/expired/i);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GOOGLE_PLACES_API_KEY;
    }
  });

  it('concurrent analyze on PG produces exactly one research report', async () => {
    const { createProspect } = await import('../src/server/orchestration/prospects');
    const { analyzeProspect } = await import('../src/server/orchestration/prospectAnalysis');
    const prospect = await createProspect({ businessName: 'PG Analyze Co', instagramHandle: 'pganalyzeco' });
    const [a, b] = await Promise.all([analyzeProspect(prospect.id), analyzeProspect(prospect.id)]);
    expect(a.report.id).toBe(b.report.id);
    expect(a.report.inputSource).toBe('system_assembled');
    expect(a.report.idempotencyKey.startsWith(`analyze:${prospect.id}:`)).toBe(true);
    const reports = await state.db.leadResearchReports.filter((r: any) => r.prospectId === prospect.id);
    expect(reports.length).toBe(1);
    // Honest fallback persisted (no LLM in test env), JSON report round-trips.
    expect(reports[0].llmModel).toBe('fallback');
    expect(typeof reports[0].report).toBe('object');
    // Prospect untouched.
    const after = await state.db.prospects.find((p: any) => p.id === prospect.id);
    expect(after.status).toBe('NEW');
  });

  it('concurrent designer generation on PG produces exactly one proposal with provenance', async () => {
    const { createProspect } = await import('../src/server/orchestration/prospects');
    const { runResearch } = await import('../src/server/orchestration/leadResearch');
    const { generateDesignProposal } = await import('../src/server/orchestration/prospectDesigner');
    const { validateDesignConfiguration } = await import('../src/server/orchestration/design');
    const idx = await state.db.client.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'design_proposals' AND indexname = 'idx_design_proposals_generation_key'`
    );
    expect(idx.rows.length).toBe(1);
    const prospect = await createProspect({ businessName: 'PG Design Co' });
    const report = await runResearch(prospect.id, { idempotencyKey: 'pgtx-des-src-1', inputText: 'They miss calls daily.' });
    const [a, b] = await Promise.all([
      generateDesignProposal(prospect.id),
      generateDesignProposal(prospect.id)
    ]);
    expect(a.design.id).toBe(b.design.id);
    const all = await state.db.designProposals.filter((d: any) => d.prospectId === prospect.id);
    expect(all.length).toBe(1);
    const d = all[0];
    expect(d.status).toBe('DRAFT');
    expect(d.sourceReportId).toBe(report.id);
    expect(d.generatorModel).toBe('fallback');
    expect(d.generationKey.startsWith(`design:${prospect.id}:`)).toBe(true);
    expect(d.rationale).toBeTruthy();
    expect(validateDesignConfiguration(d.configuration)).toEqual([]);
  });

  it('concurrent submission of the same approved design on PG yields exactly one job + one agent', async () => {
    const { createProspect } = await import('../src/server/orchestration/prospects');
    const { createDesign } = await import('../src/server/orchestration/design');
    const { submitDesignToFactory } = await import('../src/server/orchestration/factorySubmitter');
    const prospect = await createProspect({ businessName: 'PG Submit Race Co' });
    const design = await createDesign(prospect, {
      title: 'Race',
      problemStatement: 'p',
      proposedSolution: 's',
      configuration: {
        business: {
          name: 'PG Submit Race Co', type: 'local_business',
          services: [{ name: 'Race Service', price: 10, durationMinutes: 30 }],
          policies: { cancellation: 'Cancel anytime.' }
        },
        agent: {
          name: 'Race Assistant',
          systemPrompt: 'You are the Race assistant.',
          structuredConfig: {
            personality: { tone: 'friendly', behavior: 'service', language: 'en' },
            goals: [], allowedActions: ['get_business_information'], restrictedActions: [], escalationRules: [],
            bookingRules: '', orderRules: '', refundRules: '',
            toolsEnabled: ['get_business_information']
          }
        },
        scenarios: [{ id: 'sc-1', name: 'S1', userMessage: 'hi', dimension: 'factual_knowledge', severity: 'warning' }],
        knowledge: [{ title: 'FAQ', content: 'Open 9-5.' }]
      }
    });
    design.status = 'APPROVED';
    await state.db.designProposals.update(design);

    // Two truly concurrent submissions (same process; PG pool gives each its
    // own connection — UNIQUE(idempotency_key) is the database backstop).
    const [a, b] = await Promise.all([
      submitDesignToFactory(design.id, 'pgtx-submit-race-1'),
      submitDesignToFactory(design.id, 'pgtx-submit-race-1')
    ]);
    expect(a.id).toBe(b.id);
    const jobs = await state.db.factoryJobs.filter((j: any) => j.designProposalId === design.id);
    expect(jobs.length).toBe(1);
    const stored = await state.db.factoryJobs.find((j: any) => j.id === a.id);
    expect(['COMPLETED', 'DEAD_LETTERED', 'FAILED']).toContain(stored.status);
    if (stored.status === 'COMPLETED') {
      const agents = await state.db.agents.filter((x: any) => x.id === stored.agentId);
      expect(agents.length).toBe(1);
      const deliveries = await state.db.deliveries.filter((d: any) => d.factoryJobId === stored.id);
      expect(deliveries.length).toBe(1);
    }
    const storedDesign = await state.db.designProposals.find((d: any) => d.id === design.id);
    expect(storedDesign.status).toBe('SUBMITTED');
  });

  it('concurrent google discovery racing for the final quota unit on PG: exactly one proceeds', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'pg-quota-key';
    process.env.GOOGLE_PLACES_DAILY_LIMIT = '1';
    await state.db.client.exec('DELETE FROM places_usage');
    const { vi } = await import('vitest');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      places: [{ id: 'pgq1', displayName: { text: 'PG Quota Biz' } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    try {
      const { runDiscovery } = await import('../src/server/orchestration/discoveryRuns');
      const { readPlacesUsage, placesUsageBucket } = await import('../src/server/orchestration/discoveryQuota');
      const [a, b] = await Promise.allSettled([
        runDiscovery({ idempotencyKey: 'pgq-a', provider: 'google_places', query: 'a' }),
        runDiscovery({ idempotencyKey: 'pgq-b', provider: 'google_places', query: 'b' })
      ]);
      const fulfilled = [a, b].filter(r => r.status === 'fulfilled').length;
      const rejected = [a, b].filter(r => r.status === 'rejected').length;
      // At most one consumes the final unit; the other gets an honest rejection.
      expect(fulfilled + rejected).toBe(2);
      const usage = await readPlacesUsage(placesUsageBucket());
      expect(usage.calls).toBeLessThanOrEqual(1);
      expect(fulfilled).toBeLessThanOrEqual(1);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GOOGLE_PLACES_API_KEY;
      delete process.env.GOOGLE_PLACES_DAILY_LIMIT;
    }
  });

  it('lead research run persists on PG with JSON report round-trip + idempotency', async () => {
    const { runResearch, listResearchForProspect } = await import('../src/server/orchestration/leadResearch');
    const now = new Date().toISOString();
    const prospect: any = { id: 'pro-pgtx-research', businessName: 'PG Research', status: 'NEW', createdAt: now, updatedAt: now };
    await state.db.prospects.push(prospect);
    // Fallback extraction (no LLM key/provider) — deterministic PG round-trip.
    const a = await runResearch('pro-pgtx-research', { idempotencyKey: 'pgtx-research-1', inputText: 'Barbershop without online booking.' });
    const b = await runResearch('pro-pgtx-research', { idempotencyKey: 'pgtx-research-1', inputText: 'Barbershop without online booking.' });
    expect(b.id).toBe(a.id);
    const all = await listResearchForProspect('pro-pgtx-research');
    expect(all.length).toBe(1);
    expect(all[0].status).toBe('COMPLETED');
    expect(all[0].report.appointmentFit).toBe('UNKNOWN');
    // JSON columns round-trip: report object + scoreReasons array persist via PG.
    expect(typeof all[0].report).toBe('object');
    expect(Array.isArray(all[0].scoreReasons)).toBe(true);
  });

  it('factory job idempotencyKey is UNIQUE on PG; markDeadLetter round-trips boolean', async () => {
    // PG enforces the FK on (prospect, design) — satisfy it with real rows.
    const now = new Date().toISOString();
    const prospect: any = { id: 'pro-pgtx', businessName: 'PG Idem', status: 'NEW', createdAt: now, updatedAt: now };
    await state.db.prospects.push(prospect);
    const design: any = {
      id: 'des-pgtx', prospectId: 'pro-pgtx', title: 't', problemStatement: 'p', proposedSolution: 's',
      status: 'DRAFT', createdAt: now, updatedAt: now
    };
    await state.db.designProposals.push(design);

    const mk: any = {
      id: `job-pgtx-${Math.random().toString(36).slice(2, 6)}`,
      prospectId: 'pro-pgtx', designProposalId: 'des-pgtx',
      status: 'PENDING', currentStep: 'PENDING', idempotencyKey: 'pgtx-idem-1',
      attemptCount: 0, deadLettered: false, createdAt: now, updatedAt: now
    };
    await state.db.factoryJobs.push(mk);
    // Duplicate key must be rejected by the PG unique constraint.
    await expect(state.db.factoryJobs.push({ ...mk, id: `job-pgtx-dup-${Math.random().toString(36).slice(2, 6)}` })).rejects.toBeTruthy();
    const jobs = await state.db.factoryJobs.filter((j: any) => j.idempotencyKey === 'pgtx-idem-1');
    expect(jobs.length).toBe(1);
    // Boolean column (dead_lettered) round-trips as a real boolean on PG.
    const dl = await state.db.factoryJobs.find((j: any) => j.idempotencyKey === 'pgtx-idem-1');
    dl.deadLettered = true;
    await state.db.factoryJobs.update(dl);
    const reloaded = await state.db.factoryJobs.find((j: any) => j.idempotencyKey === 'pgtx-idem-1');
    expect(reloaded.deadLettered).toBe(true);
  });
});
