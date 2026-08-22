import { Router, Request, Response, NextFunction } from 'express';
import { db } from './db';
import { processAgentMessage, generateSuggestedAgentConfig } from './agentRuntime';
import { executeAgentTool, ALL_TOOL_NAMES } from './tools';
import {
  createDraftFrom, editDraft, publishVersion,
  rollbackToVersion, archiveVersion, moveToTesting, listVersions,
  getPublishedVersion, getVersionForSim, versionBelongsToAgent
} from './agentVersions';
import { indexChunk, removeEmbedding } from './embeddings';
import { readinessSnapshot } from './readiness';
import { rateLimit, RATE_LIMITS } from './security';
import { safeError } from './logSanitizer';
import {
  getProvider, runValidation, storeCredentials, getCredentials, clearCredentials,
  sanitizeIntegrationForClient
} from './integrations';
import { widgetCorsHeaders, normalizeWidgetOriginList } from './widgetSecurity';
import { createBusinessTenant, createAgentWithInitialDraft, transitionAgentStatus, AGENT_STATUS_TRANSITIONS, AGENT_STATUSES } from './agentLifecycle';
import { orchestrationRouter } from './orchestration/orchestrationRoutes';
import { runEvaluation, getLatestEvaluation, listEvaluationsForAgent } from './evaluation';
import { runSelfCorrection, listCorrectionsForAgent } from './correction';
import { listTelemetryEvents, computeMetrics, listConversationsFromTelemetry, getConversationTimeline } from './telemetry';
import { Business, Agent, AgentStatus, KnowledgeChunk, Product, Appointment, Order, User, Conversation, AgentVersion, EvalScenario, TrustedKnowledgeSource } from '../types';
import { verifyPassword, getDummyPasswordHash } from './passwords';
import {
  requireAuth,
  requireRole,
  requireTenantScope,
  requireResourceAccess,
  loadUserFromSession,
  toPublicUser,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  readCookie,
  SESSION_COOKIE,
  asyncHandler
} from './auth';

export const router = Router();

// Sales & Delivery Orchestrator — owner-gated sub-router (platform owner only).
router.use('/orchestration', orchestrationRouter);

/**
 * Cap a list response to bound memory and protect against unbounded result
 * sets as a business grows. Honours ?limit (capped at MAX) and ?cursor
 * (zero-based offset). Returns a plain array slice so existing API clients that
 * expect an array keep working; total count + next cursor are exposed via
 * response headers for clients that want pagination.
 */
const PAGINATION_MAX = 100;
const PAGINATION_DEFAULT = 50;
function paginate<T>(items: T[], req: Request, res: Response): T[] {
  const limit = Math.min(
    Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || PAGINATION_DEFAULT),
    PAGINATION_MAX
  );
  const cursor = Math.max(0, parseInt(String(req.query.cursor ?? ''), 10) || 0);
  const page = items.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit;
  const hasMore = nextCursor < items.length;
  res.setHeader('X-Total-Count', String(items.length));
  if (hasMore) res.setHeader('X-Next-Cursor', String(nextCursor));
  return page;
}

// Health Check (public)
router.get('/health', asyncHandler(async (req: Request, res: Response) => {
  // Lightweight DB liveness probe so a load-balancer/healthcheck can detect a
  // wedged database, not just a live process.
  let dbOk = false;
  try {
    await db.client.ping();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'connected' : 'unreachable',
    timestamp: new Date().toISOString()
  });
}));

// =========================================
// AUTH (login/logout public; /auth/me is session-driven)
// =========================================

// Current User Context — real user from the session, or 401.
router.get('/auth/me', asyncHandler(async (req: Request, res: Response) => {
  const user = await loadUserFromSession(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  res.json({ user: toPublicUser(user) });
}));

// Login — public. Validates credentials, creates a database-backed session,
// sets the signed HttpOnly cookie. A missing SESSION_SECRET in production is
// reported as a clear JSON 500 (not an HTML crash page) so operators can
// diagnose it without the app becoming unresponsive.
router.post('/auth/login', rateLimit({ ...RATE_LIMITS.auth, max: 10, prefix: 'login' }), asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const user = await db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user) {
    // Timing-safe dummy verification (audit P2.6): an unknown user still pays
    // the scrypt cost against a fixed dummy hash, so a "user not found"
    // response is indistinguishable by timing from a "wrong password"
    // response. Without this an attacker could enumerate valid emails.
    verifyPassword(String(password), getDummyPasswordHash());
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (!verifyPassword(String(password), user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  let session;
  try {
    session = await createSession(user.id);
  } catch (err: any) {
    const msg = err?.message || 'Failed to create session.';
    return res.status(500).json({
      error: process.env.NODE_ENV === 'production' ? 'Internal server error.' : msg
    });
  }
  setSessionCookie(req, res, session.id);
  res.json({ user: toPublicUser(user) });
}));

// Logout — public. Always 200; invalidates the server-side session row when present.
router.post('/auth/logout', asyncHandler(async (req: Request, res: Response) => {
  const raw = readCookie(req, SESSION_COOKIE);
  if (raw) {
    const sessionId = raw.split('.')[0];
    if (sessionId) await destroySession(sessionId);
  }
  clearSessionCookie(res);
  res.json({ success: true });
}));

// =========================================
// 1. BUSINESSES (MULTI-TENANT MANAGEMENT)
// =========================================

// Get all businesses (with optional search/type filters).
// Platform owner -> all businesses; business owner/staff -> ONLY their own.
router.get('/businesses', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { search, type, status } = req.query;
  const user = res.locals.user as User;
  let result = await db.businesses.toJSON();

  if (user.role !== 'PLATFORM_OWNER') {
    result = result.filter(b => b.id === user.businessId);
  }
  if (search) {
    const q = String(search).toLowerCase();
    result = result.filter(b => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q));
  }
  if (type) {
    result = result.filter(b => b.type === type);
  }
  if (status) {
    result = result.filter(b => b.status === status);
  }

  res.json(result);
}));

// Create Business — PLATFORM_OWNER only. Authoritative creation logic lives
// in agentLifecycle.createBusinessTenant (shared with the orchestrator).
router.post('/businesses', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const {
    name,
    type,
    description,
    location,
    language,
    currency,
    timezone,
    hours,
    services,
    faqs,
    policies,
    communicationStyle,
    allowedWidgetOrigins
  } = req.body;
  try {
    const newBiz = await createBusinessTenant({
      name, type, description, location, language, currency, timezone,
      hours, services, faqs, policies, communicationStyle, allowedWidgetOrigins
    });
    res.status(201).json(newBiz);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}));

