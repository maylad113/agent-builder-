import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Task 42 — platform-level sales conversation + human-escalation substrate.
 * Proves conversation binding on first outreach, retry reuse, concurrent
 * first-bind safety, provider-id separation, the OPEN → NEEDS_HUMAN → CLOSED
 * state machine, the automation gate, route auth, and Task-40 preservation.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-scv-'));
process.env.DB_PATH = path.join(tmpDir, 'scv.db');
process.env.SESSION_SECRET = 'test-scv-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { createProspect } = await import('../src/server/orchestration/prospects');
const { createWorker, runDispatcherTick, enqueueTask } = await import('../src/server/sales/workforce');
const { enqueueOutreach, listContactHistory, recordAttempt } = await import('../src/server/sales/contacts');
const {
  ensureConversation, getConversation, listConversations, listEscalationQueue,
  listTurns, appendTurn, escalateConversation, closeConversation, assertAutomatable,
  assertConversationTransition
} = await import('../src/server/sales/conversations');
const { resetTestChannel } = await import('../src/server/sales/noopChannel');
const { listTelemetryEvents } = await import('../src/server/telemetry');

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
  role: 'PHONE_SALES' as const,
  objective: 'conv test',
  channel: 'noop' as const,
  schedule: { enabled: true, timezone: 'UTC', windows: [] as any[] },
  limits: { maxConcurrentTasks: 2, maxAttempts: 3 }
};

let seq = 0;
async function mkProspect() { return createProspect({ businessName: `Conv-${Date.now()}-${seq++}` }); }
async function mkWorker(cfg: Record<string, unknown> = {}) { return createWorker({ ...WORKER_CFG, ...cfg } as any); }

describe('conversation CRUD + state machine', () => {
  it('A/B/C: create, get, list', async () => {
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    const conv = await ensureConversation(contact);
    expect(conv.status).toBe('OPEN');
    expect(conv.contactId).toBe(contact.id);
    const got = await getConversation(conv.id);
    expect(got!.id).toBe(conv.id);
    const list = await listConversations();
    expect(list.some(c => c.id === conv.id)).toBe(true);
  });

  it('D: OPEN → NEEDS_HUMAN with bounded reason', async () => {
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    const conv = await ensureConversation(contact);
    const esc = await escalateConversation(conv.id, 'x'.repeat(600));
    expect(esc.status).toBe('NEEDS_HUMAN');
    expect(esc.escalationReason!.length).toBeLessThanOrEqual(501);
  });

  it('E/F: OPEN → CLOSED and NEEDS_HUMAN → CLOSED', async () => {
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    const c1 = await ensureConversation(contact);
    const closed = await closeConversation(c1.id);
    expect(closed.status).toBe('CLOSED');
    const c2 = await ensureConversation(contact);
    expect(c2.id).toBe(c1.id); // same row, still CLOSED
  });

  it('G/H: CLOSED → OPEN and CLOSED → NEEDS_HUMAN rejected', async () => {
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    const conv = await ensureConversation(contact);
    await closeConversation(conv.id);
    expect(() => assertConversationTransition('CLOSED', 'OPEN')).toThrow(/Invalid conversation transition/);
    expect(() => assertConversationTransition('CLOSED', 'NEEDS_HUMAN')).toThrow(/Invalid conversation transition/);
    await expect(escalateConversation(conv.id, 'late')).rejects.toThrow(/Invalid conversation transition/);
    // Double-close is an idempotent no-op (same-state transitions are allowed,
    // consistent with the codebase's advanceTask convention); never reopens.
    const again = await closeConversation(conv.id);
    expect(again.status).toBe('CLOSED');
  });

  it('J/K: bounded turn content, append-only, validated direction/actor', async () => {
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    const conv = await ensureConversation(contact);
    const t1 = await appendTurn({ conversationId: conv.id, direction: 'OUTBOUND', actor: 'WORKER', safeContent: 'y'.repeat(600) });
    expect(t1.safeContent!.length).toBeLessThanOrEqual(501);
    await expect(appendTurn({ conversationId: conv.id, direction: 'SIDEWAYS' as any, actor: 'WORKER' })).rejects.toThrow();
    await expect(appendTurn({ conversationId: conv.id, direction: 'OUTBOUND', actor: 'HACKER' as any })).rejects.toThrow();
    const turns = await listTurns(conv.id);
    expect(turns.length).toBe(1);
  });
});

