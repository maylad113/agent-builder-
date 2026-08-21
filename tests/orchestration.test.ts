import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Sales & Delivery Orchestrator MVP tests.
 *
 * Flow under test: manual prospect -> design proposal -> HUMAN approve ->
 * submit -> (factory: tenant+agent create -> evaluate -> correct-if-needed ->
 * publish -> activate) -> delivery -> acceptance.
 *
 * Covers (per directive): CRUD, human-gate enforcement, submit/idempotency,
 * factory-gate authority (evaluation/correction/publish/activation remain in
 * the factory), delivery + acceptance invariants, authorization, isolation,
 * malformed/malicious input, error sanitization, and both failure terminal
 * states (FAILED via module, DEAD_LETTERED via real unresolved gates).
 *
 * No mocks: the real seeded DB, real routes, real factory services. Provider
 * stays unconfigured (GEMINI key deleted, no Ollama daemon), which the
 * runtime handles deterministically via its graceful handoff path.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-orch-'));
process.env.DB_PATH = path.join(tmpDir, 'orch.db');
process.env.SESSION_SECRET = 'test-orchestration-secret';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { publishVersion } = await import('../src/server/agentVersions');
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

interface OrchIds {
  goodProspectId?: string;
  badGateProspectId?: string;
  badCorrProspectId?: string;
  goodDesignId?: string;
  badGateDesignId?: string;
  badCorrDesignId?: string;
  jobId?: string;
  businessId?: string;
  agentId?: string;
  deliveryId?: string;
}
const ids: OrchIds = {};

const PASSING_SCENARIO = {
  id: 'sc-handoff', name: 'escalates', userMessage: 'hello',
  dimension: 'handoff', severity: 'critical', expectHandoff: true
};
const PASSING_SCENARIO_2 = {
  id: 'sc-nofab', name: 'no fabrication', userMessage: 'hello',
  dimension: 'hallucination', severity: 'critical',
  mustNotContain: ['zz-fabricated-claim-0001']
};
const FAILING_SCENARIO = {
  id: 'sc-mustcontain', name: 'needs facts', userMessage: 'prices?',
  dimension: 'factual_knowledge', severity: 'critical',
  mustContain: ['zz-never-in-any-response-9982']
};

function fullConfig(overrides: { scenarios?: any[]; knowledge?: any[] } = {}) {
  const { scenarios = [PASSING_SCENARIO, PASSING_SCENARIO_2], knowledge = [{ title: 'FAQ', content: 'Open 9-5.' }] } = overrides;
  return {
    business: {
      name: 'Municipal Barber Co.',
      type: 'barbershop',
      description: 'Local barbershop in Springfield.',
      services: [{ name: 'Haircut', price: 20, durationMinutes: 30 }],
      policies: { cancellation: 'Cancel 2h early.' }
    },
    agent: {
      name: 'Front Desk AI',
      description: 'Receptionist',
      systemPrompt: 'You are the receptionist. Never invent facts.',
      structuredConfig: {
        personality: { tone: 'friendly', behavior: 'service', language: 'en' },
        goals: ['Answer FAQs'],
        allowedActions: ['get_business_information', 'transfer_to_human'],
        restrictedActions: ['Do not invent facts'],
        escalationRules: ['Customer asks for human'],
        bookingRules: 'name+phone required',
        orderRules: 'standard',
        refundRules: 'none',
        toolsEnabled: ['get_business_information', 'transfer_to_human']
      }
    },
    scenarios,
    knowledge
  };
}

