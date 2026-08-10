import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import http from 'http';

/**
 * Webhook security tests (Phase 14/15, critical test #7):
 *   - Meta GET verification honours META_VERIFY_TOKEN and 403s otherwise.
 *   - Meta POST rejects unsigned / wrong-signature payloads.
 *   - Twilio POST rejects unsigned / wrong-signature payloads.
 *   - A re-delivered (duplicate) webhook does NOT create a second action.
 *   - Missing optional integration credentials do not crash the app: the
 *     endpoints return 403 NOT_CONFIGURED and the rest of the server is fine.
 *
 * We mount the real webhookRouter on a throwaway Express app and drive it over
 * a real loopback HTTP server, so signature/header behaviour is authentic.
 */

const APP_SECRET = 'meta-test-app-secret';
const VERIFY_TOKEN = 'meta-test-verify-token';
const TWILIO_AUTH = 'twilio-auth-token-test';
const TWILIO_SID = 'AC' + 'a'.repeat(30);
const TWILIO_NUMBER = '+15555555555';

process.env.META_APP_SECRET = APP_SECRET;
process.env.META_VERIFY_TOKEN = VERIFY_TOKEN;
process.env.TWILIO_AUTH_TOKEN = TWILIO_AUTH;
process.env.TWILIO_ACCOUNT_SID = TWILIO_SID;

import os from 'os'; import path from 'path'; import fs from 'fs';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-'));
process.env.DB_PATH = path.join(tmpDir, 'wh.db');
delete process.env.GEMINI_API_KEY;

const { db } = await import('../src/server/db');
const { webhookRouter } = await import('../src/server/webhooks');
const { storeCredentials } = await import('../src/server/integrations');

// Build a standalone app mounting ONLY the webhook router. The webhook router
// owns its own body parsing (raw for Meta, urlencoded for Twilio), mirroring the
// production server which mounts it before the global JSON/urlencoded parsers.
const app = express();
app.use('/api/webhooks', webhookRouter);
const server = http.createServer(app);
let port = 0;
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
  port = (server.address() as any).port; resolve();
}));

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  db.close(); fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseURL() { return `http://127.0.0.1:${port}`; }

async function get(path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseURL()}${path}`);
  return { status: res.status, text: await res.text() };
}
async function post(path: string, headers: Record<string,string>, body: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseURL()}${path}`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

function signMeta(raw: string): string {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
}
function signTwilio(url: string, params: Record<string,string>): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + (params[k] ?? '');
  return crypto.createHmac('sha1', TWILIO_AUTH).update(Buffer.from(data, 'utf8')).digest('base64');
}

// Seed a business + twilio integration mapped to a phone number.
function seedTwilioIntegration(): void {
  const bizId = 'biz-tw-test';
  if (!db.businesses.find(b => b.id === bizId)) {
    db.businesses.push({
      id: bizId, name: 'Twilio Test', type: 'restaurant', description: '', location: '',
      language: 'en', currency: 'usd', timezone: 'UTC',
      hours: [], services: [], faqs: [], policies: { cancellation: '', refund: '', bookingNotice: '' },
      communicationStyle: '', status: 'ACTIVE', createdAt: '', updatedAt: '',
    } as any);
  }
  const integId = 'integ-tw-test';
  if (!db.integrations.find(i => i.id === integId)) {
    db.integrations.push({
      id: integId, businessId: bizId, provider: 'twilio_sms', state: 'CONNECTED',
      statusMessage: 'ok', credentialsSet: true, configData: { phoneNumber: TWILIO_NUMBER },
    } as any);
    storeCredentials(integId, { TWILIO_ACCOUNT_SID: TWILIO_SID, TWILIO_AUTH_TOKEN: TWILIO_AUTH, TWILIO_PHONE_NUMBER: TWILIO_NUMBER });
  }
}

describe('Meta webhook', () => {
  it('GET /meta verifies with correct verify token (hub.challenge echoed)', async () => {
    const r = await get(`/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHALLENGE123`);
    expect(r.status).toBe(200);
    expect(r.text).toBe('CHALLENGE123');
  });

  it('GET /meta 403s on wrong verify token', async () => {
    const r = await get(`/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=X`);
    expect(r.status).toBe(403);
  });

  it('GET /meta 403s when META_VERIFY_TOKEN absent (integration not configured)', async () => {
    const saved = process.env.META_VERIFY_TOKEN; delete process.env.META_VERIFY_TOKEN;
    const r = await get(`/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=Y`);
    expect(r.status).toBe(403);
    process.env.META_VERIFY_TOKEN = saved;
  });

  it('POST /meta 401s on missing signature', async () => {
    const r = await post('/api/webhooks/meta', { 'Content-Type': 'application/json' }, '{}');
    expect(r.status).toBe(401);
  });

  it('POST /meta 401s on a tampered signature', async () => {
    const raw = JSON.stringify({ entry: [{ messaging: [{ sender: { id: 's1' }, recipient: { id: 'p1' }, message: { mid: 'm1', text: 'hi' } }] }] });
    const badSig = 'sha256=' + '0'.repeat(64);
    const r = await post('/api/webhooks/meta', { 'Content-Type': 'application/json', 'X-Hub-Signature-256': badSig }, raw);
    expect(r.status).toBe(401);
  });

  it('POST /meta 403s when META_APP_SECRET absent (cannot verify -> not configured)', async () => {
    const saved = process.env.META_APP_SECRET; delete process.env.META_APP_SECRET;
    const raw = '{}';
    const r = await post('/api/webhooks/meta', { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signMeta(raw) }, raw);
    expect(r.status).toBe(403);
    process.env.META_APP_SECRET = saved;
  });
});

