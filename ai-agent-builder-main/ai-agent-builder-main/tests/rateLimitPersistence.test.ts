import { describe, it, expect, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * H1 — RESTART PERSISTENCE of the rate limiter (SQLite store).
 *
 * Runs in its own file because it needs RATE_LIMIT_STORE=sqlite BEFORE the
 * server modules are imported (the store is selected once at module load).
 *
 * Proof target: a server restart must NOT reset an attacker's limit budget.
 *   1. HTTP level: exhaust the login limit (10 allowed + 429), then simulate a
 *      restart by closing the DB and re-opening the SAME file with a fresh
 *      store — the very next request is STILL 429 without any new attempts.
 *   2. Store level: bucket counts persist across a close/reopen of the DB file.
 *
 * The memory store (tests/local dev default) intentionally does NOT survive
 * restarts; production defaults to the SQLite store for exactly this reason.
 */
process.env.RATE_LIMIT_TEST = '1'; // opt in: exercise the limiter inside test mode
process.env.RATE_LIMIT_STORE = 'sqlite'; // persistent backend under test
process.env.SESSION_SECRET = 'test-rate-limit-persistence-secret';
delete process.env.GEMINI_API_KEY;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-rlpersist-'));
process.env.DB_PATH = path.join(tmpDir, 'persist.db');

const { router } = await import('../src/server/routes');
const { db, AppDatabase } = await import('../src/server/db');
const { SqliteRateLimitStore, setRateLimitStore } = await import('../src/server/security');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();

afterAll(() => {
  try { db.close(); } catch { /* already closed by the restart test */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('restart persistence (RATE_LIMIT_STORE=sqlite)', () => {
  it('a re-opened DB keeps an exhausted caller limited (429) — no new attempts needed', async () => {
    // The module-level store is already SqliteRateLimitStore over the app's
    // temp DB (env above). Make it explicit for clarity.
    setRateLimitStore(new SqliteRateLimitStore(db.sqlite));

    const url = '/api/auth/login';
    // Exhaust the login budget (max 10): requests 1..10 pass (400: empty body).
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post(url).send({});
      expect(r.status).toBe(400);
    }
    const blocked = await request(app).post(url).send({});
    expect(blocked.status).toBe(429);

    // Simulate a server restart: close the DB, reopen the SAME file with a
    // fresh connection, and re-create the store over it (as a restarted server
    // would at boot).
    db.close();
    const reopened = new AppDatabase({ dbPath: process.env.DB_PATH as string, seed: false });
    setRateLimitStore(new SqliteRateLimitStore(reopened.sqlite));

    // The caller must STILL be limited — the bucket state survived the restart.
    const afterRestart = await request(app).post(url).send({});
    expect(afterRestart.status).toBe(429);
    reopened.close();
  });

  it('store-level: bucket counts persist across close/reopen of the DB file', () => {
    const file = path.join(tmpDir, 'store-persist.db');
    const now = 1_700_000_000_000;

    const connA = new AppDatabase({ dbPath: file, seed: false });
    const storeA = new SqliteRateLimitStore(connA.sqlite);
    let count = 0;
    for (let i = 0; i < 11; i++) {
      count = storeA.incr('chat:9.9.9.9', 60_000, now + i).count;
    }
    expect(count).toBe(11); // > 10 → the middleware would 429
    connA.close();

    // "Restart": reopen the same file.
    const connB = new AppDatabase({ dbPath: file, seed: false });
    const storeB = new SqliteRateLimitStore(connB.sqlite);
    const after = storeB.incr('chat:9.9.9.9', 60_000, now + 100);
    expect(after.count).toBe(12); // state survived — still over the limit
    connB.close();
  });
});