// Get Business by ID — platform owner or the business's own owner/staff.
router.get(
  '/businesses/:id',
  requireAuth,
  requireResourceAccess(req => db.businesses.find(b => b.id === req.params.id), b => (b as Business).id),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(res.locals.resource);
  }
));

// Update Business — platform owner or the business's own owner/staff.
router.put(
  '/businesses/:id',
  requireAuth,
  requireResourceAccess(req => db.businesses.find(b => b.id === req.params.id), b => (b as Business).id),
  asyncHandler(async (req: Request, res: Response) => {
    const biz = res.locals.resource as Business;
    // Allowlist only the updatable fields. Never trust `id`, `createdAt`, or
    // arbitrary keys from the frontend (prevents mass-assignment).
    const {
      name, type, description, location, language, currency, timezone,
      hours, services, pricingNotes, faqs, policies, communicationStyle, status,
      holidays, allowedWidgetOrigins
    } = req.body || {};
    if (typeof name === 'string') biz.name = name;
    if (type) biz.type = type;
    if (typeof description === 'string') biz.description = description;
    if (typeof location === 'string') biz.location = location;
    if (language) biz.language = language;
    if (typeof currency === 'string') biz.currency = currency;
    if (typeof timezone === 'string') biz.timezone = timezone;
    if (Array.isArray(hours)) biz.hours = hours;
    if (Array.isArray(services)) biz.services = services;
    if (typeof pricingNotes === 'string') biz.pricingNotes = pricingNotes;
    if (Array.isArray(faqs)) biz.faqs = faqs;
    if (policies && typeof policies === 'object') biz.policies = policies;
    if (typeof communicationStyle === 'string') biz.communicationStyle = communicationStyle;
    if (status) biz.status = status;
    if (Array.isArray(holidays)) biz.holidays = holidays;
    // Strict origin validation: invalid entries are dropped (never wildcards,
    // never credentials) so the widget allow-list stays enforceable.
    if (Array.isArray(allowedWidgetOrigins)) biz.allowedWidgetOrigins = normalizeWidgetOriginList(allowedWidgetOrigins);
    biz.updatedAt = new Date().toISOString();
    await db.businesses.update(biz);
    res.json(biz);
  }
));

// Duplicate Business & Agent Feature (Section 33 Prompt Mandate) — PLATFORM_OWNER only,
// because it creates a new tenant (same privilege as POST /businesses).
router.post('/businesses/:id/duplicate', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const sourceBiz = await db.businesses.find(b => b.id === req.params.id);
  if (!sourceBiz) return res.status(404).json({ error: 'Source business not found.' });

  const { newName } = req.body;
  const targetName = newName || `${sourceBiz.name} (Copy)`;
  const newBizId = `biz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Clone Business
  const clonedBiz: Business = JSON.parse(JSON.stringify(sourceBiz));
  clonedBiz.id = newBizId;
  clonedBiz.name = targetName;
  clonedBiz.createdAt = new Date().toISOString();
  clonedBiz.updatedAt = new Date().toISOString();

  await db.businesses.push(clonedBiz);

  // Clone Agents
  const sourceAgents = await db.agents.filter(a => a.businessId === sourceBiz.id);
  for (const a of sourceAgents) {
    const clonedAgent: Agent = JSON.parse(JSON.stringify(a));
    clonedAgent.id = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    clonedAgent.businessId = newBizId;
    clonedAgent.name = `${a.name} for ${targetName}`;
    clonedAgent.createdAt = new Date().toISOString();
    clonedAgent.updatedAt = new Date().toISOString();
    await db.agents.push(clonedAgent);
    // Clone the agent's published version so the new agent starts with a
    // complete version history (factory workflow: duplicate template).
    const srcPub = await db.agentVersions.find(v => v.agentId === a.id && v.status === 'PUBLISHED');
    if (srcPub) {
      await db.agentVersions.push({
        id: `ver-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        agentId: clonedAgent.id,
        businessId: newBizId,
        versionNumber: 1,
        status: 'PUBLISHED',
        systemPrompt: srcPub.systemPrompt,
        structuredConfig: srcPub.structuredConfig,
        model: srcPub.model,
        changeNote: 'Cloned from template',
        createdAt: new Date().toISOString(),
        publishedAt: new Date().toISOString()
      });
    }
  }

  // Clone Knowledge Chunks
  const sourceChunks = await db.knowledgeChunks.filter(k => k.businessId === sourceBiz.id);
  for (const k of sourceChunks) {
    const clonedChunk: KnowledgeChunk = JSON.parse(JSON.stringify(k));
    clonedChunk.id = `kc-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    clonedChunk.businessId = newBizId;
    clonedChunk.createdAt = new Date().toISOString();
    await db.knowledgeChunks.push(clonedChunk);
    // Re-index under the new chunk id so RAG retrieval works for the clone.
    indexChunk(clonedChunk).catch(() => {/* non-fatal: keyword fallback still works */});
  }

  // Clone Products
  const sourceProds = await db.products.filter(p => p.businessId === sourceBiz.id);
  for (const p of sourceProds) {
    const clonedProd: Product = JSON.parse(JSON.stringify(p));
    clonedProd.id = `prod-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    clonedProd.businessId = newBizId;
    await db.products.push(clonedProd);
  }

  await db.auditLogs.push({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    businessId: newBizId,
    action: 'BUSINESS_DUPLICATED',
    details: `Duplicated business and agents from ${sourceBiz.name} to ${targetName}.`,
    timestamp: new Date().toISOString()
  });

  res.status(201).json({
    message: 'Business and Agent successfully duplicated!',
    newBusiness: clonedBiz
  });
}));

// =========================================
// 2. AGENTS & WIZARD GENERATOR
// =========================================

/**
 * Agent lifecycle — the ONLY legal status transitions (enforced server-side on
 * POST /agents/:id/status and PUT /agents/:id):
 *
 *   DRAFT    → TESTING, PAUSED, ARCHIVED
 *   TESTING  → READY, DRAFT, PAUSED, ARCHIVED   (back to DRAFT: edit & re-test)
 *   READY    → ACTIVE, TESTING, PAUSED, ARCHIVED (back to TESTING: iterate)
 *   ACTIVE   → PAUSED, ARCHIVED
 *   PAUSED   → ACTIVE, ARCHIVED, or the state it was paused from (un-pause =
 *              resume; ACTIVE re-deploy still runs the readiness gate)
 *   ARCHIVED → (terminal — no transitions out)
 *
 * Invariant: at most ONE agent per business is ACTIVE. When an agent becomes
 * ACTIVE, every other agent of the same business is automatically PAUSED.
 * Pausing/archiving the active agent leaves the business with NO active agent
 * — the public widget then honestly reports the assistant is unavailable.
 * Same-status transitions are idempotent no-ops.
 *
 * The authoritative map and transition logic now live in agentLifecycle.ts
 * (AGENT_STATUS_TRANSITIONS / transitionAgentStatus) so the route layer and
 * the orchestration layer share one implementation.
 */

