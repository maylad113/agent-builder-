import { db } from '../db';
import { FactoryJob, DesignProposal, Prospect, KnowledgeChunk, FactoryJobStatus } from '../../types';
import { getDesign, validateDesignConfiguration, markDesignSubmitted } from './design';
import { checkFactoryReadinessCompatibility, summarizeCompatibilityGaps } from './readinessCompat';
import { getProspect, setProspectStatus } from './prospects';
import {
  createJob,
  advanceJob,
  recordFailure,
  markDeadLetter,
  findJobByIdempotencyKey
} from './factoryJobs';
import { createDelivery } from './deliveries';
import { createBusinessTenant, createAgentWithInitialDraft, transitionAgentStatus } from '../agentLifecycle';
import { getLatestVersion } from '../agentVersions';
import { publishVersion } from '../agentVersions';
import { runEvaluation } from '../evaluation';
import { runSelfCorrection } from '../correction';
import { recordOrchestrationEvent } from '../telemetry';
import { safeError } from '../logSanitizer';
import { deriveOriginFromWebsite, normalizeWidgetOriginList } from '../widgetSecurity';

/**
 * The ONLY orchestration bridge into the factory lifecycle. It drives the
 * authoritative factory services in the mandated order — create tenant/agent
 * → evaluate → correct-if-required → publish → activate → delivery — and
 * records the run as a durable, idempotent factory job. It reimplements NO
 * factory logic: evaluation, correction, the publish gate, the activation
 * gate, tenant creation, and audit logging all stay in the factory modules
 * (agentLifecycle / agentVersions / evaluation / correction / readiness).
 *
 * Idempotency: the caller supplies an idempotency key. Submitting the same
 * key twice never creates a second agent/delivery — the existing job row is
 * returned. A UNIQUE index backs the invariant even under concurrent calls.
 */
export async function submitDesignToFactory(designId: string, idempotencyKey: string): Promise<FactoryJob> {
  const design = await getDesign(designId);
  if (!design) throw new Error('Design not found.');
  let prospect = await getProspect(design.prospectId);
  if (!prospect) throw new Error('Prospect not found.');
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required.');
  }
  if (design.status !== 'APPROVED') {
    // An already-SUBMITTED design returns its existing job (idempotent).
    if (design.status === 'SUBMITTED') {
      const priorJob = await db.factoryJobs.find(j => j.designProposalId === design.id);
      if (priorJob) return priorJob;
    }
    throw new Error('Design must be APPROVED before it is submitted to the factory.');
  }

  // Idempotent submission: same idempotency key returns the existing job.
  const existing = await findJobByIdempotencyKey(idempotencyKey);
  if (existing) return existing;

  // One job per design: a reuse of a different key still refuses duplicates.
  const priorJobForDesign = await db.factoryJobs.filter(j => j.designProposalId === design.id);
  if (priorJobForDesign.length > 0) return priorJobForDesign[0];

  const problems = validateDesignConfiguration(design.configuration);
  if (problems.length > 0) {
    throw new Error(`Design configuration is invalid: ${problems.join(' ')}`);
  }

  // Pre-flight: refuse to start a Factory job that the ACTIVATING readiness
  // gate is guaranteed to reject. The Factory gate remains authoritative and
  // re-checks everything; this only prevents a guaranteed-doomed job. The
  // design/configuration is NOT modified — the human owns any revision.
  const compat = checkFactoryReadinessCompatibility(design.configuration);
  if (!compat.compatible) {
    const err: any = new Error(`Design configuration is not factory-ready: ${summarizeCompatibilityGaps(compat.gaps)}`);
    err.readinessGaps = compat.gaps;
    throw err;
  }

  let job: FactoryJob;
  try {
    job = await createJob({
      prospectId: prospect.id,
      designProposalId: design.id,
      idempotencyKey
    });
  } catch (e: any) {
    // UNIQUE(idempotency_key) backstop — the losing side of a concurrent
    // submit re-reads and returns the winner's job (never duplicates).
    safeError('[orchestration] factory job create raced:', e?.message || e);
    const raced = await findJobByIdempotencyKey(idempotencyKey);
    if (raced) return raced;
    throw new Error('Factory job could not be created.');
  }

  job = await advanceJob(job, 'SUBMITTING');
  await recordOrchestrationEvent({
    eventType: 'FACTORY_JOB_STARTED',
    prospectId: prospect.id,
    businessId: prospect.businessId,
    summary: 'Factory job started',
    metadata: { jobId: job.id, designId: design.id }
  });

  // Mark the design SUBMITTED (and prospect IN_FACTORY) before the heavy work.
  await markDesignSubmitted(prospect, design);
  try {
    await setProspectStatus(prospect, 'IN_FACTORY');
  } catch (e: any) {
    // Non-fatal bookkeeping failure is logged but does not stop the pipeline.
    safeError('[orchestration] prospect status update failed:', e?.message || e);
  }

  return executeFactoryJob(job, prospect, design);
}

