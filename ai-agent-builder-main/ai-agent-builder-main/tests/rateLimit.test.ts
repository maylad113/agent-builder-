import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * H1 — persistent rate limiting + widget origin verification.
 *
 * WIDGET IMPERSONATION ASSESSMENT (conclusion: gap already closed, NO signed
 * widget token added):
 *   The widget origin allow-list (widgetSecurity.ts, P1.2) already prevents a
 *   rogue page from impersonating another business in production:
 *     - POST /api/runtime/chat requires an Origin that matches the target
 *       business's allowedWidgetOrigins; anything else is 403 BEFORE the
 *       runtime is touched (routes.ts, origin middleware).
 *     - The OPTIONS preflight enforces the same allow-list.
 *     - In production a MISSING Origin is rejected outright (403), so a
 *       non-browser client cannot target an arbitrary tenantId to burn its LLM
 *       quota. (Also pinned by securityRegressions.test.ts.)
 *     - In non-production, no-Origin requests are allowed for the dev loop and
 *       allow-list-less businesses accept localhost origins only.
 *   A signed widget token (HMAC over businessId + expiry) was considered and
 *   NOT added: it would require key distribution/rotation without closing any
 *   reachable hole — an attacker would need (a) a browser loading a page from
 *   an origin the business allow-listed, or (b) a non-browser client, which
 *   production already rejects via the missing-Origin rule. The tests below
 *   pin the policy.
 *
 * RATE LIMITING:
 *   security.ts exposes a pluggable RateLimitStore (memory default in
 *   tests/dev; SQLite default in production). Test mode normally skips the
 *   limiter so the suite can drive many requests; this file opts in with
 *   RATE_LIMIT_TEST=1 and covers:
 *     1. sliding-window behavior — N allowed, N+1 → 429, window expiry allows
 *        again (tiny window via RATE_LIMIT_WINDOW_MS keeps the test fast),
 *     2. 429 coverage for the four public/expensive endpoint classes (login,
 *        public chat, generate-config, webhooks) — plus the /api umbrella in
 *        server.ts,
 *     3. widget origin policy (disallowed origin rejected, own origin served,
 *        production missing-Origin rejected).
 *   Restart persistence (the SQLite store surviving a close/reopen of the DB
 *   file) is proven in tests/rateLimitPersistence.test.ts.
 */
process.env.RATE_LIMIT_TEST = '1'; // opt in: exercise the limiter inside test mode
process.env.SESSION_SECRET = 'test-rate-limit-secret';
delete process.env.GEMINI_API_KEY;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-rl-'));
process.env.DB_PATH = path.join(tmpDir, 'rl.db');

const { router } = await import('../src/server/routes');
const { webhookRouter } = await import('../src/server/webhooks');
const { db, AppDatabase } = await import('../src/server/db');
const { setRateLimitStore, MemoryRateLimitStore, SqliteRateLimitStore } = await import('../src/server/security');

// Run migrations + seed demo data (the business allow-list test below reads
// the seeded 'biz-tonys-barber' business). Init is idempotent.
await db.init();

/** Mirrors server.ts mounting order: webhook router first, then body parsers,
 *  then the /api router (Meta needs the raw body, so it must run pre-json). */
function makeApp() {
  const app = express();
  app.use('/api/webhooks', webhookRouter);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/api', router);
  return app;
}
const app = makeApp();

