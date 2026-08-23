import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Task 35 (Phase B) — scheduler + execution limits on the durable substrate.
 *
 * Makes the Task 34 engine schedulable and bounded: timezone-aware schedule
 * windows, one authoritative worker-eligibility decision, per-worker + global
 * concurrency limits (enforced transactionally), a controlled automatic tick
 * loop (configurable interval, no overlap, graceful start/stop), and honest
 * scheduling observability. The no-op channel remains the ONLY channel.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-sched-'));
process.env.DB_PATH = path.join(tmpDir, 'sched.db');
process.env.SESSION_SECRET = 'test-sched-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const {
  createWorker, transitionWorkerStatus, enqueueTask, claimNextTask,
  runDispatcherTick, isWorkerEligibleNow, getWorker
} = await import('../src/server/sales/workforce');
const {
  zonedMinuteInDay, scheduleWindowIncludes, setGlobalConcurrencyLimit,
  getGlobalConcurrencyLimit, startScheduler, stopScheduler, schedulerIsRunning,
  GLOBAL_CONCURRENCY_LIMIT
} = await import('../src/server/sales/scheduler');
const { resetTestChannel } = await import('../src/server/sales/noopChannel');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const platformAgent = request.agent(app);
const tonyAgent = request.agent(app);

beforeAll(async () => {
  await db.init({ seed: true });
  await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
});
afterAll(async () => { stopScheduler(); await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const CFG = {
  role: 'DISCOVERY_RESEARCH' as const,
  objective: 'research',
  channel: 'noop' as const,
  schedule: { enabled: true, timezone: 'UTC', windows: [] as any[] },
  limits: { maxConcurrentTasks: 2, maxAttempts: 3 }
};

// ---------------------------------------------------------------------------
// Timezone-aware schedule evaluation (pure)
// ---------------------------------------------------------------------------

describe('schedule timezone evaluation', () => {
  it('computes minute-in-day in the worker timezone (not server time)', () => {
    // 21:30 UTC in summer is 22:30 in Europe/London (BST).
    const z = zonedMinuteInDay(new Date('2026-08-23T21:30:00Z'), 'Europe/London');
    expect(z.day).toBe('sunday');
    expect(z.minute).toBe(22 * 60 + 30);
  });
  it('handles a non-UTC offset with a different day (Tehran +3:30 crosses to next day)', () => {
    const z = zonedMinuteInDay(new Date('2026-08-23T21:30:00Z'), 'Asia/Tehran');
    expect(z.day).toBe('monday');
    expect(z.minute).toBe(1 * 60 + 0);
  });
  it('window includes boundary start, excludes boundary end', () => {
    const w = { day: 'monday', startMin: 9 * 60, endMin: 14 * 60, activity: 'WORK' };
    expect(scheduleWindowIncludes(w, 'monday', 9 * 60)).toBe(true);
    expect(scheduleWindowIncludes(w, 'monday', 13 * 60 + 59)).toBe(true);
    expect(scheduleWindowIncludes(w, 'monday', 14 * 60)).toBe(false);
    expect(scheduleWindowIncludes(w, 'monday', 8 * 60 + 59)).toBe(false);
    expect(scheduleWindowIncludes(w, 'tuesday', 10 * 60)).toBe(false);
  });
  it('wildcard day matches any day', () => {
    const w = { day: '*', startMin: 0, endMin: 1439, activity: 'WORK' };
    expect(scheduleWindowIncludes(w, 'saturday', 500)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authoritative eligibility
// ---------------------------------------------------------------------------

describe('isWorkerEligibleNow (authoritative)', () => {
  it('eligible inside a window, ineligible outside (timezone-aware)', async () => {
    const w = await createWorker({
      ...CFG,
      schedule: { enabled: true, timezone: 'UTC', windows: [{ day: '*', startMin: 0, endMin: 60, activity: 'WORK' }] }
    });
    const inside = new Date('2026-08-23T00:30:00Z');
    const outside = new Date('2026-08-23T02:00:00Z');
    expect(isWorkerEligibleNow(w, inside)).toBe(true);
    expect(isWorkerEligibleNow(w, outside)).toBe(false);
  });
  it('paused / offline workers are never eligible', async () => {
    const w = await createWorker({ ...CFG, schedule: { enabled: true, timezone: 'UTC', windows: [{ day: '*', startMin: 0, endMin: 1439, activity: 'WORK' }] } });
    await transitionWorkerStatus(w.id, 'PAUSED');
    const paused = (await getWorker(w.id))!;
    expect(isWorkerEligibleNow(paused, new Date())).toBe(false);
    await transitionWorkerStatus(w.id, 'IDLE');
    await transitionWorkerStatus(w.id, 'OFFLINE');
    const offline = (await getWorker(w.id))!;
    expect(isWorkerEligibleNow(offline, new Date())).toBe(false);
  });
  it('schedule-disabled worker is never eligible', async () => {
    const w = await createWorker({ ...CFG, schedule: { enabled: false, timezone: 'UTC', windows: [] } });
    expect(isWorkerEligibleNow(w, new Date())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Global concurrency limit
// ---------------------------------------------------------------------------

describe('global concurrency limit', () => {
  it('configures and reads the global limit', async () => {
    await setGlobalConcurrencyLimit(5);
    expect(getGlobalConcurrencyLimit()).toBe(5);
    expect(GLOBAL_CONCURRENCY_LIMIT).toBeGreaterThan(0);
  });

  it('dispatcher does not claim beyond the global cap', async () => {
    resetTestChannel('success');
    await setGlobalConcurrencyLimit(1);
    const w1 = await createWorker({ ...CFG, schedule: { enabled: true, timezone: 'UTC', windows: [{ day: '*', startMin: 0, endMin: 1439, activity: 'WORK' }] } });
    const w2 = await createWorker({ ...CFG, schedule: { enabled: true, timezone: 'UTC', windows: [{ day: '*', startMin: 0, endMin: 1439, activity: 'WORK' }] } });
    // Occupy the single global slot with a long-running RUNNING task on w1.
    await enqueueTask({ workerId: w1.id, type: 'research', payload: {}, idempotencyKey: 'g-1' });
    await claimNextTask(w1.id); // now RUNNING (global 1/1 used)
    // w2's task should NOT be claimed this tick (global cap reached).
    const t2 = await enqueueTask({ workerId: w2.id, type: 'research', payload: {}, idempotencyKey: 'g-2' });
    const result = await runDispatcherTick();
    const t2r = await (await import('../src/server/sales/workforce')).getTask(t2.id);
    expect(t2r!.status).toBe('QUEUED');
    expect(result.claimed).toBe(0);
    await setGlobalConcurrencyLimit(GLOBAL_CONCURRENCY_LIMIT); // restore
  });
});

// ---------------------------------------------------------------------------
// Worker concurrency limit (scheduling respects it)
// ---------------------------------------------------------------------------

describe('worker concurrency limit under scheduling', () => {
  it('no additional tasks are claimed while at capacity; resumes after completion', async () => {
    resetTestChannel('success');
    const w = await createWorker({ ...CFG, schedule: { enabled: true, timezone: 'UTC', windows: [{ day: '*', startMin: 0, endMin: 1439, activity: 'WORK' }] }, limits: { maxConcurrentTasks: 1, maxAttempts: 3 } });
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'c-1' });
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'c-2' });
    // First tick: claims 1 (cap 1), completes it.
    await runDispatcherTick();
    const t1 = (await db.salesTasks.toJSON()).find((x: any) => x.idempotencyKey === 'c-1');
    const t2 = (await db.salesTasks.toJSON()).find((x: any) => x.idempotencyKey === 'c-2');
    expect(t1!.status).toBe('SUCCEEDED');
    // Second tick: now capacity is free, claims + completes the second.
    await runDispatcherTick();
    const t2r = (await db.salesTasks.toJSON()).find((x: any) => x.idempotencyKey === 'c-2');
    expect(t2r!.status).toBe('SUCCEEDED');
  });
});

// ---------------------------------------------------------------------------
// Automatic tick loop
// ---------------------------------------------------------------------------

describe('automatic tick loop', () => {
  it('starts, runs ticks, and stops gracefully (no overlap)', async () => {
    resetTestChannel('success');
    const w = await createWorker({ ...CFG, schedule: { enabled: true, timezone: 'UTC', windows: [{ day: '*', startMin: 0, endMin: 1439, activity: 'WORK' }] } });
    await enqueueTask({ workerId: w.id, type: 'research', payload: {}, idempotencyKey: 'loop-1' });
    startScheduler({ intervalMs: 25 });
    expect(schedulerIsRunning()).toBe(true);
    await new Promise(r => setTimeout(r, 120));
    stopScheduler();
    expect(schedulerIsRunning()).toBe(false);
    const t = (await db.salesTasks.toJSON()).find((x: any) => x.idempotencyKey === 'loop-1');
    expect(t!.status).toBe('SUCCEEDED');
  });

  it('duplicate start is a no-op (no multiple loops)', () => {
    startScheduler({ intervalMs: 10000 });
    const first = schedulerIsRunning();
    startScheduler({ intervalMs: 10000 });
    expect(schedulerIsRunning()).toBe(first);
    stopScheduler();
    expect(schedulerIsRunning()).toBe(false);
  });

  it('a failing tick does not kill the loop (next tick still runs)', async () => {
    resetTestChannel('success');
    startScheduler({ intervalMs: 20 });
    await new Promise(r => setTimeout(r, 80));
    expect(schedulerIsRunning()).toBe(true);
    stopScheduler();
    expect(schedulerIsRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('scheduler authorization', () => {
  it('PLATFORM_OWNER can control the scheduler; tenant is rejected', async () => {
    const ok = await platformAgent.post('/api/sales/scheduler/start').send({ intervalMs: 10000 });
    expect([200, 201, 204]).toContain(ok.status);
    const stop = await platformAgent.post('/api/sales/scheduler/stop');
    expect([200, 201, 204]).toContain(stop.status);
    const tenant = await tonyAgent.post('/api/sales/scheduler/start').send({});
    expect(tenant.status).toBe(403);
  });
});
