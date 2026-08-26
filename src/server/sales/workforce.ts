import { db } from '../db';
import {
  SalesWorker, SalesWorkerRole, SalesWorkerStatus, SalesChannelType,
  SalesWorkerSchedule, SalesWorkerLimits,
  SalesTask, SalesTaskStatus, SalesAttemptOutcome
} from '../../types';
import { recordOrchestrationEvent } from '../telemetry';
import { executeChannelDispatch, ChannelDispatch } from './noopChannel';
import { scheduleWindowIncludes, zonedMinuteInDay, globalRunningTaskCount, globalCapacityAvailable } from './scheduler';
import { recordAttempt, finalizeContact, assertOutreachPayload, assertProspectEligible, assertDiscoveryNotDismissed, isProspectIneligibleError } from './contacts';
import { ensureConversation, assertAutomatable, HumanGateError } from './conversations';

/**
 * Sales workforce execution substrate (Phase A / Task 34).
 *
 * Durable, crash-safe, idempotent execution for future sales workers. Workers
 * are INSTANCES of one architecture (role + config drive behavior — never a
 * per-worker class). Durable tasks are persisted before execution, claimed
 * atomically (FOR UPDATE SKIP LOCKED on PG; SQLite serializes on the
 * connection mutex), executed through a pluggable channel (no-op/test channel
 * in this phase), retried with a hard bound, and recovered from crashes by a
 * deterministic stale-task reaper.
 *
 * PLATFORM_OWNER-only; platform-level entities (NOT customer tenants). No
 * phone/Instagram/outreach — this is execution infrastructure only.
 */

export const WORKER_TRANSITIONS: Record<SalesWorkerStatus, SalesWorkerStatus[]> = {
  IDLE: ['RUNNING', 'PAUSED', 'OFFLINE'],
  RUNNING: ['IDLE', 'PAUSED', 'OFFLINE'],
  PAUSED: ['IDLE', 'OFFLINE'],
  OFFLINE: ['IDLE']
};

export const TASK_TRANSITIONS: Record<SalesTaskStatus, SalesTaskStatus[]> = {
  QUEUED: ['RUNNING', 'DEAD_LETTERED'],
  // BLOCKED (Task 44): parked awaiting human conversation resolution.
  RUNNING: ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'BLOCKED'],
  // Resumed (→ QUEUED) only by conversation close; dead-letterable as an
  // operator escape hatch. Never claimed, never reaped, never retried.
  BLOCKED: ['QUEUED', 'DEAD_LETTERED'],
  SUCCEEDED: [],
  // FAILED is retryable: returns to QUEUED (bounded), else DEAD_LETTERED.
  FAILED: ['QUEUED', 'DEAD_LETTERED'],
  DEAD_LETTERED: []
};

/** Hard attempt ceiling per task (initial + retries). */
export const MAX_TASK_ATTEMPTS = 3;
/** A claimed/running task older than this is considered crashed/stale. */
export const STALE_TASK_MS = 5 * 60 * 1000; // 5 minutes
/** Base backoff for a retryable failure (attempt^2 * base). */
const RETRY_BACKOFF_BASE_MS = 1000;

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Worker registry
// ---------------------------------------------------------------------------

export async function createWorker(input: {
  role: SalesWorkerRole;
  objective?: string;
  channel: SalesChannelType;
  schedule?: Partial<SalesWorkerSchedule>;
  limits?: Partial<SalesWorkerLimits>;
  strategyVersionId?: string;
}): Promise<SalesWorker> {
  if (!input.role || !input.channel) throw new Error('role and channel are required.');
  const now = new Date().toISOString();
  const worker: SalesWorker = {
    id: genId('wk'),
    role: input.role,
    status: 'IDLE',
    objective: input.objective,
    channel: input.channel,
    schedule: {
      enabled: input.schedule?.enabled ?? true,
      windows: input.schedule?.windows ?? [],
      timezone: input.schedule?.timezone
    },
    limits: {
      maxConcurrentTasks: input.limits?.maxConcurrentTasks ?? 2,
      maxAttempts: input.limits?.maxAttempts ?? MAX_TASK_ATTEMPTS
    },
    strategyVersionId: input.strategyVersionId,
    createdAt: now,
    updatedAt: now
  };
  await db.salesWorkers.push(worker);
  return worker;
}

export async function getWorker(id: string): Promise<SalesWorker | undefined> {
  return db.salesWorkers.find(w => w.id === id);
}

