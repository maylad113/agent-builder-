import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Task 25 — close the web_chat human-handoff reply loop.
 *
 * The public widget can now retrieve NEW messages in its own conversation
 * (owner/human replies, agent replies, system notices) via a cursor-based,
 * tenant-scoped, origin-enforced, rate-limited public route:
 *
 *   GET /api/runtime/conversations/:conversationId/messages?business=<id>&after=<messageId>
 *
 * Authority model (mirrors POST /runtime/chat): the business id + the
 * unguessable conversation id + the per-business origin allow-list. The
 * server derives the conversation->business relationship; a client-supplied
 * business id that does not match the conversation's tenant is a 404 (no
 * existence leak). Reads are pure — no writes, no telemetry.
 *
 * No mocks: real DB, real routes, real owner-side reply machinery.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-wmsg-'));
process.env.DB_PATH = path.join(tmpDir, 'wmsg.db');
process.env.SESSION_SECRET = 'test-wmsg-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { executeAgentTool } = await import('../src/server/tools');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const tonyAgent = request.agent(app);

const BIZ = 'biz-tonys-barber';
const OTHER_BIZ = 'biz-second-shop';

async function widgetChat(body: any, origin?: string) {
  let r = request(app).post('/api/runtime/chat');
  if (origin) r = r.set('Origin', origin);
  return r.send({ tenantId: BIZ, channel: 'web_chat', ...body });
}
function widgetMessages(convId: string, opts: { business?: string; after?: string; origin?: string } = {}) {
  let r = request(app).get(`/api/runtime/conversations/${convId}/messages`);
  const q: string[] = [];
  if (opts.business) q.push(`business=${encodeURIComponent(opts.business)}`);
  if (opts.after) q.push(`after=${encodeURIComponent(opts.after)}`);
  if (q.length) r = request(app).get(`/api/runtime/conversations/${convId}/messages?${q.join('&')}`);
  if (opts.origin) r = r.set('Origin', opts.origin);
  return r;
}

