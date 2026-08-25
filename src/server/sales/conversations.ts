import { db } from '../db';
import {
  SalesConversation, SalesConversationStatus, SalesConversationTurn,
  SalesTurnDirection, SalesTurnActor, SalesContact, SalesChannelType
} from '../../types';
import { recordOrchestrationEvent } from '../telemetry';

/** Distinct error for the NEEDS_HUMAN automation gate (Task 44). The
 *  dispatcher treats this as "park the task", NOT as a provider failure —
 *  it never consumes a retry attempt. */
export class HumanGateError extends Error {}

/**
 * Platform-level sales conversation + human-escalation substrate (Task 42).
 *
 * This module is the AUTHORITATIVE owner of conversation state. It never
 * reuses the tenant-scoped customer conversation tables. One conversation per
 * contact (UNIQUE(contact_id) is the DB backstop — concurrent first binds
 * resolve to the SAME row). The provider's thread/call id
 * (provider_conversation_id) is separate from our internal id and UNIQUE when
 * present. Transitions are deterministic and application-enforced:
 *
 *   OPEN → NEEDS_HUMAN   (escalate; reason server-bounded)
 *   OPEN → CLOSED
 *   NEEDS_HUMAN → CLOSED (human resolution; never auto-reopen)
 *
 * CLOSED is terminal: no CLOSED → OPEN / CLOSED → NEEDS_HUMAN.
 * A NEEDS_HUMAN conversation refuses automated outreach continuation.
 * Turns are append-only; content is bounded and safe (never raw provider
 * payloads, secrets, or prompts).
 */

const SUMMARY_MAX = 500;