// Get Agents (optionally filtered by businessId; tenant enforced server-side)
router.get('/agents', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const agents = businessId ? await db.agents.filter(a => a.businessId === businessId) : await db.agents.toJSON();
  res.json(agents);
}));

// Get a single agent — tenant-scoped via requireResourceAccess.
router.get(
  '/agents/:id',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(res.locals.resource as Agent);
  }
));

// Generate Suggested Agent Configuration (AI Assistant Wizard)
// Auth required. Produces an EDITABLE PROPOSAL only — never auto-activates.
// H1: every call burns Gemini tokens, so it gets its own tighter budget,
// applied BEFORE requireAuth so unauthenticated hammering is throttled too.
router.post('/agents/generate-config', rateLimit({ ...RATE_LIMITS.generate, prefix: 'generate' }), requireAuth, async (req: Request, res: Response) => {
  const { name, type, description, hours, services, faqs } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'Name and type are required for agent generation.' });
  }

  const suggestedConfig = await generateSuggestedAgentConfig({
    name,
    type,
    description,
    hours,
    services,
    faqs
  });

  res.json(suggestedConfig);
});

// Create Agent — tenant derived from the session (body businessId cannot widen access)
router.post('/agents', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const { name, description, systemPrompt, structuredConfig, llmProvider, model, status } = req.body;
  const businessId = res.locals.businessId as string | null;

  if (!businessId || !name) {
    return res.status(400).json({ error: 'businessId and agent name are required.' });
  }
  try {
    const newAgent = await createAgentWithInitialDraft({
      businessId, name, description, systemPrompt, structuredConfig, llmProvider, model, status
    });
    res.status(201).json(newAgent);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}));

// Update Agent — resource belongs to the authorized tenant.
// This edits metadata only (name/description). Config edits go through the
// version endpoints so a draft never silently changes the live agent.
router.put(
  '/agents/:id',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;

    // Status is owned by the lifecycle endpoint — changing it via PUT would
    // bypass the transition rules, so it is rejected here.
    if (req.body.status !== undefined && req.body.status !== agent.status) {
      return res.status(400).json({
        error: 'Change agent status via POST /api/agents/:id/status (lifecycle transitions are enforced server-side).'
      });
    }

    // Metadata edits only (name/description) — never trust arbitrary keys
    // (prevents mass-assignment). Config edits go through the version
    // endpoints so a draft never silently changes the live agent. Metadata
    // edits deliberately do NOT bump the version number — the version counter
    // tracks published config snapshots, not cosmetic field changes.
    const { name, description } = req.body;
    if (name !== undefined) agent.name = name;
    if (description !== undefined) agent.description = description;

    agent.updatedAt = new Date().toISOString();
    await db.agents.update(agent);

    await db.auditLogs.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      businessId: agent.businessId,
      agentId: agent.id,
      action: 'AGENT_UPDATED',
      details: `Updated agent "${agent.name}" metadata.`,
      timestamp: new Date().toISOString()
    });

    res.json(agent);
  }
));

// Change Agent Status — lifecycle enforced server-side (authoritative logic
// in agentLifecycle.transitionAgentStatus; readiness gate cannot be bypassed).
router.post(
  '/agents/:id/status',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;

    const { status } = req.body;
    try {
      const updated = await transitionAgentStatus(agent, status);
      res.json(updated);
    } catch (err: any) {
      // Readiness-gate failures carry the structured checklist for the UI.
      res.status(400).json({ error: err.message, readiness: err.readiness });
    }
  }
));

// Agent readiness checklist (Phase 20) — read-only snapshot for the UI.
router.get(
  '/agents/:id/readiness',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    res.json(await readinessSnapshot(agent));
  }
));

// =========================================
// 2b. AGENT VERSIONS
// =========================================
// Version history + lifecycle. All tenant-scoped via requireResourceAccess on
// the parent agent. Editing a draft never changes the live agent; publishing
// is an explicit operation that snapshots the draft onto the agent row.

router.get(
  '/agents/:id/versions',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await listVersions(req.params.id));
  }
));

router.get(
  '/agents/:id/versions/published',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const pub = await getPublishedVersion(req.params.id);
    if (!pub) return res.status(404).json({ error: 'No published version.' });
    res.json(pub);
  }
));

router.post(
  '/agents/:id/versions',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    // Create a new draft from an existing version. Defaults to the published
    // version; if none is published yet (e.g. a brand-new agent that only has
    // its initial draft), fall back to the latest version of any status so the
    // user can still iterate before the first publish.
    const { fromVersionId, changeNote } = req.body;
    // Resolve the source version, scoped to THIS agent (IDOR guard: a caller
    // authorized for this agent must not draft from another agent's version).
    const sourceId = fromVersionId
      || (await getPublishedVersion(req.params.id))?.id
      || (await listVersions(req.params.id))[0]?.id;
    if (!sourceId) return res.status(400).json({ error: 'No source version to draft from.' });
    try {
      const draft = await createDraftFrom(sourceId, changeNote, req.params.id);
      res.status(201).json(draft);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
));

router.put(
  '/agents/:id/versions/:versionId',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const updated = await editDraft(req.params.versionId, req.body, req.params.id);
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
));

router.post(
  '/agents/:id/versions/:versionId/publish',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const pub = await publishVersion(req.params.versionId, req.params.id);
      await db.auditLogs.push({
        id: `log-${Date.now()}`,
        businessId: (res.locals.resource as Agent).businessId,
        agentId: req.params.id,
        action: 'AGENT_PUBLISHED',
        details: `Published agent version v${pub.versionNumber}.`,
        timestamp: new Date().toISOString()
      });
      res.json(pub);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
));

router.post(
  '/agents/:id/versions/:versionId/test',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      res.json(await moveToTesting(req.params.versionId, req.params.id));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
));

router.post(
  '/agents/:id/versions/:versionId/rollback',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const pub = await rollbackToVersion(req.params.versionId, req.params.id);
      res.json(pub);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
));

router.post(
  '/agents/:id/versions/:versionId/archive',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      res.json(await archiveVersion(req.params.versionId, req.params.id));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
));

// =========================================
// 2b. AGENT EVALUATION
// =========================================
// Run a set of test scenarios against the REAL agent runtime (simulator mode
// against the DRAFT/TESTING version — never a PUBLISHED version) and persist
// the scored, failure-classified result. Critical failures block publication
// (enforced in publishVersion via assertPublishClear).

