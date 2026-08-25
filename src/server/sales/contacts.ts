import { db } from '../db';
import {
  Prospect, SalesWorker, SalesContact, SalesAttempt,
  SalesAttemptOutcome, SalesChannelType
} from '../../types';
import { recordOrchestrationEvent } from '../telemetry';
import { enqueueTask, getWorker, getTask } from './workforce';

/**
 * Sales contact assignment + outreach attempt ledger (Task 37).
 *
 * sales_contacts is the durable CURRENT relationship prospect <-> worker/channel:
 * one ACTIVE contact per (prospect, channel) — UNIQUE(prospect_id, channel) is
 * the database backstop for concurrent assignment races. A contact remains after
 * completion; its outreach history lives in sales_attempts, which is append-only
 * and NEVER disappears when a contact completes. Each real channel execution
 * (including retries) writes its own distinguishable attempt row.
 *
 * PLATFORM_OWNER-only (see routes.ts); platform-level entities. Eligibility is
 * derived server-side from the authoritative prospect row — never from a
 * client-supplied flag. The cooldown is a fixed server constant (no request
 * parameter). The channel is always derived from the worker row; the client
 * cannot override it. Idempotency: deterministic idempotency key
 * `outreach:{prospectId}:{channel}` + UNIQUE constraints; a repeated call
 * resolves to the same contact/task.
 */

/** Minimum gap between outreach attempts on the same contact. Server-side only. */
export const OUTREACH_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

const SUMMARY_MAX = 500;

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeSummarize(text: string | undefined, max = SUMMARY_MAX): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

/** Strict outreach payload shape — protects a future real channel from
 *  malformed/arbitrary payloads (id fields must be non-empty strings). */
