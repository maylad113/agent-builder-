import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Task 38 — structured channel result envelope + attempt-scoped idempotency.
 * Proves the safe seam future real providers plug into; noop only.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-env-'));
process.env.DB_PATH = path.join(tmpDir, 'env.db');
process.env.SESSION_SECRET = 'test-env-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { db } = await import('../src/server/db');
const { createProspect } = await import('../src/server/orchestration/prospects');
const { createWorker, enqueueTask, claimNextTask, runDispatcherTick } = await import('../src/server/sales/workforce');
const { executeChannelTask, executeChannelDispatch, isChannelImplemented, resetTestChannel, testChannelCalls } = await import('../src/server/sales/noopChannel');
import type { ChannelDispatch } from '../src/server/sales/noopChannel';
const { enqueueOutreach, listContactHistory, assertOutreachPayload, recordAttempt } = await import('../src/server/sales/contacts');

const WORKER_CFG = {
  role: 'DISCOVERY_RESEARCH' as const,
  objective: 'channels',
  channel: 'noop' as const,
  schedule: { enabled: true, timezone: 'UTC', windows: [] as any[] },
  limits: { maxConcurrentTasks: 2, maxAttempts: 3 }
};

let seq = 0;
async function mkProspect() { return createProspect({ businessName: `Env-${Date.now()}-${seq++}` }); }
async function mkWorker(cfg: Record<string, unknown> = {}) { return createWorker({ ...WORKER_CFG, ...cfg } as any); }

beforeAll(async () => { await db.init({ seed: false }); });
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('structured channel envelope (noop)', () => {
  it('DELIVERED/CONNECTED success', async () => {
    resetTestChannel('success');
    const w = await mkWorker();
    const r = await executeChannelTask(w, {} as any, { attemptKey: 'wtask-1:2' });
    expect(r.success).toBe(true);
    expect(r.outcome).toBe('CONNECTED');
    expect(r.retryable).toBe(false);
    expect(r.attemptKey).toBe('wtask-1:2');
    expect(r.providerId).toBe('noop-provider-wtask-1:2');
  });

  it('REJECTED is permanent (retryable=false)', async () => {
    resetTestChannel('permanent');
    const r = await executeChannelTask(await mkWorker(), {} as any, { attemptKey: 'k' });
    expect(r.success).toBe(false);
    expect(r.outcome).toBe('REJECTED');
    expect(r.retryable).toBe(false);
  });

  it('TIMEOUT is retryable failure (ambiguous accept is never a success)', async () => {
    resetTestChannel('timeout');
    const r = await executeChannelTask(await mkWorker(), {} as any, { attemptKey: 'k' });
    expect(r.success).toBe(false); // ambiguous acceptance must NOT count as success
    expect(r.outcome).toBe('TIMEOUT');
    expect(r.retryable).toBe(true);
  });

  it('ERROR classification (retryable)', async () => {
    resetTestChannel('retryable');
    const r = await executeChannelTask(await mkWorker(), {} as any, { attemptKey: 'k' });
    expect(r.success).toBe(false);
    expect(r.outcome).toBe('ERROR');
    expect(r.retryable).toBe(true);
  });

  it('key derivation is exactly taskId:attemptNumber', async () => {
    resetTestChannel('success');
    const w = await mkWorker();
    const t = await enqueueTask({ workerId: w.id, type: 'x', payload: {}, idempotencyKey: `t-${Date.now()}` });
    const claimed = await claimNextTask(w.id);
    expect(claimed).not.toBeNull();
    const dispatch: ChannelDispatch = { attemptKey: `${claimed!.id}:${claimed!.attemptCount}`, payload: {} };
    const r = await executeChannelTask(w, {} as any, dispatch);
    expect(r.attemptKey).toBe(`${claimed!.id}:${claimed!.attemptCount}`);
  });

  it('attemptKey cannot be overridden by payload fields', async () => {
    resetTestChannel('success');
    const w = await mkWorker();
    const r = await executeChannelTask(w, {} as any, { attemptKey: 'server-key:9', payload: { attemptKey: 'hacked', anything: 'x' } });
    expect(r.attemptKey).toBe('server-key:9');
  });
});