router.post(
  '/agents/:id/versions/:versionId/evaluate',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const { scenarios } = req.body as { scenarios: EvalScenario[] };
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      return res.status(400).json({ error: 'A non-empty scenarios array is required.' });
    }
    // Basic scenario validation (data integrity for the persisted run).
    for (const s of scenarios) {
      if (!s.id || !s.name || !s.userMessage || !s.dimension) {
        return res.status(400).json({ error: 'Each scenario needs id, name, userMessage, dimension.' });
      }
    }
    // Verify the target version belongs to THIS agent (IDOR guard: the path's
    // :id is tenant-verified by requireResourceAccess, but :versionId is not —
    // a foreign version would otherwise be recorded on this agent's eval run).
    if (!(await versionBelongsToAgent(req.params.versionId, agent.id))) {
      return res.status(404).json({ error: 'Version not found.' });
    }
    try {
      const result = await runEvaluation({
        businessId: agent.businessId,
        agentId: agent.id,
        versionId: req.params.versionId,
        scenarios
      });
      res.status(200).json(result);
    } catch (e: any) {
      safeError('[routes] evaluation failed:', e?.message || e);
      res.status(500).json({ error: 'Evaluation failed.' });
    }
  }
));

router.get(
  '/agents/:id/versions/:versionId/evaluations',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const latest = await getLatestEvaluation(agent.businessId, req.params.versionId);
    res.json({ latest });
  }
));

router.get(
  '/agents/:id/evaluations',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const runs = await listEvaluationsForAgent(agent.businessId, agent.id);
    res.json(runs);
  }
));

// =========================================
// 2c. AGENT SELF-CORRECTION LOOP
// =========================================
// GENERATE -> EVALUATE -> CLASSIFY FAILURE -> CORRECT -> RE-EVALUATE -> PASS /
// HUMAN REVIEW. Runs against a DRAFT/TESTING version and only ever produces a
// NEW draft; published versions are never mutated. Safety failures always
// escalate to human review. The existing evaluation publish gate is NOT
// bypassed: a corrected draft must still pass evaluation to be publishable.

router.post(
  '/agents/:id/versions/:versionId/correct',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const { scenarios, trustedKnowledgeSources, maxAttempts } = req.body as {
      scenarios: EvalScenario[];
      trustedKnowledgeSources?: TrustedKnowledgeSource[];
      maxAttempts?: number;
    };
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      return res.status(400).json({ error: 'A non-empty scenarios array is required.' });
    }
    try {
      const result = await runSelfCorrection({
        businessId: agent.businessId,
        agentId: agent.id,
        versionId: req.params.versionId,
        scenarios,
        trustedKnowledgeSources,
        maxAttempts
      });
      res.status(200).json(result);
    } catch (e: any) {
      // Version-not-found / published-version errors surface as 400.
      res.status(400).json({ error: e.message || 'Self-correction failed.' });
    }
  }
));

router.get(
  '/agents/:id/corrections',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const runs = await listCorrectionsForAgent(agent.businessId, agent.id);
    res.json(runs);
  }
));

// =========================================
// MONITORING / TELEMETRY (tenant-scoped)
// All routes are auth + resource-access guarded. The business scope is derived
// server-side from the authenticated agent's businessId — never from the
// client. No write endpoints exist (telemetry is server-side recorded only).
// =========================================

router.get(
  '/agents/:id/telemetry',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const { versionId, from, to, isPublished, limit } = req.query as any;
    const events = await listTelemetryEvents({
      businessId: agent.businessId,
      agentId: agent.id,
      versionId: versionId || undefined,
      from: from || undefined,
      to: to || undefined,
      isPublished: isPublished === 'true' ? true : isPublished === 'false' ? false : undefined,
      limit: limit ? Number(limit) : undefined
    });
    res.json(events);
  }
));

router.get(
  '/agents/:id/metrics',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const { versionId, from, to, isPublished } = req.query as any;
    const metrics = await computeMetrics({
      businessId: agent.businessId,
      agentId: agent.id,
      versionId: versionId || undefined,
      from: from || undefined,
      to: to || undefined,
      isPublished: isPublished === 'true' ? true : isPublished === 'false' ? false : undefined
    });
    res.json(metrics);
  }
));

// =========================================
// 2b. PER-CONVERSATION DRILL-DOWN
// =========================================
// List conversations (with telemetry activity) for the agent's tenant. Derived
// from telemetry events grouped by conversationId + the conversation row. The
// agent resource is the tenant anchor: requireResourceAccess loads the agent,
// verifies its businessId is the caller's tenant, then every conversation
// lookup is scoped to that same businessId. A business owner can never list or
// open another tenant's conversations — server-side authorization is
// authoritative; the frontend only renders what the API returns.
router.get(
  '/agents/:id/conversations',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const { isPublished, from, to, limit } = req.query as any;
    const summaries = await listConversationsFromTelemetry({
      businessId: agent.businessId,
      agentId: agent.id,
      isPublished: isPublished === 'true' ? true : isPublished === 'false' ? false : undefined,
      from: from || undefined,
      to: to || undefined,
      limit: limit ? Number(limit) : undefined
    });
    res.json(summaries);
  }
));

// Single conversation timeline. Tenant-scoped: getConversationTimeline requires
// BOTH conversationId AND businessId match (the agent's tenant). A cross-tenant
// or non-existent id returns null -> 404 (no existence leak).
router.get(
  '/agents/:id/conversations/:conversationId',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const timeline = await getConversationTimeline(agent.businessId, req.params.conversationId);
    if (!timeline) return res.status(404).json({ error: 'Conversation not found.' });
    res.json(timeline);
  })
);

// =========================================
// 3. RUNTIME CHAT & SIMULATOR
// =========================================

// Public, customer-facing widget endpoint. NO authentication (a website
// visitor is not logged in). The runtime returns the safe reply +
// conversationId + status plus an `agentAvailable` flag; the internal debug
// block (system prompt, retrieved knowledge, tool calls, latency) is
// developer-only and NEVER returned to the public widget — it is populated
// only for authenticated, tenant-scoped sessions (simulator use).
// The runtime itself is tenant-scoped and never trusts a frontend-supplied
// conversation id across tenants.
// OPTIONS preflight for the cross-origin widget. Origin is enforced per-business
// (P1.2): only origins in the target business's allowedWidgetOrigins are allowed;
// unknown origins receive 403.
router.options('/runtime/chat', asyncHandler(async (req: Request, res: Response) => {
  // The browser preflight cannot send the custom x-business-id value (preflight
  // only lists header names). Resolve the tenant from the `business` query param
  // the widget appends, then enforce the per-business origin allow-list.
  const tenantId = (req.query.business as string) || (req.headers['x-business-id'] as string) || undefined;
  const origin = req.headers.origin;
  const headers = tenantId ? await widgetCorsHeaders(tenantId, origin) : null;
  if (!headers) {
    return res.status(403).end();
  }
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, String(v));
  return res.status(204).end();
}));