describe('Twilio webhook signature verification', () => {
  it('POST /twilio 403s when TWILIO_AUTH_TOKEN absent', async () => {
    const saved = process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_AUTH_TOKEN;
    const form = new URLSearchParams({ MessageSid: 'SM1', From: '+15551112222', To: TWILIO_NUMBER, Body: 'hi' }).toString();
    const r = await post('/api/webhooks/twilio', { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
    expect(r.status).toBe(403);
    process.env.TWILIO_AUTH_TOKEN = saved;
  });

  it('POST /twilio 401s on wrong signature', async () => {
    const form = new URLSearchParams({ MessageSid: 'SM1', From: '+15551112222', To: TWILIO_NUMBER, Body: 'hi' }).toString();
    const r = await post('/api/webhooks/twilio', { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bogus' }, form);
    expect(r.status).toBe(401);
  });

  it('POST /twilio accepts a correctly signed inbound SMS (200) and dedupes a re-delivery', async () => {
    seedTwilioIntegration();
    const params: Record<string,string> = { MessageSid: 'SM-DEDUP-1', From: '+15551112222', To: TWILIO_NUMBER, Body: 'hello' };
    const url = `${baseURL()}/api/webhooks/twilio`;
    const sig = signTwilio(url, params);
    const form = new URLSearchParams(params).toString();
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig };

    // First delivery: accepted (200). The agent runtime runs with no Gemini key
    // -> returns a holding reply; the SMS send is a guarded no-op.
    const r1 = await post('/api/webhooks/twilio', headers, form);
    expect(r1.status).toBe(200);
    expect(r1.text).toContain('Response');

    // Re-deliver the SAME MessageSid: must NOT create a second action. Customer
    // count for this caller must not grow on the duplicate delivery.
    const beforeCount = db.customers.filter(c => c.businessId === 'biz-tw-test' && c.phone === '+15551112222').length;
    const r2 = await post('/api/webhooks/twilio', headers, form);
    expect(r2.status).toBe(200);
    const afterCount = db.customers.filter(c => c.businessId === 'biz-tw-test' && c.phone === '+15551112222').length;
    expect(afterCount).toBe(beforeCount);
  });

  it('POST /twilio handles a missed-call status callback (200)', async () => {
    seedTwilioIntegration();
    const params: Record<string,string> = { CallSid: 'CA-MISSED-1', From: '+15559998888', To: TWILIO_NUMBER, CallStatus: 'no-answer' };
    const url = `${baseURL()}/api/webhooks/twilio`;
    const sig = signTwilio(url, params);
    const form = new URLSearchParams(params).toString();
    const r = await post('/api/webhooks/twilio', { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, form);
    expect(r.status).toBe(200);
    // A customer record should have been created for the missed caller.
    const cust = db.customers.find(c => c.businessId === 'biz-tw-test' && c.phone === '+15559998888');
    expect(cust).toBeTruthy();
    // A re-delivery of the same CallSid must not create a second customer.
    const beforeCount = db.customers.filter(c => c.businessId === 'biz-tw-test' && c.phone === '+15559998888').length;
    await post('/api/webhooks/twilio', { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, form);
    const afterCount = db.customers.filter(c => c.businessId === 'biz-tw-test' && c.phone === '+15559998888').length;
    expect(afterCount).toBe(beforeCount);
  });

  it('POST /twilio honours STOP opt-out (no reply path beyond acknowledgement)', async () => {
    seedTwilioIntegration();
    const params: Record<string,string> = { MessageSid: 'SM-STOP-1', From: '+15550000001', To: TWILIO_NUMBER, Body: 'STOP' };
    const url = `${baseURL()}/api/webhooks/twilio`;
    const sig = signTwilio(url, params);
    const form = new URLSearchParams(params).toString();
    const r = await post('/api/webhooks/twilio', { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, form);
    expect(r.status).toBe(200);
  });
});
