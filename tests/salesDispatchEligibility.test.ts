import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Task 46 — dispatch-time prospect lifecycle recheck.
 * The SAME authoritative eligibility used at assignment is re-verified at the
 * final boundary before the channel executes; a stale task (prospect became
 * REJECTED / CONVERTED / business-linked / dismissed-source) is TERMINALLY
 * refused — no channel call, no retry, contact never finalized.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-de-'));
process.env.DB_PATH = path.join(tmpDir, 'de.db');
process.env.SESSION_SECRET = 'test-de-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { createProspect } = await import('../src/server/orchestration/prospects');
const { runDiscovery } = await import('../src/server/orchestration/discoveryRuns');
const { dismissDiscoveryResult } = await import('../src/server/orchestration/discoveryAcceptance');
const { createBusinessTenant } = await import('../src/server/agentLifecycle');
const { createWorker, runDispatcherTick } = await import('../src/server/sales/workforce');
const { enqueueOutreach, listContactHistory } = await import('../src/server/sales/contacts');
const { ensureConversation, escalateConversation, closeConversation } = await import('../src/server/sales/conversations');
const { resetTestChannel, testChannelCalls } = await import('../src/server/sales/noopChannel');

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

const CFG: any = {
  role: 'PHONE_SALES', channel: 'noop',
  schedule: { enabled: true, timezone: 'UTC', windows: [] },
  limits: { maxConcurrentTasks: 2, maxAttempts: 3 }
};
let seq = 0;
/** Simulate a lifecycle change happening AFTER assignment (e.g. conversion via
 *  the factory pipeline) — bypasses the route-level transition guard, exactly
 *  like the real conversion path does when it links the prospect. */
async function setProspectState(id: string, patch: Record<string, unknown>) {
  const cur = await db.prospects.find(x => x.id === id);
  await db.prospects.update({ ...cur!, ...patch });
}
async function mkProspect() { return createProspect({ businessName: `DE-${Date.now()}-${seq++}` }); }
async function setup(mode: 'success' | 'timeout' | 'permanent' = 'success') {
  resetTestChannel(mode);
  const p = await createProspect({ businessName: `DE-${Date.now()}-${seq++}` });
  const w = await createWorker(CFG);
  const { contact, task } = await enqueueOutreach(p.id, w.id);
  return { p, w, contact, task: task! };
}

async function expectTerminalRefusal(taskId: string, contactId: string, callsBefore: number) {
  const t = await db.salesTasks.find(x => x.id === taskId);
  expect(t!.status).toBe('DEAD_LETTERED');
  expect(t!.lastError).toMatch(/no longer eligible/i);
  expect(testChannelCalls()).toBe(callsBefore); // channel never executed
  const contact = await db.salesContacts.find(c => c.id === contactId);
  expect(contact!.status).toBe('ACTIVE'); // NOT finalized
  const { attempts } = await listContactHistory(contactId);
  expect(attempts.length).toBe(1);
  expect(attempts[0].outcome).toBe('PERMANENT_FAILURE');
  expect(attempts[0].safeSummary).toMatch(/no longer eligible/i);
}