// One endpoint, two callers:
//  - PUBLIC WIDGET (no session): serves ONLY the business's ACTIVE agent. When
//    the business has no ACTIVE agent it returns 200 with `agentAvailable:
//    false` and an honest message (the widget must render it as an error, not
//    a fake answer). Debug is ALWAYS null for unauthenticated callers.
//  - SIMULATOR (authenticated session scoped to the tenant): may pass
//    `agentId` to run a SPECIFIC agent regardless of status (so owners can test
//    DRAFT/TESTING/READY agents before deploying). Passing agentId requires a
//    valid session AND tenant access to that agent. Debug is included only for
//    authenticated sessions scoped to the tenant being chatted with.
router.post('/runtime/chat', rateLimit({ ...RATE_LIMITS.public, prefix: 'chat', keyFn: (req) => String(req.body?.tenantId ?? '') }), async (req: Request, res: Response, next: NextFunction) => {
  // Per-business origin enforcement (P1.2): the widget may only POST from an
  // origin the business explicitly allow-listed. This prevents cross-tenant
  // impersonation and arbitrary-origin abuse. Tenancy is still enforced by
  // tenantId inside the runtime; origin is an additional layer.
  const { tenantId } = req.body || {};
  const origin = req.headers.origin;
  // In production, require an Origin header AND a business allow-list match.
  // A missing Origin header must NOT bypass enforcement (otherwise any
  // non-browser client could target an arbitrary tenantId to consume its LLM
  // quota). In development we still allow localhost/curl for the dev loop.
  if (process.env.NODE_ENV === 'production' && !origin) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  const headers = tenantId ? await widgetCorsHeaders(tenantId, origin) : null;
  if (origin && !headers) {
    // Unknown origin: reject. Don't reflect the origin.
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, String(v));
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
}, async (req: Request, res: Response) => {
  const { tenantId, userMessage, conversationId, channel, customerName, customerPhone, agentId } = req.body;

  if (!tenantId || !userMessage) {
    return res.status(400).json({ error: 'tenantId and userMessage are required.' });
  }

  // Payload-size guard: keep customer messages reasonable to limit abuse.
  if (typeof userMessage !== 'string' || userMessage.length > 8000) {
    return res.status(413).json({ error: 'Message too long.' });
  }

  // Debug gating: internal diagnostics are included ONLY for an authenticated
  // session scoped to the tenant in the request. The public widget never
  // receives system prompts, retrieved knowledge, or tool results.
  const user = await loadUserFromSession(req);
  const tenantAccess = !!user && (user.role === 'PLATFORM_OWNER' || user.businessId === tenantId);
  const includeDebug = tenantAccess;

  // Internal agent selection (simulator): agentId is honored ONLY for a
  // valid session with access to that agent's business.
  if (agentId) {
    if (!user) {
      return res.status(401).json({ error: 'Authentication required to simulate a specific agent.' });
    }
    if (!tenantAccess) {
      return res.status(403).json({ error: 'Forbidden: you do not have access to this business.' });
    }
    const agent = await db.agents.find(a => a.id === agentId);
    if (!agent || agent.businessId !== tenantId) {
      return res.status(403).json({ error: 'Forbidden: agent does not belong to this business.' });
    }
  }

  try {
    const result = await processAgentMessage({
      tenantId,
      userMessage,
      conversationId,
      channel: channel || 'web_chat',
      customerName,
      customerPhone,
      agentId,
      includeDebug
    });

    // Customer-facing fields: the widget always receives the safe
    // `agentAvailable` flag (false = no ACTIVE agent → render as an error,
    // never a fake answer) plus reply/conversationId/status. The internal
    // debug block (system prompt, retrieved knowledge, tool results) is
    // developer-only: it is attached ONLY for authenticated sessions scoped
    // to the tenant being chatted with (simulator use case).
    res.json({
      reply: result.reply,
      conversationId: result.conversationId,
      status: result.status,
      agentAvailable: result.agentAvailable,
      ...(includeDebug && result.debug ? { debug: result.debug } : {})
    });
  } catch (err: any) {
    // Configuration errors (no agent, no published version) are expected
    // degradation, not server faults — return 503 with a customer-friendly
    // message so the widget shows a graceful state instead of a crash.
    const msg = err?.message || '';
    const isConfigError = /No agent configured|Business not found|No published version|not ACTIVE/i.test(msg);
    const status = isConfigError ? 503 : 500;
    safeError(`[runtime/chat] ${msg || 'Agent runtime processing failed'}`);
    res.status(status).json({
      error: 'Agent runtime processing failed',
      fallbackMessage: "I am having trouble processing your request right now. I will connect you with a team member."
    });
  }
});

// Authenticated simulator endpoint for business owners/staff testing an agent.
// Returns the full result INCLUDING the developer-only debug block (system
// prompt, retrieved knowledge, tool calls, execution id) so the agent can be
// debugged. Tenant-scoped: the requested tenant must be the caller's own
// (platform owner may target any tenant).
router.post(
  '/runtime/simulate',
  requireAuth,
  requireTenantScope,
  asyncHandler(async (req: Request, res: Response) => {
    const businessId = res.locals.businessId as string | null;
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required.' });
    }
    const { userMessage, conversationId, channel, customerName, customerPhone, versionId } = req.body;
    if (!userMessage) {
      return res.status(400).json({ error: 'userMessage is required.' });
    }
    try {
      const result = await processAgentMessage({
        tenantId: businessId,
        userMessage,
        conversationId,
        channel: channel || 'web_chat',
        customerName,
        customerPhone,
        versionId,
        simulator: true,
        // The simulator is an authenticated, tenant-scoped owner tool: it
        // receives the full developer debug block (execution id, system
        // prompt, retrieved knowledge, tool calls) so agents can be debugged.
        includeDebug: true
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({
        error: err.message || 'Agent runtime processing failed',
        fallbackMessage: "I am having trouble processing your request right now. I will connect you with a team member."
      });
    }
  }
));

// =========================================
// 4. KNOWLEDGE BASE
// =========================================

router.get('/knowledge', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  if (!businessId) return res.status(400).json({ error: 'businessId required.' });

  const items = await db.knowledgeChunks.filter(k => k.businessId === businessId);
  res.json(paginate(items, req, res));
}));

