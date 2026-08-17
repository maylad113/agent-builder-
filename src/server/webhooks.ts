import express, { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from './db';
import { processAgentMessage } from './agentRuntime';
import { getCredentials } from './integrations';
import { rateLimit, RATE_LIMITS } from './security';
import { safeError } from './logSanitizer';

/**
 * Phase 14/15: External channel webhooks (Meta/Instagram + Twilio/SMS).
 *
 * Design (per the production hardening spec):
 *   Meta webhook  -> verify subscription -> identify business -> normalize event
 *                    -> conversation -> Agent Runtime -> response -> Meta API
 *   Twilio webhook-> call status lookup -> missed-call detection -> create/update
 *                    customer -> conversation -> SMS follow-up -> Agent Runtime
 *
 * Security invariants:
 *   - Never trust inbound `businessId`. The business is ALWAYS resolved server-side
 *     from the configured channel/phone number / Meta page id, then verified against
 *     the integration's stored credentials.
 *   - Webhook signatures are verified when a verify token / app secret is present.
 *     When no secret is configured the integration is NOT_CONFIGURED and the
 *     endpoint returns 403 (it never processes unverified inbound traffic).
 *   - Duplicate webhook delivery is idempotent: a seen message-id within the
 *     retention window is acknowledged but never re-processed (so a re-delivered
 *     event cannot create a second booking or send a second reply).
 *   - The wrong business can never reply: the response is sent through the
 *     business's own configured provider credentials only.
 */

export const webhookRouter = Router();

// H1: provider webhooks are PUBLIC endpoints that can trigger LLM replies (an
// inbound message runs the agent runtime). Rate-limit per IP as defense-in-depth
// on top of signature verification. The budget (RATE_LIMITS.webhooks) is
// generous so legitimate provider bursts — Twilio callbacks, Meta event pages —
// are never dropped, while a rogue client hammering the endpoint is throttled.
webhookRouter.use(rateLimit({ ...RATE_LIMITS.webhooks, prefix: 'webhook' }));

// ---------------------------------------------------------------------------
// Idempotency: persist processed inbound message ids in the database so a
// duplicate delivery after a server restart is STILL deduplicated (audit P1.5).
// The in-memory Map (used pre-audit) reset on every restart, so a provider
// retrying delivery of an event seen before the restart could create a second
// booking/reply. The `processed_webhooks` table is self-provisioned (idempotent)
// so the check works regardless of migration ordering. On PostgreSQL this is a
// real upsert; on SQLite INSERT OR IGNORE atomically deduplicates.
// ---------------------------------------------------------------------------
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours (covers provider retry windows)

function ensureProcessedWebhooksTable(): void {
  const sqlite = db.sqlite;
  if (!sqlite) return; // Postgres dialect: table created by migration
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS processed_webhooks (
       id TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_processed_webhooks_created_at
       ON processed_webhooks(created_at);`
  );
}

async function isDuplicate(id: string): Promise<boolean> {
  ensureProcessedWebhooksTable();
  const now = Date.now();
  // SQLite uses the self-provisioned processed_webhooks(id, created_at) table.
  // PostgreSQL has the richer webhook_processed_events(source, event_id) table
  // (created in migrations/pg/001) — use it directly. Both paths atomically
  // dedupe: SQLite via INSERT OR IGNORE, PG via ON CONFLICT DO NOTHING.
  let res;
  if (db.client.dialect === 'sqlite') {
    res = await db.client.exec(
      'INSERT OR IGNORE INTO processed_webhooks (id, created_at) VALUES (?, ?)',
      [id, now]
    );
  } else {
    // source is a fixed namespace; event_id is the provider message/call id.
    res = await db.client.exec(
      'INSERT INTO webhook_processed_events (source, event_id, business_id, processed_at) VALUES (?, ?, ?, ?) ON CONFLICT (source, event_id) DO NOTHING',
      ['inbound', id, null, new Date().toISOString()]
    );
  }
  // Opportunistic, bounded cleanup of ancient entries (best-effort, never throws).
  try {
    if (db.client.dialect === 'sqlite') {
      await db.client.exec('DELETE FROM processed_webhooks WHERE created_at < ?', [now - MAX_AGE_MS]);
    } else {
      await db.client.exec("DELETE FROM webhook_processed_events WHERE processed_at < ?", [new Date(now - MAX_AGE_MS).toISOString()]);
    }
  } catch { /* ignore cleanup errors */ }
  return res.changes === 0;
}

// ---------------------------------------------------------------------------
// Meta / Instagram Business Messaging
// https://developers.facebook.com/docs/messenger-platform/instagram
// ---------------------------------------------------------------------------

function metaVerifyToken(): string | undefined {
  return process.env.META_VERIFY_TOKEN;
}

function metaAppSecret(): string | undefined {
  return process.env.META_APP_SECRET;
}

/** Verify the X-Hub-Signature-256 header against the raw body using the app secret. */
function verifyMetaSignature(rawBody: string | Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader) return false;
  // Header format: "sha256=<hex>"
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

/**
 * Resolve the business that owns a given Meta page/IG account id. The mapping is
 * stored on the business's meta_instagram integration configData (pageId/igUserId).
 * This is the ONLY way an inbound Meta event reaches a business — the page id in
 * the payload is matched server-side, never trusting any client-supplied tenant.
 */
async function resolveBusinessByMetaPageId(pageId: string): Promise<{ businessId: string; integrationId: string } | null> {
  for (const integ of await db.integrations.toJSON()) {
    if (integ.provider !== 'meta_instagram') continue;
    const cfg = integ.configData || {};
    if (cfg.pageId === pageId || cfg.igUserId === pageId) {
      return { businessId: integ.businessId, integrationId: integ.id };
    }
  }
  return null;
}

/** Send a reply back to the Instagram sender via the Meta Graph API. */
async function sendMetaReply(creds: Record<string, string>, pageScopedUserId: string, text: string): Promise<void> {
  const token = creds.META_PAGE_ACCESS_TOKEN || creds.META_ACCESS_TOKEN;
  if (!token) return; // no token -> cannot reply; logged elsewhere
  const endpoint = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(token)}`;
  const body = JSON.stringify({ recipient: { id: pageScopedUserId }, message: { text } });
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    // Network/provider failure must not crash the webhook; it is logged.
    safeError('[webhook:meta] reply failed:', err);
  }
}

// Meta uses the raw body for signature verification. Express's json() parser
// consumes the stream, so we register a per-route raw parser that reads the
// raw bytes before JSON parsing for the POST route only.
const rawBodyParser = (req: Request, _res: Response, next: () => void) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => { data += chunk; });
  req.on('end', () => {
    (req as any).rawBody = data;
    try {
      (req as any).body = data ? JSON.parse(data) : {};
    } catch {
      (req as any).body = {};
    }
    next();
  });
};

