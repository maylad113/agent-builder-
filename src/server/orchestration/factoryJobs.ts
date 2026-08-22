import { db } from '../db';
import { FactoryJob, FactoryJobStatus } from '../../types';

/**
 * Deterministic factory-job state machine. Every transition is validated
 * against the explicit map; terminal states are COMPLETED / FAILED /
 * DEAD_LETTERED (no infinite retry). Transitions are durable (each mutation
 * persists the row before returning).
 *
 * PENDING → SUBMITTING → EVALUATING → (CORRECTING) → PUBLISHING → ACTIVATING → COMPLETED
 * Any non-terminal state may fall to FAILED (retryable, bounded) or
 * DEAD_LETTERED (permanent — e.g. a gate rejected the design).
 */

export const FACTORY_JOB_TRANSITIONS: Record<FactoryJobStatus, FactoryJobStatus[]> = {
  PENDING: ['SUBMITTING', 'FAILED', 'DEAD_LETTERED'],
  SUBMITTING: ['EVALUATING', 'FAILED', 'DEAD_LETTERED'],
  EVALUATING: ['CORRECTING', 'PUBLISHING', 'FAILED', 'DEAD_LETTERED'],
  CORRECTING: ['PUBLISHING', 'FAILED', 'DEAD_LETTERED'],
  PUBLISHING: ['ACTIVATING', 'FAILED', 'DEAD_LETTERED'],
  ACTIVATING: ['COMPLETED', 'FAILED', 'DEAD_LETTERED'],
  COMPLETED: [],
  // FAILED may return to SUBMITTING ONLY via the bounded retry path
  // (retryFactoryJob) — attempt-limited, row-locked, never automatic.
  FAILED: ['SUBMITTING'],
  DEAD_LETTERED: []
};

function genId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a PENDING job. The caller must have verified idempotency first
 *  (unique index on idempotencyKey backs that). */
export async function createJob(input: {
  prospectId: string;
  designProposalId: string;
  idempotencyKey: string;
}): Promise<FactoryJob> {
  const now = new Date().toISOString();
  const job: FactoryJob = {
    id: genId(),
    prospectId: input.prospectId,
    designProposalId: input.designProposalId,
    status: 'PENDING',
    currentStep: 'PENDING',
    idempotencyKey: input.idempotencyKey,
    attemptCount: 0,
    deadLettered: false,
    createdAt: now,
    updatedAt: now
  };
  await db.factoryJobs.push(job);
  return job;
}

export async function getJob(id: string): Promise<FactoryJob | undefined> {
  return db.factoryJobs.find(j => j.id === id);
}

export async function listJobs(): Promise<FactoryJob[]> {
  const all = await db.factoryJobs.toJSON();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findJobByIdempotencyKey(key: string): Promise<FactoryJob | undefined> {
  return db.factoryJobs.find(j => j.idempotencyKey === key);
}

/** Advance the job to a new status/step. Throws on an illegal transition
 *  (deterministic — callers must not guess states). */
export async function advanceJob(job: FactoryJob, next: FactoryJobStatus): Promise<FactoryJob> {
  if (!FACTORY_JOB_TRANSITIONS[job.status].includes(next)) {
    throw new Error(`Invalid factory job transition: ${job.status} -> ${next}.`);
  }
  job.status = next;
  job.currentStep = next;
  job.updatedAt = new Date().toISOString();
  await db.factoryJobs.update(job);
  return job;
}

/** Record a (bounded) failure. attemptCount is incremented by the caller
 *  before retrying. Terminal via the transitions map. */
export async function recordFailure(job: FactoryJob, reason: string): Promise<FactoryJob> {
  if (!FACTORY_JOB_TRANSITIONS[job.status].includes('FAILED')) {
    throw new Error(`Invalid factory job transition: ${job.status} -> FAILED.`);
  }
  job.status = 'FAILED';
  job.lastError = reason;
  job.deadLettered = false;
  job.updatedAt = new Date().toISOString();
  await db.factoryJobs.update(job);
  return job;
}

/** Mark permanent failure (e.g. a gate rejected the design deterministically,
 *  so retrying the same design cannot help). */
export async function markDeadLetter(job: FactoryJob, reason: string): Promise<FactoryJob> {
  if (!FACTORY_JOB_TRANSITIONS[job.status].includes('DEAD_LETTERED')) {
    throw new Error(`Invalid factory job transition: ${job.status} -> DEAD_LETTERED.`);
  }
  job.status = 'DEAD_LETTERED';
  job.lastError = reason;
  job.deadLettered = true;
  job.updatedAt = new Date().toISOString();
  await db.factoryJobs.update(job);
  return job;
}
