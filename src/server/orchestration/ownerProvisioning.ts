import crypto from 'crypto';
import { db } from '../db';
import { hashPassword } from '../passwords';
import { toPublicUser } from '../auth';
import { recordOrchestrationEvent } from '../telemetry';
import { Delivery, PublicUser, User } from '../../types';

/**
 * Owner-account provisioning at delivery (Task 23).
 *
 * The delivered business owner must be able to log into the platform and
 * manage their agent. This module creates a BUSINESS_OWNER user for an
 * EXISTING delivery's business using the EXISTING users table + the existing
 * scrypt password hashing — no new authentication architecture.
 *
 * SECURITY INVARIANTS:
 *  - The one-time temporary password is generated server-side with
 *    crypto.randomBytes, stored ONLY as the existing scrypt hash, returned
 *    ONLY on the initial provisioning response, and NEVER stored in
 *    plaintext, logged, recorded in telemetry/audit, or returned on replay.
 *  - Idempotent per delivery: the provisioned user id is recorded on the
 *    delivery payload; a replay returns the existing account's public info
 *    WITHOUT a password and NEVER creates a second user.
 *  - Concurrency: the delivery row is locked inside a transaction (PG
 *    FOR UPDATE; SQLite serializes on the connection mutex), so a racing
 *    request waits for the winner and re-reads the resulting account. The
 *    users.email UNIQUE constraint remains the global backstop.
 *  - Duplicate email: rejected with a safe generic error — never discloses
 *    the other account's tenant/business, never modifies or reassigns it.
 *  - The delivery (path id) is the sole authority for the business; every
 *    client-supplied server-owned field (businessId/tenantId/role/password/
 *    createdAt/...) is ignored.
 */

const MAX_EMAIL_LEN = 254; // RFC 5321 path limit
const MAX_NAME_LEN = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ProvisionOwnerAccountResult {
  user: PublicUser;
  /** True when the delivery was already provisioned (idempotent replay). */
  alreadyProvisioned: boolean;
  /** One-time temporary password — present ONLY on the initial provisioning
   *  response. Absent on every replay. */
  temporaryPassword?: string;
}

function normalizeEmail(raw: unknown): string {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
    throw new Error('A valid email address is required.');
  }
  return email;
}

function cleanName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!name) throw new Error('A name is required.');
  if (name.length > MAX_NAME_LEN) throw new Error('Name is too long.');
  return name;
}

export async function provisionOwnerAccount(
  deliveryId: string,
  input: { email?: unknown; name?: unknown }
): Promise<ProvisionOwnerAccountResult> {
  const email = normalizeEmail(input.email);
  const name = cleanName(input.name);

  const result = await db.client.transaction(async (): Promise<ProvisionOwnerAccountResult> => {
    // Lock the delivery row FIRST (PG row lock; SQLite strips FOR UPDATE and
    // the per-connection mutex serializes) so a concurrent provisioning
    // request for the SAME delivery waits for the winner, then re-reads the
    // resulting account instead of creating a second user.
    const locked = await db.client.query('SELECT id FROM deliveries WHERE id = ? FOR UPDATE', [deliveryId]);
    if (locked.rows.length === 0) throw new Error('Delivery not found.');
    const delivery = (await db.deliveries.find(d => d.id === deliveryId)) as Delivery;

    // Only a delivery that actually reached the business (agent activated by
    // the factory) is eligible — a PENDING delivery is not ready.
    if (delivery.status !== 'DELIVERED' && delivery.status !== 'ACCEPTED') {
      throw new Error('Delivery is not ready for owner account provisioning.');
    }

    // Idempotent replay: return the existing account's public info — NEVER a
    // second user, NEVER the original password again.
    const existingUserId = delivery.deliveryPayload?.ownerAccountUserId;
    if (existingUserId) {
      const existing = await db.users.find(u => u.id === existingUserId);
      if (existing) return { user: toPublicUser(existing), alreadyProvisioned: true };
    }

    // Email is globally unique. Reject duplicates with a safe generic error:
    // no tenant/business disclosure, no modification, no reassignment.
    const taken = await db.users.find(u => u.email.toLowerCase() === email);
    if (taken) throw new Error('An account with this email already exists.');

    // Cryptographically secure one-time password; only the scrypt hash is stored.
    const temporaryPassword = crypto.randomBytes(16).toString('base64url');
    const now = new Date().toISOString();
    const user: User = {
      id: genId('usr'),
      email,
      passwordHash: hashPassword(temporaryPassword),
      name,
      role: 'BUSINESS_OWNER',
      businessId: delivery.businessId,
      createdAt: now,
      updatedAt: now
    };
    try {
      await db.users.push(user);
    } catch {
      // UNIQUE(email) backstop — a concurrent request (e.g. for another
      // delivery) claimed the email between the check and the insert.
      const nowTaken = await db.users.find(u => u.email.toLowerCase() === email);
      if (nowTaken) throw new Error('An account with this email already exists.');
      throw new Error('Owner account could not be created.');
    }

    delivery.deliveryPayload = { ...(delivery.deliveryPayload || {}), ownerAccountUserId: user.id };
    delivery.updatedAt = now;
    await db.deliveries.update(delivery);
    return { user: toPublicUser(user), temporaryPassword, alreadyProvisioned: false };
  });

  if (!result.alreadyProvisioned) {
    // Best-effort, never throws into the request path. Records ids only —
    // NEVER the password. Scoped to the delivery's real tenant.
    const delivery = await db.deliveries.find(d => d.id === deliveryId);
    await recordOrchestrationEvent({
      eventType: 'OWNER_ACCOUNT_PROVISIONED',
      prospectId: delivery?.prospectId,
      businessId: result.user.businessId ?? undefined,
      agentId: delivery?.agentId,
      metadata: { deliveryId },
      summary: 'Owner account provisioned for delivery'
    });
  }
  return result;
}
