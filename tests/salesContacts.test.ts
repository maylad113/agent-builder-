import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Task 37 — sales contact assignment + outreach attempt ledger.
 *
 * Durable, idempotent, server-eligibility-gated assignment of prospects to
 * sales workers, a deterministic task payload, a fixed server-side cooldown,
 * and an append-only attempt ledger wired into the existing dispatcher. The
 * no-op channel remains the ONLY executor. PLATFORM_OWNER-only.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-sc-'));
process.env.DB_PATH = path.join(tmpDir, 'sc.db');
process.env.SESSION_SECRET = 'test-sc-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { createProspect, updateProspect } = await import('../src/server/orchestration/prospects');
const { createWorker, enqueueTask, runDispatcherTick, MAX_TASK_ATTEMPTS } = await import('../src/server/sales/workforce');
const {
  enqueueOutreach, getSalesContact, listContactHistory,
  assertProspectEligible, OUTREACH_COOLDOWN_MS
} = await import('../src/server/sales/contacts');
const { registerTestChannel, resetTestChannel } = await import('../src/server/sales/noopChannel');

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

beforeAll(async () => {
  await db.init({ seed: true });
  await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const WORKER_CFG = {
  role: 'DISCOVERY_RESEARCH' as const,
  objective: 'contact prospects',
  channel: 'noop' as const,
  schedule: { enabled: true, timezone: 'UTC', windows: [] as any[] },
  limits: { maxConcurrentTasks: 2, maxAttempts: 3 }
};

let seq = 0;
async function makeProspect(overrides: Record<string, unknown> = {}) {
  return createProspect({ businessName: `LedgerBiz-${Date.now()}-${seq++}`, ...overrides });
}
async function makeWorker(cfg: Record<string, unknown> = {}) {
  return createWorker({ ...WORKER_CFG, ...cfg } as any);
}
async function backdateAttempts(contactId: string, iso: string) {
  await db.client.query('UPDATE sales_attempts SET created_at = ? WHERE contact_id = ?', [iso, contactId]);
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe('prospect eligibility (server-derived)', () => {
  it('accepts a NEW eligible prospect', async () => {
    const p = await makeProspect();
    expect(assertProspectEligible(p).id).toBe(p.id);
  });

  it('rejects a REJECTED prospect', async () => {
    const p = await makeProspect();
    await updateProspect(p, { status: 'REJECTED' });
    const w = await makeWorker();
    await expect(enqueueOutreach(p.id, w.id)).rejects.toThrow(/not eligible/i);
  });

  it('rejects a CONVERTED prospect', async () => {
    const p = await makeProspect();
    await updateProspect(p, { status: 'DESIGN_PROPOSED' });
    await updateProspect(p, { status: 'APPROVED' });
    await updateProspect(p, { status: 'IN_FACTORY' });
    await updateProspect(p, { status: 'CONVERTED' });
    const w = await makeWorker();
    await expect(enqueueOutreach(p.id, w.id)).rejects.toThrow(/not eligible/i);
  });

  it('rejects a prospect linked to a customer tenant (businessId set)', async () => {
    const p = await makeProspect();
    const biz = await db.client.query('SELECT id FROM businesses LIMIT 1', []);
    await db.client.query('UPDATE prospects SET business_id = ? WHERE id = ?', [biz.rows[0].id, p.id]);
    const w = await makeWorker();
    await expect(enqueueOutreach(p.id, w.id)).rejects.toThrow(/not eligible/i);
  });

  it('rejects a prospect whose discovery result was dismissed', async () => {
    const p = await makeProspect();
    const now = new Date().toISOString();
    await db.client.query(
      `INSERT INTO discovery_runs (id, provider, status, idempotency_key, created_at, updated_at)
       VALUES (?, 'manual_list', 'COMPLETED', ?, ?, ?)`,
      ['drun-sc-1', `idem-drun-sc-1-${Date.now()}`, now, now]
    );
    await db.client.query(
      `INSERT INTO discovery_results (id, run_id, source_provider, source_type, normalized, verification, dismissed_at, created_at)
       VALUES (?, ?, 'manual_list', 'manual', '{}', 'UNVERIFIED', ?, ?)`,
      ['dr-dismissed-1', 'drun-sc-1', now, now]
    );
    await db.client.query('UPDATE prospects SET discovery_result_id = ? WHERE id = ?', ['dr-dismissed-1', p.id]);
    const w = await makeWorker();
    await expect(enqueueOutreach(p.id, w.id)).rejects.toThrow(/dismissed/i);
  });

  it('rejects a PAUSED or OFFLINE worker', async () => {
    const p = await makeProspect();
    const w = await makeWorker();
    const { transitionWorkerStatus } = await import('../src/server/sales/workforce');
    await transitionWorkerStatus(w.id, 'PAUSED');
    await expect(enqueueOutreach(p.id, w.id)).rejects.toThrow(/not eligible/i);
  });

  it('rejects unknown prospect/worker ids', async () => {
    const w = await makeWorker();
    await expect(enqueueOutreach('pro-missing', w.id)).rejects.toThrow(/not found/i);
    const p = await makeProspect();
    await expect(enqueueOutreach(p.id, 'wk-missing')).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe('assignment', () => {
  it('creates an ACTIVE contact and a linked task with a deterministic payload', async () => {
    const p = await makeProspect();
    const w = await makeWorker();
    const { contact, task, created } = await enqueueOutreach(p.id, w.id);
    expect(created).toBe(true);
    expect(contact.status).toBe('ACTIVE');
    expect(contact.prospectId).toBe(p.id);
    expect(contact.workerId).toBe(w.id);
    expect(contact.channel).toBe('noop'); // derived from the worker row
    expect(task).toBeTruthy();
    expect(task!.payload).toMatchObject({ prospectId: p.id, contactId: contact.id, channel: 'noop' });
    expect(task!.idempotencyKey).toBe(`outreach:${p.id}:noop`);
  });

  it('derives the channel from the worker (client cannot override it)', async () => {
    const p = await makeProspect();
    const w = await makeWorker();
    const res = await platformAgent
      .post(`/api/sales/prospects/${p.id}/assign`)
      .send({ workerId: w.id, channel: 'phone', eligible: true });
    expect(res.status).toBe(201);
    expect(res.body.contact.channel).toBe('noop'); // worker's channel wins
    expect(res.body.task.payload.channel).toBe('noop');
  });

  it('repeated assignment is idempotent (same contact + task, created=false)', async () => {
    const p = await makeProspect();
    const w = await makeWorker();
    const first = await enqueueOutreach(p.id, w.id);
    const second = await enqueueOutreach(p.id, w.id);
    expect(second.created).toBe(false);
    expect(second.contact.id).toBe(first.contact.id);
    expect(second.task!.id).toBe(first.task!.id);
    const contacts = (await db.salesContacts.toJSON()).filter(c => c.prospectId === p.id);
    expect(contacts.length).toBe(1);
    const tasks = (await db.salesTasks.toJSON()).filter(t => t.idempotencyKey === `outreach:${p.id}:noop`);
    expect(tasks.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrency (SQLite: connection mutex serializes the whole transaction)
// ---------------------------------------------------------------------------

describe('assignment concurrency', () => {
  it('same prospect + same worker concurrently resolves to exactly one contact/task', async () => {
    const p = await makeProspect();
    const w = await makeWorker();
    const [a, b] = await Promise.all([enqueueOutreach(p.id, w.id), enqueueOutreach(p.id, w.id)]);
    expect(a.contact.id).toBe(b.contact.id);
    expect(a.task!.id).toBe(b.task!.id);
    const contacts = (await db.salesContacts.toJSON()).filter(c => c.prospectId === p.id);
    expect(contacts.length).toBe(1);
  });

  it('same prospect + different workers (same channel) — UNIQUE(prospect,channel) allows exactly one', async () => {
    const p = await makeProspect();
    const w1 = await makeWorker();
    const w2 = await makeWorker();
    const results = await Promise.all([
      enqueueOutreach(p.id, w1.id).then(r => ({ ok: true as const, contact: r.contact })).catch(e => ({ ok: false as const, err: e })),
      enqueueOutreach(p.id, w2.id).then(r => ({ ok: true as const, contact: r.contact })).catch(e => ({ ok: false as const, err: e }))
    ]);
    const contacts = (await db.salesContacts.toJSON()).filter(c => c.prospectId === p.id && c.channel === 'noop');
    expect(contacts.length).toBe(1);
    // Both calls resolved (the loser re-read the winner), never throwing an internal error.
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect((r as any).contact.id).toBe(contacts[0].id);
    }
  });

  it('different prospects + same worker concurrently both succeed', async () => {
    const p1 = await makeProspect();
    const p2 = await makeProspect();
    const w = await makeWorker();
    const [a, b] = await Promise.all([enqueueOutreach(p1.id, w.id), enqueueOutreach(p2.id, w.id)]);
    expect(a.contact.id).not.toBe(b.contact.id);
    expect(a.created && b.created).toBe(true);
  });

  it('route-level duplicate assign returns 200 + created=false (no 500)', async () => {
    const p = await makeProspect();
    const w = await makeWorker();
    const first = await platformAgent.post(`/api/sales/prospects/${p.id}/assign`).send({ workerId: w.id });
    expect(first.status).toBe(201);
    const second = await platformAgent.post(`/api/sales/prospects/${p.id}/assign`).send({ workerId: w.id });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.contact.id).toBe(first.body.contact.id);
  });
});

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

describe('cooldown (server-side, fixed)', () => {
  it('a recent attempt blocks an immediate new attempt (409)', async () => {
    resetTestChannel('success');
    const p = await makeProspect();
    const w = await makeWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick(); // records a SUCCEEDED attempt at "now"
    await expect(enqueueOutreach(p.id, w.id)).rejects.toThrow(/cooldown/i);
    const res = await platformAgent.post(`/api/sales/prospects/${p.id}/assign`).send({ workerId: w.id });
    expect(res.status).toBe(409);
    void contact;
  });

  it('an expired cooldown permits another attempt', async () => {
    resetTestChannel('success');
    const p = await makeProspect();
    const w = await makeWorker();
    const first = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    await backdateAttempts(first.contact.id, new Date(Date.now() - OUTREACH_COOLDOWN_MS - 1000).toISOString());
    const second = await enqueueOutreach(p.id, w.id);
    expect(second.contact.id).toBe(first.contact.id);
    expect(second.created).toBe(false);
    // The contact remains ACTIVE and re-usable after the failed/completed attempt window.
  });

  it('cooldown is not client-configurable (no request parameter)', async () => {
    resetTestChannel('success');
    const p = await makeProspect();
    const w = await makeWorker();
    await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const res = await platformAgent
      .post(`/api/sales/prospects/${p.id}/assign`)
      .send({ workerId: w.id, cooldownMs: 0, bypassCooldown: true });
    expect(res.status).toBe(409); // server still enforces
  });
});

// ---------------------------------------------------------------------------
// Attempt ledger (wired into the dispatcher; no-op channel remains executor)
// ---------------------------------------------------------------------------

describe('attempt recording', () => {
  it('noop success creates a SUCCEEDED attempt and completes the contact', async () => {
    resetTestChannel('success');
    const p = await makeProspect();
    const w = await makeWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('SUCCEEDED');
    expect(attempts[0].taskId).toBe(task!.id);
    expect((await getSalesContact(contact.id))!.status).toBe('COMPLETED');
    // Historical attempts remain queryable after completion.
    expect((await listContactHistory(contact.id)).attempts.length).toBe(1);
  });

  it('retryable failure records an ERROR (retryable) attempt', async () => {
    resetTestChannel('retryable');
    const p = await makeProspect();
    const w = await makeWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('ERROR');
    expect(attempts[0].safeSummary).toBeTruthy();
  });

  it('permanent failure records a REJECTED (non-retryable) attempt (no retry)', async () => {
    resetTestChannel('permanent');
    const p = await makeProspect();
    const w = await makeWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('REJECTED');
  });

  it('each retry is a distinguishable new attempt row (history preserved)', async () => {
    resetTestChannel('retryable');
    const p = await makeProspect();
    const w = await makeWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    for (let i = 0; i < MAX_TASK_ATTEMPTS; i++) {
      await db.client.query('UPDATE sales_tasks SET available_at = ? WHERE id = ?', [new Date(0).toISOString(), task!.id]);
      await runDispatcherTick();
    }
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(MAX_TASK_ATTEMPTS);
    expect(new Set(attempts.map(a => a.id)).size).toBe(MAX_TASK_ATTEMPTS);
    expect(attempts.every(a => a.outcome === 'ERROR')).toBe(true);
    // final task state is DEAD_LETTERED by the substrate (unchanged behavior)
    const t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('DEAD_LETTERED');
  });

  it('attempt recording is idempotent per (task, attempt) — no duplicate rows', async () => {
    resetTestChannel('success');
    const p = await makeProspect();
    const w = await makeWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    const { recordAttempt } = await import('../src/server/sales/contacts');
    await recordAttempt({ taskId: task!.id, attemptNumber: 1, outcome: 'SUCCEEDED' });
    await recordAttempt({ taskId: task!.id, attemptNumber: 1, outcome: 'SUCCEEDED' }); // replay
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.filter(a => a.attemptNumber === 1).length).toBe(1);
  });

  it('non-outreach tasks (no contactId payload) record nothing', async () => {
    resetTestChannel('success');
    const w = await makeWorker();
    const t = await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: `plain-${Date.now()}` });
    await runDispatcherTick();
    const all = await db.salesAttempts.toJSON();
    expect(all.some(a => a.taskId === t.id)).toBe(false);
  });

  it('attempt rows never carry secrets', async () => {
    resetTestChannel('retryable');
    const p = await makeProspect();
    const w = await makeWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const { attempts } = await listContactHistory(contact.id);
    const blob = JSON.stringify(attempts);
    expect(blob).not.toMatch(/\bsk-[a-z0-9]{8,}|bearer\s+[a-z0-9]{10,}|api[_-]?key["']?\s*[:=]/i);
    for (const a of attempts) expect((a.safeSummary || '').length).toBeLessThanOrEqual(501);
  });
});

// ---------------------------------------------------------------------------
// Routes: auth + tenancy + validation
// ---------------------------------------------------------------------------

describe('route auth + validation', () => {
  it('unauthenticated requests are rejected (401)', async () => {
    expect((await unauthAgent.post('/api/sales/prospects/any/assign').send({ workerId: 'x' })).status).toBe(401);
    expect((await unauthAgent.get('/api/sales/contacts/any')).status).toBe(401);
    expect((await unauthAgent.get('/api/sales/contacts/any/history')).status).toBe(401);
  });

  it('BUSINESS_OWNER is rejected (403) — platform sales data stays platform-owned', async () => {
    expect((await tonyAgent.post('/api/sales/prospects/any/assign').send({ workerId: 'x' })).status).toBe(403);
    expect((await tonyAgent.get('/api/sales/contacts/any')).status).toBe(403);
    expect((await tonyAgent.get('/api/sales/contacts/any/history')).status).toBe(403);
  });

  it('PLATFORM_OWNER can read contact + history', async () => {
    resetTestChannel('success');
    const p = await makeProspect();
    const w = await makeWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    const got = await platformAgent.get(`/api/sales/contacts/${contact.id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(contact.id);
    const hist = await platformAgent.get(`/api/sales/contacts/${contact.id}/history`);
    expect(hist.status).toBe(200);
    expect(hist.body.contact.id).toBe(contact.id);
    expect(Array.isArray(hist.body.attempts)).toBe(true);
  });

  it('malformed input is rejected (400)', async () => {
    expect((await platformAgent.post('/api/sales/prospects/pro-x/assign').send({})).status).toBe(400);
    expect((await platformAgent.get('/api/sales/contacts/missing/history')).status).toBe(404);
  });

  it('route-level eligibility errors return 400 (never 500 with internals)', async () => {
    const p = await makeProspect();
    await updateProspect(p, { status: 'REJECTED' });
    const w = await makeWorker();
    const res = await platformAgent.post(`/api/sales/prospects/${p.id}/assign`).send({ workerId: w.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not eligible/i);
    expect(JSON.stringify(res.body)).not.toMatch(/sqlite|syntax|stack/i);
  });
});