// GET /api/webhooks/meta — subscription verification (hub.mode=subscribe).
webhookRouter.get('/meta', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = metaVerifyToken();

  // If Meta isn't configured at all, the endpoint must not pretend to verify.
  if (!expected) {
    return res.status(403).json({ error: 'Meta integration not configured.' });
  }
  if (mode === 'subscribe' && token === expected) {
    return res.status(200).send(String(challenge ?? ''));
  }
  return res.sendStatus(403);
});

// POST /api/webhooks/meta — inbound messages + delivery/echo events.
webhookRouter.post('/meta', rawBodyParser, async (req: Request, res: Response) => {
  // Always acknowledge Meta quickly; processing happens after we respond 200.
  const ack = () => res.status(200).json({ received: true });

  const appSecret = metaAppSecret();
  // Without an app secret we cannot verify the payload signature -> reject.
  if (!appSecret) return res.status(403).json({ error: 'Meta integration not configured.' });

  if (!verifyMetaSignature((req as any).rawBody ?? '', req.get('X-Hub-Signature-256'), appSecret)) {
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  const body = req.body as any;
  // Meta delivers an array of entries; some are delivery/echo/read and have no
  // customer message. Acknowledge and ignore those.
  const entries: any[] = body?.entry ?? [];
  for (const entry of entries) {
    const messaging: any[] = entry?.messaging ?? [];
    for (const ev of messaging) {
      const msg = ev?.message;
      // Skip echoes (our own replies) and non-message events.
      if (!msg || ev.is_echo || !msg.text) continue;

      const senderId = ev?.sender?.id;
      const recipientId = ev?.recipient?.id; // the business's page/IG id
      const messageId = msg.mid || `${ev.sender?.id}:${ev.timestamp}`;
      if (!senderId || !recipientId) continue;

      // Idempotency: a re-delivered webhook must not produce a duplicate reply.
      if (await isDuplicate(messageId)) continue;

      // Resolve the business from the page id the message was sent TO.
      const resolved = await resolveBusinessByMetaPageId(recipientId);
      if (!resolved) continue; // no business owns this page -> drop silently

      const creds = (await getCredentials(resolved.integrationId, resolved.businessId)) || {};
      // Run the agent against the published version for that business.
      try {
        const result = await processAgentMessage({
          tenantId: resolved.businessId,
          userMessage: msg.text,
          channel: 'instagram',
          customerName: 'IG Customer',
        });
        const reply = result.reply || 'Sorry, I could not process that.';
        await sendMetaReply(creds, senderId, reply);
      } catch (err) {
        safeError('[webhook:meta] runtime error:', err);
      }
    }
  }
  return ack();
});

// ---------------------------------------------------------------------------
// Twilio / SMS — missed-call AI receptionist
// ---------------------------------------------------------------------------

function twilioAuthToken(): string | undefined {
  return process.env.TWILIO_AUTH_TOKEN;
}

function twilioAccountSid(): string | undefined {
  return process.env.TWILIO_ACCOUNT_SID;
}

/**
 * Validate the Twilio request signature (X-Twilio-Signature).
 * Twilio signs the full URL + sorted form params with HMAC-SHA1 using the auth
 * token. Because our parser above is JSON-oriented, the Twilio route uses
 * express.urlencoded (mounted at the app level) and reconstructs the param map
 * from req.body.
 */
function verifyTwilioSignature(url: string, params: Record<string, string>, signatureHeader: string | undefined, authToken: string): boolean {
  if (!signatureHeader) return false;
  // Build the data Twilio signs: url + sorted key=value pairs.
  let data = url;
  const keys = Object.keys(params).sort();
  for (const k of keys) data += k + (params[k] ?? '');
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

/** Resolve a business by the Twilio phone number the inbound call/SMS reached. */
async function resolveBusinessByPhoneNumber(phone: string): Promise<{ businessId: string; integrationId: string } | null> {
  if (!phone) return null;
  const norm = phone.replace(/\D/g, '');
  for (const integ of await db.integrations.toJSON()) {
    if (integ.provider !== 'twilio_sms') continue;
    const cfg = integ.configData || {};
    const cfgNum = (cfg.phoneNumber || '').replace(/\D/g, '');
    if (cfgNum && cfgNum === norm) {
      return { businessId: integ.businessId, integrationId: integ.id };
    }
  }
  return null;
}

/** Send an SMS reply through the business's Twilio credentials. */
async function sendTwilioSms(creds: Record<string, string>, fromNumber: string, toNumber: string, body: string): Promise<void> {
  const sid = creds.TWILIO_ACCOUNT_SID || twilioAccountSid();
  const token = creds.TWILIO_AUTH_TOKEN || twilioAuthToken();
  if (!sid || !token || !fromNumber) return;
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const form = new URLSearchParams({ From: fromNumber, To: toNumber, Body: body });
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  } catch (err) {
    safeError('[webhook:twilio] sms send failed:', err);
  }
}

/** Customer SMS opt-out preferences (in-memory set of opted-out numbers per business). */
const optedOut = new Set<string>(); // `${businessId}:${phone}`
function isOptedOut(businessId: string, phone: string): boolean {
  return optedOut.has(`${businessId}:${phone}`);
}
function setOptedOut(businessId: string, phone: string): void {
  optedOut.add(`${businessId}:${phone}`);
}

// Twilio sends application/x-www-form-urlencoded. Install a per-route parser so
// the Twilio handler receives req.body as a flat string map. (The production
// server mounts the webhook router before any global body parser, so we own
// parsing for these routes.)
const twilioFormParser = express.urlencoded({ extended: false, limit: '1mb' });

/**
 * POST /api/webhooks/twilio — handles BOTH voice call status callbacks and
 * inbound SMS replies. Twilio posts form-urlencoded data.
 *
 * Missed-call workflow:
 *   call status (no answer) -> create/update customer -> start conversation ->
 *   send SMS follow-up -> (customer replies) -> Agent Runtime -> reply by SMS.
 */
webhookRouter.post('/twilio', twilioFormParser, async (req: Request, res: Response) => {
  const authToken = twilioAuthToken();
  if (!authToken) return res.status(403).json({ error: 'Twilio integration not configured.' });

  // Reconstruct the full URL Twilio signed (without proxy nuances for dev).
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host') || '';
  const url = `${proto}://${host}/api/webhooks/twilio`;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.body || {})) params[k] = String(v);

  if (!verifyTwilioSignature(url, params, req.get('X-Twilio-Signature'), authToken)) {
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  const callStatus = params.CallStatus;
  const messageSid = params.MessageSid;
  const fromNumber = params.From || params.Caller;
  const toNumber = params.To || params.Called;

  // --- Inbound SMS reply path ---
  if (messageSid && params.Body) {
    // Idempotency on the provider message id.
    if (await isDuplicate(messageSid)) return res.status(200).type('text/xml').send('<Response/>');

    const resolved = await resolveBusinessByPhoneNumber(toNumber);
    if (!resolved) return res.status(200).type('text/xml').send('<Response/>');
    if (isOptedOut(resolved.businessId, fromNumber)) {
      // Honour opt-out: never reply to a customer who opted out.
      return res.status(200).type('text/xml').send('<Response/>');
    }
    const text = String(params.Body).trim();
    const lower = text.toLowerCase();
    if (lower === 'stop' || lower === 'unsubscribe' || lower === 'cancel') {
      setOptedOut(resolved.businessId, fromNumber);
      return res.status(200).type('text/xml').send('<Response/>');
    }

    const creds = (await getCredentials(resolved.integrationId, resolved.businessId)) || {};
    try {
      const result = await processAgentMessage({
        tenantId: resolved.businessId,
        userMessage: text,
        channel: 'sms',
        customerName: 'SMS Caller',
        customerPhone: fromNumber,
      });
      const reply = result.reply || 'Sorry, I could not process that.';
      await sendTwilioSms(creds, toNumber, fromNumber, reply);
    } catch (err) {
      safeError('[webhook:twilio] sms runtime error:', err);
    }
    return res.status(200).type('text/xml').send('<Response/>');
  }

  // --- Voice call status path (missed-call AI receptionist) ---
  if (callStatus) {
    const callSid = params.CallSid;
    if (callSid && await isDuplicate(`call:${callSid}`)) {
      return res.status(200).type('text/xml').send('<Response/>');
    }
    // Missed call = no-answer / failed / busy while ringing the business.
    const missed = ['no-answer', 'failed', 'busy'].includes(callStatus);
    if (!missed || !fromNumber || !toNumber) {
      return res.status(200).type('text/xml').send('<Response/>');
    }

    const resolved = await resolveBusinessByPhoneNumber(toNumber);
    if (!resolved) return res.status(200).type('text/xml').send('<Response/>');
    if (isOptedOut(resolved.businessId, fromNumber)) {
      return res.status(200).type('text/xml').send('<Response/>');
    }

    // Create/update the customer record for this caller (tenant-scoped).
    let customer = await db.customers.find(c => c.businessId === resolved.businessId && c.phone === fromNumber);
    if (!customer) {
      customer = {
        id: `cust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        businessId: resolved.businessId,
        name: 'Missed Call',
        phone: fromNumber,
        createdAt: new Date().toISOString(),
      };
      await db.customers.push(customer);
    }

    // Trigger the missed-call follow-up via the agent (template-driven intro).
    const followUp = process.env.TWILIO_MISSED_CALL_TEMPLATE ||
      'Hi, we missed your call. How can I help you today? (Reply STOP to opt out)';
    const creds = (await getCredentials(resolved.integrationId, resolved.businessId)) || {};
    try {
      // Run the agent with the missed-call prompt so it can answer questions
      // and book an appointment if the customer replies, then send the intro.
      const result = await processAgentMessage({
        tenantId: resolved.businessId,
        userMessage: followUp,
        channel: 'sms',
        customerName: customer.name,
        customerPhone: fromNumber,
      });
      const reply = result.reply || followUp;
      await sendTwilioSms(creds, toNumber, fromNumber, reply);
    } catch (err) {
      safeError('[webhook:twilio] missed-call follow-up error:', err);
      // Even if the AI fails, send the static template so the customer isn't
      // left with silence — the agent will engage on their next reply.
      await sendTwilioSms(creds, toNumber, fromNumber, followUp);
    }
    return res.status(200).type('text/xml').send('<Response/>');
  }

  // Unknown event shape -> acknowledge.
  return res.status(200).type('text/xml').send('<Response/>');
});