afterAll(() => {
  try { db.close(); } catch { /* closed by the persistence test */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('sliding-window rate limiting (memory store)', () => {
  it('allows N requests, rejects N+1 with 429, then allows again after the window expires', async () => {
    const savedWindow = process.env.RATE_LIMIT_WINDOW_MS;
    process.env.RATE_LIMIT_WINDOW_MS = '150'; // tiny window: fast test
    try {
      const url = '/api/auth/login';
      // Login budget is max 10 (routes.ts). Requests 1..10 pass the limiter
      // (the handler rejects the empty body with 400 — we only care that the
      // limiter lets them through).
      for (let i = 0; i < 10; i++) {
        const r = await request(app).post(url).send({});
        expect(r.status).toBe(400);
      }
      // Request 11 exceeds the budget → 429.
      const blocked = await request(app).post(url).send({});
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      // Let the window elapse → the bucket resets and the caller is allowed.
      await new Promise(res => setTimeout(res, 220));
      const allowed = await request(app).post(url).send({});
      expect(allowed.status).toBe(400);
    } finally {
      if (savedWindow === undefined) delete process.env.RATE_LIMIT_WINDOW_MS;
      else process.env.RATE_LIMIT_WINDOW_MS = savedWindow;
    }
  });
});

describe('rate-limit coverage: every public/expensive endpoint class returns 429', () => {
  it('POST /api/runtime/chat (public widget chat, 60/min)', async () => {
    const url = '/api/runtime/chat';
    const body = { tenantId: 'biz-tonys-barber', userMessage: 'hi' };
    let last = 0;
    for (let i = 0; i < 60; i++) {
      last = (await request(app).post(url).send(body)).status;
    }
    expect(last).not.toBe(429); // 60 allowed
    const blocked = await request(app).post(url).send(body);
    expect(blocked.status).toBe(429);
  });

  it('POST /api/agents/generate-config (LLM generation, 20/min) — limited before auth', async () => {
    const url = '/api/agents/generate-config';
    const body = { name: 'X', type: 'general' };
    // The limiter runs BEFORE requireAuth, so unauthenticated hammering is
    // throttled: the first 20 are 401 (limiter passes, auth rejects) ...
    for (let i = 0; i < 20; i++) {
      const r = await request(app).post(url).send(body);
      expect(r.status).toBe(401);
    }
    // ... and the 21st is 429 regardless of auth.
    const blocked = await request(app).post(url).send(body);
    expect(blocked.status).toBe(429);
  });

  it('POST /api/webhooks/twilio (provider webhook, 300/min)', async () => {
    const url = '/api/webhooks/twilio';
    let last = 0;
    for (let i = 0; i < 300; i++) {
      // Twilio is not configured in tests → 403 before any processing.
      last = (await request(app).post(url).type('form').send({ CallSid: `CA${i}` })).status;
    }
    expect(last).toBe(403);
    const blocked = await request(app).post(url).type('form').send({ CallSid: 'CA-END' });
    expect(blocked.status).toBe(429);
  });
});

describe('widget origin policy (H1 assessment: allow-list already closes impersonation)', () => {
  beforeAll(async () => {
    // Fresh store: the chat coverage test above exhausted the 'chat' bucket.
    setRateLimitStore(new MemoryRateLimitStore());
    // Give the seed business a real allow-list, as an operator would before
    // embedding the widget (mirrors widget.test.ts).
    const biz = await db.businesses.find(b => b.id === 'biz-tonys-barber');
    if (biz) {
      biz.allowedWidgetOrigins = ['https://tonysbarber.example'];
      await db.businesses.update(biz);
    }
  });

  it('rejects a disallowed Origin (cross-tenant impersonation attempt)', async () => {
    const r = await request(app)
      .post('/api/runtime/chat')
      .set('Origin', 'https://evil.example')
      .send({ tenantId: 'biz-tonys-barber', userMessage: 'hi' });
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a disallowed Origin on the OPTIONS preflight', async () => {
    const r = await request(app)
      .options('/api/runtime/chat?business=biz-tonys-barber')
      .set('Origin', 'https://evil.example');
    expect(r.status).toBe(403);
  });

  it('serves the widget from the business\u2019s own allowed origin', async () => {
    const r = await request(app)
      .post('/api/runtime/chat')
      .set('Origin', 'https://tonysbarber.example')
      .send({ tenantId: 'biz-tonys-barber', userMessage: 'hi' });
    expect(r.status).not.toBe(403);
    expect(r.headers['access-control-allow-origin']).toBe('https://tonysbarber.example');
  });

  it('production: a missing Origin is rejected even with a valid tenantId', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const r = await request(app)
        .post('/api/runtime/chat')
        .send({ tenantId: 'biz-tonys-barber', userMessage: 'hi' });
      expect(r.status).toBe(403);
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });
});

describe('sqlite store unit behavior', () => {
  it('sweeps only expired buckets and keeps sliding-window counts intact', () => {
    // Exercises SqliteRateLimitStore directly on a scratch DB.
    const file = path.join(tmpDir, 'sweep.db');
    const conn = new AppDatabase({ dbPath: file, seed: false });
    const store = new SqliteRateLimitStore(conn.sqlite);
    const now = 1_700_000_000_000;
    store.incr('login:1.1.1.1', 60_000, now);       // count 1
    store.incr('login:1.1.1.1', 60_000, now + 10);  // count 2
    // An expired bucket (window_start 10 minutes ago) is swept away.
    store.incr('chat:2.2.2.2', 60_000, now - 600_000);
    store.sweep(now, 60_000);
    expect(store.incr('chat:2.2.2.2', 60_000, now).count).toBe(1); // swept → fresh
    expect(store.incr('login:1.1.1.1', 60_000, now + 20).count).toBe(3); // kept
    conn.close();
    fs.rmSync(file, { force: true });
    fs.rmSync(file + '-wal', { force: true });
    fs.rmSync(file + '-shm', { force: true });
  });
});
