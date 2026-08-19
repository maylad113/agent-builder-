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

  it('orchestration tables exist after PG init (prospects/design/factory/deliveries/acceptances)', async () => {
    const res = await state.db.client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('prospects','design_proposals','factory_jobs','deliveries','acceptances')`
    );
    const names = res.rows.map((r: any) => r.table_name);
    for (const t of ['prospects', 'design_proposals', 'factory_jobs', 'deliveries', 'acceptances']) {
      expect(names).toContain(t);
    }
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