router.post('/knowledge', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const { title, type = 'faq', content, tags = [] } = req.body;
  const businessId = res.locals.businessId as string | null;
  if (!businessId || !title || !content) {
    return res.status(400).json({ error: 'businessId, title, and content are required.' });
  }

  const chunk: KnowledgeChunk = {
    id: `kc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    businessId,
    title,
    type,
    content,
    tags: Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()),
    createdAt: new Date().toISOString()
  };

  await db.knowledgeChunks.push(chunk);
  // Index for semantic retrieval (re-indexes on change; no-op if no API key).
  indexChunk(chunk).catch(() => {/* embedding failures are non-fatal */});
  res.status(201).json(chunk);
}));

router.put(
  '/knowledge/:id',
  requireAuth,
  requireResourceAccess(req => db.knowledgeChunks.find(k => k.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const chunk = res.locals.resource as KnowledgeChunk;
    const { title, content, tags, type } = req.body;
    if (title !== undefined) chunk.title = title;
    if (content !== undefined) chunk.content = content;
    if (type !== undefined) chunk.type = type;
    if (Array.isArray(tags)) chunk.tags = tags;
    await db.knowledgeChunks.update(chunk);
    indexChunk(chunk).catch(() => {/* non-fatal */});
    res.json(chunk);
  }
));

router.delete(
  '/knowledge/:id',
  requireAuth,
  requireResourceAccess(req => db.knowledgeChunks.find(k => k.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const chunk = res.locals.resource as KnowledgeChunk;
    const idx = await db.knowledgeChunks.findIndex(k => k.id === chunk.id);
    if (idx === -1) return res.status(404).json({ error: 'Item not found.' });

    await db.knowledgeChunks.splice(idx, 1);
    removeEmbedding(chunk.id).catch(() => {});
    res.json({ success: true });
  }
));

// =========================================
// 5. APPOINTMENTS
// =========================================

router.get('/appointments', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const { date, status } = req.query;
  const businessId = res.locals.businessId as string | null;
  if (businessId) {
    // DB-side pagination (audit P2.9): build a parameterized WHERE so we never
    // materialize the whole appointments table into memory.
    const where: string[] = ['business_id = ?'];
    const params: any[] = [businessId];
    if (date) { where.push('date = ?'); params.push(String(date)); }
    if (status) { where.push('status = ?'); params.push(String(status)); }
    const limit = Math.min(Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || PAGINATION_DEFAULT), PAGINATION_MAX);
    const offset = Math.max(0, parseInt(String(req.query.cursor ?? ''), 10) || 0);
    const { rows, total } = await db.appointments.paginateWhere(where.join(' AND '), params, { orderBy: 'date', limit, offset });
    res.setHeader('X-Total-Count', String(total));
    if (offset + limit < total) res.setHeader('X-Next-Cursor', String(offset + limit));
    return res.json(rows);
  }
  // Platform-owner (no tenant scope): fall back to legacy full-list pagination.
  let apps = await db.appointments.toJSON();
  if (date) apps = apps.filter(a => a.date === date);
  if (status) apps = apps.filter(a => a.status === status);
  res.json(paginate(apps, req, res));
}));

router.post('/appointments', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const { serviceId, customerName, customerPhone, date, startTime, notes } = req.body;
  const businessId = res.locals.businessId as string | null;
  if (!businessId) return res.status(400).json({ error: 'Invalid businessId.' });

  // Delegate to the same transactional booking engine the agent runtime uses,
  // so the REST API and the AI tool share ONE source of truth for overlap
  // prevention, service-duration end times, and business-hours validation.
  // This is a TRUSTED server-side caller (already authenticated + tenant-
  // scoped), so it passes the full enabled-tool set to the authorization gate
  // (the gate never defaults to permitting — audit P1.1).
  const result = await executeAgentTool('book_appointment', {
    serviceIdOrName: serviceId,
    customerName,
    customerPhone,
    date,
    startTime,
    notes
  }, { tenantId: businessId, channel: 'web_chat', toolsEnabled: ALL_TOOL_NAMES });

  if (!result.success) {
    return res.status(409).json({ error: result.error });
  }
  // The tool records the appointment; return the full record for the dashboard.
  const created = await db.appointments.find(a => a.id === result.data?.appointmentId);
  res.status(201).json(created ?? result.data);
}));

router.put(
  '/appointments/:id',
  requireAuth,
  requireResourceAccess(req => db.appointments.find(a => a.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const app = res.locals.resource as Appointment;
    // Whitelist mutable fields only. NEVER Object.assign(req.body) — that would
    // let a caller overwrite id/businessId/serviceId (tenant-isolation bypass /
    // mass-assignment) or forge completion status.
    const { status, notes } = req.body || {};
    const ALLOWED_STATUS = ['CONFIRMED', 'CANCELLED', 'RESCHEDULED'];
    if (typeof status === 'string' && ALLOWED_STATUS.includes(status)) {
      app.status = status as Appointment['status'];
    }
    if (typeof notes === 'string') app.notes = notes.slice(0, 1000);
    await db.appointments.update(app);

    if (status === 'CANCELLED') {
      await db.auditLogs.push({
        id: `log-${Date.now()}`,
        businessId: app.businessId,
        action: 'APPOINTMENT_CANCELLED',
        details: `Appointment ${app.id} cancelled.`,
        timestamp: new Date().toISOString()
      });
    }
    res.json(app);
  }
));

// =========================================
// 6. PRODUCTS & ORDERS
// =========================================

router.get('/products', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const items = businessId ? await db.products.filter(p => p.businessId === businessId) : await db.products.toJSON();
  res.json(paginate(items, req, res));
}));

router.post('/products', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const { name, sku, price, inventory, description, category } = req.body;
  const businessId = res.locals.businessId as string | null;
  if (!businessId) return res.status(400).json({ error: 'Invalid businessId.' });
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Product name is required.' });
  }
  const priceNum = Number(price);
  const inventoryNum = Number(inventory);
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    return res.status(400).json({ error: 'price must be a non-negative number.' });
  }
  if (!Number.isFinite(inventoryNum) || inventoryNum < 0) {
    return res.status(400).json({ error: 'inventory must be a non-negative number.' });
  }
  const prod: Product = {
    id: `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    businessId,
    name: String(name).slice(0, 200),
    sku: sku ? String(sku).slice(0, 100) : `SKU-${Date.now()}`,
    price: priceNum,
    inventory: Math.floor(inventoryNum),
    description: typeof description === 'string' ? description.slice(0, 2000) : '',
    category: category ? String(category).slice(0, 100) : 'General'
  };
  await db.products.push(prod);
  await db.auditLogs.push({
    id: `log-${Date.now()}`,
    businessId,
    action: 'PRODUCT_CREATED',
    details: `Product "${prod.name}" created (SKU ${prod.sku}, inventory ${prod.inventory}).`,
    timestamp: new Date().toISOString()
  });
  res.status(201).json(prod);
}));

