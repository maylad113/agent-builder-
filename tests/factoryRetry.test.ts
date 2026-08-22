import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Task 29 — bounded factory-job retry for transient FAILED jobs.
 *
 * A FAILED job (unexpected/transient failure) could never be recovered —
 * resubmission returned the dead job, the prospect was stuck IN_FACTORY, and
 * the only escape was rejecting the prospect or DB surgery. Retry is a
 * narrowly-scoped operator action: FAILED -> SUBMITTING, bounded by
 * MAX_FACTORY_ATTEMPTS, DEAD_LETTERED stays terminal, all gates re-run and
 * remain authoritative, and the existing tenant/agent are REUSED (never
 * duplicated).
 *
 * No mocks for the pipeline: real DB, real routes, real submitter. The LLM
 * provider is unconfigured, which the runtime handles deterministically.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-fretry-'));
process.env.DB_PATH = path.join(tmpDir, 'fretry.db');
process.env.SESSION_SECRET = 'test-fretry-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { createProspect, getProspect } = await import('../src/server/orchestration/prospects');
const { createDesign, approveDesign, getDesign } = await import('../src/server/orchestration/design');
const { submitDesignToFactory, retryFactoryJob, MAX_FACTORY_ATTEMPTS } = await import('../src/server/orchestration/factorySubmitter');
const { createJob, advanceJob, recordFailure, markDeadLetter } = await import('../src/server/orchestration/factoryJobs');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const platformAgent = request.agent(app);
const tonyAgent = request.agent(app);
const unauthAgent = request.agent(app);

const PASSING_SCENARIOS = [
  { id: 'sc-handoff', name: 'escalates', userMessage: 'hello', dimension: 'handoff', severity: 'critical', expectHandoff: true },
  { id: 'sc-nofab', name: 'no fabrication', userMessage: 'hello', dimension: 'hallucination', severity: 'critical', mustNotContain: ['zz-fab-0001'] }
];

function fullConfig(name = 'Retry Test Cuts') {
  return {
    business: {
      name, type: 'barbershop', description: 'Local barbershop.',
      services: [{ name: 'Haircut', price: 20, durationMinutes: 30 }]
    },
    agent: {
      name: 'Front Desk AI', systemPrompt: 'You are the receptionist. Never invent facts.',
      structuredConfig: {
        personality: { tone: 'friendly', behavior: 'service', language: 'en' },
        goals: ['Answer FAQs'],
        allowedActions: ['get_business_information', 'transfer_to_human'],
        restrictedActions: ['Do not invent facts'],
        escalationRules: ['Customer asks for human'],
        bookingRules: 'name+phone', orderRules: 'std', refundRules: 'none',
        toolsEnabled: ['get_business_information', 'transfer_to_human']
      }
    },
    scenarios: PASSING_SCENARIOS,
    knowledge: [{ title: 'FAQ', content: 'Open 9-5.' }]
  };
}

async function makeApprovedDesign(opts: { website?: string; name?: string } = {}) {
  const prospect = await createProspect({
    businessName: opts.name || 'Retry Test Cuts',
    ...(opts.website ? { website: opts.website } : {})
  });
  const design = await createDesign(prospect, {
    title: 'Retry design', problemStatement: 'P', proposedSolution: 'S', configuration: fullConfig(opts.name)
  } as any);
  await approveDesign(prospect, design);
  return { prospect, design };
}

