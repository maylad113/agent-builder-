import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Task 34 (Phase A) — durable sales-worker execution substrate.
 *
 * A crash-safe, idempotent, concurrency-protected execution substrate for
 * future sales workers. Workers are INSTANCES of one architecture (1/12/50
 * workers are identical rows). Durable tasks are claimed atomically
 * (FOR UPDATE SKIP LOCKED semantics), executed through a pluggable channel
 * (a no-op/test channel in this phase), retried with a bound, and recovered
 * from crashes by a deterministic stale-task reaper. PLATFORM_OWNER-only;
 * platform-level (not customer-tenant) entities.
 *
 * No external channels, no outreach, no sales prompts — execution only.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-sw-'));
process.env.DB_PATH = path.join(tmpDir, 'sw.db');
process.env.SESSION_SECRET = 'test-sw-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const {
  createWorker, getWorker, transitionWorkerStatus, WORKER_TRANSITIONS,
  enqueueTask, getTask, advanceTask, TASK_TRANSITIONS,
  claimNextTask, reapStaleTasks, runDispatcherTick, MAX_TASK_ATTEMPTS,
  STALE_TASK_MS
} = await import('../src/server/sales/workforce');
const { registerTestChannel, resetTestChannel, testChannelCalls } = await import('../src/server/sales/noopChannel');

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
  objective: 'research prospects',
  channel: 'noop' as const,
  schedule: { enabled: true, windows: [{ day: '*', startMin: 0, endMin: 1439, activity: 'WORK' }] },
  limits: { maxConcurrentTasks: 2, maxAttempts: 3 }
};

// ---------------------------------------------------------------------------
// Worker model + state machine
// ---------------------------------------------------------------------------

describe('worker model + state machine', () => {
  it('creates a worker (one architecture, role-driven config)', async () => {
    const w = await createWorker(WORKER_CFG);
    expect(w.id).toMatch(/^wk-/);
    expect(w.role).toBe('DISCOVERY_RESEARCH');
    expect(w.status).toBe('IDLE');
    expect(w.channel).toBe('noop');
  });

  it('accepts valid transitions and rejects invalid ones', async () => {
    const w = await createWorker(WORKER_CFG);
    const paused = await transitionWorkerStatus(w.id, 'PAUSED');
    expect(paused.status).toBe('PAUSED');
    const idle = await transitionWorkerStatus(w.id, 'IDLE');
    expect(idle.status).toBe('IDLE');
    // A genuinely-PAUSED worker cannot jump straight to RUNNING.
    const w2 = await createWorker(WORKER_CFG);
    await transitionWorkerStatus(w2.id, 'PAUSED');
    await expect(transitionWorkerStatus(w2.id, 'RUNNING')).rejects.toThrow();
    expect(WORKER_TRANSITIONS.IDLE).toContain('PAUSED');
    expect(WORKER_TRANSITIONS.IDLE).toContain('OFFLINE');
    expect(WORKER_TRANSITIONS.IDLE).toContain('RUNNING');
    expect(WORKER_TRANSITIONS.PAUSED).not.toContain('RUNNING');
  });
});

// ---------------------------------------------------------------------------
// Task model + state machine + idempotency
// ---------------------------------------------------------------------------

