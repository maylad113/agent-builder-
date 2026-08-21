import { Router, Request, Response } from 'express';
import { requireAuth, requireRole, asyncHandler } from '../auth';
import { safeError } from '../logSanitizer';
import {
  createProspect,
  getProspect,
  listProspects,
  updateProspect
} from './prospects';
import {
  createDesign,
  getDesign,
  listDesignsForProspect,
  approveDesign,
  validateDesignConfiguration
} from './design';
import { listJobs, getJob } from './factoryJobs';
import { listDeliveries, getDelivery, acceptDelivery, buildOnboardingArtifact } from './deliveries';
import { provisionOwnerAccount } from './ownerProvisioning';
import { submitDesignToFactory } from './factorySubmitter';
import {
  runResearch,
  getResearchReport,
  listResearchForProspect
} from './leadResearch';
import {
  runDiscovery,
  listDiscoveryRuns,
  getDiscoveryRun,
  listResultsForRun
} from './discoveryRuns';
import { acceptDiscoveryResult, dismissDiscoveryResult } from './discoveryAcceptance';
import { analyzeProspect } from './prospectAnalysis';
import { generateDesignProposal } from './prospectDesigner';
import { checkFactoryReadinessCompatibility } from './readinessCompat';
import { placesUsageBucket, readPlacesUsage, placesDailyLimit } from './discoveryQuota';
import { rateLimit, RATE_LIMITS } from '../security';

/**
 * Owner-gated orchestration API. EVERY route is requireAuth +
 * requireRole('PLATFORM_OWNER'). No route ever returns err.stack, SQL,
 * credentials, or raw internal messages — module errors carry client-safe
 * text; unexpected errors are safeError'd server-side and answered 500 with
 * a generic message.
 */

export const orchestrationRouter = Router();

/** Map module errors: 'not found' → 404, validation → 400, other → 500. */
function replyError(res: Response, e: any): null {
  if (e && typeof e.message === 'string' && e.message.toLowerCase().includes('not found')) {
    res.status(404).json({ error: 'Not found.' });
    return null;
  }
  if (e && typeof e.message === 'string' && e.message) {
    // Validation-style errors authored by the module (safe text, no internals).
    res.status(400).json({ error: e.message });
    return null;
  }
  safeError('[orchestration] unexpected error:', e);
  res.status(500).json({ error: 'Internal error.' });
  return null;
}

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

orchestrationRouter.post('/prospects', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const prospect = await createProspect({
      businessName: req.body?.businessName,
      contactName: req.body?.contactName,
      contactEmail: req.body?.contactEmail,
      contactPhone: req.body?.contactPhone,
      website: req.body?.website,
      instagramHandle: req.body?.instagramHandle,
      location: req.body?.location,
      notes: req.body?.notes
    });
    res.status(201).json(prospect);
  } catch (e: any) {
    replyError(res, e);
  }
}));

orchestrationRouter.get('/prospects', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (_req: Request, res: Response) => {
  res.json(await listProspects());
}));

orchestrationRouter.get('/prospects/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const prospect = await getProspect(String(req.params.id));
  if (!prospect) return res.status(404).json({ error: 'Not found.' });
  res.json(prospect);
}));

orchestrationRouter.patch('/prospects/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const prospect = await getProspect(String(req.params.id));
    if (!prospect) return res.status(404).json({ error: 'Not found.' });
    const updated = await updateProspect(prospect, req.body || {});
    res.json(updated);
  } catch (e: any) {
    replyError(res, e);
  }
}));

// ---------------------------------------------------------------------------
// Lead discovery (candidate intake — owner-gated; evidence only; discovery
// NEVER triggers research/scoring/factory/outreach)
// ---------------------------------------------------------------------------

orchestrationRouter.post('/discovery-runs', rateLimit({ ...RATE_LIMITS.generate, prefix: 'discovery' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const run = await runDiscovery({
      idempotencyKey: req.body?.idempotencyKey,
      query: req.body?.query,
      location: req.body?.location,
      candidates: req.body?.candidates,
      provider: req.body?.provider
    });
    res.status(201).json({ run, results: await listResultsForRun(run.id) });
  } catch (e: any) {
    replyError(res, e);
  }
}));

orchestrationRouter.get('/discovery-runs', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const limit = Number(req.query.limit) || 50;
  res.json(await listDiscoveryRuns(limit));
}));

orchestrationRouter.get('/discovery-runs/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const run = await getDiscoveryRun(String(req.params.id));
  if (!run) return res.status(404).json({ error: 'Not found.' });
  res.json({ run, results: await listResultsForRun(run.id) });
}));