router.get('/orders', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  if (businessId) {
    // DB-side pagination (audit P2.9).
    const limit = Math.min(Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || PAGINATION_DEFAULT), PAGINATION_MAX);
    const offset = Math.max(0, parseInt(String(req.query.cursor ?? ''), 10) || 0);
    const { rows, total } = await db.orders.paginateWhere('business_id = ?', [businessId], { orderBy: 'created_at', desc: true, limit, offset });
    res.setHeader('X-Total-Count', String(total));
    if (offset + limit < total) res.setHeader('X-Next-Cursor', String(offset + limit));
    return res.json(rows);
  }
  const orders = await db.orders.toJSON();
  res.json(paginate(orders, req, res));
}));

// =========================================
// 7. CONVERSATIONS & HUMAN HANDOFF
// =========================================

router.get('/conversations', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  if (businessId) {
    // DB-side pagination (audit P2.9): avoid loading all conversations.
    const limit = Math.min(Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || PAGINATION_DEFAULT), PAGINATION_MAX);
    const offset = Math.max(0, parseInt(String(req.query.cursor ?? ''), 10) || 0);
    const { rows, total } = await db.conversations.paginateWhere('business_id = ?', [businessId], { orderBy: 'last_message_at', desc: true, limit, offset });
    res.setHeader('X-Total-Count', String(total));
    if (offset + limit < total) res.setHeader('X-Next-Cursor', String(offset + limit));
    return res.json(rows);
  }
  const convs = await db.conversations.toJSON();
  res.json(paginate(convs, req, res));
}));

// Get a single conversation by id (tenant-scoped via requireResourceAccess).
router.get(
  '/conversations/:id',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(res.locals.resource);
  }
));

router.get(
  '/conversations/:id/messages',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const conv = res.locals.resource as { id: string };
    const msgs = await db.messages.filter(m => m.conversationId === conv.id);
    res.json(paginate(msgs, req, res));
  }
));

// Human Agent Takeover endpoint
router.post(
  '/conversations/:id/takeover',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const conv = res.locals.resource as Conversation;

    conv.status = 'HUMAN_HANDLING';
    conv.handoffStartedAt = new Date().toISOString();
    await db.conversations.update(conv);

    await db.messages.push({
      id: `msg-${Date.now()}-system`,
      conversationId: conv.id,
      sender: 'system',
      content: 'A human team member has joined the chat and taken over.',
      channel: conv.channel,
      timestamp: new Date().toISOString()
    });

    await db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: conv.businessId,
      action: 'HUMAN_HANDOFF_ACCEPTED',
      details: `Human took over conversation ${conv.id}.`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, conversation: conv });
  }
));

// Send Human Agent Message directly
router.post(
  '/conversations/:id/message',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const conv = res.locals.resource as any;

    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Message content required.' });

    const msg = {
      id: `msg-${Date.now()}-human`,
      conversationId: conv.id,
      sender: 'human_agent' as const,
      content,
      channel: conv.channel,
      timestamp: new Date().toISOString()
    };

    await db.messages.push(msg);
    conv.lastMessageAt = new Date().toISOString();
    await db.conversations.update(conv);

    res.json(msg);
  }
));

// Resolve Conversation
router.post(
  '/conversations/:id/resolve',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const conv = res.locals.resource as Conversation;

    conv.status = 'RESOLVED';
    conv.resolvedAt = new Date().toISOString();
    await db.conversations.update(conv);
    res.json(conv);
  }
));

// Resume AI: re-enable the agent on a resolved/handed-off conversation.
router.post(
  '/conversations/:id/resume',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const conv = res.locals.resource as Conversation;
    // Only allow resuming from RESOLVED or HUMAN_HANDLING.
    if (conv.status !== 'RESOLVED' && conv.status !== 'HUMAN_HANDLING' && conv.status !== 'WAITING_FOR_HUMAN') {
      return res.status(400).json({ error: `Cannot resume a conversation in ${conv.status}.` });
    }
    conv.status = 'AI_HANDLING';
    await db.conversations.update(conv);

    await db.messages.push({
      id: `msg-${Date.now()}-system`,
      conversationId: conv.id,
      sender: 'system',
      content: 'AI assistant has resumed handling this conversation.',
      channel: conv.channel,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, conversation: conv });
  }
));

// =========================================
// 8. CHANNELS & INTEGRATIONS
// =========================================

router.get('/channels', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const chans = businessId ? await db.channels.filter(c => c.businessId === businessId) : await db.channels.toJSON();
  res.json(chans);
}));

router.put(
  '/channels/:id',
  requireAuth,
  requireResourceAccess(req => db.channels.find(c => c.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const chan = res.locals.resource as any;

    const { status, details, configData } = req.body;
    if (status) chan.status = status;
    if (details) chan.details = details;
    if (configData) chan.configData = configData;
    chan.updatedAt = new Date().toISOString();
    await db.channels.update(chan);

    await db.auditLogs.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      businessId: chan.businessId,
      action: 'CHANNEL_UPDATED',
      details: `Channel ${chan.type} status updated to ${chan.status}.`,
      timestamp: new Date().toISOString()
    });

    res.json(chan);
  }
));

router.get('/integrations', requireAuth, requireTenantScope, asyncHandler(async (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const items = businessId ? await db.integrations.filter(i => i.businessId === businessId) : await db.integrations.toJSON();
  // Never leak credentials. configData holds only non-secret config.
  res.json(items.map(sanitizeIntegrationForClient));
}));

/**
 * Update an integration's NON-SECRET configData only.
 * CRITICAL: this route NEVER accepts `state`/`connected`/`credentialsSet` from
 * the frontend. State transitions to CONNECTED only via POST /:id/validate,
 * which runs the real provider validation. Credentials are stored server-side
 * via the /:id/credentials route and never persisted to configData.
 */
router.put(
  '/integrations/:id',
  requireAuth,
  requireResourceAccess(req => db.integrations.find(i => i.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const integ = res.locals.resource as any;
    const { configData } = req.body;
    // Only non-secret configData is accepted; never `state`/`connected`.
    if (configData && typeof configData === 'object' && !Array.isArray(configData)) {
      integ.configData = { ...integ.configData, ...configData };
    }
    integ.updatedAt = new Date().toISOString();
    await db.integrations.update(integ);
    res.json(sanitizeIntegrationForClient(integ));
  }
));

/**
 * Submit credentials for an integration (server-side only). Stores them in
 * process memory (never in the DB row, never returned to the client) and marks
 * the integration CONFIGURING. Does NOT set CONNECTED — that requires /validate.
 */