beforeAll(async () => {
  await db.init();
  const pLogin = await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  expect(pLogin.status).toBe(200);
  const tLogin = await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
  expect(tLogin.status).toBe(200);
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ===========================================================================
// Authorization
// ===========================================================================

describe('orchestration authorization', () => {
  it('unauthenticated requests are rejected (401) on all orchestration routes', async () => {
    const res = await unauthAgent.get('/api/orchestration/prospects');
    expect(res.status).toBe(401);
    const r2 = await unauthAgent.post('/api/orchestration/prospects').send({ businessName: 'x' });
    expect(r2.status).toBe(401);
  });

  it('non-platform-owner (tenant) is rejected (403)', async () => {
    const res = await tonyAgent.get('/api/orchestration/prospects');
    expect(res.status).toBe(403);
    const r2 = await tonyAgent.post('/api/orchestration/prospects').send({ businessName: 'x' });
    expect(r2.status).toBe(403);
    const r3 = await tonyAgent.post('/api/orchestration/designs/des-nope/approve');
    expect(r3.status).toBe(403);
  });
});

// ===========================================================================
// Prospects CRUD
// ===========================================================================

describe('prospects', () => {
  it('platform owner creates a prospect (1)', async () => {
    const res = await platformAgent.post('/api/orchestration/prospects').send({
      businessName: 'Municipal Barber Co.',
      contactName: 'Sam Owner',
      contactPhone: '+15550000001'
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^pro-/);
    expect(res.body.status).toBe('NEW');
    ids.goodProspectId = res.body.id;
  });

  it('retrieves the created prospect (2)', async () => {
    const res = await platformAgent.get(`/api/orchestration/prospects/${ids.goodProspectId}`);
    expect(res.status).toBe(200);
    expect(res.body.businessName).toBe('Municipal Barber Co.');
    const list = await platformAgent.get('/api/orchestration/prospects');
    expect(list.body.some((p: any) => p.id === ids.goodProspectId)).toBe(true);
  });

  it('updates prospect fields (3)', async () => {
    const res = await platformAgent.patch(`/api/orchestration/prospects/${ids.goodProspectId}`).send({
      location: 'Springfield', notes: 'Corner of Main and 5th.'
    });
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('Springfield');
    expect(res.body.status).toBe('NEW');
  });

  it('ignores a client-supplied businessId (tenant label cannot be forged)', async () => {
    const res = await platformAgent.patch(`/api/orchestration/prospects/${ids.goodProspectId}`).send({
      businessId: 'biz-tonys-barber'
    });
    expect(res.status).toBe(200);
    expect(res.body.businessId ?? null).toBeNull(); // never adopts a forged tenant id
  });

  it('rejects malformed input (21a)', async () => {
    const missing = await platformAgent.post('/api/orchestration/prospects').send({});
    expect(missing.status).toBe(400);
  });
});

// ===========================================================================
// Designs + human approval gate
// ===========================================================================

describe('designs + human gate', () => {
  it('creates a design proposal (4) and moves the prospect', async () => {
    const res = await platformAgent.post(`/api/orchestration/prospects/${ids.goodProspectId}/designs`).send({
      title: 'AI Receptionist',
      problemStatement: 'Missed calls after hours.',
      proposedSolution: 'AI receptionist answers FAQs and escalates.',
      capabilities: ['answer_faqs', 'handoff'],
      configuration: fullConfig()
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    ids.goodDesignId = res.body.id;
    const prospect = await platformAgent.get(`/api/orchestration/prospects/${ids.goodProspectId}`);
    expect(prospect.body.status).toBe('DESIGN_PROPOSED');
  });

  it('cannot be submitted to the factory before HUMAN approval (5)', async () => {
    const res = await platformAgent.post(`/api/orchestration/designs/${ids.goodDesignId}/submit`).send({
      idempotencyKey: 'early-submit-1'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/APPROVED/);
    const jobs = await platformAgent.get('/api/orchestration/factory-jobs');
    expect(jobs.body.some((j: any) => j.idempotencyKey === 'early-submit-1')).toBe(false);
  });

  it('approve is explicit (6); design becomes APPROVED with a timestamp', async () => {
    const res = await platformAgent.post(`/api/orchestration/designs/${ids.goodDesignId}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approvedAt).toBeTruthy();
    const prospect = await platformAgent.get(`/api/orchestration/prospects/${ids.goodProspectId}`);
    expect(prospect.body.status).toBe('APPROVED');
  });

  it('blocks approval when configuration is invalid (human gate cannot rubber-stamp garbage)', async () => {
    const res = await platformAgent.post(`/api/orchestration/prospects/${ids.goodProspectId}/designs`).send({
      title: 'Bad', problemStatement: 'p', proposedSolution: 's',
      configuration: { business: { name: 'x' } } // missing scenarios/agent
    });
    expect(res.status).toBe(201);
    const approve = await platformAgent.post(`/api/orchestration/designs/${res.body.id}/approve`);
    expect(approve.status).toBe(400);
    expect(approve.body.error).toMatch(/configuration/i);
  });
});

// ===========================================================================
// Factory submission — happy path (gates stay authoritative)
// ===========================================================================

describe('factory submission (happy path)', () => {
  it('submits an APPROVED design and completes end-to-end (7, 8)', async () => {
    const res = await platformAgent.post(`/api/orchestration/designs/${ids.goodDesignId}/submit`).send({
      idempotencyKey: 'good-submit-1'
    });
    expect(res.status).toBe(200);
    const job = res.body;
    ids.jobId = job.id;
    ids.businessId = job.businessId;
    ids.agentId = job.agentId;
    expect(job.status).toBe('COMPLETED');
    expect(job.deadLettered).toBe(false);
    expect(job.businessId).toBeTruthy();
    expect(job.agentId).toBeTruthy();
    const prospect = await platformAgent.get(`/api/orchestration/prospects/${ids.goodProspectId}`);
    expect(prospect.body.status).toBe('CONVERTED');
    expect(prospect.body.businessId).toBe(job.businessId);
  }, 30000);

  it('produced a real tenant agent wired through the factory (9, 12)', async () => {
    // An evaluation was recorded for the version (evaluation authority seam).
    const evals = await db.evaluationResults.filter((e: any) => e.agentId === ids.agentId);
    expect(evals.length).toBeGreaterThanOrEqual(1);
    expect(evals[0].businessId).toBe(ids.businessId);
    // The version is PUBLISHED (publish gate outcome).
    const published = await db.agentVersions.find((v: any) => v.agentId === ids.agentId && v.status === 'PUBLISHED');
    expect(published).toBeTruthy();
    // The agent is ACTIVE (activation/readiness gate outcome).
    const agent = await db.agents.find((a: any) => a.id === ids.agentId);
    expect(agent.status).toBe('ACTIVE');
    expect(agent.businessId).toBe(ids.businessId);
    // Telemetry recorded the lifecycle (observability discipline).
    const started = await db.telemetry.find((t: any) => t.eventType === 'FACTORY_JOB_STARTED');
    expect(started).toBeTruthy();
  });

  it('creates the delivery only after successful activation (13)', async () => {
    const deliveries = await platformAgent.get('/api/orchestration/deliveries');
    const mine = deliveries.body.filter((d: any) => d.businessId === ids.businessId);
    expect(mine.length).toBe(1);
    ids.deliveryId = mine[0].id;
    expect(mine[0].status).toBe('DELIVERED');
    expect(mine[0].agentId).toBe(ids.agentId);
    const agentCreatedStill = await db.deliveries.find((d: any) => d.prospectId === ids.goodProspectId);
    expect(agentCreatedStill).toBeTruthy();
  });

  // =========================================================================
  // Idempotency
  // =========================================================================

  it('idempotent submission: same key returns the SAME job (16)', async () => {
    const res = await platformAgent.post(`/api/orchestration/designs/${ids.goodDesignId}/submit`).send({
      idempotencyKey: 'good-submit-1'
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ids.jobId);
    expect(res.body.status).toBe('COMPLETED');
  }, 30000);

  it('a duplicate idempotency key creates NO duplicate agent or delivery (17)', async () => {
    const agents = await db.agents.filter((a: any) => a.businessId === ids.businessId);
    expect(agents.length).toBe(1);
    const deliveries = await db.deliveries.filter((d: any) => d.businessId === ids.businessId);
    expect(deliveries.length).toBe(1);
    const jobs = await db.factoryJobs.filter((j: any) => j.idempotencyKey === 'good-submit-1');
    expect(jobs.length).toBe(1);
  });

  it('even with a DIFFERENT key, re-submitting the same design yields the original job (no duplicate agent)', async () => {
    const res = await platformAgent.post(`/api/orchestration/designs/${ids.goodDesignId}/submit`).send({
      idempotencyKey: 'good-submit-2'
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ids.jobId);
    const agents = await db.agents.filter((a: any) => a.businessId === ids.businessId);
    expect(agents.length).toBe(1);
    const jobs = await db.factoryJobs.filter((j: any) => j.designProposalId === ids.goodDesignId);
    expect(jobs.length).toBe(1);
  }, 30000);

  // =========================================================================
  // Acceptance
  // =========================================================================

  it('acceptance works (14)', async () => {
    const res = await platformAgent.post(`/api/orchestration/deliveries/${ids.deliveryId}/accept`).send({
      acceptedBy: 'sam-owner', acceptanceMethod: 'in_person'
    });
    expect(res.status).toBe(201);
    expect(res.body.deliveryId).toBe(ids.deliveryId);
    expect(res.body.acceptedAt).toBeTruthy();
    const delivery = await platformAgent.get(`/api/orchestration/deliveries/${ids.deliveryId}`);
    expect(delivery.body.status).toBe('ACCEPTED');
  });

  it('rejects a duplicate acceptance (15)', async () => {
    const res = await platformAgent.post(`/api/orchestration/deliveries/${ids.deliveryId}/accept`).send({
      acceptedBy: 'sam-owner-again'
    });
    expect(res.status).toBe(400);
    const rows = await db.acceptances.filter((a: any) => a.deliveryId === ids.deliveryId);
    expect(rows.length).toBe(1);
  });
});

// ===========================================================================
// Failure terminals: gates stay authoritative; DEAD_LETTERED
// ===========================================================================

describe('gateway authority + DEAD_LETTERED', () => {
  it('a design failing evaluation dead-letters at CORRECTING; publish gate would still block (10, 11, 25)', async () => {
    const p = await platformAgent.post('/api/orchestration/prospects').send({ businessName: 'Broken Perez Salon' });
    ids.badCorrProspectId = p.body.id;
    const d = await platformAgent.post(`/api/orchestration/prospects/${p.body.id}/designs`).send({
      title: 'Unresolvable', problemStatement: 'x', proposedSolution: 'y',
      configuration: fullConfig({ scenarios: [FAILING_SCENARIO] })
    });
    ids.badCorrDesignId = d.body.id;
    await platformAgent.post(`/api/orchestration/designs/${d.body.id}/approve`);
    const submit = await platformAgent.post(`/api/orchestration/designs/${d.body.id}/submit`).send({
      idempotencyKey: 'bad-corr-1'
    });
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('DEAD_LETTERED');
    expect(submit.body.currentStep).toBe('CORRECTING');
    expect(submit.body.lastError).toContain('correction');

    // Evaluation authority: a failing evaluation row exists for that version.
    const agent = await db.agents.find((a: any) => a.businessId === submit.body.businessId);
    const evals = await db.evaluationResults.filter((e: any) => e.agentId === agent.id);
    expect(evals.length).toBeGreaterThanOrEqual(1);
    expect(evals[0].overallPassed).toBe(false);

    // The REAL correction engine ran for this agent (correction authority).
    const correctionRuns = await db.correctionRuns.filter((c: any) => c.agentId === agent.id);
    expect(correctionRuns.length).toBeGreaterThanOrEqual(1);

    // Nothing got published (publish authority uncompromised by orchestration).
    const versions = await db.agentVersions.filter((v: any) => v.agentId === agent.id);
    const anyPublished = versions.some((v: any) => v.status === 'PUBLISHED');
    expect(anyPublished).toBe(false);
    // Direct factory call confirms the gate itself still rejects this version.
    await expect(publishVersion(evals[0].versionId, agent.id)).rejects.toThrow(/blocked|critical/i);

    // No delivery WITHOUT successful activation.
    const deliveries = await db.deliveries.filter((x: any) => x.businessId === submit.body.businessId);
    expect(deliveries.length).toBe(0);
  }, 60000);

  it('a design missing knowledge is rejected at the compatibility gate (never reaches the factory) (12, 25)', async () => {
    const p = await platformAgent.post('/api/orchestration/prospects').send({ businessName: 'Readiness Failing Gym' });
    ids.badGateProspectId = p.body.id;
    const d = await platformAgent.post(`/api/orchestration/prospects/${p.body.id}/designs`).send({
      title: 'No Knowledge', problemStatement: 'x', proposedSolution: 'y',
      configuration: fullConfig({ knowledge: undefined as any, scenarios: [PASSING_SCENARIO, PASSING_SCENARIO_2] })
    });
    ids.badGateDesignId = d.body.id;
    // Strip knowledge (simulate operator edit) → guaranteed runtime failure,
    // now caught by the Task 16 compatibility check at submission.
    const cfg = d.body.configuration;
    delete cfg.knowledge;
    const designRow = await db.designProposals.find((x: any) => x.id === d.body.id);
    designRow.configuration = cfg;
    await db.designProposals.update(designRow);
    const jobsBefore = (await db.factoryJobs.toJSON()).length;
    await platformAgent.post(`/api/orchestration/designs/${d.body.id}/approve`);
    const submit = await platformAgent.post(`/api/orchestration/designs/${d.body.id}/submit`).send({
      idempotencyKey: 'bad-gate-1'
    });
    expect(submit.status).toBe(400);
    expect(JSON.stringify(submit.body)).toContain('Knowledge base');
    expect((await db.factoryJobs.toJSON()).length).toBe(jobsBefore);
  }, 60000);

  it('module-level failure path is deterministic: recordFailure → FAILED terminal (24)', async () => {
    const job = await createJob({ prospectId: ids.goodProspectId!, designProposalId: ids.goodDesignId!, idempotencyKey: 'module-fail-1' });
    const submitting = await advanceJob(job, 'SUBMITTING');
    expect(submitting.status).toBe('SUBMITTING');
    const failed = await recordFailure(submitting, 'synthetic failure');
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toBe('synthetic failure');
    expect(failed.deadLettered).toBe(false);
    // FAILED is terminal in the explicit map.
    await expect(advanceJob(failed, 'COMPLETED')).rejects.toThrow(/Invalid factory job transition/);
  });

  it('module-level dead-letter path: markDeadLetter → DEAD_LETTERED terminal', async () => {
    const job = await createJob({ prospectId: ids.goodProspectId!, designProposalId: ids.goodDesignId!, idempotencyKey: 'module-dl-1' });
    const submitting = await advanceJob(job, 'SUBMITTING');
    const dl = await markDeadLetter(submitting, 'permanent');
    expect(dl.status).toBe('DEAD_LETTERED');
    expect(dl.deadLettered).toBe(true);
    await expect(advanceJob(dl, 'PUBLISHING')).rejects.toThrow(/Invalid factory job transition/);
  });
});

// ===========================================================================
// Security / abuse
// ===========================================================================

describe('security & error sanitization', () => {
  it('foreign design/factory-job/delivery ids are 404 (no existence leak)', async () => {
    expect((await platformAgent.get('/api/orchestration/designs/des-nope')).status).toBe(404);
    expect((await platformAgent.get('/api/orchestration/factory-jobs/job-nope')).status).toBe(404);
    expect((await platformAgent.get('/api/orchestration/deliveries/del-nope')).status).toBe(404);
    expect((await platformAgent.post('/api/orchestration/designs/des-nope/submit').send({ idempotencyKey: 'x' })).status).toBe(404);
    expect((await platformAgent.post('/api/orchestration/deliveries/del-nope/accept').send({ acceptedBy: 'x' })).status).toBe(404);
  });

  it('invalid state transitions are rejected deterministically', async () => {
    // NEW prospect cannot jump to IN_FACTORY.
    const p = await platformAgent.post('/api/orchestration/prospects').send({ businessName: 'Transition Test' });
    const bad = await platformAgent.patch(`/api/orchestration/prospects/${p.body.id}`).send({ status: 'IN_FACTORY' });
    expect(bad.status).toBe(400);
    // Legal transition still works (NEW -> REJECTED).
    const ok = await platformAgent.patch(`/api/orchestration/prospects/${p.body.id}`).send({ status: 'REJECTED' });
    expect(ok.status).toBe(200);
  });

  it('SQL-like malicious input is safely stored via parameterized queries', async () => {
    const evil = `'); DROP TABLE prospects;--`;
    const res = await platformAgent.post('/api/orchestration/prospects').send({ businessName: evil });
    expect(res.status).toBe(201);
    const fetched = await platformAgent.get(`/api/orchestration/prospects/${res.body.id}`);
    expect(fetched.body.businessName).toBe(evil);
    const stillThere = await platformAgent.get('/api/orchestration/prospects');
    expect(stillThere.status).toBe(200);
  });

  it('oversized input is bounded (truncated, not crashed)', async () => {
    const huge = 'X'.repeat(5000);
    const res = await platformAgent.post('/api/orchestration/prospects').send({ businessName: huge });
    expect(res.status).toBe(201);
    expect(res.body.businessName.length).toBeLessThanOrEqual(200);
  });

  it('secret-shaped junk keys never echo back in responses (23)', async () => {
    const secret = 'sk-live-fake-9876543210abcdefghij';
    const res = await platformAgent.post('/api/orchestration/prospects').send({
      businessName: 'Secrets Test', apiKey: secret, secretField: secret
    });
    expect(res.status).toBe(201);
    const bodyJson = JSON.stringify(res.body);
    expect(bodyJson).not.toContain(secret);
  });

  it('error responses never leak SQL/stack/credentials (22); route-level error texts stay generic', async () => {
    const res = await platformAgent.post('/api/orchestration/designs/no-such/submit').send({ idempotencyKey: 'x' });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/(SELECT|INSERT|sqlite|postgresql|Error:)/i);
    // Validation errors are the only source of detail and are module-authored.
    const invalidTransition = await platformAgent.post('/api/orchestration/prospects').send({ businessName: 'ValTest' });
    const transitionErr = await platformAgent.patch(`/api/orchestration/prospects/${invalidTransition.body.id}`).send({ status: 'CONVERTED' });
    expect([400, 404]).toContain(transitionErr.status);
  });
});