// Acceptance bridge: discovery_result -> prospect. Data/lifecycle transition
// only — the handler performs no research/scoring/factory/outreach side
// effects. Client-supplied tenant/prospect ids are ignored (server-derived).
orchestrationRouter.post('/discovery-results/:id/accept', rateLimit({ ...RATE_LIMITS.generate, prefix: 'discovery-accept' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const outcome = await acceptDiscoveryResult(String(req.params.id));
    res.status(outcome.created ? 201 : 200).json({
      prospect: outcome.prospect,
      result: outcome.result,
      created: outcome.created,
      associated: outcome.associated
    });
  } catch (e: any) {
    replyError(res, e);
  }
}));

// Dismissal bridge: the reject half of the triage decision (Task 21). Same
// envelope as acceptance — owner-gated, rate-limited, path id is the only
// scope authority (client-supplied tenant/prospect ids are ignored). The
// handler performs no research/scoring/factory/outreach side effects.
orchestrationRouter.post('/discovery-results/:id/dismiss', rateLimit({ ...RATE_LIMITS.generate, prefix: 'discovery-dismiss' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await dismissDiscoveryResult(String(req.params.id));
    res.status(200).json({ result });
  } catch (e: any) {
    replyError(res, e);
  }
}));

// Places usage observability (Task 22): READ-ONLY operator view of the
// existing global UTC-day counter + configured cap. Performs no writes,
// records no telemetry, and is deliberately NOT tenant-scoped — the counter
// belongs to the single shared Google project (it is an operator guard,
// never billing). Client-supplied tenant/date/count parameters are ignored.
orchestrationRouter.get('/discovery/usage', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (_req: Request, res: Response) => {
  const bucket = placesUsageBucket();
  const usage = await readPlacesUsage(bucket);
  const limit = placesDailyLimit();
  res.json({
    date: bucket,
    used: usage.calls,
    limit: limit ?? null,
    remaining: limit === undefined ? null : Math.max(0, limit - usage.calls)
  });
}));

// ---------------------------------------------------------------------------
// Lead research (evidence/extraction layer — owner-gated; never a decision)
// ---------------------------------------------------------------------------

// Prospect analyze (Task 9): thin composition over runResearch with
// content-hash idempotency. 201 first creation, 200 identical replay.
// Client-supplied tenant/prospect ids are ignored; path id wins.
orchestrationRouter.post('/prospects/:id/analyze', rateLimit({ ...RATE_LIMITS.generate, prefix: 'analyze' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const outcome = await analyzeProspect(String(req.params.id), { inputText: req.body?.inputText });
    res.status(outcome.created ? 201 : 200).json(outcome);
  } catch (e: any) {
    replyError(res, e);
  }
}));

orchestrationRouter.post('/prospects/:id/research', rateLimit({ ...RATE_LIMITS.generate, prefix: 'research' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const report = await runResearch(String(req.params.id), {
      idempotencyKey: req.body?.idempotencyKey,
      inputText: req.body?.inputText,
      inputSource: req.body?.inputSource
    });
    res.status(200).json(report);
  } catch (e: any) {
    replyError(res, e);
  }
}));

orchestrationRouter.get('/prospects/:id/research', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const prospect = await getProspect(String(req.params.id));
  if (!prospect) return res.status(404).json({ error: 'Not found.' });
  res.json(await listResearchForProspect(prospect.id));
}));

orchestrationRouter.get('/research/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const report = await getResearchReport(String(req.params.id));
  if (!report) return res.status(404).json({ error: 'Not found.' });
  res.json(report);
}));

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

// Designer generation (Task 11): validated DRAFT proposal from the latest
// COMPLETED analysis report. 201 first generation, 200 idempotent replay.
// The handler NEVER approves/submits/builds — human approval route unchanged.
orchestrationRouter.post('/prospects/:id/design', rateLimit({ ...RATE_LIMITS.generate, prefix: 'design' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const outcome = await generateDesignProposal(String(req.params.id));
    res.status(outcome.created ? 201 : 200).json(outcome);
  } catch (e: any) {
    replyError(res, e);
  }
}));

orchestrationRouter.post('/prospects/:id/designs', rateLimit({ ...RATE_LIMITS.generate, prefix: 'design-create' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const prospect = await getProspect(String(req.params.id));
    if (!prospect) return res.status(404).json({ error: 'Not found.' });
    const design = await createDesign(prospect, {
      title: req.body?.title,
      problemStatement: req.body?.problemStatement,
      proposedSolution: req.body?.proposedSolution,
      agentType: req.body?.agentType,
      capabilities: req.body?.capabilities,
      channels: req.body?.channels,
      integrations: req.body?.integrations,
      configuration: req.body?.configuration
    });
    res.status(201).json(design);
  } catch (e: any) {
    replyError(res, e);
  }
}));

orchestrationRouter.get('/prospects/:id/designs', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const prospect = await getProspect(String(req.params.id));
  if (!prospect) return res.status(404).json({ error: 'Not found.' });
  res.json(await listDesignsForProspect(prospect.id));
}));

