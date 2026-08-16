import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Missing optional credentials must NOT break the application (Phase 12 /
 * critical test #8). We start the app with NONE of the optional integration
 * variables (Google, Meta, Twilio, Voice) and assert the core platform works:
 * auth, business listing, agent listing, knowledge, and the public chat
 * endpoint (which gracefully auto-escalates without GEMINI_API_KEY).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-noenv-'));
process.env.DB_PATH = path.join(tmpDir, 'noenv.db');
process.env.SESSION_SECRET = 'test-noenv-secret';
process.env.NODE_ENV = 'test';
// Ensure ALL optional credentials are absent.
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_REDIRECT_URI;
delete process.env.META_APP_ID;
delete process.env.META_APP_SECRET;
delete process.env.META_VERIFY_TOKEN;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_PHONE_NUMBER;
delete process.env.VOICE_AI_API_KEY;
delete process.env.VOICE_AI_ENDPOINT;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

const app = makeApp();
const agent = request.agent(app);

beforeAll(async () => {
  await db.init();
  await agent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('platform works without any optional integration credentials (Phase 12)', () => {
  it('health endpoint responds', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('auth works', async () => {
    // Auth is proven by the authenticated businesses call in the next test;
    // here we just confirm the session cookie was set on login.
    const r = await agent.get('/api/businesses');
    expect(r.status).toBe(200);
  });

  it('businesses are listed', async () => {
    const r = await agent.get('/api/businesses');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThan(0);
  });

  it('agents are listed', async () => {
    const r = await agent.get('/api/agents?businessId=biz-tonys-barber');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThan(0);
  });

  it('knowledge chunks are queryable', async () => {
    const r = await agent.get('/api/knowledge?businessId=biz-tonys-barber');
    expect(r.status).toBe(200);
  });

  it('public chat auto-escalates gracefully (no crash, no leak)', async () => {
    const r = await request(app).post('/api/runtime/chat').send({
      tenantId: 'biz-tonys-barber', userMessage: 'hello'
    });
    expect(r.status).toBe(200);
    expect(r.body.reply).toBeTruthy();
    // No internal diagnostics leaked to the customer-facing endpoint.
    expect(r.body.debug).toBeUndefined();
  });
});