export async function listWorkers(): Promise<SalesWorker[]> {
  return db.salesWorkers.toJSON();
}

export async function transitionWorkerStatus(id: string, next: SalesWorkerStatus): Promise<SalesWorker> {
  const w = await getWorker(id);
  if (!w) throw new Error('Worker not found.');
  if (next !== w.status && !WORKER_TRANSITIONS[w.status].includes(next)) {
    throw new Error(`Invalid worker transition: ${w.status} -> ${next}.`);
  }
  w.status = next;
  w.updatedAt = new Date().toISOString();
  await db.salesWorkers.update(w);
  return w;
}

/** AUTHORITATIVE worker eligibility (Task 35): not paused/offline, schedule
 *  enabled, and (when windows exist) the current minute — in the worker's own
 *  timezone — falls inside a working window. Deterministic, single source. */
export function isWorkerEligibleNow(w: SalesWorker, now: Date = new Date()): boolean {
  if (w.status === 'PAUSED' || w.status === 'OFFLINE') return false;
  if (!w.schedule.enabled) return false;
  if (!w.schedule.windows || w.schedule.windows.length === 0) return true;
  const tz = w.schedule.timezone || 'UTC';
  const { day, minute } = zonedMinuteInDay(now, tz);
  return w.schedule.windows.some(win => scheduleWindowIncludes(win, day, minute));
}

// Back-compat alias for the Task 34 name (same authoritative decision).
export const isWorkerRunnableNow = isWorkerEligibleNow;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function enqueueTask(input: {
  workerId: string;
  type: string;
  payload?: Record<string, any>;
  idempotencyKey: string;
  availableAt?: string;
}): Promise<SalesTask> {
  if (!input.workerId || !input.type) throw new Error('workerId and type are required.');
  if (!input.idempotencyKey || typeof input.idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required.');
  }
  const existing = await db.salesTasks.find(t => t.idempotencyKey === input.idempotencyKey);
  if (existing) return existing; // idempotent — never duplicate logical work
  const now = new Date().toISOString();
  const task: SalesTask = {
    id: genId('wtask'),
    workerId: input.workerId,
    type: input.type,
    payload: input.payload,
    status: 'QUEUED',
    attemptCount: 0,
    availableAt: input.availableAt ?? now,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now
  };
  try {
    await db.salesTasks.push(task);
  } catch {
    // UNIQUE(idempotency_key) backstop — a concurrent enqueue won; return it.
    const raced = await db.salesTasks.find(t => t.idempotencyKey === input.idempotencyKey);
    if (raced) return raced;
    throw new Error('Task could not be enqueued.');
  }
  return task;
}

export async function getTask(id: string): Promise<SalesTask | undefined> {
  return db.salesTasks.find(t => t.id === id);
}

export async function advanceTask(id: string, next: SalesTaskStatus): Promise<SalesTask> {
  const t = await getTask(id);
  if (!t) throw new Error('Task not found.');
  if (next !== t.status && !TASK_TRANSITIONS[t.status].includes(next)) {
    throw new Error(`Invalid task transition: ${t.status} -> ${next}.`);
  }
  t.status = next;
  t.updatedAt = new Date().toISOString();
  await db.salesTasks.update(t);
  return t;
}

// ---------------------------------------------------------------------------
// Claiming (concurrency-safe, atomic)
// ---------------------------------------------------------------------------

/**
 * Atomically claim the next runnable task for a worker. Inside one
 * transaction: lock the candidate row (FOR UPDATE SKIP LOCKED on PG — a
 * racing claimer skips it; SQLite serializes), re-verify it is still QUEUED
 * and within the worker's concurrency budget, then mark it RUNNING and bump
 * the attempt count. ONE TASK = ONE ACTIVE CLAIM.
 */