describe('dispatch-time eligibility recheck (stale-task window closed)', () => {
  it('1. CONVERTED after assignment → terminal refusal, no channel, contact not completed', async () => {
    const { p, contact, task } = await setup();
    await setProspectState(p.id, { status: 'CONVERTED' });
    const callsBefore = testChannelCalls();
    const tick = await runDispatcherTick();
    expect(tick.succeeded).toBe(0);
    expect(tick.failed).toBeGreaterThanOrEqual(1); // other queued tasks may share the tick
    await expectTerminalRefusal(task.id, contact.id, callsBefore);
  });

  it('2. REJECTED after assignment → terminal refusal', async () => {
    const { p, contact, task } = await setup();
    await setProspectState(p.id, { status: 'REJECTED' });
    const callsBefore = testChannelCalls();
    await runDispatcherTick();
    await expectTerminalRefusal(task.id, contact.id, callsBefore);
  });

  it('3. businessId linked after assignment → terminal refusal', async () => {
    const { p, contact, task } = await setup();
    const biz = await createBusinessTenant({ name: `DE-Biz-${Date.now()}`, type: 'retail' });
    await db.prospects.update({ ...p, businessId: biz.id });
    const callsBefore = testChannelCalls();
    await runDispatcherTick();
    await expectTerminalRefusal(task.id, contact.id, callsBefore);
  });

  it('4. discovery source dismissed after assignment → terminal refusal', async () => {
    const run = await runDiscovery({ idempotencyKey: `de-disc-${Date.now()}-${seq++}`, candidates: [{ businessName: `DE-Src-${Date.now()}` }] });
    const result = (await db.discoveryResults.filter(r => r.runId === run.id))[0];
    const p = await mkProspect();
    await db.prospects.update({ ...p, discoveryResultId: result.id });
    const pLinked = await db.prospects.find(x => x.id === p.id);
    const w = await createWorker(CFG);
    const { contact, task } = await enqueueOutreach(pLinked!.id, w.id);
    await dismissDiscoveryResult(result.id);
    const callsBefore = testChannelCalls();
    await runDispatcherTick();
    await expectTerminalRefusal(task!.id, contact.id, callsBefore);
    resetTestChannel('success'); // restore for subsequent tests
  });

  it('5. eligible prospect regression — normal channel path unchanged', async () => {
    const { contact, task } = await setup();
    const callsBefore = testChannelCalls();
    const tick = await runDispatcherTick();
    expect(tick.succeeded).toBe(1);
    expect(testChannelCalls()).toBe(callsBefore + 1);
    const t = await db.salesTasks.find(x => x.id === task.id);
    expect(t!.status).toBe('SUCCEEDED');
    const c = await db.salesContacts.find(x => x.id === contact.id);
    expect(c!.status).toBe('COMPLETED');
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts[0].outcome).toBe('CONNECTED');
  });

  it('6. human-gate regression: ineligible while BLOCKED → resolved → terminal refusal (no channel)', async () => {
    const { p, contact, task } = await setup();
    const conv = await ensureConversation(contact);
    await escalateConversation(conv.id, 'gate');
    const calls0 = testChannelCalls();
    await runDispatcherTick(); // parks
    let t = await db.salesTasks.find(x => x.id === task.id);
    expect(t!.status).toBe('BLOCKED');
    expect(t!.attemptCount).toBe(1);
    await setProspectState(p.id, { status: 'CONVERTED' }); // ineligible while parked
    await closeConversation(conv.id); // human resolves → resume
    t = await db.salesTasks.find(x => x.id === task.id);
    expect(t!.status).toBe('QUEUED'); // Task-44 resume intact
    const tick = await runDispatcherTick();
    expect(tick.succeeded).toBe(0);
    expect(testChannelCalls()).toBe(calls0); // channel NEVER executed
    t = await db.salesTasks.find(x => x.id === task.id);
    expect(t!.status).toBe('DEAD_LETTERED');
    expect(t!.attemptCount).toBe(2); // resumed claim incremented once; refusal is terminal
  });

  it('7/12. repeated ticks after terminal refusal: no re-execution, no dup task/ledger', async () => {
    const { p, contact, task } = await setup();
    await setProspectState(p.id, { status: 'REJECTED' });
    const callsBefore = testChannelCalls();
    await runDispatcherTick();
    for (let i = 0; i < 5; i++) await runDispatcherTick();
    expect(testChannelCalls()).toBe(callsBefore);
    const tasks = (await db.salesTasks.toJSON()).filter(x => x.payload?.contactId === contact.id);
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe('DEAD_LETTERED');
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
  });

  it('8. TIMEOUT/ERROR retry semantics unchanged', async () => {
    const { task } = await setup('timeout'); // task enqueued under timeout mode
    await runDispatcherTick();
    const t = await db.salesTasks.find(x => x.id === task.id);
    expect(t!.status).toBe('QUEUED'); // retryable, not terminal
    expect(t!.attemptCount).toBe(1);
    const { attempts } = await listContactHistory(task.payload!.contactId);
    expect(attempts[0].outcome).toBe('TIMEOUT');
    resetTestChannel('success');
  });

  it('9. REJECTED channel result remains a permanent provider failure', async () => {
    const { contact, task } = await setup('permanent');
    await runDispatcherTick();
    const t = await db.salesTasks.find(x => x.id === task.id);
    expect(t!.status).toBe('DEAD_LETTERED');
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts[0].outcome).toBe('REJECTED');
    resetTestChannel('success');
  });

  it('10. security: routes still role-gated; no client eligibility override', async () => {
    const un = await unauthAgent.get('/api/sales/conversations');
    expect(un.status).toBe(401);
    const bo = await tonyAgent.get('/api/sales/conversations');
    expect(bo.status).toBe(403);
    const po = await platformAgent.get('/api/sales/conversations');
    expect(po.status).toBe(200);
    // client cannot override eligibility: assign route rejects REJECTED prospect
    const { p } = await setup();
    await setProspectState(p.id, { status: 'REJECTED' });
    const w2 = await createWorker(CFG);
    const r = await platformAgent.post(`/api/sales/prospects/${p.id}/assign`).send({ workerId: w2.id });
    expect(r.status).toBe(400);
  });

  it('11. terminal refusal ledger row is NOT a channel attempt (no providerId/conversationId)', async () => {
    const { p, contact, task } = await setup();
    await setProspectState(p.id, { status: 'CONVERTED' });
    await runDispatcherTick();
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('PERMANENT_FAILURE');
    expect(attempts[0].providerId ?? null).toBeNull();
    expect(attempts[0].conversationId ?? null).toBeNull(); // refusal recorded before binding
    expect(attempts[0].attemptNumber).toBe(1); // the claim's attempt number
  });
});

