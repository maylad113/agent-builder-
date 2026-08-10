import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Widget cross-origin test (Phase 17 / critical test #10):
 *  - The widget POSTs from an external origin (Origin: https://business.example)
 *    to the platform's /api/runtime/chat.
 *  - The server must respond with Access-Control-Allow-Origin reflecting the
 *    request origin, so the browser allows the cross-origin fetch.
 *  - OPTIONS preflight must return 204 with the right CORS headers.
 *  - The dashboard (authenticated) routes must NOT return permissive CORS.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-widget-'));
process.env.DB_PATH = path.join(tmpDir, 'widget.db');
process.env.SESSION_SECRET = 'test-widget-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

const app = makeApp();

beforeAll(async () => {
  // ensure a business exists for the widget to address
});
afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const EXTERNAL_ORIGIN = 'https://business.example';

describe('widget cross-origin (Phase 17)', () => {
  it('reflects the request Origin and allows cross-origin POST', async () => {
    const res = await request(app)
      .post('/api/runtime/chat')
      .set('Origin', EXTERNAL_ORIGIN)
      .send({ tenantId: 'biz-tonys-barber', userMessage: 'hi' });
    // Without a Gemini key the runtime auto-escalates; either way the HTTP
    // response must carry CORS headers so the browser allows the fetch.
    expect(res.headers['access-control-allow-origin']).toBe(EXTERNAL_ORIGIN);
    expect(res.headers['vary']).toMatch(/Origin/);
  });

  it('handles OPTIONS preflight with 204 and CORS headers', async () => {
    const res = await request(app).options('/api/runtime/chat').set('Origin', EXTERNAL_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(EXTERNAL_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(res.headers['access-control-allow-headers']).toMatch(/Content-Type/);
  });

  it('authenticated dashboard route does not advertise permissive CORS', async () => {
    const res = await request(app).get('/api/businesses').set('Origin', EXTERNAL_ORIGIN);
    // /api/businesses requires auth; even on 401 it must not send an open
    // Access-Control-Allow-Origin header (no cross-origin dashboard access).
    expect(res.headers['access-control-allow-origin']).toBeFalsy();
  });
});