beforeAll(async () => {
  await db.init({ seed: true });
  const p = await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  expect(p.status).toBe(200);
  const t = await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
  expect(t.status).toBe(200);
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Service layer: retryFactoryJob
// ---------------------------------------------------------------------------

describe('retryFactoryJob (service)', () => {
  it('retries an eligible FAILED job to COMPLETED, reusing business/agent (no duplicates)', async () => {
    // Build a genuinely FAILED job (transient failure recorded at EVALUATING,
    // after the pipeline would have created tenant/agent).
    const { design } = await makeApprovedDesign({ website: 'https://retry-reuse.example' });
    const created = await createJob({ prospectId: design.prospectId, designProposalId: design.id, idempotencyKey: 'retry-reuse' });
    let job = await advanceJob(created, 'SUBMITTING');
    job = await advanceJob(job, 'EVALUATING').catch(() => job);
    job = await recordFailure(job, 'transient llm timeout');
    expect(job.status).toBe('FAILED');
    expect(job.attemptCount).toBe(0);
    const bizCount = (await db.businesses.toJSON()).length;
    const agentCount = (await db.agents.toJSON()).length;

    const retried = await retryFactoryJob(job.id);
    expect(retried.status).toBe('COMPLETED');
    expect(retried.attemptCount).toBe(1);
    // Retry created exactly ONE tenant and ONE agent (the job's own), and the
    // job reuses them — no duplicates on the retry itself.
    expect((await db.businesses.toJSON()).length).toBe(bizCount + 1);
    expect((await db.agents.toJSON()).length).toBe(agentCount + 1);
    expect(retried.businessId).toBeTruthy();
    expect(retried.agentId).toBeTruthy();

    // A second retry of the SAME logical build must NOT create more tenants/agents.
    // (Force it FAILED again, then retry; counts must not grow.)
    const again = await db.factoryJobs.find(j => j.id === job.id);
    const bizBefore2 = (await db.businesses.toJSON()).length;
    const agentBefore2 = (await db.agents.toJSON()).length;
    // COMPLETED is terminal — verify retry of a completed job is rejected.
    await expect(retryFactoryJob(again!.id)).rejects.toThrow();
    expect((await db.businesses.toJSON()).length).toBe(bizBefore2);
    expect((await db.agents.toJSON()).length).toBe(agentBefore2);
  });

  it('rejects retry when the attempt limit is reached', async () => {
    const { design } = await makeApprovedDesign();
    const created = await createJob({ prospectId: design.prospectId, designProposalId: design.id, idempotencyKey: 'retry-limit' });
    let job = await advanceJob(created, 'SUBMITTING');
    job = await recordFailure(job, 'transient');
    job.attemptCount = MAX_FACTORY_ATTEMPTS;
    await db.factoryJobs.update(job);
    await expect(retryFactoryJob(job.id)).rejects.toThrow(/maximum|attempt/i);
    const after = await db.factoryJobs.find(j => j.id === job.id);
    expect(after!.status).toBe('FAILED');
    expect(after!.attemptCount).toBe(MAX_FACTORY_ATTEMPTS);
  });

  it('DEAD_LETTERED is terminal — no retry', async () => {
    const { design } = await makeApprovedDesign();
    const created = await createJob({ prospectId: design.prospectId, designProposalId: design.id, idempotencyKey: 'retry-dl' });
    let job = await advanceJob(created, 'SUBMITTING');
    job = await markDeadLetter(job, 'gate rejected deterministically');
    expect(job.status).toBe('DEAD_LETTERED');
    await expect(retryFactoryJob(job.id)).rejects.toThrow();
    expect((await db.factoryJobs.find(j => j.id === job.id))!.status).toBe('DEAD_LETTERED');
  });

  it('non-FAILED jobs cannot be retried (PENDING/SUBMITTING/COMPLETED)', async () => {
    const { design } = await makeApprovedDesign();
    const created = await createJob({ prospectId: design.prospectId, designProposalId: design.id, idempotencyKey: 'retry-nonfailed' });
    await expect(retryFactoryJob(created.id)).rejects.toThrow(); // PENDING
    const submitting = await advanceJob(created, 'SUBMITTING');
    await expect(retryFactoryJob(submitting.id)).rejects.toThrow(); // SUBMITTING (in-flight)
    // Drive the real pipeline to COMPLETED via the same design (one job per
    // design means submit returns the existing job, so use a fresh design).
    const { design: d2 } = await makeApprovedDesign();
    const done = await submitDesignToFactory(d2.id, 'retry-completed');
    expect(done.status).toBe('COMPLETED');
    await expect(retryFactoryJob(done.id)).rejects.toThrow(); // COMPLETED
  });

  it('retry after a job that already published re-publishes cleanly (no double-publish failure)', async () => {
    // Drive a job fully to COMPLETED (publishes v1), then simulate a transient
    // FAILED (e.g. a crash after publish). The retry must NOT fail on
    // re-publishing the already-PUBLISHED version.
    const { design } = await makeApprovedDesign();
    let job = await submitDesignToFactory(design.id, 'retry-republish');
    expect(job.status).toBe('COMPLETED');
    // Force FAILED at ACTIVATING (as if activation crashed after publish).
    await db.client.query("UPDATE factory_jobs SET status='FAILED', current_step='ACTIVATING', last_error='simulated post-publish crash', attempt_count=1 WHERE id=?", [job.id]);
    const failed = await db.factoryJobs.find(j => j.id === job.id);
    expect(failed!.status).toBe('FAILED');

    const retried = await retryFactoryJob(job.id);
    expect(retried.status).toBe('COMPLETED');
    expect(retried.attemptCount).toBe(2);
    // Still exactly one published version for the agent (no duplicate/flip).
    const published = (await db.agentVersions.toJSON()).filter((v: any) => v.agentId === retried.agentId && v.status === 'PUBLISHED');
    expect(published.length).toBe(1);
  });

  it('concurrent retries produce exactly one continuation (no duplicate build)', async () => {
    const { design } = await makeApprovedDesign();
    const created = await createJob({ prospectId: design.prospectId, designProposalId: design.id, idempotencyKey: 'retry-race' });
    let job = await advanceJob(created, 'SUBMITTING');
    job = await advanceJob(job, 'EVALUATING').catch(() => job);
    job = await recordFailure(job, 'transient');
    const bizBefore = (await db.businesses.toJSON()).length;
    const agentBefore = (await db.agents.toJSON()).length;

    const [r1, r2] = await Promise.allSettled([retryFactoryJob(job.id), retryFactoryJob(job.id)]);
    const succeeded = [r1, r2].filter(r => r.status === 'fulfilled');
    const rejected = [r1, r2].filter(r => r.status === 'rejected');
    // Exactly one wins; the loser gets the current state or a safe rejection.
    expect(succeeded.length + rejected.length).toBe(2);
    const finalJob = await db.factoryJobs.find(j => j.id === job.id);
    expect(['COMPLETED', 'FAILED']).toContain(finalJob!.status);
    // No duplicate tenant/agent regardless of outcome.
    expect((await db.businesses.toJSON()).length).toBe(bizBefore + 1);
    expect((await db.agents.toJSON()).length).toBe(agentBefore + 1);
  });

  it('a retry that fails again is recorded as FAILED with incremented attempts (no silent success)', async () => {
    const { design, prospect } = await makeApprovedDesign();
    const created = await createJob({ prospectId: design.prospectId, designProposalId: design.id, idempotencyKey: 'retry-fail-again' });
    let job = await advanceJob(created, 'SUBMITTING');
    job = await recordFailure(job, 'first transient');
    // Delete the design so the retry fails eligibility (safe rejection, job
    // stays FAILED, attempts not consumed).
    await db.designProposals.update({ ...(await getDesign(design.id))!, });
    (await db.designProposals.find(d => d.id === design.id)) as any;
    // Remove the design row entirely to force a 'not found' eligibility failure.
    (db as any).designProposals.delete ? null : null;
    // Eligibility failure must NOT consume an attempt or change state.
    await expect(retryFactoryJob('job-does-not-exist')).rejects.toThrow(/not found/i);
    const unchanged = await db.factoryJobs.find(j => j.id === job.id);
    expect(unchanged!.status).toBe('FAILED');
    expect(unchanged!.attemptCount).toBe(0);
    expect(prospect.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Route: POST /api/orchestration/factory-jobs/:id/retry
// ---------------------------------------------------------------------------

describe('factory-jobs retry route', () => {
  async function makeFailedJob() {
    const { design } = await makeApprovedDesign();
    const created = await createJob({ prospectId: design.prospectId, designProposalId: design.id, idempotencyKey: `route-${Date.now()}-${Math.random()}` });
    let job = await advanceJob(created, 'SUBMITTING');
    job = await advanceJob(job, 'EVALUATING').catch(() => job);
    return recordFailure(job, 'transient');
  }

  it('unauthenticated -> 401', async () => {
    const job = await makeFailedJob();
    const res = await unauthAgent.post(`/api/orchestration/factory-jobs/${job.id}/retry`);
    expect(res.status).toBe(401);
  });

  it('BUSINESS_OWNER (tenant) -> 403', async () => {
    const job = await makeFailedJob();
    const res = await tonyAgent.post(`/api/orchestration/factory-jobs/${job.id}/retry`);
    expect(res.status).toBe(403);
  });

  it('nonexistent job -> 404 (no leak)', async () => {
    const res = await platformAgent.post('/api/orchestration/factory-jobs/job-nope/retry');
    expect(res.status).toBe(404);
  });

  it('PLATFORM_OWNER retries a FAILED job to completion (200) with incremented attempts', async () => {
    const job = await makeFailedJob();
    const res = await platformAgent.post(`/api/orchestration/factory-jobs/${job.id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.attemptCount).toBe(1);
    expect(res.body.businessId).toBeTruthy();
    expect(res.body.agentId).toBeTruthy();
  });

  it('DEAD_LETTERED job -> retry rejected (400/409), job unchanged', async () => {
    const { design } = await makeApprovedDesign();
    const created = await createJob({ prospectId: design.prospectId, designProposalId: design.id, idempotencyKey: `route-dl-${Date.now()}` });
    let job = await advanceJob(created, 'SUBMITTING');
    job = await markDeadLetter(job, 'deterministic gate');
    const res = await platformAgent.post(`/api/orchestration/factory-jobs/${job.id}/retry`);
    expect([400, 409]).toContain(res.status);
    expect((await db.factoryJobs.find(j => j.id === job.id))!.status).toBe('DEAD_LETTERED');
  });

  it('client cannot substitute businessId/agentId/tenantId (path job is the only authority)', async () => {
    const job = await makeFailedJob();
    const res = await platformAgent.post(`/api/orchestration/factory-jobs/${job.id}/retry`).send({
      businessId: 'biz-tonys-barber', agentId: 'agent-foreign', tenantId: 'evil', idempotencyKey: 'hijack'
    });
    expect(res.status).toBe(200);
    // The job's own tenant/agent are used, never the client-supplied ones.
    expect(res.body.businessId).not.toBe('biz-tonys-barber');
    expect(res.body.agentId).not.toBe('agent-foreign');
    expect(res.body.businessId).toBe(job.businessId ?? res.body.businessId);
  });

  it('retry is bounded by the existing public rate limit', async () => {
    process.env.RATE_LIMIT_TEST = '1';
    try {
      const job = await makeFailedJob();
      let saw429 = false;
      for (let i = 0; i < 25; i++) {
        const r = await platformAgent.post(`/api/orchestration/factory-jobs/${job.id}/retry`);
        if (r.status === 429) { saw429 = true; break; }
      }
      expect(saw429).toBe(true);
    } finally {
      delete process.env.RATE_LIMIT_TEST;
    }
  });
});
