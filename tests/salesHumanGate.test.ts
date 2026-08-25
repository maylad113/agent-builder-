import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Task 44 — human-gate task lifecycle: park, don't burn.
 * A NEEDS_HUMAN conversation PARKS the outreach task (BLOCKED) without
 * consuming attempts; conversation resolution resumes the SAME task; normal
 * provider/channel failure semantics are unchanged.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-hg-'));
process.env.DB_PATH = path.join(tmpDir, 'hg.db');
process.env.SESSION_SECRET = 'test-hg-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { db } = await import('../src/server/db');
const { createProspect } = await import('../src/server/orchestration/prospects');
const {
  createWorker, runDispatcherTick, enqueueTask, claimNextTask, reapStaleTasks, blockTaskForHuman
} = await import('../src/server/sales/workforce');
const { enqueueOutreach, listContactHistory } = await import('../src/server/sales/contacts');
const { ensureConversation, escalateConversation, closeConversation, getConversation } = await import('../src/server/sales/conversations');
const { resetTestChannel, testChannelCalls } = await import('../src/server/sales/noopChannel');
const { listTelemetryEvents } = await import('../src/server/telemetry');

beforeAll(async () => { await db.init({ seed: false }); });
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const CFG: any = {
  role: 'PHONE_SALES', channel: 'noop',
  schedule: { enabled: true, timezone: 'UTC', windows: [] },
  limits: { maxConcurrentTasks: 2, maxAttempts: 3 }
};
let seq = 0;
async function mkProspect() { return createProspect({ businessName: `HG-${Date.now()}-${seq++}` }); }
async function mkWorker(cfg: Record<string, unknown> = {}) { return createWorker({ ...CFG, ...cfg } as any); }
/** Assign, bind the conversation, escalate it — BEFORE the first dispatch. */
async function gatedSetup() {
  resetTestChannel('success');
  const p = await mkProspect();
  const w = await mkWorker();
  const { contact, task } = await enqueueOutreach(p.id, w.id);
  const conv = await ensureConversation(contact);
  await escalateConversation(conv.id, 'gate for test');
  return { p, w, contact, task: task!, conv };
}

describe('A/B: park, never burn', () => {
  it('gate parks the task without consuming an attempt or executing the channel', async () => {
    const { task, conv } = await gatedSetup();
    const callsBefore = testChannelCalls();
    const tick = await runDispatcherTick();
    expect(testChannelCalls()).toBe(callsBefore); // channel never executed
    expect(tick.succeeded).toBe(0);
    expect(tick.failed).toBe(0);
    const t = await db.salesTasks.find(x => x.id === task.id);
    expect(t!.status).toBe('BLOCKED');
    expect(t!.attemptCount).toBe(1); // claim incremented; the GATE did not
    expect(t!.lastError).toContain('human review');
    expect((await getConversation(conv.id))!.status).toBe('NEEDS_HUMAN');
  });

  it('repeated ticks leave the parked task untouched (no burn, no backoff, no dead-letter)', async () => {
    const { task } = await gatedSetup();
    await runDispatcherTick();
    const callsBefore = testChannelCalls();
    for (let i = 0; i < 5; i++) await runDispatcherTick();
    expect(testChannelCalls()).toBe(callsBefore);
    const t = await db.salesTasks.find(x => x.id === task.id);
    expect(t!.status).toBe('BLOCKED');
    expect(t!.attemptCount).toBe(1);
    expect(t!.status).not.toBe('DEAD_LETTERED');
    // no retry backoff was applied (availableAt unchanged from enqueue)
    expect(t!.availableAt).toBe(task.availableAt);
  });
});