describe('attempt persistence with envelope', () => {
  it('providerId + conversationId persisted', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].providerId).toBeTruthy();
    expect(attempts[0].providerId).toBe(`noop-provider-${task!.id}`); // stable logical-task key (Task 50)
  });

  it('legacy rows with null providerId/conversationId remain readable', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await recordAttempt({ taskId: task!.id, attemptNumber: 1, outcome: 'SUCCEEDED' }); // no provider/conversation ids
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts[attempts.length - 1].providerId == null).toBe(true);
    expect(attempts[attempts.length - 1].conversationId == null).toBe(true);
  });

  it('malformed outreach payloads rejected pre-dispatch', () => {
    expect(() => assertOutreachPayload(undefined)).toThrow();
    expect(() => assertOutreachPayload({})).toThrow();
    expect(() => assertOutreachPayload({ prospectId: 'p', contactId: 'c' })).toThrow();
    expect(() => assertOutreachPayload({ prospectId: 'p', contactId: 'c', channel: 'noop' })).not.toThrow();
    expect(() => assertOutreachPayload({ prospectId: '', contactId: 'c', channel: 'noop' })).toThrow();
  });
});

describe('dispatcher TIMEOUT semantics (end-to-end)', () => {
  it('TIMEOUT → task retried, ledger TIMEOUT (never SUCCEEDED), contact stays ACTIVE', async () => {
    resetTestChannel('timeout');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    const t1 = await runDispatcherTick();
    // claimed counts every claim in the tick (TIMEOUT requeues; backoff 0ms in test env)
    expect(t1.succeeded).toBe(0);
    expect(t1.failed).toBeGreaterThanOrEqual(1);
    // task retried (still QUEUED; attempts remain)
    const t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('QUEUED');
    expect(t!.attemptCount).toBe(1);
    // ledger records the structured outcome — never SUCCEEDED
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('TIMEOUT');
    expect(attempts[0].outcome).not.toBe('SUCCEEDED');
    // contact NOT finalized
    expect(contact.status).toBe('ACTIVE');
    const after = await db.salesContacts.find(c => c.id === contact.id);
    expect(after!.status).toBe('ACTIVE');
  });

  it('REJECTED → permanent DEAD_LETTERED, ledger REJECTED', async () => {
    resetTestChannel('permanent');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    const t = await runDispatcherTick();
    expect(t).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts[0].outcome).toBe('REJECTED');
  });

  it('ERROR → retryable requeue while attempts remain', async () => {
    resetTestChannel('retryable');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('QUEUED');
    expect((await listContactHistory(contact.id)).attempts[0].outcome).toBe('ERROR');
  });

  it('CONNECTED → successful task + ledger + contact completion', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    const t = await runDispatcherTick();
    expect(t).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect((await db.salesTasks.find(x => x.id === task!.id))!.status).toBe('SUCCEEDED');
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts[0].outcome).toBe('CONNECTED');
    expect((await db.salesContacts.find(c => c.id === contact.id))!.status).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------------------
// Task 48 — channel-gated dispatch: refuse unimplemented real channels.
// Proves phone / instagram_dm / unknown NEVER reach the noop executor and
// never fabricate success, while the noop channel is untouched.
// ---------------------------------------------------------------------------

describe('Task 48 — channel gate (refuse unimplemented channels)', () => {
  async function mkChannelWorker(channel: 'noop' | 'phone' | 'instagram_dm') {
    return createWorker({
      role: 'PHONE_SALES', channel,
      schedule: { enabled: true, timezone: 'UTC', windows: [] },
      limits: { maxConcurrentTasks: 2, maxAttempts: 3 }
    } as any);
  }

  it('gate boundary: noop executes the noop executor; phone/instagram_dm refuse without calling it', async () => {
    resetTestChannel('success');
    const dispatch = { attemptKey: 'gate:1', payload: {} };
    const noopW = await mkChannelWorker('noop');
    const c0 = testChannelCalls();
    const ok = await executeChannelDispatch(noopW, {} as any, dispatch);
    expect(ok.outcome).toBe('CONNECTED');
    expect(testChannelCalls()).toBe(c0 + 1); // noop executor invoked

    for (const ch of ['phone', 'instagram_dm'] as const) {
      const w = await mkChannelWorker(ch);
      const cN = testChannelCalls();
      const r = await executeChannelDispatch(w, {} as any, dispatch);
      expect(testChannelCalls()).toBe(cN); // noop executor NOT invoked
      expect(r.outcome).toBe('REJECTED');
      expect(r.success).toBe(false);
      expect(r.retryable).toBe(false); // permanent
      expect(r.providerId == null).toBe(true);
      expect(r.conversationId == null).toBe(true);
      expect(r.error).toBe('Channel not implemented.');
      expect(r.error).not.toMatch(/phone|instagram|prospect|noop-provider/i); // bounded, no leak
    }
  });

  it('isChannelImplemented: only noop; unknown/unsupported labels are refused', () => {
    expect(isChannelImplemented('noop')).toBe(true);
    expect(isChannelImplemented('phone')).toBe(false);
    expect(isChannelImplemented('instagram_dm')).toBe(false);
    expect(isChannelImplemented('carrier_pigeon')).toBe(false); // unknown -> never falls through to noop
    expect(isChannelImplemented(undefined)).toBe(false);
    expect(isChannelImplemented(123)).toBe(false);
  });

  it('unknown/unsupported channel label refuses (never silently uses noop)', async () => {
    resetTestChannel('success');
    const w = await mkChannelWorker('noop');
    const forged: any = { ...w, channel: 'carrier_pigeon' }; // bypasses TS + route enum
    const c0 = testChannelCalls();
    const r = await executeChannelDispatch(forged, {} as any, { attemptKey: 'gate:2', payload: {} });
    expect(testChannelCalls()).toBe(c0);
    expect(r.outcome).toBe('REJECTED');
    expect(r.retryable).toBe(false);
  });

  for (const channel of ['phone', 'instagram_dm'] as const) {
    it(`${channel}: dispatch -> DEAD_LETTERED, no noop call, no success ledger, contact ACTIVE`, async () => {
      resetTestChannel('success');
      const p = await mkProspect();
      const w = await mkChannelWorker(channel);
      const { contact, task } = await enqueueOutreach(p.id, w.id);
      const c0 = testChannelCalls();
      const tick = await runDispatcherTick();
      expect(testChannelCalls()).toBe(c0); // noop executor NEVER reached
      expect(tick.succeeded).toBe(0);
      const t = await db.salesTasks.find(x => x.id === task!.id);
      expect(t!.status).toBe('DEAD_LETTERED');
      expect(t!.attemptCount).toBe(1); // single claim; refusal is permanent (no retry consumption)
      expect(t!.lastError).toBe('Channel not implemented.');
      const c = await db.salesContacts.find(x => x.id === contact.id);
      expect(c!.status).toBe('ACTIVE'); // never finalized
      const { attempts } = await listContactHistory(contact.id);
      expect(attempts.length).toBe(1);
      expect(attempts[0].outcome).toBe('REJECTED');
      expect(attempts[0].outcome).not.toBe('CONNECTED');
      expect(attempts[0].outcome).not.toBe('DELIVERED');
      expect(attempts[0].providerId == null).toBe(true); // no fabricated provider id
      // conversationId is the INTERNAL sales_conversations.id bound after dispatch —
      // a legitimate internal id, never a fabricated/noop/provider id.
      expect(attempts[0].conversationId ?? '').not.toMatch(/^noop-/);
      expect(attempts[0].conversationId ?? '').not.toMatch(/provider/i);
    });

    it(`${channel}: refusal is permanent — no retry/backoff; repeated ticks are no-ops`, async () => {
      resetTestChannel('success');
      const p = await mkProspect();
      const w = await mkChannelWorker(channel);
      const { contact, task } = await enqueueOutreach(p.id, w.id);
      const c0 = testChannelCalls();
      await runDispatcherTick();
      for (let i = 0; i < 4; i++) await runDispatcherTick();
      expect(testChannelCalls()).toBe(c0);
      const tasks = (await db.salesTasks.toJSON()).filter(x => x.payload?.contactId === contact.id);
      expect(tasks.length).toBe(1); // no new task
      expect(tasks[0].status).toBe('DEAD_LETTERED');
      const { attempts } = await listContactHistory(contact.id);
      expect(attempts.length).toBe(1); // no duplicate ledger
    });
  }

  it('human gate + phone: park -> resolve -> resume -> channel gate refuses (noop never called)', async () => {
    resetTestChannel('success');
    const { ensureConversation, escalateConversation, closeConversation } = await import('../src/server/sales/conversations');
    const p = await mkProspect();
    const w = await mkChannelWorker('phone');
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    const conv = await ensureConversation(contact);
    await escalateConversation(conv.id, 'gate48');
    const c0 = testChannelCalls();
    await runDispatcherTick(); // parks (BLOCKED) before any channel logic
    let t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('BLOCKED');
    expect(testChannelCalls()).toBe(c0);
    await closeConversation(conv.id); // human resolves -> QUEUED
    t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('QUEUED');
    await runDispatcherTick(); // resumes -> channel gate refuses
    t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('DEAD_LETTERED');
    expect(testChannelCalls()).toBe(c0); // noop NEVER called across the whole lifecycle
    expect((await db.salesContacts.find(x => x.id === contact.id))!.status).toBe('ACTIVE');
  });

  it('noop regression: dispatch through the gate executes and succeeds exactly as before', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkChannelWorker('noop');
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    const c0 = testChannelCalls();
    const tick = await runDispatcherTick();
    expect(testChannelCalls()).toBe(c0 + 1); // noop executor invoked via the gate
    expect(tick).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    const t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('SUCCEEDED');
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts[0].outcome).toBe('CONNECTED');
    expect(attempts[0].providerId).toBe(`noop-provider-${task!.id}`); // stable logical-task key (Task 50) // existing noop id semantics preserved
    expect((await db.salesContacts.find(x => x.id === contact.id))!.status).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------------------
// Task 50 — stable provider idempotency key across retries.
// Same logical task -> same attemptKey on every attempt; distinct tasks ->
// distinct keys. attemptNumber stays the per-attempt ledger/audit identifier.
// ---------------------------------------------------------------------------


// Task 50 — verify the stable provider idempotency key via the ledger: each
// channel attempt echoes attemptKey into providerId as `noop-provider-{key}`.
// The production dispatcher is used unmodified; the spy seam is avoided.
// Cleanest verification: spy on the noop module's dispatch seam to capture
// the exact attemptKey the REAL dispatcher passes, without altering behavior.
// Uses the real runDispatcherTick; the spy only records.
// Cleanest verification: the ledger echoes each channel attempt's attemptKey
// into providerId as `noop-provider-{key}`. Assert stability directly on the
// ledger rows so the REAL dispatcher path is used unmodified (no spy re-implementation).
describe('Task 50 — stable provider idempotency key', () => {
  // helper: collect providerIds for a contact's attempts
  async function providerIdsFor(contactId: string): Promise<string[]> {
    const { attempts } = await listContactHistory(contactId);
    return attempts.map((a: any) => a.providerId).filter((x: any) => x != null) as string[];
  }

  it('stable key: TIMEOUT -> retry -> same attemptKey (byte-identical), distinct attemptNumber 1,2', async () => {
    resetTestChannel('timeout');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick(); // attempt 1: TIMEOUT -> retryable
    resetTestChannel('success');
    const cur: any = await db.salesTasks.find((x: any) => x.id === task!.id);
    cur.availableAt = new Date(Date.now() - 1000).toISOString();
    await db.salesTasks.update(cur);
    await runDispatcherTick(); // attempt 2: succeeds with SAME key
    const ids = await providerIdsFor(contact.id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(1); // SAME byte-for-byte key across attempts
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.map((a: any) => a.outcome)).toEqual(['TIMEOUT', 'CONNECTED']);
    expect(attempts.map((a: any) => a.attemptNumber)).toEqual([1, 2]); // distinct ledger numbers
    expect(attempts[0].providerId).toBe(`noop-provider-${task!.id}`); // key == task.id
  });

  it('three-attempt stability: attempt 1 == 2 == 3; ledger numbers 1,2,3', async () => {
    resetTestChannel('timeout');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    for (let i = 0; i < 3; i++) { // each FORCEs availability -> one execution
      await runDispatcherTick();
      const cur: any = await db.salesTasks.find((x: any) => x.id === task!.id);
      if (cur.status === 'QUEUED' && i < 2) { cur.availableAt = new Date(Date.now() - 1000).toISOString(); await db.salesTasks.update(cur); }
    }
    const ids = await providerIdsFor(contact.id);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(1);
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.map((a: any) => a.attemptNumber)).toEqual([1, 2, 3]);
  });

  it('distinct logical tasks get distinct keys', async () => {
    resetTestChannel('success');
    const p1 = await mkProspect();
    const p2 = await mkProspect();
    const w = await mkWorker();
    const r1 = await enqueueOutreach(p1.id, w.id);
    const r2 = await enqueueOutreach(p2.id, w.id);
    await runDispatcherTick();
    const id1 = (await providerIdsFor(r1.contact.id))[0];
    const id2 = (await providerIdsFor(r2.contact.id))[0];
    expect(id1).not.toBe(id2);
    expect(id1).toBe(`noop-provider-${r1.task!.id}`);
    expect(id2).toBe(`noop-provider-${r2.task!.id}`);
  });

  it('key is server-derived task.id, never client-supplied', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const id = (await providerIdsFor(task!.payload.contactId))[0];
    expect(id).toBe(`noop-provider-${task!.id}`);
    expect(task!.id).not.toMatch(/client|payload|fromRequest/i);
  });
});

// ---------------------------------------------------------------------------
// Task 54 — Provider Eligibility Contract
// ---------------------------------------------------------------------------

describe('Task 54 — provider eligibility contract', () => {
  it('contract module exposes the eligibility check seam', async () => {
    const pc = await import('../src/server/sales/providerContract');
    expect(typeof pc.checkProspectEligibilityHelper).toBe('function');
  });

  it('noop adapter satisfies the SalesProviderAdapter contract', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    expect(noopAdapter.channel).toBe('noop');
    expect(typeof noopAdapter.checkEligibilityBeforeSend).toBe('function');
    expect(typeof noopAdapter.execute).toBe('function');
    // structural contract check: a SalesProviderAdapter reference is satisfied
    const adapter: import('../src/server/sales/providerContract').SalesProviderAdapter = noopAdapter;
    expect(adapter.channel).toBe('noop');
  });

  it('noop eligibility check returns the CURRENT eligibility state (best-effort, not atomic)', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    const p = await mkProspect();
    expect(await noopAdapter.checkEligibilityBeforeSend(p.id)).toBe(true);
    const cur: any = await db.prospects.find((x: any) => x.id === p.id);
    cur.status = 'REJECTED';
    await db.prospects.update(cur);
    expect(await noopAdapter.checkEligibilityBeforeSend(p.id)).toBe(false);
  });

  it('noop eligibility check returns false for a missing prospect', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    expect(await noopAdapter.checkEligibilityBeforeSend('prsp-does-not-exist')).toBe(false);
  });

  it('transient DB error during noop eligibility check propagates (retryable), not misclassified', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    const p = await mkProspect();
    const orig = db.prospects.find;
    (db.prospects as any).find = async () => { throw new Error('simulated transient db error'); };
    await expect(noopAdapter.checkEligibilityBeforeSend(p.id)).rejects.toThrow(/simulated transient/);
    (db.prospects as any).find = orig;
  });

  it('channel gate behavior unchanged: phone still refused, noop still executes', async () => {
    expect(isChannelImplemented('noop')).toBe(true);
    expect(isChannelImplemented('phone')).toBe(false);
    expect(isChannelImplemented('instagram_dm')).toBe(false);
    expect(isChannelImplemented('whatsapp')).toBe(false);
    resetTestChannel('success');
    const w: any = await mkWorker({ channel: 'phone' });
    const t: any = { id: 'wtask-gate-check', payload: {} };
    const res = await executeChannelDispatch(w, t, { attemptKey: t.id });
    expect(res.outcome).toBe('REJECTED');
    expect(res.retryable).toBe(false);
  });

  it('noop adapter execute() echoes the stable Task 50 attemptKey', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    resetTestChannel('success');
    const w: any = await mkWorker();
    const t: any = { id: 'wtask-contract-echo', payload: {} };
    const res = await noopAdapter.execute(w, t, { attemptKey: t.id });
    expect(res.attemptKey).toBe('wtask-contract-echo');
    expect(res.providerId).toBe('noop-provider-wtask-contract-echo');
  });

  // ---------------------------------------------------------------------------
  // Task 54 audit finding: the provider seam must be ENFORCED — the pre-send
  // eligibility check runs inside execute(), and dispatch routes through the
  // adapter (never into the raw executor). No transaction/lock is held across
  // the provider call; the check is a plain read before send.
  // ---------------------------------------------------------------------------

  it('adapter execute() refuses a deterministically ineligible prospect pre-send (no provider execution)', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    resetTestChannel('success');
    const p = await mkProspect();
    const cur: any = await db.prospects.find((x: any) => x.id === p.id);
    cur.status = 'REJECTED';
    await db.prospects.update(cur);
    const w: any = await mkWorker();
    const t: any = { id: 'wtask-pre-send-refusal', payload: { prospectId: p.id } };
    const before = testChannelCalls();
    const res = await noopAdapter.execute(w, t, { attemptKey: t.id, payload: t.payload });
    expect(res.outcome).toBe('REJECTED');
    expect(res.retryable).toBe(false);
    expect(res.error).toBe('Prospect no longer eligible for outreach.');
    expect(testChannelCalls()).toBe(before); // external side effect never executed
  });

  it('adapter execute() performs the check and sends when the prospect is eligible', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    resetTestChannel('success');
    const p = await mkProspect();
    const w: any = await mkWorker();
    const t: any = { id: 'wtask-pre-send-ok', payload: { prospectId: p.id } };
    const before = testChannelCalls();
    const res = await noopAdapter.execute(w, t, { attemptKey: t.id, payload: t.payload });
    expect(res.outcome).toBe('CONNECTED');
    expect(testChannelCalls()).toBe(before + 1);
  });

  it('transient eligibility-check error in execute() propagates (retryable), never misclassified as ineligibility', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    const p = await mkProspect();
    const w: any = await mkWorker();
    const t: any = { id: 'wtask-pre-send-transient', payload: { prospectId: p.id } };
    const orig = db.prospects.find;
    (db.prospects as any).find = async () => { throw new Error('simulated transient db error'); };
    const before = testChannelCalls();
    await expect(noopAdapter.execute(w, t, { attemptKey: t.id, payload: t.payload })).rejects.toThrow(/simulated transient/);
    (db.prospects as any).find = orig;
    expect(testChannelCalls()).toBe(before);
  });

  it('non-outreach payload (no prospectId) skips the pre-send check and executes', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    resetTestChannel('success');
    const w: any = await mkWorker();
    const t: any = { id: 'wtask-no-prospect', payload: { anything: 'x' } };
    const before = testChannelCalls();
    const res = await noopAdapter.execute(w, t, { attemptKey: t.id, payload: t.payload });
    expect(res.outcome).toBe('CONNECTED');
    expect(testChannelCalls()).toBe(before + 1);
  });

  it('dispatch seam: prospect becomes ineligible between preflight and send → DEAD_LETTERED as REJECTED, provider never executed', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    const orig = db.prospects.find.bind(db.prospects);
    let prospectReads = 0;
    // First read (dispatcher preflight) sees eligible; any later read (the
    // adapter's pre-send check) sees REJECTED — simulating the TOCTOU race.
    (db.prospects as any).find = async (pred: any) => {
      prospectReads++;
      const prospect = await orig(pred);
      if (prospectReads >= 2 && prospect) return { ...(prospect as any), status: 'REJECTED' };
      return prospect;
    };
    const callsBefore = testChannelCalls();
    await runDispatcherTick();
    (db.prospects as any).find = orig;
    const t: any = await db.salesTasks.find((x: any) => x.id === task!.id);
    expect(t.status).toBe('DEAD_LETTERED');
    expect(t.lastError).toBe('Prospect no longer eligible for outreach.');
    expect(testChannelCalls()).toBe(callsBefore); // no side effect executed
    const c: any = await db.salesContacts.find((x: any) => x.id === contact.id);
    expect(c.status).toBe('ACTIVE');
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('REJECTED');
    expect(attempts[0].attemptNumber).toBe(1);
    // Task 56: refusal-at-adapter leaves ZERO conversation rows for the contact.
    const convs = (await db.salesConversations.toJSON()).filter((c: any) => c.contactId === contact.id);
    expect(convs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 56 — authoritative anchor + post-dispatch binding
// ---------------------------------------------------------------------------

describe('Task 56 — authoritative contact anchor + clean refusal ordering', () => {
  it('A. adapter anchors on contact.prospectId, ignoring a divergent payload id', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    resetTestChannel('success');
    // eligibleInPayload: payload ids a DIFFERENT eligible prospect; contact is REJECTED → adapter must refuse.
    const pPayload = await mkProspect(); // stays eligible
    const pContact = await mkProspect();
    (pContact as any).status = 'REJECTED';
    await db.prospects.update(pContact as any);
    const w: any = await mkWorker();
    const fakeContact: any = { id: 'sc-diverg', prospectId: pContact.id, channel: 'noop', status: 'ACTIVE' };
    const t: any = { id: 'wtask-diverg', payload: { prospectId: pPayload.id, contactId: fakeContact.id } };
    const before = testChannelCalls();
    const res = await noopAdapter.execute(w, t, { attemptKey: t.id, payload: t.payload }, fakeContact);
    expect(res.outcome).toBe('REJECTED');
    // Conversation not created by adapter/dispatch path; extra hypotheses covered below.
    expect(res.retryable).toBe(false);
    expect(testChannelCalls()).toBe(before); // no side effect executed (contact-authoritative refusal)
  });

  it('A2. adapter anchors on contact.prospectId and executes when contact is eligible even if payload points at a REJECTED one', async () => {
    const { noopAdapter } = await import('../src/server/sales/noopChannel');
    resetTestChannel('success');
    const pRejected = await mkProspect();
    (pRejected as any).status = 'REJECTED';
    await db.prospects.update(pRejected as any);
    const pEligible = await mkProspect();
    const w: any = await mkWorker();
    const fakeContact: any = { id: 'sc-anchor', prospectId: pEligible.id, channel: 'noop', status: 'ACTIVE' };
    const t: any = { id: 'wtask-anchor', payload: { prospectId: pRejected.id, contactId: fakeContact.id } };
    const before = testChannelCalls();
    const res = await noopAdapter.execute(w, t, { attemptKey: t.id, payload: t.payload }, fakeContact);
    expect(res.outcome).toBe('CONNECTED'); // contact-authoritative ELIGIBLE → executes despite bad payload id
    expect(testChannelCalls()).toBe(before + 1);
  });

  it('B. dispatcher refusal-at-adapter leaves ZERO conversation rows (full path)', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    // Flip REJECTED through the tick path so adapter refuses (preflight may also catch).
    const orig = db.prospects.find.bind(db.prospects);
    let n = 0;
    (db.prospects as any).find = async (pred: any) => {
      n++;
      const prospect: any = await orig(pred);
      if (n >= 2 && prospect) return { ...prospect, status: 'REJECTED' }; // pass preflight, fail adapter
      return prospect;
    };
    await runDispatcherTick();
    (db.prospects as any).find = orig;
    const convs = (await db.salesConversations.toJSON()).filter((c: any) => c.contactId === contact.id);
    expect(convs.length).toBe(0); // ZERO conversation rows when adapter refuses
  });

  it('C. successful dispatch binds the conversation post-dispatch (ordering preserved)', async () => {
    resetTestChannel('success-conv'); // provider returns a conversation id
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const t: any = await db.salesTasks.find((x: any) => x.id === task!.id);
    expect(t.status).toBe('SUCCEEDED');
    const convs = (await db.salesConversations.toJSON()).filter((c: any) => c.contactId === contact.id);
    expect(convs.length).toBe(1);
    expect(convs[0].providerConversationId).toBe(`noop-conv-${task!.id}`);
  });
});