describe('task model + state machine + idempotency', () => {
  it('enqueues a durable task (QUEUED) with an idempotency key', async () => {
    const w = await createWorker(WORKER_CFG);
    const t = await enqueueTask({ workerId: w.id, type: 'research', payload: { prospectId: 'p-1' }, idempotencyKey: 'k-1' });
    expect(t.status).toBe('QUEUED');
    expect(t.attemptCount).toBe(0);
    expect(t.id).toMatch(/^wtask-/);
  });

  it('duplicate idempotency key returns the SAME task (no duplicate work)', async () => {
    const w = await createWorker(WORKER_CFG);
    const t1 = await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-dup' });
    const t2 = await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-dup' });
    expect(t2.id).toBe(t1.id);
    const all = (await db.salesTasks.toJSON()).filter((x: any) => x.idempotencyKey === 'k-dup');
    expect(all.length).toBe(1);
  });

  it('rejects invalid task transitions', async () => {
    const w = await createWorker(WORKER_CFG);
    const t = await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-inv' });
    await expect(advanceTask(t.id, 'SUCCEEDED')).rejects.toThrow(); // QUEUED -> SUCCEEDED invalid
    expect(TASK_TRANSITIONS.QUEUED).toContain('RUNNING');
    expect(TASK_TRANSITIONS.SUCCEEDED).toEqual([]);
    expect(TASK_TRANSITIONS.DEAD_LETTERED).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Claiming (concurrency-safe)
// ---------------------------------------------------------------------------

describe('task claiming', () => {
  it('claims the next eligible QUEUED task (one active claim)', async () => {
    const w = await createWorker(WORKER_CFG);
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-c1' });
    const claimed = await claimNextTask(w.id);
    expect(claimed).toBeTruthy();
    expect(claimed!.status).toBe('RUNNING');
    expect(claimed!.attemptCount).toBe(1);
    // A second claim for the same worker returns the next task or null (not the same one).
    const again = await claimNextTask(w.id);
    expect(again?.id).not.toBe(claimed!.id);
  });

  it('concurrent claims never yield the same task twice', async () => {
    const w = await createWorker(WORKER_CFG);
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-race' });
    const [a, b] = await Promise.all([claimNextTask(w.id), claimNextTask(w.id)]);
    const ids = [a?.id, b?.id].filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length); // distinct
    // Exactly one claim won the single task.
    expect(ids.length).toBe(1);
  });

  it('respects the worker concurrency limit', async () => {
    const w = await createWorker({ ...WORKER_CFG, limits: { maxConcurrentTasks: 1, maxAttempts: 3 } });
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-lim1' });
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-lim2' });
    const first = await claimNextTask(w.id);
    expect(first).toBeTruthy();
    // Concurrency limit (1) reached — a second claim is refused.
    const second = await claimNextTask(w.id);
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dispatcher + no-op channel (success / retry / dead-letter)
// ---------------------------------------------------------------------------

describe('dispatcher + no-op channel', () => {
  it('executes a runnable task to SUCCEEDED via the no-op channel', async () => {
    resetTestChannel('success');
    const w = await createWorker(WORKER_CFG);
    const t0 = await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-succ' });
    const before = testChannelCalls();
    await runDispatcherTick();
    const t = await getTask(t0.id);
    expect(t!.status).toBe('SUCCEEDED');
    expect(testChannelCalls()).toBeGreaterThanOrEqual(before + 1);
  });

  it('retryable failure schedules a retry (back to QUEUED, attempt recorded)', async () => {
    resetTestChannel('retryable');
    const w = await createWorker(WORKER_CFG);
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-retry' });
    await runDispatcherTick();
    const t = (await db.salesTasks.toJSON()).find((x: any) => x.idempotencyKey === 'k-retry');
    expect(t!.status).toBe('QUEUED');
    expect(t!.attemptCount).toBe(1);
    expect(t!.lastError).toBeTruthy();
  });

  it('permanent failure DEAD_LETTERs immediately (no retry)', async () => {
    resetTestChannel('permanent');
    const w = await createWorker(WORKER_CFG);
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-perm' });
    await runDispatcherTick();
    const t = (await db.salesTasks.toJSON()).find((x: any) => x.idempotencyKey === 'k-perm');
    expect(t!.status).toBe('DEAD_LETTERED');
  });

  it('bounded retry dead-letters after MAX attempts (no infinite retry)', async () => {
    resetTestChannel('retryable');
    const w = await createWorker(WORKER_CFG);
    const t0 = await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-cap' });
    // Drive attempts directly (the backoff window delays claimable retries).
    for (let i = 0; i < MAX_TASK_ATTEMPTS + 2; i++) {
      // Force the task to be due so the dispatcher can claim it this tick.
      await db.client.query('UPDATE sales_tasks SET available_at = ? WHERE id = ?', [new Date(0).toISOString(), t0.id]);
      await runDispatcherTick();
    }
    const t = await getTask(t0.id);
    expect(t!.status).toBe('DEAD_LETTERED');
    expect(t!.attemptCount).toBe(MAX_TASK_ATTEMPTS);
  });

  it('paused worker does not execute', async () => {
    resetTestChannel('success');
    const w = await createWorker(WORKER_CFG);
    await transitionWorkerStatus(w.id, 'PAUSED');
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-paused' });
    await runDispatcherTick();
    const t = (await db.salesTasks.toJSON()).find((x: any) => x.idempotencyKey === 'k-paused');
    expect(t!.status).toBe('QUEUED'); // untouched
    expect(testChannelCalls()).toBe(0);
  });

  it('disabled (schedule-disabled) worker does not execute', async () => {
    resetTestChannel('success');
    const w = await createWorker({ ...WORKER_CFG, schedule: { enabled: false, windows: [] } });
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-disabled' });
    await runDispatcherTick();
    const t = (await db.salesTasks.toJSON()).find((x: any) => x.idempotencyKey === 'k-disabled');
    expect(t!.status).toBe('QUEUED');
    expect(testChannelCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stale-task reaper (crash recovery)
// ---------------------------------------------------------------------------

describe('stale-task reaper', () => {
  it('recovers a crashed CLAIMED/RUNNING task back to QUEUED (bounded by attempts)', async () => {
    const w = await createWorker(WORKER_CFG);
    const t = await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-stale' });
    await claimNextTask(w.id);
    // Simulate a crash: leave it RUNNING past the stale threshold.
    await db.client.query(
      'UPDATE sales_tasks SET claimed_at = ?, status = ? WHERE id = ?',
      [new Date(Date.now() - STALE_TASK_MS - 1000).toISOString(), 'RUNNING', t.id]
    );
    const reaped = await reapStaleTasks();
    expect(reaped).toBeGreaterThanOrEqual(1);
    const after = await getTask(t.id);
    expect(['QUEUED', 'FAILED']).toContain(after!.status);
  });

  it('a fresh (non-stale) RUNNING task is NOT reaped', async () => {
    const w = await createWorker(WORKER_CFG);
    const t = await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'k-fresh' });
    await claimNextTask(w.id);
    const reaped = await reapStaleTasks();
    const after = await getTask(t.id);
    expect(after!.status).toBe('RUNNING');
    expect(reaped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Authorization + tenancy
// ---------------------------------------------------------------------------

describe('authorization + tenancy', () => {
  it('PLATFORM_OWNER can create workers via the admin route', async () => {
    const res = await platformAgent.post('/api/sales/workers').send(WORKER_CFG);
    expect([200, 201]).toContain(res.status);
    expect(res.body.id).toMatch(/^wk-/);
  });
  it('BUSINESS_OWNER is rejected (403)', async () => {
    const res = await tonyAgent.post('/api/sales/workers').send(WORKER_CFG);
    expect(res.status).toBe(403);
  });
  it('unauthenticated is rejected (401)', async () => {
    const res = await unauthAgent.post('/api/sales/workers').send(WORKER_CFG);
    expect(res.status).toBe(401);
  });
  it('workers are platform-level (no customer businessId attached)', async () => {
    const res = await platformAgent.get('/api/sales/workers');
    expect(res.status).toBe(200);
    for (const w of res.body) {
      expect(w.businessId).toBeUndefined();
    }
  });
});