describe('C/D/E: resolution resumes the SAME task and it executes normally', () => {
  it('resume preserves identity and the resumed task executes with normal semantics', async () => {
    const { contact, task, conv } = await gatedSetup();
    await runDispatcherTick(); // parked (attemptCount 1)
    const callsBefore = testChannelCalls();
    const closed = await closeConversation(conv.id);
    expect(closed.status).toBe('CLOSED');
    // SAME task resumed, identity fully preserved
    const resumed = await db.salesTasks.find(x => x.id === task.id);
    expect(resumed!.status).toBe('QUEUED');
    expect(resumed!.id).toBe(task.id);
    expect(resumed!.payload).toEqual(task.payload);
    expect(resumed!.idempotencyKey).toBe(task.idempotencyKey);
    expect(resumed!.attemptCount).toBe(1); // unchanged by park/resume
    expect(resumed!.lastError).toBeFalsy();
    // dispatch again — normal execution path resumes
    const tick = await runDispatcherTick();
    expect(tick.succeeded).toBe(1);
    expect(testChannelCalls()).toBe(callsBefore + 1); // channel ran exactly once
    const done = await db.salesTasks.find(x => x.id === task.id);
    expect(done!.status).toBe('SUCCEEDED');
    expect(done!.attemptCount).toBe(2); // real channel execution increments once
    const after = await db.salesContacts.find(c => c.id === contact.id);
    expect(after!.status).toBe('COMPLETED'); // normal contact finalization
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1); // exactly one REAL attempt (the gate wrote none)
    expect(attempts[0].outcome).toBe('CONNECTED');
  });

  it('human gate records NO attempt ledger row and no provider failure', async () => {
    const { contact } = await gatedSetup();
    await runDispatcherTick(); // parked
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(0); // channel never executed → no attempt row
  });
});