orchestrationRouter.get('/designs/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const design = await getDesign(String(req.params.id));
  if (!design) return res.status(404).json({ error: 'Not found.' });
  res.json(design);
}));

/** HUMAN approval only. Guarded: validation problem summary is client-safe. */
orchestrationRouter.post('/designs/:id/approve', rateLimit({ ...RATE_LIMITS.generate, prefix: 'design-approve' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const design = await getDesign(String(req.params.id));
    if (!design) return res.status(404).json({ error: 'Not found.' });
    const prospect = await getProspect(design.prospectId);
    if (!prospect) return res.status(404).json({ error: 'Not found.' });
    // Approval is an explicit human action; configuration validity is checked
    // up-front so an invalid design cannot be silently approved.
    if (design.configuration) {
      const problems = validateDesignConfiguration(design.configuration);
      if (problems.length > 0) {
        return res.status(400).json({ error: 'Design configuration is invalid: ' + problems.join(' ') });
      }
    }
    const updated = await approveDesign(prospect, design);
    // ADVISORY only: approval is never blocked by compatibility gaps (the
    // owner may intend manual enrichment). Submission re-checks and refuses
    // to start a guaranteed-doomed Factory job.
    const compat = checkFactoryReadinessCompatibility(updated.configuration);
    res.json({ ...updated, compatibilityGaps: compat.gaps });
  } catch (e: any) {
    replyError(res, e);
  }
}));

/** Submit to the factory. Idempotent on body.idempotencyKey. */
orchestrationRouter.post('/designs/:id/submit', rateLimit({ ...RATE_LIMITS.generate, prefix: 'design-submit' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const idempotencyKey = req.body?.idempotencyKey;
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 200) {
      return res.status(400).json({ error: 'idempotencyKey is required (string <= 200 chars).' });
    }
    const job = await submitDesignToFactory(String(req.params.id), idempotencyKey);
    res.status(200).json(job);
  } catch (e: any) {
    // Readiness-compatibility rejections carry structured, client-safe gaps.
    if (Array.isArray(e?.readinessGaps)) {
      return res.status(400).json({ error: e.message, gaps: e.readinessGaps });
    }
    replyError(res, e);
  }
}));

// ---------------------------------------------------------------------------
// Factory jobs
// ---------------------------------------------------------------------------

orchestrationRouter.get('/factory-jobs', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (_req: Request, res: Response) => {
  res.json(await listJobs());
}));

orchestrationRouter.get('/factory-jobs/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const job = await getJob(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'Not found.' });
  res.json(job);
}));

// ---------------------------------------------------------------------------
// Deliveries + acceptance
// ---------------------------------------------------------------------------

orchestrationRouter.get('/deliveries', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (_req: Request, res: Response) => {
  res.json(await listDeliveries());
}));

orchestrationRouter.get('/deliveries/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const delivery = await getDelivery(String(req.params.id));
  if (!delivery) return res.status(404).json({ error: 'Not found.' });
  res.json(delivery);
}));

// Deterministic, LLM-free customer onboarding artifact (Task 19). Read-only
// assembly from persisted state — never activates channels or contacts anyone.
orchestrationRouter.get('/deliveries/:id/onboarding', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const artifact = await buildOnboardingArtifact(String(req.params.id));
    res.json(artifact);
  } catch (e: any) {
    replyError(res, e);
  }
}));

orchestrationRouter.post('/deliveries/:id/accept', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const delivery = await getDelivery(String(req.params.id));
    if (!delivery) return res.status(404).json({ error: 'Not found.' });
    const prospect = await getProspect(delivery.prospectId);
    const acceptance = await acceptDelivery(prospect, delivery, {
      acceptedBy: req.body?.acceptedBy,
      acceptanceMethod: req.body?.acceptanceMethod,
      metadata: req.body?.metadata
    });
    res.status(201).json(acceptance);
  } catch (e: any) {
    replyError(res, e);
  }
}));

// Owner-account provisioning at delivery (Task 23). Creates the delivered
// business's BUSINESS_OWNER login using the existing users table + scrypt
// hashing; the server-generated one-time password is returned ONLY on the
// initial 201 response. Idempotent per delivery — a replay returns 200 with
// the existing account and NO password, and never creates a second user.
orchestrationRouter.post('/deliveries/:id/provision-owner-account', rateLimit({ ...RATE_LIMITS.generate, prefix: 'provision-owner' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await provisionOwnerAccount(String(req.params.id), {
      email: req.body?.email,
      name: req.body?.name
    });
    res.status(result.alreadyProvisioned ? 200 : 201).json(result);
  } catch (e: any) {
    replyError(res, e);
  }
}));