/**
 * Maximum factory attempts (initial submission + retries). A FAILED job may be
 * retried only while attemptCount is below this bound. Env-overridable for
 * operations; invalid/negative values fall back to the default. Deterministic.
 */
export function maxFactoryAttempts(): number {
  const raw = parseInt(process.env.MAX_FACTORY_ATTEMPTS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}
export const MAX_FACTORY_ATTEMPTS = 3;

/**
 * Retry an eligible FAILED factory job (Task 29). Eligibility is enforced
 * INSIDE a transaction with the job row locked (PG FOR UPDATE; SQLite strips
 * it and the per-connection mutex serializes), so concurrent retries cannot
 * both pass the attempt-limit check. The pipeline then re-runs from
 * SUBMITTING, REUSING the job's existing tenant/agent (never duplicating),
 * with every gate re-run and authoritative.
 */
export async function retryFactoryJob(jobId: string): Promise<FactoryJob> {
  const job = await db.client.transaction(async (): Promise<FactoryJob> => {
    const locked = await db.client.query('SELECT id FROM factory_jobs WHERE id = ? FOR UPDATE', [jobId]);
    if (locked.rows.length === 0) throw new Error('Factory job not found.');
    const current = await db.factoryJobs.find(j => j.id === jobId) as FactoryJob;
    if (current.status === 'DEAD_LETTERED') {
      throw new Error('A dead-lettered job cannot be retried.');
    }
    if (current.status !== 'FAILED') {
      throw new Error(`Only a FAILED job can be retried (current: ${current.status}).`);
    }
    if (current.attemptCount >= maxFactoryAttempts()) {
      throw new Error(`Factory job has reached the maximum of ${maxFactoryAttempts()} attempts.`);
    }
    return advanceJob(current, 'SUBMITTING');
  });

  const design = await getDesign(job.designProposalId);
  if (!design) throw new Error('Design not found for this job.');
  const prospect = await getProspect(job.prospectId);
  if (!prospect) throw new Error('Prospect not found for this job.');

  await recordOrchestrationEvent({
    eventType: 'FACTORY_JOB_STARTED',
    prospectId: prospect.id,
    businessId: job.businessId,
    agentId: job.agentId,
    metadata: { jobId: job.id, designId: design.id },
    summary: `Factory job retried (attempt ${job.attemptCount + 1})`
  });

  return executeFactoryJob(job, prospect, design);
}

/**
 * The shared, resumable factory pipeline. Drives tenant/agent reuse-or-create
 * → evaluate → correct-if-required → publish → activate → deliver. Every gate
 * (evaluation publish gate, activation readiness) re-runs and stays
 * authoritative on both the initial submission and any retry.
 */
async function executeFactoryJob(job: FactoryJob, prospect: Prospect, design: DesignProposal): Promise<FactoryJob> {
  job.attemptCount += 1;

  const stepEvent = async (step: FactoryJobStatus, detail?: string) => {
    await recordOrchestrationEvent({
      eventType: 'FACTORY_JOB_STEP',
      prospectId: prospect.id,
      businessId: job.businessId,
      agentId: job.agentId,
      metadata: { jobId: job.id, designId: design.id, step },
      summary: detail ? `${step}: ${detail}` : `Step ${step}`
    });
  };

  try {
    const config = design.configuration!;

    // --- Step SUBMITTING: tenant + agent + draft version -------------------
    // Widget origin: derive the customer's website origin from the EXISTING
    // prospect website data (validated by the widget security rules; absent or
    // invalid website -> no origin, never a guess). Safe merge semantics:
    // design-config origins and owner-added origins are preserved, duplicates
    // removed, and an existing tenant's allow-list is never overwritten.
    const websiteOrigin = deriveOriginFromWebsite(prospect.website);
    // REUSE the job's existing tenant on retry (job.businessId wins); fall
    // back to the prospect's converted tenant, then create. Never duplicates.
    let business = job.businessId
      ? await db.businesses.find(b => b.id === job.businessId)
      : (prospect.businessId ? await db.businesses.find(b => b.id === prospect.businessId) : undefined);
    if (!business) {
      business = await createBusinessTenant({
        ...config.business,
        name: config.business.name || prospect.businessName,
        allowedWidgetOrigins: normalizeWidgetOriginList([
          ...(Array.isArray(config.business.allowedWidgetOrigins) ? config.business.allowedWidgetOrigins : []),
          ...(websiteOrigin ? [websiteOrigin] : [])
        ])
      });
      prospect = await db.prospects.find(p => p.id === prospect.id) as Prospect;
      prospect.businessId = business.id;
      prospect.updatedAt = new Date().toISOString();
      await db.prospects.update(prospect);
    } else if (websiteOrigin) {
      const existing = normalizeWidgetOriginList(business.allowedWidgetOrigins);
      if (!existing.includes(websiteOrigin)) {
        business.allowedWidgetOrigins = [...existing, websiteOrigin];
        business.updatedAt = new Date().toISOString();
        await db.businesses.update(business);
      }
    }
    job.businessId = business.id;
    job.updatedAt = new Date().toISOString();

    // Optional knowledge chunks (feeds the activation readiness check — the
    // design supplies real chunks; if absent the readiness gate will honestly
    // dead-letter the job at ACTIVATING with its checklist).
    if (Array.isArray(config.knowledge) && config.knowledge.length > 0) {
      for (const k of config.knowledge) {
        const chunk: KnowledgeChunk = {
          id: `knw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          businessId: business.id,
          title: String(k.title),
          type: k.type || 'text',
          content: String(k.content),
          tags: Array.isArray(k.tags) ? k.tags : [],
          createdAt: new Date().toISOString()
        };
        await db.knowledgeChunks.push(chunk);
      }
    }
    await stepEvent('SUBMITTING', 'tenant created');

    // REUSE the job's existing agent on retry; create only when absent.
    let agent = job.agentId ? await db.agents.find(a => a.id === job.agentId) : undefined;
    if (!agent) {
      agent = await createAgentWithInitialDraft({
        businessId: business.id,
        name: config.agent.name,
        description: config.agent.description,
        systemPrompt: config.agent.systemPrompt,
        structuredConfig: config.agent.structuredConfig,
        llmProvider: config.agent.llmProvider,
        model: config.agent.model,
        status: 'READY'
      });
      job.agentId = agent.id;
      job.updatedAt = new Date().toISOString();
      await db.factoryJobs.update(job);
    }

    const draft = await getLatestVersion(agent.id);
    if (!draft) throw new Error('No draft version was created for the agent.');
    let targetVersionId = draft.id;

    // --- Step EVALUATING ---------------------------------------------------
    job = await advanceJob(job, 'EVALUATING');
    await stepEvent('EVALUATING');
    const evalResult = await runEvaluation({
      businessId: business.id,
      agentId: agent.id,
      versionId: targetVersionId,
      scenarios: config.scenarios
    });

    // --- Step CORRECTING (only when evaluation did not pass) ---------------
    if (!evalResult.overallPassed) {
      job = await advanceJob(job, 'CORRECTING');
      await stepEvent('CORRECTING');
      const correction = await runSelfCorrection({
        businessId: business.id,
        agentId: agent.id,
        versionId: targetVersionId,
        scenarios: config.scenarios,
        trustedKnowledgeSources: config.trustedKnowledgeSources || []
      });
      if (correction.finalEvaluationPassed && correction.finalVersionId) {
        targetVersionId = correction.finalVersionId;
        await stepEvent('CORRECTING', 'resolved');
      } else {
        await markDeadLetter(job, 'Self-correction could not resolve the failures; the design needs human review.');
        await recordOrchestrationEvent({
          eventType: 'FACTORY_JOB_FAILED',
          prospectId: prospect.id,
          businessId: job.businessId,
          agentId: job.agentId,
          metadata: { jobId: job.id, designId: design.id, step: 'CORRECTING' },
          summary: 'Correction unresolved (dead-lettered)'
        });
        return job;
      }
    }

    // --- Step PUBLISHING (gate stays authoritative) ------------------------
    job = await advanceJob(job, 'PUBLISHING');
    await stepEvent('PUBLISHING');
    try {
      // On retry the target version may already be PUBLISHED from the prior
      // attempt — re-publishing is then a no-op (the gate already ran), not a
      // failure. Only DRAFT/TESTING versions go through publishVersion.
      const existingVersion = await db.agentVersions.find(v => v.id === targetVersionId);
      if (existingVersion && existingVersion.status === 'PUBLISHED') {
        await stepEvent('PUBLISHING', 'already published (retry)');
      } else {
        await publishVersion(targetVersionId, agent.id);
        await stepEvent('PUBLISHING', 'published');
      }
    } catch (e: any) {
      await markDeadLetter(job, 'Publish evaluation gate blocked.');
      await recordOrchestrationEvent({
        eventType: 'FACTORY_JOB_FAILED',
        prospectId: prospect.id,
        businessId: job.businessId,
        agentId: job.agentId,
        metadata: { jobId: job.id, designId: design.id, step: 'PUBLISHING' },
        summary: 'Publish gate blocked (dead-lettered)'
      });
      return job;
    }

    // --- Step ACTIVATING (readiness gate stays authoritative) --------------
    job = await advanceJob(job, 'ACTIVATING');
    await stepEvent('ACTIVATING');
    const currentAgent = await db.agents.find(a => a.id === agent.id);
    if (!currentAgent) {
      throw new Error('Agent vanished during submission.');
    }
    try {
      await transitionAgentStatus(currentAgent, 'ACTIVE');
    } catch (e: any) {
      await markDeadLetter(job, 'Activation readiness gate failed.');
      await recordOrchestrationEvent({
        eventType: 'FACTORY_JOB_FAILED',
        prospectId: prospect.id,
        businessId: job.businessId,
        agentId: job.agentId,
        metadata: { jobId: job.id, designId: design.id, step: 'ACTIVATING' },
        summary: 'Activation readiness gate failed (dead-lettered)'
      });
      return job;
    }
    await stepEvent('ACTIVATING', 'activated');

    // --- Delivery (only after successful activation) -----------------------
    const delivery = await createDelivery(prospect, job);
    try {
      const refreshed = await db.prospects.find(p => p.id === prospect.id);
      if (refreshed) await setProspectStatus(refreshed, 'CONVERTED');
    } catch (e: any) {
      safeError('[orchestration] prospect conversion bookkeeping failed:', e?.message || e);
    }

    job = await advanceJob(job, 'COMPLETED');
    await recordOrchestrationEvent({
      eventType: 'FACTORY_JOB_STEP',
      prospectId: prospect.id,
      businessId: job.businessId,
      agentId: job.agentId,
      metadata: { jobId: job.id, designId: design.id, step: 'COMPLETED' },
      summary: `Factory job completed (delivery ${delivery.id})`
    });
    return job;
  } catch (e: any) {
    // Deterministic gate failures mark DEAD_LETTERED inline above; anything
    // reaching here is an unexpected/transient failure → FAILED (terminal).
    safeError('[orchestration] factory job failed:', e?.message || e);
    if (['FAILED', 'DEAD_LETTERED', 'COMPLETED'].includes(job.status)) return job;
    await db.factoryJobs.update(await recordFailure(job, 'Unexpected factory failure (see server logs).'));
    await recordOrchestrationEvent({
      eventType: 'FACTORY_JOB_FAILED',
      prospectId: prospect.id,
      businessId: job.businessId,
      agentId: job.agentId,
      metadata: { jobId: job.id, designId: design.id, step: job.currentStep },
      summary: 'Unexpected factory failure'
    });
    return job;
  }
}
