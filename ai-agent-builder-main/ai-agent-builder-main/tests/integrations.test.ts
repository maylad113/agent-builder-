import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Integration security tests (P1.1).
 *
 * Proves the secure integration lifecycle:
 *  - The PUT /integrations/:id route NEVER accepts `state`/`connected` from the
 *    client (mass-assignment protection). Setting them has no effect.
 *  - The ONLY path to CONNECTED is POST /:id/credentials + POST /:id/validate.
 *  - validate() with bogus credentials yields state=ERROR (never fake-CONNECTED).
 *  - Credentials are never echoed back in the GET /integrations response.
 *  - Disconnect clears credentials and sets state=DISCONNECTED.
 *
 * These hit real provider HTTP probes (Google/Meta/Twilio), which will fail
 * against bogus credentials — that is the correct behavior we assert.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-integ-'));
process.env.DB_PATH = path.join(tmpDir, 'integ.db');
process.env.SESSION_SECRET = 'test-integ-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;
// Provide platform OAuth config so providers are "platformConfigured", but the
// submitted user credentials will be bogus and the real API probe must fail.
process.env.GOOGLE_CLIENT_ID = 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const platformAgent = request.agent(app);

let googleIntegId = '';

beforeAll(async () => {
  await db.init();
  const login = await platformAgent.post('/api/auth/login').send({
    email: 'owner@agentfactory.io',
    password: 'Password123!'
  });
  expect(login.status).toBe(200);

  // Find the seeded Google Calendar integration for Tony's.
  const list = await platformAgent.get('/api/integrations');
  const google = list.body.find((i: any) => i.provider === 'google_calendar');
  expect(google).toBeDefined();
  googleIntegId = google.id;
  expect(google.state).toBe('NOT_CONFIGURED');
});

afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('integration lifecycle security (P1.1)', () => {
  it('rejects client-supplied state/connected via PUT (mass-assignment guard)', async () => {
    const res = await platformAgent.put(`/api/integrations/${googleIntegId}`).send({
      state: 'CONNECTED',
      connected: true,
      credentialsSet: true,
      statusMessage: 'Hacked',
      configData: { calendarId: 'cal@example.com' }
    });
    expect(res.status).toBe(200);
    // state must NOT have changed to CONNECTED from the client payload.
    expect(res.body.state).not.toBe('CONNECTED');
    expect(res.body.credentialsSet).not.toBe(true);
  });

  it('storing credentials marks CONFIGURING (not CONNECTED)', async () => {
    const res = await platformAgent.post(`/api/integrations/${googleIntegId}/credentials`).send({
      credentials: { access_token: 'bogus-token-xyz' }
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('CONFIGURING');
    expect(res.body.statusMessage).toMatch(/pending validation/i);
  });

  it('validate with bogus credentials yields ERROR (never fake CONNECTED)', async () => {
    // The Google provider probes the real calendar API; bogus token => 401/403.
    const res = await platformAgent.post(`/api/integrations/${googleIntegId}/validate`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ERROR');
    expect(res.body.lastError).toBeTruthy();
  });

  it('never echoes credentials in the integration list', async () => {
    const list = await platformAgent.get('/api/integrations');
    const g = list.body.find((i: any) => i.id === googleIntegId);
    expect(g).toBeDefined();
    // No credentials field anywhere on the public shape.
    expect(g.credentials).toBeUndefined();
    expect(g.access_token).toBeUndefined();
    expect(g.configData).toEqual(expect.not.objectContaining({ access_token: expect.anything() }));
  });

  it('disconnect clears credentials and sets DISCONNECTED', async () => {
    const res = await platformAgent.post(`/api/integrations/${googleIntegId}/disconnect`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('DISCONNECTED');

    // A subsequent validate without new credentials must be rejected.
    const revalidate = await platformAgent.post(`/api/integrations/${googleIntegId}/validate`);
    expect(revalidate.status).toBe(400);
  });
});