// ---------------------------------------------------------------------------
// Task 52 — eligibility failure classification: deterministic ineligibility is
// permanent; transient/unexpected DB errors are retryable (never DEAD_LETTERED
// as "no longer eligible").
// ---------------------------------------------------------------------------

describe('Task 52 — eligibility error classification', () => {
  it('transient DB error in eligibility recheck -> retryable QUEUED, NOT DEAD_LETTERED, contact ACTIVE', async () => {
    const { contact, task } = await setup();
    const orig = db.prospects.find;
    (db.prospects as any).find = async () => { throw new Error('simulated transient db error'); };
    await runDispatcherTick();
    (db.prospects as any).find = orig;
    const t: any = await db.salesTasks.find((x: any) => x.id === task!.id);
    expect(t.status).toBe('QUEUED');
    expect(t.attemptCount).toBe(1);
    expect(t.lastError).toMatch(/simulated transient db error/);
    expect(t.lastError).not.toBe('Prospect no longer eligible for outreach.');
    const c: any = await db.salesContacts.find((x: any) => x.id === contact.id);
    expect(c.status).toBe('ACTIVE');
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('ERROR');
    expect(attempts[0].providerId ?? null).toBeNull();
  });

  it('transient error disappears -> next retry can execute normally (noop success)', async () => {
    resetTestChannel('success');
    const { contact, task } = await setup();
    const orig = db.prospects.find;
    (db.prospects as any).find = async () => { throw new Error('simulated transient db error'); };
    await runDispatcherTick();
    (db.prospects as any).find = orig;
    let t: any = await db.salesTasks.find((x: any) => x.id === task!.id);
    expect(t.status).toBe('QUEUED');
    t.availableAt = new Date(Date.now() - 1000).toISOString();
    await db.salesTasks.update(t);
    await runDispatcherTick();
    t = await db.salesTasks.find((x: any) => x.id === task!.id);
    expect(t.status).toBe('SUCCEEDED');
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.map((a: any) => a.outcome)).toEqual(['ERROR', 'CONNECTED']);
    expect(new Set(attempts.map((a: any) => a.providerId).filter(Boolean)).size).toBe(1); // same stable Task 50 key
  });

  it('transient error during discovery-dismissal recheck -> retryable, NOT DEAD_LETTERED', async () => {
    // link a discovery result so assertDiscoveryNotDismissed actually queries it
    const run = await runDiscovery({ idempotencyKey: `t52-disc-${Date.now()}-${seq++}`, candidates: [{ businessName: `T52-Src-${Date.now()}` }] });
    const result = (await db.discoveryResults.filter(r => r.runId === run.id))[0];
    const p = await mkProspect();
    await db.prospects.update({ ...p, discoveryResultId: result.id });
    const pLinked = await db.prospects.find(x => x.id === p.id);
    const w = await createWorker(CFG);
    const { contact, task } = await enqueueOutreach(pLinked!.id, w.id);
    const orig = db.discoveryResults.find;
    (db.discoveryResults as any).find = async () => { throw new Error('simulated transient db error'); };
    await runDispatcherTick();
    (db.discoveryResults as any).find = orig;
    const t: any = await db.salesTasks.find((x: any) => x.id === task!.id);
    expect(t.status).toBe('QUEUED');
    expect(t.lastError).toMatch(/simulated transient db error/);
    expect(t.lastError).not.toBe('Prospect no longer eligible for outreach.');
    const c: any = await db.salesContacts.find((x: any) => x.id === contact.id);
    expect(c.status).toBe('ACTIVE');
  });

  it('genuine ineligibility still DEAD_LETTERED permanently (typed error), error never retryable', async () => {
    resetTestChannel('success');
    const { contact, task } = await setup();
    await setProspectState((await db.salesContacts.find((c: any) => c.id === contact.id)).prospectId, { status: 'REJECTED' });
    const c0 = testChannelCalls();
    await runDispatcherTick();
    const t: any = await db.salesTasks.find((x: any) => x.id === task!.id);
    expect(testChannelCalls()).toBe(c0);
    expect(t.status).toBe('DEAD_LETTERED');
    expect(t.lastError).toBe('Prospect no longer eligible for outreach.');
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('PERMANENT_FAILURE');
    expect(attempts[0].providerId ?? null).toBeNull();
  });
});

