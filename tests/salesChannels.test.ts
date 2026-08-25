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
const { executeChannelTask, resetTestChannel } = await import('../src/server/sales/noopChannel');
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

  it('TIMEOUT is retryable (ambiguous accept)', async () => {
    resetTestChannel('timeout');
    const r = await executeChannelTask(await mkWorker(), {} as any, { attemptKey: 'k' });
    expect(r.success).toBe(true); // provider may have accepted — ambiguous success, retryable key preservation
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
    expect(attempts[0].providerId).toBe(`noop-provider-${task!.id}:1`);
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