export function assertOutreachPayload(payload: Record<string, any> | undefined): { prospectId: string; contactId: string; channel: string } {
  const p = payload as any;
  if (!p || typeof p !== 'object') throw new Error('outreach payload missing');
  const { prospectId, contactId, channel } = p;
  if (typeof prospectId !== 'string' || !prospectId) throw new Error('invalid outreach payload (prospectId)');
  if (typeof contactId !== 'string' || !contactId) throw new Error('invalid outreach payload (contactId)');
  if (typeof channel !== 'string' || !channel) throw new Error('invalid outreach payload (channel)');
  return { prospectId, contactId, channel };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getSalesContact(id: string): Promise<SalesContact | undefined> {
  return db.salesContacts.find(c => c.id === id);
}

export async function listContactHistory(contactId: string): Promise<{
  contact: SalesContact | undefined;
  attempts: SalesAttempt[];
}> {
  const contact = await getSalesContact(contactId);
  if (!contact) return { contact: undefined, attempts: [] };
  const attempts = (await db.salesAttempts.toJSON())
    .filter(a => a.contactId === contactId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { contact, attempts };
}

// ---------------------------------------------------------------------------
// Eligibility (server-derived; authoritative)
// ---------------------------------------------------------------------------

/** The authoritative prospect eligibility check for sales outreach. Rejects
 *  missing, REJECTED, and CONVERTED prospects, prospects already linked to a
 *  real customer tenant (businessId set), and prospects whose discovery result
 *  was dismissed. Never trusts the caller. */
export function assertProspectEligible(prospect: Prospect | undefined): Prospect {
  if (!prospect) throw new Error('Prospect not found.');
  if (prospect.status === 'REJECTED') throw new Error('Prospect is rejected and not eligible for outreach.');
  if (prospect.status === 'CONVERTED') throw new Error('Prospect is converted and not eligible for outreach.');
  if (prospect.businessId) throw new Error('Prospect is linked to a customer tenant and not eligible for outreach.');
  return prospect;
}

async function assertDiscoveryNotDismissed(prospect: Prospect): Promise<void> {
  if (!prospect.discoveryResultId) return;
  const result = await db.discoveryResults.find(r => r.id === prospect.discoveryResultId);
  if (result?.dismissedAt) throw new Error('Prospect source is dismissed and not eligible for outreach.');
}

function assertWorkerEligible(worker: SalesWorker | undefined): SalesWorker {
  if (!worker) throw new Error('Worker not found.');
  if (worker.status === 'PAUSED' || worker.status === 'OFFLINE') {
    throw new Error(`Worker is ${worker.status.toLowerCase()} and not eligible for assignment.`);
  }
  return worker;
}

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

/** The most recent attempt timestamp on this contact (ledger is the source). */
export async function lastAttemptAt(contactId: string): Promise<number | null> {
  const attempts = (await db.salesAttempts.toJSON()).filter(a => a.contactId === contactId);
  if (attempts.length === 0) return null;
  const latest = attempts.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  return new Date(latest.createdAt).getTime();
}

export function cooldownActive(lastAt: number | null, now: Date = new Date()): boolean {
  if (lastAt === null) return false;
  return now.getTime() - lastAt < OUTREACH_COOLDOWN_MS;
}

// ---------------------------------------------------------------------------
// Assignment (idempotent, race-safe)
// ---------------------------------------------------------------------------

export interface OutreachAssignment {
  contact: SalesContact;
  task: Awaited<ReturnType<typeof getTask>>;
  /** true when the call created new rows; false when it resolved an existing assignment. */
  created: boolean;
}

/**
 * Assign a prospect to a worker (idempotent). The channel is derived from the
 * WORKER row — never from the caller. All validation + inserts run in one
 * transaction; the UNIQUE backstop resolves a concurrent loser to the winner's
 * assignment (the returned contact/task are the same logical assignment).
 */
export async function enqueueOutreach(prospectId: string, workerId: string, now: Date = new Date()): Promise<OutreachAssignment> {
  const prospect = assertProspectEligible(await db.prospects.find(p => p.id === prospectId));
  await assertDiscoveryNotDismissed(prospect);
  const worker = assertWorkerEligible(await getWorker(workerId));
  const channel: SalesChannelType = worker.channel;
  const idempotencyKey = `outreach:${prospect.id}:${channel}`;

  // Task 38: cooldown is rechecked INSIDE the transaction (contact row-based
  // proof-of-cooldown becomes durable within the same atomic unit as the
  // idempotent return) — closes the check-then-act slot race.
  const attempt = async (): Promise<OutreachAssignment> =>
    db.client.transaction(async () => {
      const contact = await db.salesContacts.find(c => c.prospectId === prospect.id && c.channel === channel);
      if (contact) {
        const last = await lastAttemptAt(contact.id);
        if (cooldownActive(last, now)) {
          throw new Error('Outreach cooldown active: a recent attempt exists; retry later.');
        }
        const task = await db.salesTasks.find(t => t.idempotencyKey === idempotencyKey);
        return { contact, task: task ?? undefined, created: false };
      }
      const iso = now.toISOString();
      const newContact: SalesContact = {
        id: genId('sc'),
        prospectId: prospect.id,
        workerId: worker.id,
        channel,
        status: 'ACTIVE',
        assignedAt: iso,
        createdAt: iso,
        updatedAt: iso
      };
      await db.salesContacts.push(newContact);
      const task = await enqueueTask({
        workerId: worker.id,
        type: 'OUTREACH',
        payload: { prospectId: prospect.id, contactId: newContact.id, channel },
        idempotencyKey
      });
      return { contact: newContact, task, created: true };
    });

  try {
    const result = await attempt();
    if (result.created) {
      await recordOrchestrationEvent({
        eventType: 'SALES_ASSIGNED',
        prospectId: prospect.id,
        summary: `Sales contact assigned (${channel})`,
        metadata: { step: 'assign' }
      }).catch(() => {});
    }
    return result;
  } catch (e: any) {
    // Cooldown errors must propagate — they are not UNIQUE races.
    if (/cooldown/i.test(e?.message || '')) throw e;
    // UNIQUE(prospect_id, channel) race backstop: the concurrent call won.
    const raced = await db.salesContacts.find(c => c.prospectId === prospect.id && c.channel === channel);
    if (raced) {
      const task = await db.salesTasks.find(t => t.idempotencyKey === idempotencyKey);
      return { contact: raced, task: task ?? undefined, created: false };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Attempt recording (called from the dispatcher; best-effort, never breaks execution)
// ---------------------------------------------------------------------------

/**
 * Record one REAL channel execution against a task's contact. Idempotent per
 * (taskId, attemptNumber) — each claim bumps the task's attemptCount, so every
 * retry is a distinguishable ledger row while a recording replay dedupes.
 * Never throws into the execution path (a ledger failure must not break a
 * task). No secrets, no raw provider payloads — bounded safe summary.
 */
export async function recordAttempt(input: {
  taskId: string;
  attemptNumber: number;
  outcome: SalesAttemptOutcome;
  error?: string;
  providerId?: string;
  conversationId?: string;
}): Promise<void> {
  try {
    const task = await getTask(input.taskId);
    const contactId = task?.payload?.contactId as string | undefined;
    if (!contactId) return; // task is not an outreach task — nothing to record
    const contact = await getSalesContact(contactId);
    if (!contact) return;
    const attempt: SalesAttempt = {
      id: genId('att'),
      contactId,
      taskId: input.taskId,
      attemptNumber: input.attemptNumber,
      outcome: input.outcome,
      providerId: input.providerId,
      conversationId: input.conversationId,
      safeSummary: safeSummarize(input.error),
      createdAt: new Date().toISOString()
    };
    await db.salesAttempts.push(attempt);
  } catch {
    // UNIQUE(task_id, attempt_number) already recorded, or ledger transiently unavailable.
  }
}

/**
 * Update the contact's lifecycle status after an attempt, preserving the
 * attempt ledger. A successful outreach COMPLETES the contact (the row remains
 * as the durable current relationship; history lives in sales_attempts).
 */
export async function finalizeContact(contactId: string, outcome: SalesAttemptOutcome): Promise<void> {
  try {
    const contact = await getSalesContact(contactId);
    if (!contact) return;
    const next = outcome === 'SUCCEEDED' ? 'COMPLETED' : contact.status;
    if (next === contact.status) return;
    contact.status = next;
    contact.updatedAt = new Date().toISOString();
    await db.salesContacts.update(contact);
  } catch {
    // best-effort — ledger is authoritative
  }
}
