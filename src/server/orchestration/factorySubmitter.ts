import { db } from '../db';
import { FactoryJob, DesignProposal, Prospect, KnowledgeChunk, FactoryJobStatus } from '../../types';
import { getDesign, validateDesignConfiguration, markDesignSubmitted } from './design';
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
    let business = prospect.businessId
      ? await db.businesses.find(b => b.id === prospect.businessId)
      : undefined;
    if (!business) {
      business = await createBusinessTenant({
        ...config.business,
        name: config.business.name || prospect.businessName
      });
      prospect = await db.prospects.find(p => p.id === prospect.id) as Prospect;
      prospect.businessId = business.id;
      prospect.updatedAt = new Date().toISOString();
      await db.prospects.update(prospect);
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

    const agent = await createAgentWithInitialDraft({
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
      await publishVersion(targetVersionId, agent.id);
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
    await stepEvent('PUBLISHING', 'published');

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