export function genConversationId(): string {
  return `scv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function genTurnId(): string {
  return `stn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeSummarize(text: string | undefined, max = SUMMARY_MAX): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

// ---------------------------------------------------------------------------
// State machine (deterministic, explicit)
// ---------------------------------------------------------------------------

export const CONVERSATION_TRANSITIONS: Record<SalesConversationStatus, SalesConversationStatus[]> = {
  OPEN: ['NEEDS_HUMAN', 'CLOSED'],
  NEEDS_HUMAN: ['CLOSED'],
  CLOSED: []
};

export function assertConversationTransition(from: SalesConversationStatus, to: SalesConversationStatus): void {
  if (to !== from && !CONVERSATION_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid conversation transition: ${from} -> ${to}.`);
  }
}

// ---------------------------------------------------------------------------
// Create / bind
// ---------------------------------------------------------------------------

/**
 * Resolve-or-create the durable conversation for a contact. Idempotent:
 * the contact's active conversation identity is reused; a UNIQUE(contact_id)
 * race loser resolves to the winner's row. Only one conversation exists per
 * contact, ever. If `providerConversationId` is supplied by a channel result
 * it is persisted (separate from the internal id) when not already set.
 */
export async function ensureConversation(
  contact: SalesContact,
  providerConversationId?: string
): Promise<SalesConversation> {
  const existing = await db.salesConversations.find(c => c.contactId === contact.id);
  if (existing) {
    await maybePersistProviderId(existing, providerConversationId);
    return (await db.salesConversations.find(c => c.id === existing.id))!;
  }
  const now = new Date().toISOString();
  const conv: SalesConversation = {
    id: genConversationId(),
    contactId: contact.id,
    channel: contact.channel as SalesChannelType,
    providerConversationId: safeSummarize(providerConversationId, 200),
    status: 'OPEN',
    createdAt: now,
    updatedAt: now
  };
  try {
    await db.salesConversations.push(conv);
    await recordOrchestrationEvent({
      eventType: 'SALES_CONVERSATION_OPENED',
      metadata: { jobId: contact.id },
      summary: `sales conversation opened for contact ${contact.id}`
    }).catch(() => {});
    return conv;
  } catch {
    // UNIQUE(contact_id) race — a concurrent first bind won; resolve to it.
    const winner = await db.salesConversations.find(c => c.contactId === contact.id);
    if (winner) {
      await maybePersistProviderId(winner, providerConversationId);
      return (await db.salesConversations.find(c => c.id === winner.id))!;
    }
    throw new Error('Conversation could not be created.');
  }
}

/** Persist a provider conversation id only when absent (never overwrite). */
async function maybePersistProviderId(conv: SalesConversation, providerId?: string): Promise<void> {
  const safe = safeSummarize(providerId, 200);
  if (!safe || conv.providerConversationId === safe) return;
  if (conv.providerConversationId) return; // already bound to a different provider id
  await db.salesConversations.update({ ...conv, providerConversationId: safe, updatedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getConversation(id: string): Promise<SalesConversation | undefined> {
  return db.salesConversations.find(c => c.id === id);
}

export async function listConversations(limit = 100): Promise<SalesConversation[]> {
  const all = await db.salesConversations.toJSON();
  return all
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.min(Math.max(limit, 1), 500));
}

export async function listEscalationQueue(limit = 100): Promise<SalesConversation[]> {
  const all = (await db.salesConversations.toJSON()).filter(c => c.status === 'NEEDS_HUMAN');
  return all
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) // oldest first — longest waiting
    .slice(0, Math.min(Math.max(limit, 1), 500));
}

export async function listTurns(conversationId: string, limit = 200): Promise<SalesConversationTurn[]> {
  const all = (await db.salesConversationTurns.toJSON()).filter(t => t.conversationId === conversationId);
  return all
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, Math.min(Math.max(limit, 1), 1000));
}

// ---------------------------------------------------------------------------
// Turns (append-only)
// ---------------------------------------------------------------------------

const VALID_DIRECTIONS: SalesTurnDirection[] = ['INBOUND', 'OUTBOUND'];
const VALID_ACTORS: SalesTurnActor[] = ['WORKER', 'PROSPECT', 'HUMAN', 'SYSTEM'];

export async function appendTurn(input: {
  conversationId: string;
  direction: SalesTurnDirection;
  actor: SalesTurnActor;
  safeContent?: string;
}): Promise<SalesConversationTurn> {
  const conv = await getConversation(input.conversationId);
  if (!conv) throw new Error('Conversation not found.');
  if (!VALID_DIRECTIONS.includes(input.direction)) throw new Error(`Invalid turn direction.`);
  if (!VALID_ACTORS.includes(input.actor)) throw new Error(`Invalid turn actor.`);
  const turn: SalesConversationTurn = {
    id: genTurnId(),
    conversationId: conv.id,
    direction: input.direction,
    actor: input.actor,
    safeContent: safeSummarize(input.safeContent),
    createdAt: new Date().toISOString()
  };
  await db.salesConversationTurns.push(turn);
  return turn;
}

// ---------------------------------------------------------------------------
// Escalation / resolution
// ---------------------------------------------------------------------------

export async function escalateConversation(id: string, reason?: string): Promise<SalesConversation> {
  const conv = await getConversation(id);
  if (!conv) throw new Error('Conversation not found.');
  assertConversationTransition(conv.status, 'NEEDS_HUMAN');
  const safeReason = safeSummarize(reason) || 'requires human review';
  const updated: SalesConversation = { ...conv, status: 'NEEDS_HUMAN', escalationReason: safeReason, updatedAt: new Date().toISOString() };
  await db.salesConversations.update(updated);
  await recordOrchestrationEvent({
    eventType: 'SALES_CONVERSATION_ESCALATED',
    metadata: { jobId: conv.contactId },
    summary: `sales conversation escalated (contact ${conv.contactId})`
  }).catch(() => {});
  return updated;
}

/** Human resolution — NEEDS_HUMAN → CLOSED (or OPEN → CLOSED for direct close).
 *  Never auto-reopens; CLOSED is terminal. Double-close is an idempotent no-op.
 *  Task 44: closing a conversation RESUMES its parked (BLOCKED) outreach tasks
 *  back to QUEUED in the SAME transaction — no new task, same id/payload/key,
 *  attemptCount untouched, no retry penalty. The conversation row is locked
 *  (FOR UPDATE on PG; mutex-serialized on SQLite) so a concurrent park
 *  serializes deterministically — a task can never be stranded BLOCKED after
 *  the conversation closed. */
export async function closeConversation(id: string): Promise<SalesConversation> {
  return db.client.transaction(async () => {
    const conv = await getConversation(id);
    if (!conv) throw new Error('Conversation not found.');
    if (conv.status === 'CLOSED') return conv; // idempotent: no dup event/resume
    assertConversationTransition(conv.status, 'CLOSED');
    await db.client.query('SELECT id FROM sales_conversations WHERE id = ? FOR UPDATE', [id]);
    const now = new Date().toISOString();
    const updated: SalesConversation = { ...conv, status: 'CLOSED', updatedAt: now };
    await db.salesConversations.update(updated);
    // Resume ONLY parked outreach tasks tied to THIS conversation's contact.
    const parked = (await db.salesTasks.toJSON())
      .filter(t => t.status === 'BLOCKED' && t.payload?.contactId === conv.contactId);
    for (const t of parked) {
      t.status = 'QUEUED';
      t.availableAt = now;
      t.claimedAt = undefined;
      t.lastError = undefined;
      t.updatedAt = now;
      await db.salesTasks.update(t);
      await recordOrchestrationEvent({
        eventType: 'SALES_TASK_RESUMED',
        metadata: { jobId: t.id },
        summary: `sales task resumed after human resolution (contact ${conv.contactId})`
      }).catch(() => {});
    }
    await recordOrchestrationEvent({
      eventType: 'SALES_CONVERSATION_CLOSED',
      metadata: { jobId: conv.contactId },
      summary: `sales conversation closed (contact ${conv.contactId})`
    }).catch(() => {});
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Automation gate
// ---------------------------------------------------------------------------

/**
 * Throws when the contact's conversation is in a state that forbids automated
 * outreach continuation. NEEDS_HUMAN refuses automation (human gate); CLOSED
 * refuses (terminal). The caller (dispatcher) converts the refusal into the
 * existing failTask semantics — never silently succeeds, never deletes.
 */
export async function assertAutomatable(contactId: string): Promise<void> {
  const conv = await db.salesConversations.find(c => c.contactId === contactId);
  if (!conv) return;
  if (conv.status === 'NEEDS_HUMAN') {
    throw new HumanGateError('Conversation requires human review; automated outreach is blocked.');
  }
  if (conv.status === 'CLOSED' && !conv.escalationReason) {
    // Directly-closed (never escalated) conversation = terminal refusal.
    // A conversation closed AFTER an escalation (escalationReason present)
    // means the human RESOLVED the gate — automation may proceed (Task 44:
    // this is what lets a resumed task execute normally).
    throw new Error('Conversation is closed; automated outreach is blocked.');
  }
}