describe('binding + dispatcher integration', () => {
  it('L: first outreach binds a conversation and records internal conversationId', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const convs = await db.salesConversations.filter(c => c.contactId === contact.id);
    expect(convs.length).toBe(1);
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].conversationId).toBe(convs[0].id); // INTERNAL id
    expect(attempts[0].conversationId).not.toBe(convs[0].providerConversationId);
  });

  it('M: retry reuses the same conversation (no duplicate)', async () => {
    resetTestChannel('retryable');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    resetTestChannel('success');
    await runDispatcherTick(); // retry (backoff 0 in test env)
    const convs = await db.salesConversations.filter(c => c.contactId === contact.id);
    expect(convs.length).toBe(1);
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    for (const a of attempts) expect(a.conversationId).toBe(convs[0].id);
  });

  it('N: concurrent first bind produces exactly one conversation', async () => {
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    const [c1, c2, c3] = await Promise.all([
      ensureConversation(contact), ensureConversation(contact), ensureConversation(contact)
    ]);
    expect(c1.id).toBe(c2.id);
    expect(c2.id).toBe(c3.id);
    const convs = await db.salesConversations.filter(c => c.contactId === contact.id);
    expect(convs.length).toBe(1);
  });

  it('O/P: provider conversation id persisted, distinct from internal id', async () => {
    resetTestChannel('success-conv'); // provider returns its own thread id
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const conv = (await db.salesConversations.filter(c => c.contactId === contact.id))[0];
    expect(conv.providerConversationId).toMatch(/^noop-conv-/);
    expect(conv.providerConversationId).not.toBe(conv.id);
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts[0].providerId).toMatch(/^noop-provider-/);
    expect(attempts[0].conversationId).toBe(conv.id); // internal id on the attempt
    resetTestChannel('success');
  });

  it('Q: attempt references the conversation via internal id', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const { attempts } = await listContactHistory(contact.id);
    const conv = await getConversation(attempts[0].conversationId!);
    expect(conv).toBeDefined();
    expect(conv!.contactId).toBe(contact.id);
  });

  it('R: NEEDS_HUMAN blocks automated continuation (task fails, never succeeds)', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick(); // succeeds; conversation OPEN, contact COMPLETED
    const conv = (await db.salesConversations.filter(c => c.contactId === contact.id))[0];
    await escalateConversation(conv.id, 'customer asked to call back later');
    await expect(assertAutomatable(contact.id)).rejects.toThrow(/human review/);
    // A new manual task on the same contact must fail (not silently succeed).
    const t2 = await enqueueTask({ workerId: w.id, type: 'outreach', payload: { prospectId: p.id, contactId: contact.id, channel: 'noop' }, idempotencyKey: `manual-${Date.now()}-${seq++}` });
    const tick = await runDispatcherTick();
    expect(tick.succeeded).toBe(0);
    expect(tick.failed).toBeGreaterThanOrEqual(1);
    const t2row = await db.salesTasks.find(t => t.id === t2.id);
    expect(t2row!.status).not.toBe('SUCCEEDED');
  });

  it('S: resolve closes the escalation', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const conv = (await db.salesConversations.filter(c => c.contactId === contact.id))[0];
    await escalateConversation(conv.id, 'needs pricing approval');
    const resolved = await closeConversation(conv.id);
    expect(resolved.status).toBe('CLOSED');
    await expect(assertAutomatable(contact.id)).rejects.toThrow(/closed/);
  });

  it('Z: Task-40 TIMEOUT behavior unchanged with conversation binding', async () => {
    resetTestChannel('timeout');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    const tick = await runDispatcherTick();
    expect(tick.succeeded).toBe(0);
    expect(tick.failed).toBeGreaterThanOrEqual(1);
    const t = await db.salesTasks.find(x => x.id === task!.id);
    expect(t!.status).toBe('QUEUED'); // retried, not completed
    const after = await db.salesContacts.find(c => c.id === contact.id);
    expect(after!.status).toBe('ACTIVE'); // not finalized
    const convs = await db.salesConversations.filter(c => c.contactId === contact.id);
    expect(convs.length).toBe(1); // bound even for TIMEOUT
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts[0].outcome).toBe('TIMEOUT');
    expect(attempts[0].conversationId).toBe(convs[0].id);
  });

  it('Y: legacy attempts with null conversation_id remain readable', async () => {
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact, task } = await enqueueOutreach(p.id, w.id);
    await recordAttempt({ taskId: task!.id, attemptNumber: 1, outcome: 'ERROR', error: 'legacy' });
    const { attempts } = await listContactHistory(contact.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].conversationId ?? null).toBeNull(); // legacy null remains readable
  });
});