export async function claimNextTask(workerId: string, now: Date = new Date()): Promise<SalesTask | null> {
  const worker = await getWorker(workerId);
  if (!worker) return null;
  const maxConcurrent = worker.limits?.maxConcurrentTasks ?? 2;

  return db.client.transaction(async () => {
    const inFlight = await db.client.query(
      'SELECT COUNT(*) AS n FROM sales_tasks WHERE worker_id = ? AND status = ?',
      [workerId, 'RUNNING']
    );
    const running = Number(inFlight.rows[0]?.n ?? 0);
    if (running >= maxConcurrent) return null;

    const due = await db.client.query(
      `SELECT id FROM sales_tasks
       WHERE worker_id = ? AND status = ? AND available_at <= ?
       ORDER BY created_at ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [workerId, 'QUEUED', now.toISOString()]
    );
    const row = due.rows[0];
    if (!row) return null;

    const task = await db.salesTasks.find(t => t.id === row.id);
    if (!task || task.status !== 'QUEUED') return null; // lost the race
    task.status = 'RUNNING';
    task.attemptCount += 1;
    task.claimedAt = now.toISOString();
    task.updatedAt = now.toISOString();
    await db.salesTasks.update(task);
    return task;
  });
}

// ---------------------------------------------------------------------------
// Stale-task reaper (crash recovery)
// ---------------------------------------------------------------------------

/**
 * Recover tasks claimed (RUNNING) but never completed because the process
 * crashed. Stale = claimedAt older than STALE_TASK_MS. Deterministic +
 * bounded: below the attempt cap the task returns to QUEUED for a retry; at
 * the cap it DEAD_LETTERs. Row-locked so the reaper cannot race a live completer.
 */
export async function reapStaleTasks(now: Date = new Date()): Promise<number> {
  const threshold = new Date(now.getTime() - STALE_TASK_MS).toISOString();
  return db.client.transaction(async () => {
    const stale = await db.client.query(
      `SELECT id FROM sales_tasks
       WHERE status = ? AND claimed_at IS NOT NULL AND claimed_at < ?
       FOR UPDATE SKIP LOCKED`,
      ['RUNNING', threshold]
    );
    let recovered = 0;
    for (const row of stale.rows) {
      const t = await db.salesTasks.find(x => x.id === row.id);
      if (!t || t.status !== 'RUNNING') continue; // completed concurrently
      const cap = (await getWorker(t.workerId))?.limits?.maxAttempts ?? MAX_TASK_ATTEMPTS;
      if (t.attemptCount >= cap) {
        t.status = 'DEAD_LETTERED';
        t.lastError = 'Stale after crash; attempt limit reached.';
        t.completedAt = now.toISOString();
      } else {
        t.status = 'QUEUED';
        t.lastError = 'Recovered from stale (crashed) claim.';
        t.availableAt = now.toISOString();
      }
      t.claimedAt = undefined;
      t.updatedAt = now.toISOString();
      await db.salesTasks.update(t);
      recovered++;
    }
    return recovered;
  });
}

// ---------------------------------------------------------------------------
// Completion / failure recording
// ---------------------------------------------------------------------------

/**
 * Park a claimed task because its conversation requires a human (Task 44).
 * RUNNING → BLOCKED. NOT a retry: attemptCount unchanged, no backoff, no new
 * task, payload/idempotency key/contact untouched. Re-locks the conversation
 * row inside the transaction so a concurrent conversation close serializes
 * (a task is never stranded BLOCKED after the conversation already closed).
 * Only parks while the conversation is still NEEDS_HUMAN — otherwise throws
 * and the caller falls back to the normal failure path.
 */
export async function blockTaskForHuman(taskId: string, reason: string, now: Date = new Date()): Promise<SalesTask> {
  return db.client.transaction(async () => {
    const t = await db.salesTasks.find(x => x.id === taskId);
    if (!t || t.status !== 'RUNNING') throw new Error('Task is not running; cannot park.');
    const contactId = t.payload?.contactId as string | undefined;
    const conv = contactId
      ? await db.salesConversations.find(c => c.contactId === contactId)
      : undefined;
    if (conv) {
      await db.client.query('SELECT id FROM sales_conversations WHERE id = ? FOR UPDATE', [conv.id]);
      const fresh = await db.salesConversations.find(c => c.id === conv.id);
      if (!fresh || fresh.status !== 'NEEDS_HUMAN') {
        throw new Error('Conversation no longer requires human review.');
      }
    }
    t.status = 'BLOCKED';
    t.claimedAt = undefined;
    t.lastError = reason.slice(0, 500);
    t.updatedAt = now.toISOString();
    await db.salesTasks.update(t);
    return t;
  });
}

async function completeTask(task: SalesTask, now: Date): Promise<SalesTask> {
  return db.client.transaction(async () => {
    const t = await db.salesTasks.find(x => x.id === task.id);
    if (!t || t.status !== 'RUNNING') return t ?? task; // already reaped/resolved
    t.status = 'SUCCEEDED';
    t.completedAt = now.toISOString();
    t.lastError = undefined;
    t.updatedAt = now.toISOString();
    await db.salesTasks.update(t);
    return t;
  });
}

async function failTask(task: SalesTask, error: string, permanent: boolean, now: Date): Promise<SalesTask> {
  const worker = await getWorker(task.workerId);
  const cap = worker?.limits?.maxAttempts ?? MAX_TASK_ATTEMPTS;
  return db.client.transaction(async () => {
    const t = await db.salesTasks.find(x => x.id === task.id);
    if (!t || t.status !== 'RUNNING') return t ?? task;
    t.lastError = error.slice(0, 500);
    t.claimedAt = undefined;
    if (permanent || t.attemptCount >= cap) {
      t.status = 'DEAD_LETTERED';
      t.completedAt = now.toISOString();
    } else {
      // Retryable: back to QUEUED with exponential backoff.
      t.status = 'QUEUED';
      t.availableAt = new Date(now.getTime() + Math.pow(t.attemptCount, 2) * RETRY_BACKOFF_BASE_MS).toISOString();
    }
    t.updatedAt = now.toISOString();
    await db.salesTasks.update(t);
    return t;
  });
}

// ---------------------------------------------------------------------------
// Tick dispatcher
// ---------------------------------------------------------------------------

/**
 * The smallest viable dispatcher: for each runnable worker, claim up to its
 * concurrency budget and execute each claimed task through the channel,
 * recording success / retryable-failure (backoff) / permanent-failure
 * (dead-letter). Single-process, I/O-bound, DB-backed. Thin by design.
 */
export async function runDispatcherTick(now: Date = new Date()): Promise<{ claimed: number; succeeded: number; failed: number }> {
  const workers = (await listWorkers()).filter(w => isWorkerEligibleNow(w, now));
  let claimed = 0, succeeded = 0, failed = 0;

  for (const worker of workers) {
    const budget = worker.limits?.maxConcurrentTasks ?? 2;
    for (let i = 0; i < budget; i++) {
      // Global safety ceiling (Task 35): never exceed the workforce-wide
      // concurrency cap, so one scheduling bug can't execute unlimited work.
      if (!globalCapacityAvailable(await globalRunningTaskCount())) return { claimed, succeeded, failed };
      const task = await claimNextTask(worker.id, now);
      if (!task) break;
      claimed++;
      const started = Date.now();
      const isOutreach = Boolean(task.payload?.contactId);
      if (isOutreach) assertOutreachPayload(task.payload); // strict shape before dispatch (never mutates task)
      try {
        if (isOutreach) {
          // Task 42/44 human gate: a NEEDS_HUMAN conversation PARKS the task
          // (no channel execution, no attempt consumption, no retry, no
          // dead-letter). A CLOSED conversation keeps the Task-42 refusal
          // semantics (generic failure path).
          try {
            await assertAutomatable(String(task.payload.contactId));
          } catch (gateErr: any) {
            if (gateErr instanceof HumanGateError) {
              await blockTaskForHuman(task.id, gateErr.message, now);
              await recordOrchestrationEvent({
                eventType: 'SALES_TASK_PARKED',
                metadata: { jobId: task.id },
                summary: `sales task parked for human review (attempt ${task.attemptCount})`
              }).catch(() => {});
              continue; // next claim slot — task is visibly parked
            }
            throw gateErr;
          }
          // Bind the contact's durable conversation (idempotent — retries and
          // concurrent first binds resolve to the SAME conversation row).
          const contact = await db.salesContacts.find(c => c.id === String(task.payload.contactId));
          if (!contact) throw new Error('Outreach contact not found.');
          // Task 46: dispatch-time prospect lifecycle recheck — the SAME
          // authoritative eligibility as assignment, re-verified at the final
          // boundary before the channel executes. A stale task (prospect
          // became REJECTED/CONVERTED/business-linked/dismissed after
          // assignment) is TERMINALLY refused: no channel call, no retry, no
          // retry-attempt consumption, contact never finalized.
          // Task 52: classify eligibility failures — permanent refusal ONLY for
          // a ProspectIneligibleError thrown by the deterministic asserts. Any
          // other (transient/infrastructure) error is rethrown into the outer
          // retryable-failure path; it is NEVER misclassified as ineligibility.
          try {
            const prospect = await db.prospects.find(p => p.id === contact.prospectId);
            assertProspectEligible(prospect);
            await assertDiscoveryNotDismissed(prospect!);
          } catch (elErr: any) {
            if (!isProspectIneligibleError(elErr)) throw elErr; // transient -> retryable
            
            const reason = 'Prospect no longer eligible for outreach.';
            await failTask(task, reason, true, now); // permanent — terminal DEAD_LETTERED
            failed++;
            await recordAttempt({
              taskId: task.id, attemptNumber: task.attemptCount, outcome: 'PERMANENT_FAILURE',
              error: reason
            });
            await recordOrchestrationEvent({
              eventType: 'OUTREACH_COMPLETED',
              metadata: { jobId: task.id },
              summary: `outreach refused: prospect no longer eligible (attempt ${task.attemptCount})`
            }).catch(() => {});
            continue;
          }
          await recordOrchestrationEvent({
            eventType: 'OUTREACH_ATTEMPTED',
            metadata: { jobId: task.id },
            summary: `sales worker ${worker.role} outreach attempt ${task.attemptCount}`
          }).catch(() => {});
        }
        // Stable provider idempotency key (Task 50): task.id is the unique,
        // server-derived logical-task identifier — IDENTICAL across retries,
        // enabling provider-side deduplication. Client never supplies it.
        // attemptCount remains the per-attempt ledger/audit number (the key
        // and the attempt number are deliberately not collapsed).
        const dispatch: ChannelDispatch = { attemptKey: task.id, payload: task.payload };
        // Load the AUTHORITATIVE contact once, before dispatch, so the adapter
        // anchors eligibility on contact.prospectId (never the payload).
        const contactForDispatch = isOutreach
          ? await db.salesContacts.find(c => c.id === String(task.payload.contactId))
          : undefined;
        // Channel-gated (Task 48): an unimplemented real channel returns a
        // structured PERMANENT refusal here and never reaches the noop executor.
        const result = await executeChannelDispatch(worker, task, dispatch, contactForDispatch);
        // Classification is authoritative from the structured outcome, not the
        // success boolean: ambiguous acceptance (TIMEOUT) MUST NOT complete
        // the task, the ledger, or the contact.
        const isSuccess = result.outcome === 'CONNECTED' || result.outcome === 'DELIVERED';
        // Bind the conversation whenever the provider actually EXECUTED the
        // attempt (CONNECTED/DELIVERED/TIMEOUT/ERROR). A refusal (REJECTED)
        // is a pre-execution safety refusal and never fabricates a row.
        let internalConversationId: string | undefined;
        const executedAttempt = result.outcome !== 'REJECTED';
        if (isOutreach && executedAttempt) {
          const contact = await db.salesContacts.find(c => c.id === String(task.payload.contactId));
          if (contact) {
            const conv = await ensureConversation(contact, result.conversationId);
            internalConversationId = conv.id;
          }
        }
        if (isSuccess) {
          await completeTask(task, now);
          succeeded++;
        } else {
          await failTask(task, result.error || result.outcome, !result.retryable, now);
          failed++;
        }
        if (isOutreach) {
          await recordAttempt({
            taskId: task.id, attemptNumber: task.attemptCount, outcome: result.outcome,
            error: isSuccess ? undefined : result.error,
            providerId: result.providerId, conversationId: internalConversationId
          });
          if (isSuccess) await finalizeContact(String(task.payload.contactId), 'SUCCEEDED');
          await recordOrchestrationEvent({
            eventType: 'OUTREACH_COMPLETED',
            metadata: { jobId: task.id },
            summary: `outreach ${result.outcome.toLowerCase()} (attempt ${task.attemptCount})`
          }).catch(() => {});
        }
      } catch (e: any) {
        await failTask(task, e?.message || 'execution error', false, now);
        failed++;
        if (isOutreach) {
          await recordAttempt({ taskId: task.id, attemptNumber: task.attemptCount, outcome: 'ERROR', error: e?.message || 'execution error' });
          await recordOrchestrationEvent({
            eventType: 'OUTREACH_COMPLETED',
            metadata: { jobId: task.id },
            summary: `outreach error (attempt ${task.attemptCount})`
          }).catch(() => {});
        }
      }
      const durationMs = Date.now() - started;
      if (!isOutreach) {
        await recordOrchestrationEvent({
          eventType: 'FACTORY_JOB_STEP',
          metadata: { jobId: task.id },
          summary: `sales worker ${worker.role} task ${task.type} attempt ${task.attemptCount} (${durationMs}ms)`
        }).catch(() => {});
      }
    }
  }
  return { claimed, succeeded, failed };
}