describe('F/G: genuine failures unchanged', () => {
  it('TIMEOUT/ERROR still consume retries, backoff, and dead-letter at the cap', async () => {
    resetTestChannel('timeout');
    const p = await mkProspect();
    const w = await mkWorker();
    const { task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('QUEUED'); // retryable
    expect(t!.attemptCount).toBe(1);
    expect(new Date(t!.availableAt).getTime()).toBeGreaterThan(Date.now()); // backoff applied
    // exhaust to the cap
    resetTestChannel('timeout');
    await new Promise(r => setTimeout(r, 1100));
    await runDispatcherTick();
    await new Promise(r => setTimeout(r, 4100));
    await runDispatcherTick();
    const dead = await db.salesTasks.find(x => x.id === task!.id);
    expect(dead!.status).toBe('DEAD_LETTERED');
    expect(dead!.attemptCount).toBe(3);
  }, 15000);

  it('REJECTED remains a permanent failure', async () => {
    resetTestChannel('permanent');
    const p = await mkProspect();
    const w = await mkWorker();
    const { task } = await enqueueOutreach(p.id, w.id);
    const tick = await runDispatcherTick();
    expect(tick.failed).toBe(1);
    const t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('DEAD_LETTERED');
    expect(t!.attemptCount).toBe(1);
    const { attempts } = await listContactHistory((await db.salesContacts.toJSON()).find(c => c.id === task!.payload!.contactId)!.id);
    expect(attempts[0].outcome).toBe('REJECTED');
  });
});

describe('H/I: stale reaper and concurrency ignore BLOCKED', () => {
  it('stale reaper recovers RUNNING but never touches BLOCKED', async () => {
    const { contact, task } = await gatedSetup();
    await runDispatcherTick(); // parked
    const parked = await db.salesTasks.find(x => x.id === task.id);
    expect(parked!.status).toBe('BLOCKED');
    // age a genuinely RUNNING task into staleness
    const w2 = await mkWorker();
    const other = await enqueueTask({ workerId: w2.id, type: 'noop-other', payload: {}, idempotencyKey: `hg-${Date.now()}-a` });
    const claimed = await claimNextTask(w2.id);
    await db.salesTasks.update({ ...claimed!, claimedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    const recovered = await reapStaleTasks();
    expect(recovered).toBe(1);
    const stillParked = await db.salesTasks.find(x => x.id === task.id);
    expect(stillParked!.status).toBe('BLOCKED');
    expect(stillParked!.attemptCount).toBe(1);
  });

  it('BLOCKED does not count toward worker concurrency', async () => {
    const w = await mkWorker({ limits: { maxConcurrentTasks: 1, maxAttempts: 3 } });
    const p = await mkProspect();
    const { contact } = await enqueueOutreach(p.id, w.id);
    const conv = await ensureConversation(contact);
    await escalateConversation(conv.id, 'gate');
    const t1 = await claimNextTask(w.id);
    expect(t1).not.toBeNull();
    await blockTaskForHuman(t1!.id, 'Conversation requires human review; automated outreach is blocked.');
    // budget is 1; if BLOCKED counted as RUNNING this claim would return null
    const t2 = await enqueueTask({ workerId: w.id, type: 'noop-other', payload: {}, idempotencyKey: `hg-${Date.now()}-b` });
    const claimed2 = await claimNextTask(w.id);
    expect(claimed2).not.toBeNull();
    expect(claimed2!.id).toBe(t2.id);
  });
});

describe('J: idempotent resolution', () => {
  it('double close does not duplicate tasks, resumes, or conversations', async () => {
    const { contact, task, conv } = await gatedSetup();
    await runDispatcherTick(); // parked
    await closeConversation(conv.id);
    await closeConversation(conv.id);
    await closeConversation(conv.id);
    const tasks = (await db.salesTasks.toJSON()).filter(t => t.payload?.contactId === contact.id);
    expect(tasks.length).toBe(1); // only the original task exists
    expect(tasks[0].id).toBe(task.id);
    expect(tasks[0].status).toBe('QUEUED');
    const convs = await db.salesConversations.filter(c => c.contactId === contact.id);
    expect(convs.length).toBe(1);
    await runDispatcherTick();
    const done = await db.salesTasks.find(x => x.id === task.id);
    expect(done!.status).toBe('SUCCEEDED'); // resumed task executes exactly once
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
  });

  it('resume does not affect unrelated parked tasks', async () => {
    const g1 = await gatedSetup();
    const g2 = await gatedSetup();
    await runDispatcherTick(); // both parked
    await closeConversation(g1.conv.id);
    const t1 = await db.salesTasks.find(x => x.id === g1.task.id);
    const t2 = await db.salesTasks.find(x => x.id === g2.task.id);
    expect(t1!.status).toBe('QUEUED');
    expect(t2!.status).toBe('BLOCKED'); // unrelated task untouched
  });
});

describe('telemetry + race ordering', () => {
  it('SALES_TASK_PARKED and SALES_TASK_RESUMED recorded with safe summaries', async () => {
    const { contact, task, conv } = await gatedSetup();
    await runDispatcherTick();
    await closeConversation(conv.id);
    const events = await listTelemetryEvents({ businessId: 'platform', limit: 200 });
    const parked = events.find(e => e.eventType === 'SALES_TASK_PARKED' && (e as any).metadata?.jobId === task.id);
    const resumed = events.find(e => e.eventType === 'SALES_TASK_RESUMED' && (e as any).metadata?.jobId === task.id);
    expect(parked).toBeDefined();
    expect(resumed).toBeDefined();
    expect(JSON.stringify([parked, resumed])).not.toContain('gate for test');
  });

  it('conversation resolved before the task runs → task is NOT parked, executes normally', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    const conv = await ensureConversation(contact);
    await escalateConversation(conv.id, 'gate');
    await closeConversation(conv.id); // human resolves BEFORE the task runs
    // The gate is resolved → no parking; normal execution proceeds.
    await runDispatcherTick();
    const t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('SUCCEEDED');
    expect(t!.attemptCount).toBe(1);
  });

  it('directly-closed conversation (never escalated) still refuses automation', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    const conv = await ensureConversation(contact);
    await closeConversation(conv.id); // direct close — no escalation
    await runDispatcherTick();
    const t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).not.toBe('BLOCKED'); // never parks a closed conversation
    expect(t!.status).toBe('QUEUED'); // refused via the existing retryable failure path
    expect(t!.lastError).toMatch(/closed/);
  });
});