describe('routes: auth + escalation queue + telemetry', () => {
  it('T/U/V: unauthenticated 401, BUSINESS_OWNER 403, PLATFORM_OWNER allowed', async () => {
    const un = await unauthAgent.get('/api/sales/conversations');
    expect(un.status).toBe(401);
    const bo = await tonyAgent.get('/api/sales/conversations');
    expect(bo.status).toBe(403);
    const po = await platformAgent.get('/api/sales/conversations');
    expect(po.status).toBe(200);
    expect(Array.isArray(po.body)).toBe(true);
  });

  it('escalation queue + resolve route', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const conv = (await db.salesConversations.filter(c => c.contactId === contact.id))[0];
    await escalateConversation(conv.id, 'requested a human');
    const queue = await platformAgent.get('/api/sales/conversations/escalations');
    expect(queue.status).toBe(200);
    expect(queue.body.some((c: any) => c.id === conv.id)).toBe(true);
    const detail = await platformAgent.get(`/api/sales/conversations/${conv.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.conversation.status).toBe('NEEDS_HUMAN');
    const resolve = await platformAgent.post(`/api/sales/conversations/${conv.id}/resolve`).send({});
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe('CLOSED');
    // Idempotent re-resolve stays CLOSED (same-state no-op; never reopens).
    const again = await platformAgent.post(`/api/sales/conversations/${conv.id}/resolve`).send({});
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('CLOSED');
  });

  it('resolve route refuses to set ids / bypass transitions', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const conv = (await db.salesConversations.filter(c => c.contactId === contact.id))[0];
    const before = await getConversation(conv.id);
    await platformAgent.post(`/api/sales/conversations/${conv.id}/resolve`).send({ id: 'hacked', providerConversationId: 'x', status: 'OPEN' });
    const after = await getConversation(conv.id);
    expect(after!.id).toBe(before!.id);
    expect(after!.providerConversationId).toBe(before!.providerConversationId);
    expect(after!.status).toBe('CLOSED');
  });

  it('X: telemetry events recorded with safe summaries', async () => {
    resetTestChannel('success');
    const p = await mkProspect();
    const w = await mkWorker();
    const { contact } = await enqueueOutreach(p.id, w.id);
    await runDispatcherTick();
    const conv = (await db.salesConversations.filter(c => c.contactId === contact.id))[0];
    // Plant a secret-looking marker in the escalation reason; telemetry must
    // never echo it (summaries are generic ids-only).
    await escalateConversation(conv.id, 'SECRET_MARKER_XYZ123');
    await closeConversation(conv.id);
    const events = await listTelemetryEvents({ businessId: 'platform', limit: 200 });
    const types = events.map(e => e.eventType);
    expect(types).toContain('SALES_CONVERSATION_OPENED');
    expect(types).toContain('SALES_CONVERSATION_ESCALATED');
    expect(types).toContain('SALES_CONVERSATION_CLOSED');
    const raw = JSON.stringify(events);
    expect(raw).not.toContain('SECRET_MARKER_XYZ123');
    expect(raw).not.toContain('AIza'); // no cloud API-key-shaped values
  });

  it('W: no tenant data in sales conversation surface', async () => {
    const po = await platformAgent.get('/api/sales/conversations');
    const raw = JSON.stringify(po.body);
    expect(raw).not.toContain('businessId');
  });
});