router.post(
  '/integrations/:id/credentials',
  requireAuth,
  requireResourceAccess(req => db.integrations.find(i => i.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const integ = res.locals.resource as any;
    const credentials = req.body?.credentials;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      return res.status(400).json({ error: 'credentials object is required.' });
    }
    // Audit P2.11: validate each credential value BEFORE storing. Reject empty
    // strings and bound length so a giant value can't blow up storage/logs, and
    // so a stray empty form field doesn't mark the integration "configured".
    const MAX_CRED_LEN = 4096;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(credentials)) {
      if (typeof v !== 'string') {
        return res.status(400).json({ error: `Credential "${k}" must be a string.` });
      }
      const trimmed = v.trim();
      if (!trimmed) {
        return res.status(400).json({ error: `Credential "${k}" must not be empty.` });
      }
      if (trimmed.length > MAX_CRED_LEN) {
        return res.status(400).json({ error: `Credential "${k}" exceeds the maximum length of ${MAX_CRED_LEN} characters.` });
      }
      clean[k] = trimmed;
    }
    if (Object.keys(clean).length === 0) {
      return res.status(400).json({ error: 'At least one credential value is required.' });
    }
    // Persist credentials encrypted at rest (fails safe — never stores plaintext —
    // if no encryption key is configured). The error message never reveals the
    // key state to the client beyond a generic storage-unavailable notice.
    try {
      await storeCredentials(integ.id, integ.businessId, integ.provider, clean);
    } catch {
      return res.status(503).json({ error: 'Credential storage is not available. Contact your administrator.' });
    }
    integ.credentialsSet = true;
    integ.state = 'CONFIGURING';
    integ.lastError = undefined;
    integ.statusMessage = 'Credentials received — pending validation.';
    integ.updatedAt = new Date().toISOString();
    await db.integrations.update(integ);

    await db.auditLogs.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      businessId: integ.businessId,
      action: 'INTEGRATION_CREDENTIALS_SET',
      details: `Credentials submitted for ${integ.provider}. Validation required to connect.`,
      timestamp: new Date().toISOString()
    });

    res.json({ id: integ.id, state: integ.state, statusMessage: integ.statusMessage });
  }
));

/**
 * Validate an integration against the real provider. This is the ONLY path to
 * CONNECTED. The provider's validate() must succeed; otherwise state=ERROR.
 */
router.post(
  '/integrations/:id/validate',
  requireAuth,
  requireResourceAccess(req => db.integrations.find(i => i.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const integ = res.locals.resource as any;
    const provider = getProvider(integ.provider);
    const credentials = (await getCredentials(integ.id, integ.businessId)) || {};
    if (!integ.credentialsSet && Object.keys(credentials).length === 0) {
      return res.status(400).json({ error: 'No credentials stored. Submit credentials first.' });
    }
    const outcome = await runValidation(provider, integ.id, integ.configData, credentials);
    integ.state = outcome.state;
    integ.statusMessage = outcome.statusMessage;
    integ.lastError = outcome.lastError;
    integ.lastValidatedAt = new Date().toISOString();
    if (outcome.meta && Object.keys(outcome.meta).length) {
      integ.configData = { ...(integ.configData || {}), ...outcome.meta };
    }
    if (outcome.state === 'CONNECTED') integ.lastSync = new Date().toISOString();
    await db.integrations.update(integ);

    await db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: integ.businessId,
      action: outcome.state === 'CONNECTED' ? 'INTEGRATION_CONNECTED' : 'INTEGRATION_VALIDATION_FAILED',
      details: `Integration ${integ.provider} validation: ${outcome.statusMessage}`,
      timestamp: new Date().toISOString()
    });

    res.json({ id: integ.id, state: integ.state, statusMessage: integ.statusMessage, lastError: integ.lastError });
  }
));

/** Disconnect an integration (clears stored credentials, state=DISCONNECTED). */
router.post(
  '/integrations/:id/disconnect',
  requireAuth,
  requireResourceAccess(req => db.integrations.find(i => i.id === req.params.id)),
  asyncHandler(async (req: Request, res: Response) => {
    const integ = res.locals.resource as any;
    await clearCredentials(integ.id, integ.businessId);
    integ.credentialsSet = false;
    integ.state = 'DISCONNECTED';
    integ.statusMessage = 'Disconnected by operator.';
    integ.lastError = undefined;
    integ.updatedAt = new Date().toISOString();
    await db.integrations.update(integ);
    res.json({ id: integ.id, state: integ.state, statusMessage: integ.statusMessage });
  }
));

// =========================================
// 9. ANALYTICS & TEMPLATES
// =========================================

// Cross-tenant aggregate — PLATFORM_OWNER only.
router.get('/analytics/overview', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const totalBusinesses = await db.businesses.length();
  const activeAgentsArr = await db.agents.filter(a => a.status === 'ACTIVE');
  const activeAgents = activeAgentsArr.length;
  const totalConversations = await db.conversations.length();
  const totalAppointments = await db.appointments.length();
  const totalOrders = await db.orders.length();
  
  const totalTokens = await db.usageRecords.reduce((acc, u) => acc + u.tokensUsed, 0);
  const totalEstimatedCostUsd = await db.usageRecords.reduce((acc, u) => acc + u.estimatedCostUsd, 0);

  res.json({
    totalBusinesses,
    activeAgents,
    inactiveAgents: (await db.agents.length()) - activeAgents,
    totalConversations,
    totalAppointments,
    totalOrders,
    totalTokens,
    totalEstimatedCostUsd,
    recentActivity: (await db.auditLogs.slice(-10)).reverse()
  });
}));

// Global UI data (industry templates) — authenticated users only.
router.get('/templates', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  res.json(await db.templates.toJSON());
}));

// Audit logs — platform owner sees all; business users see only their own.
router.get('/audit-logs', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = req.query;
  const user = res.locals.user as User;

  if (businessId) {
    if (user.role !== 'PLATFORM_OWNER' && String(businessId) !== user.businessId) {
      return res.status(404).json({ error: 'Not found.' });
    }
    const logs = (await db.auditLogs.filter(l => l.businessId === businessId)).reverse();
    return res.json(paginate(logs, req, res));
  }
  const logs = (user.role === 'PLATFORM_OWNER'
    ? await db.auditLogs.toJSON()
    : await db.auditLogs.filter(l => l.businessId === user.businessId)
  ).reverse();
  res.json(paginate(logs, req, res));
}));

// 404 catch-all for unmatched /api/* routes. Without this, unmatched API paths
// fall through to the SPA catch-all in server.ts and return index.html, which
// breaks API clients that expect JSON. This runs inside the /api router, so it
// only matches /api/* paths.
router.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});