beforeAll(async () => {
  await db.init();
  await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
  // A second tenant to prove cross-tenant reads are impossible.
  await db.businesses.push({
    id: OTHER_BIZ, name: 'Other Shop', type: 'salon', description: 'x', location: 'y',
    language: 'en', currency: 'toman', timezone: 'Asia/Tehran', hours: [], services: [], faqs: [],
    policies: { cancellation: 'c', refund: 'r', bookingNotice: 'b' }, communicationStyle: 's',
    status: 'ACTIVE', allowedWidgetOrigins: [], holidays: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  } as any);
  const conv: any = {
    id: 'conv-foreign-tenant', businessId: OTHER_BIZ, customerId: 'cust-x', customerName: 'X',
    channel: 'web_chat', status: 'AI_HANDLING', lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  await db.conversations.push(conv);
  await db.messages.push({
    id: 'msg-foreign-secret', conversationId: 'conv-foreign-tenant', sender: 'agent',
    content: 'FOREIGN-TENANT-SECRET-CONTENT', channel: 'web_chat', timestamp: new Date().toISOString()
  } as any);
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('widget message retrieval — security', () => {
  it('missing business param is rejected (400)', async () => {
    const res = await widgetMessages('conv-whatever');
    expect(res.status).toBe(400);
  });
  it('guessed/nonexistent conversation id is 404 (no existence leak)', async () => {
    const res = await widgetMessages('conv-does-not-exist', { business: BIZ });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('conv-foreign-tenant');
  });
  it('a REAL conversation from another tenant is 404 for this business (cross-tenant read impossible)', async () => {
    const res = await widgetMessages('conv-foreign-tenant', { business: BIZ });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('FOREIGN-TENANT-SECRET-CONTENT');
  });
  it('a foreign business id cannot read this tenant’s conversation', async () => {
    const start = await widgetChat({ userMessage: 'hello', customerName: 'Sec Tester' });
    const convId = start.body.conversationId;
    const res = await widgetMessages(convId, { business: OTHER_BIZ });
    expect(res.status).toBe(404);
  });
  it('foreign origin is rejected (403) in any mode', async () => {
    const start = await widgetChat({ userMessage: 'hello', customerName: 'Origin Tester' });
    const res = await widgetMessages(start.body.conversationId, { business: BIZ, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
  it('production mode: allow-listed origin works, missing origin is rejected', async () => {
    const biz = await db.businesses.find(b => b.id === BIZ);
    const prevOrigins = biz!.allowedWidgetOrigins;
    biz!.allowedWidgetOrigins = ['https://customer.example'];
    await db.businesses.update(biz!);
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const start = await widgetChat({ userMessage: 'hello', customerName: 'Prod Tester' }, 'https://customer.example');
      expect(start.status).toBe(200);
      const ok = await widgetMessages(start.body.conversationId, { business: BIZ, origin: 'https://customer.example' });
      expect(ok.status).toBe(200);
      expect(ok.headers['access-control-allow-origin']).toBe('https://customer.example');
      const noOrigin = await widgetMessages(start.body.conversationId, { business: BIZ });
      expect(noOrigin.status).toBe(403);
      const foreign = await widgetMessages(start.body.conversationId, { business: BIZ, origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
    } finally {
      process.env.NODE_ENV = prevEnv;
      biz!.allowedWidgetOrigins = prevOrigins;
      await db.businesses.update(biz!);
    }
  });
});

describe('widget message retrieval — visibility + cursor', () => {
  it('bootstrap returns only customer-visible fields of the conversation’s messages (no toolCalls, no internals)', async () => {
    const start = await widgetChat({ userMessage: 'what are your hours?', customerName: 'Visibility Tester' });
    expect(start.status).toBe(200);
    const convId = start.body.conversationId;
    const res = await widgetMessages(convId, { business: BIZ });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2); // customer + agent reply
    for (const m of res.body.messages) {
      expect(Object.keys(m).sort()).toEqual(['content', 'id', 'sender', 'timestamp']);
      expect(['customer', 'agent', 'human_agent', 'system']).toContain(m.sender);
      expect(JSON.stringify(m)).not.toMatch(/toolCall|passwordHash|SECRET|GEMINI|systemPrompt/i);
    }
    expect(res.body.conversationStatus).toBeDefined();
    expect(typeof res.body.hasMore).toBe('boolean');
  });

  it('the POST chat response carries the reply messageId so the widget can set its cursor', async () => {
    const start = await widgetChat({ userMessage: 'hello', customerName: 'Cursor Seed' });
    expect(start.status).toBe(200);
    expect(typeof start.body.messageId).toBe('string');
    expect(start.body.messageId).toMatch(/^msg-/);
  });

  it('after=<messageId> returns only NEWER messages; a repeated poll is identical and writes nothing', async () => {
    const start = await widgetChat({ userMessage: 'hello', customerName: 'Cursor Tester' });
    const convId = start.body.conversationId;
    const cursor = start.body.messageId;

    const before = await db.messages.filter((m: any) => m.conversationId === convId);
    const convBefore = await db.conversations.find((c: any) => c.id === convId);

    // Newer than the reply cursor: nothing yet.
    const r1 = await widgetMessages(convId, { business: BIZ, after: cursor });
    expect(r1.status).toBe(200);
    expect(r1.body.messages).toEqual([]);

    // Repeat: identical result, and the read performed NO writes.
    const r2 = await widgetMessages(convId, { business: BIZ, after: cursor });
    expect(r2.body).toEqual(r1.body);
    const afterMsgs = await db.messages.filter((m: any) => m.conversationId === convId);
    const convAfter = await db.conversations.find((c: any) => c.id === convId);
    expect(afterMsgs.length).toBe(before.length);
    expect(convAfter!.lastMessageAt).toBe(convBefore!.lastMessageAt);

    // Bootstrap (no cursor) returns the full visible transcript in a
    // deterministic order across calls.
    const b1 = await widgetMessages(convId, { business: BIZ });
    const b2 = await widgetMessages(convId, { business: BIZ });
    expect(b1.body.messages.map((m: any) => m.id)).toEqual(b2.body.messages.map((m: any) => m.id));
    const sorted = [...b1.body.messages].sort((a: any, b: any) => a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : a.timestamp.localeCompare(b.timestamp));
    expect(b1.body.messages.map((m: any) => m.id)).toEqual(sorted.map((m: any) => m.id));
  });

  it('a cursor from ANOTHER conversation cannot cross the boundary (falls back to this conversation only)', async () => {
    const start = await widgetChat({ userMessage: 'hello', customerName: 'Boundary Tester' });
    const convId = start.body.conversationId;
    const res = await widgetMessages(convId, { business: BIZ, after: 'msg-foreign-secret' });
    expect(res.status).toBe(200);
    const contents = JSON.stringify(res.body);
    expect(contents).not.toContain('FOREIGN-TENANT-SECRET-CONTENT');
    // Falls back to bootstrap: only THIS conversation's messages.
    for (const m of res.body.messages) {
      expect(m.id).not.toBe('msg-foreign-secret');
    }
  });
});

describe('widget message retrieval — human handoff loop', () => {
  it('customer → handoff → owner takeover+reply → widget poll → customer continues', async () => {
    // 1. Customer sends a message (enters a real conversation).
    const start = await widgetChat({ userMessage: 'I want a refund!', customerName: 'Handoff Loop' });
    expect(start.status).toBe(200);
    const convId = start.body.conversationId;
    let cursor: string | undefined = start.body.messageId;

    // 2. AI escalates to human (same tool path the runtime uses).
    const esc = await executeAgentTool('transfer_to_human', { reason: 'refund dispute' }, {
      tenantId: BIZ, conversationId: convId, toolsEnabled: ['transfer_to_human']
    });
    expect(esc.success).toBe(true);

    // 3. Owner takes over and replies through the EXISTING owner-side routes.
    const takeover = await tonyAgent.post(`/api/conversations/${convId}/takeover`);
    expect(takeover.status).toBe(200);
    const reply = await tonyAgent.post(`/api/conversations/${convId}/message`).send({ content: 'Hi, this is Tony — I will sort your refund out today.' });
    expect(reply.status).toBe(200);

    // 4. The widget polls with its cursor and receives the owner reply (+ notices), no duplicates on re-poll.
    const poll = await widgetMessages(convId, { business: BIZ, after: cursor });
    expect(poll.status).toBe(200);
    const humanMsgs = poll.body.messages.filter((m: any) => m.sender === 'human_agent');
    expect(humanMsgs.length).toBe(1);
    expect(humanMsgs[0].content).toContain('Tony');
    expect(poll.body.conversationStatus).toBe('HUMAN_HANDLING');

    const lastId = poll.body.messages[poll.body.messages.length - 1].id;
    const repoll = await widgetMessages(convId, { business: BIZ, after: lastId });
    expect(repoll.body.messages).toEqual([]);

    // 5. The customer can continue the conversation (holding reply while human handles it).
    const cont = await widgetChat({ userMessage: 'thank you', conversationId: convId, customerName: 'Handoff Loop' });
    expect(cont.status).toBe(200);
    expect(cont.body.reply).toContain('team member');
    // The new exchange is then visible to subsequent polls (cursor advances).
    const poll2 = await widgetMessages(convId, { business: BIZ, after: lastId });
    expect(poll2.body.messages.some((m: any) => m.sender === 'customer' && m.content === 'thank you')).toBe(true);
  });

  it('polling is bounded by the existing public rate limit', async () => {
    // The limiter is bypassed in test mode unless RATE_LIMIT_TEST=1 (the
    // project's existing opt-in hook for limiter tests).
    process.env.RATE_LIMIT_TEST = '1';
    try {
      const start = await widgetChat({ userMessage: 'hello', customerName: 'Rate Tester' });
      const convId = start.body.conversationId;
      // 60/min per business key (chat-messages prefix).
      let saw429 = false;
      for (let i = 0; i < 70; i++) {
        const r = await widgetMessages(convId, { business: BIZ });
        if (r.status === 429) { saw429 = true; break; }
      }
      expect(saw429).toBe(true);
    } finally {
      delete process.env.RATE_LIMIT_TEST;
    }
  });
});
