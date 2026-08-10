import { Router, Request, Response, NextFunction } from 'express';
import { db } from './db';
import { processAgentMessage, generateSuggestedAgentConfig } from './agentRuntime';
import { executeAgentTool } from './tools';
import {
  createInitialDraft, createDraftFrom, editDraft, publishVersion,
  rollbackToVersion, archiveVersion, moveToTesting, listVersions,
  getPublishedVersion, getVersionForSim
} from './agentVersions';
import { indexChunk, removeEmbedding } from './embeddings';
import { assertActivatable, readinessSnapshot } from './readiness';
import { rateLimit, RATE_LIMITS } from './security';
import {
  getProvider, runValidation, storeCredentials, getCredentials, clearCredentials
} from './integrations';
import { widgetCorsHeaders } from './widgetSecurity';
import { Business, Agent, KnowledgeChunk, Product, Appointment, Order, User, Conversation, AgentVersion } from '../types';
import { verifyPassword } from './passwords';
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
  SESSION_COOKIE
} from './auth';

export const router = Router();

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
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// =========================================
// AUTH (login/logout public; /auth/me is session-driven)
// =========================================

// Current User Context — real user from the session, or 401.
router.get('/auth/me', (req: Request, res: Response) => {
  const user = loadUserFromSession(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  res.json({ user: toPublicUser(user) });
});

// Login — public. Validates credentials, creates a SQLite-backed session,
// sets the signed HttpOnly cookie. A missing SESSION_SECRET in production is
// reported as a clear JSON 500 (not an HTML crash page) so operators can
// diagnose it without the app becoming unresponsive.
router.post('/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const user = db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (!verifyPassword(String(password), user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  let session;
  try {
    session = createSession(user.id);
  } catch (err: any) {
    const msg = err?.message || 'Failed to create session.';
    return res.status(500).json({
      error: process.env.NODE_ENV === 'production' ? 'Internal server error.' : msg
    });
  }
  setSessionCookie(res, session.id);
  res.json({ user: toPublicUser(user) });
});

// Logout — public. Always 200; invalidates the server-side session row when present.
router.post('/auth/logout', (req: Request, res: Response) => {
  const raw = readCookie(req, SESSION_COOKIE);
  if (raw) {
    const sessionId = raw.split('.')[0];
    if (sessionId) destroySession(sessionId);
  }
  clearSessionCookie(res);
  res.json({ success: true });
});

// =========================================
// 1. BUSINESSES (MULTI-TENANT MANAGEMENT)
// =========================================

// Get all businesses (with optional search/type filters).
// Platform owner -> all businesses; business owner/staff -> ONLY their own.
router.get('/businesses', requireAuth, (req: Request, res: Response) => {
  const { search, type, status } = req.query;
  const user = res.locals.user as User;
  let result = db.businesses.toJSON();

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
});

// Create Business — PLATFORM_OWNER only.
router.post('/businesses', requireAuth, requireRole('PLATFORM_OWNER'), (req: Request, res: Response) => {
  const {
    name,
    type,
    description,
    location,
    language = 'en',
    currency = 'toman',
    timezone = 'Asia/Tehran',
    hours,
    services = [],
    faqs = [],
    policies,
    communicationStyle
  } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'Business name and type are required.' });
  }

  const defaultHours = [
    { day: 'monday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
    { day: 'tuesday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
    { day: 'wednesday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
    { day: 'thursday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
    { day: 'friday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
    { day: 'saturday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
    { day: 'sunday', isOpen: false, openTime: '09:00', closeTime: '20:00' },
  ] as const;

  const newBiz: Business = {
    id: `biz-${Date.now()}`,
    name,
    type,
    description: description || '',
    location: location || 'Main Street',
    language,
    currency,
    timezone,
    hours: hours || defaultHours,
    services: services.map((s: any, idx: number) => ({
      id: s.id || `srv-${Date.now()}-${idx}`,
      name: s.name,
      price: Number(s.price) || 0,
      durationMinutes: Number(s.durationMinutes) || 30,
      description: s.description || ''
    })),
    faqs: faqs.map((f: any, idx: number) => ({
      id: f.id || `faq-${Date.now()}-${idx}`,
      question: f.question,
      answer: f.answer
    })),
    policies: policies || {
      cancellation: 'Cancel at least 2 hours in advance.',
      refund: 'No monetary refunds after service completed.',
      bookingNotice: 'Book up to 14 days in advance.'
    },
    communicationStyle: communicationStyle || 'Friendly, courteous, and efficient.',
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.businesses.push(newBiz);

  // Initialize Default Channels & Integrations for new tenant
  const defaultChannels = ['web_chat', 'instagram', 'sms', 'voice'] as const;
  defaultChannels.forEach(chanType => {
    db.channels.push({
      id: `chan-${Date.now()}-${chanType}`,
      businessId: newBiz.id,
      type: chanType,
      status: chanType === 'web_chat' ? 'connected' : 'not_configured',
      details: chanType === 'web_chat' ? 'Widget ready to embed' : 'Not configured',
      updatedAt: new Date().toISOString()
    });
  });

  const providers = ['google_calendar', 'meta_instagram', 'twilio_sms', 'voice_ai'] as const;
  providers.forEach(prov => {
    db.integrations.push({
      id: `integ-${Date.now()}-${prov}`,
      businessId: newBiz.id,
      provider: prov,
      state: 'NOT_CONFIGURED',
      statusMessage: 'Not configured',
      credentialsSet: false
    });
  });

  db.auditLogs.push({
    id: `log-${Date.now()}`,
    businessId: newBiz.id,
    action: 'BUSINESS_CREATED',
    details: `Business "${newBiz.name}" (${newBiz.type}) created.`,
    timestamp: new Date().toISOString()
  });

  res.status(201).json(newBiz);
});

// Get Business by ID — platform owner or the business's own owner/staff.
router.get(
  '/businesses/:id',
  requireAuth,
  requireResourceAccess(req => db.businesses.find(b => b.id === req.params.id), b => (b as Business).id),
  (req: Request, res: Response) => {
    res.json(res.locals.resource);
  }
);

// Update Business — platform owner or the business's own owner/staff.
router.put(
  '/businesses/:id',
  requireAuth,
  requireResourceAccess(req => db.businesses.find(b => b.id === req.params.id), b => (b as Business).id),
  (req: Request, res: Response) => {
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
    if (Array.isArray(allowedWidgetOrigins)) biz.allowedWidgetOrigins = allowedWidgetOrigins;
    biz.updatedAt = new Date().toISOString();
    db.businesses.update(biz);
    res.json(biz);
  }
);

// Duplicate Business & Agent Feature (Section 33 Prompt Mandate) — PLATFORM_OWNER only,
// because it creates a new tenant (same privilege as POST /businesses).
router.post('/businesses/:id/duplicate', requireAuth, requireRole('PLATFORM_OWNER'), (req: Request, res: Response) => {
  const sourceBiz = db.businesses.find(b => b.id === req.params.id);
  if (!sourceBiz) return res.status(404).json({ error: 'Source business not found.' });

  const { newName } = req.body;
  const targetName = newName || `${sourceBiz.name} (Copy)`;
  const newBizId = `biz-${Date.now()}`;

  // Clone Business
  const clonedBiz: Business = JSON.parse(JSON.stringify(sourceBiz));
  clonedBiz.id = newBizId;
  clonedBiz.name = targetName;
  clonedBiz.createdAt = new Date().toISOString();
  clonedBiz.updatedAt = new Date().toISOString();

  db.businesses.push(clonedBiz);

  // Clone Agents
  const sourceAgents = db.agents.filter(a => a.businessId === sourceBiz.id);
  sourceAgents.forEach(a => {
    const clonedAgent: Agent = JSON.parse(JSON.stringify(a));
    clonedAgent.id = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    clonedAgent.businessId = newBizId;
    clonedAgent.name = `${a.name} for ${targetName}`;
    clonedAgent.createdAt = new Date().toISOString();
    clonedAgent.updatedAt = new Date().toISOString();
    db.agents.push(clonedAgent);
    // Clone the agent's published version so the new agent starts with a
    // complete version history (factory workflow: duplicate template).
    const srcPub = db.agentVersions.find(v => v.agentId === a.id && v.status === 'PUBLISHED');
    if (srcPub) {
      db.agentVersions.push({
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
  });

  // Clone Knowledge Chunks
  const sourceChunks = db.knowledgeChunks.filter(k => k.businessId === sourceBiz.id);
  sourceChunks.forEach(k => {
    const clonedChunk: KnowledgeChunk = JSON.parse(JSON.stringify(k));
    clonedChunk.id = `kc-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    clonedChunk.businessId = newBizId;
    clonedChunk.createdAt = new Date().toISOString();
    db.knowledgeChunks.push(clonedChunk);
  });

  // Clone Products
  const sourceProds = db.products.filter(p => p.businessId === sourceBiz.id);
  sourceProds.forEach(p => {
    const clonedProd: Product = JSON.parse(JSON.stringify(p));
    clonedProd.id = `prod-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    clonedProd.businessId = newBizId;
    db.products.push(clonedProd);
  });

  db.auditLogs.push({
    id: `log-${Date.now()}`,
    businessId: newBizId,
    action: 'BUSINESS_DUPLICATED',
    details: `Duplicated business and agents from ${sourceBiz.name} to ${targetName}.`,
    timestamp: new Date().toISOString()
  });

  res.status(201).json({
    message: 'Business and Agent successfully duplicated!',
    newBusiness: clonedBiz
  });
});

// =========================================
// 2. AGENTS & WIZARD GENERATOR
// =========================================

// Get Agents (optionally filtered by businessId; tenant enforced server-side)
router.get('/agents', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const agents = businessId ? db.agents.filter(a => a.businessId === businessId) : db.agents.toJSON();
  res.json(agents);
});

// Get a single agent — tenant-scoped via requireResourceAccess.
router.get(
  '/agents/:id',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    res.json(res.locals.resource as Agent);
  }
);

// Generate Suggested Agent Configuration (AI Assistant Wizard)
router.post('/agents/generate-config', requireAuth, async (req: Request, res: Response) => {
  const { name, type, description, hours, services } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'Name and type are required for agent generation.' });
  }

  const suggestedConfig = await generateSuggestedAgentConfig({
    name,
    type,
    description,
    hours,
    services
  });

  res.json(suggestedConfig);
});

// Create Agent — tenant derived from the session (body businessId cannot widen access)
router.post('/agents', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const { name, description, systemPrompt, structuredConfig, llmProvider = 'gemini', model = 'gemini-3.6-flash' } = req.body;
  const businessId = res.locals.businessId as string | null;

  if (!businessId || !name) {
    return res.status(400).json({ error: 'businessId and agent name are required.' });
  }

  const newAgent: Agent = {
    id: `agent-${Date.now()}`,
    businessId,
    name,
    description: description || 'AI Receptionist & Assistant',
    version: 1,
    status: 'READY',
    systemPrompt: systemPrompt || 'You are an AI assistant. Answer customer queries politely based on business context.',
    structuredConfig: structuredConfig || {
      personality: { tone: 'friendly', behavior: 'service', language: 'en' },
      goals: ['Answer FAQs', 'Book appointments'],
      allowedActions: ['check_business_hours', 'get_business_information', 'check_availability', 'book_appointment', 'transfer_to_human'],
      restrictedActions: ['Do not make up fake information'],
      escalationRules: ['Customer requests human'],
      bookingRules: 'Require name and phone number',
      orderRules: 'Standard checkout',
      refundRules: 'Non-refundable',
      toolsEnabled: ['check_business_hours', 'get_business_information', 'check_availability', 'book_appointment', 'transfer_to_human']
    },
    llmProvider,
    model,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.agents.push(newAgent);

  // Create the first DRAFT version snapshot. The agent row is the live config;
  // the version history is immutable. Editing happens on drafts, not the row.
  createInitialDraft(newAgent);

  db.auditLogs.push({
    id: `log-${Date.now()}`,
    businessId,
    agentId: newAgent.id,
    action: 'AGENT_CREATED',
    details: `Created agent "${newAgent.name}" v1.`,
    timestamp: new Date().toISOString()
  });

  res.status(201).json(newAgent);
});

// Update Agent — resource belongs to the authorized tenant.
// This edits metadata only (name/description). Config edits go through the
// version endpoints so a draft never silently changes the live agent.
router.put(
  '/agents/:id',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    const { name, description } = req.body;
    if (name !== undefined) agent.name = name;
    if (description !== undefined) agent.description = description;
    agent.updatedAt = new Date().toISOString();
    db.agents.update(agent);

    db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: agent.businessId,
      agentId: agent.id,
      action: 'AGENT_UPDATED',
      details: `Updated agent "${agent.name}" metadata.`,
      timestamp: new Date().toISOString()
    });

    res.json(agent);
  }
);

// Toggle Agent Deployment Status — resource belongs to the authorized tenant
router.post(
  '/agents/:id/status',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;

    const { status } = req.body;
    if (!['DRAFT', 'TESTING', 'READY', 'ACTIVE', 'PAUSED', 'ARCHIVED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status state.' });
    }

    // Validate readiness before setting ACTIVE (Phase 20): the server-side
    // composite checklist must pass. The frontend cannot bypass this.
    if (status === 'ACTIVE') {
      try {
        assertActivatable(agent);
      } catch (err: any) {
        return res.status(400).json({
          error: err.message,
          readiness: err.readiness
        });
      }
    }

    agent.status = status;
    agent.updatedAt = new Date().toISOString();
    db.agents.update(agent);

    db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: agent.businessId,
      agentId: agent.id,
      action: 'AGENT_STATUS_CHANGED',
      details: `Agent "${agent.name}" state set to ${status}.`,
      timestamp: new Date().toISOString()
    });

    res.json(agent);
  }
);

// Agent readiness checklist (Phase 20) — read-only snapshot for the UI.
router.get(
  '/agents/:id/readiness',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;
    res.json(readinessSnapshot(agent));
  }
);

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
  (req: Request, res: Response) => {
    res.json(listVersions(req.params.id));
  }
);

router.get(
  '/agents/:id/versions/published',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    const pub = getPublishedVersion(req.params.id);
    if (!pub) return res.status(404).json({ error: 'No published version.' });
    res.json(pub);
  }
);

router.post(
  '/agents/:id/versions',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    // Create a new draft from an existing version (defaults to published).
    const { fromVersionId, changeNote } = req.body;
    const sourceId = fromVersionId || getPublishedVersion(req.params.id)?.id;
    if (!sourceId) return res.status(400).json({ error: 'No source version to draft from.' });
    try {
      const draft = createDraftFrom(sourceId, changeNote);
      res.status(201).json(draft);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

router.put(
  '/agents/:id/versions/:versionId',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    try {
      const updated = editDraft(req.params.versionId, req.body);
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

router.post(
  '/agents/:id/versions/:versionId/publish',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    try {
      const pub = publishVersion(req.params.versionId);
      db.auditLogs.push({
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
);

router.post(
  '/agents/:id/versions/:versionId/test',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    try {
      res.json(moveToTesting(req.params.versionId));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

router.post(
  '/agents/:id/versions/:versionId/rollback',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    try {
      const pub = rollbackToVersion(req.params.versionId);
      res.json(pub);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

router.post(
  '/agents/:id/versions/:versionId/archive',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    try {
      res.json(archiveVersion(req.params.versionId));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
);

// =========================================
// 3. RUNTIME CHAT & SIMULATOR
// =========================================

// Public, customer-facing widget endpoint. NO authentication (a website
// visitor is not logged in). Returns ONLY the safe reply + conversationId +
// status — never the internal debug block (system prompt, retrieved knowledge,
// tool calls, latency) which is developer-only and must not leak to customers.
// The runtime itself is tenant-scoped and never trusts a frontend-supplied
// conversation id across tenants.
// OPTIONS preflight for the cross-origin widget. Origin is enforced per-business
// (P1.2): only origins in the target business's allowedWidgetOrigins are allowed;
// unknown origins receive 403.
router.options('/runtime/chat', (req: Request, res: Response) => {
  // The browser preflight cannot send the custom x-business-id value (preflight
  // only lists header names). Resolve the tenant from the `business` query param
  // the widget appends, then enforce the per-business origin allow-list.
  const tenantId = (req.query.business as string) || (req.headers['x-business-id'] as string) || undefined;
  const origin = req.headers.origin;
  const headers = tenantId ? widgetCorsHeaders(tenantId, origin) : null;
  if (!headers) {
    return res.status(403).end();
  }
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, String(v));
  return res.status(204).end();
});

router.post('/runtime/chat', rateLimit({ ...RATE_LIMITS.public, prefix: 'chat' }), (req: Request, res: Response, next: NextFunction) => {
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
  const headers = tenantId ? widgetCorsHeaders(tenantId, origin) : null;
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
  const { tenantId, userMessage, conversationId, channel, customerName, customerPhone } = req.body;

  if (!tenantId || !userMessage) {
    return res.status(400).json({ error: 'tenantId and userMessage are required.' });
  }

  // Payload-size guard: keep customer messages reasonable to limit abuse.
  if (typeof userMessage !== 'string' || userMessage.length > 8000) {
    return res.status(413).json({ error: 'Message too long.' });
  }

  try {
    const result = await processAgentMessage({
      tenantId,
      userMessage,
      conversationId,
      channel: channel || 'web_chat',
      customerName,
      customerPhone
    });

    // Customer-facing: strip all internal diagnostics.
    res.json({
      reply: result.reply,
      conversationId: result.conversationId,
      status: result.status
    });
  } catch (err: any) {
    res.status(500).json({
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
  async (req: Request, res: Response) => {
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
        simulator: true
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({
        error: err.message || 'Agent runtime processing failed',
        fallbackMessage: "I am having trouble processing your request right now. I will connect you with a team member."
      });
    }
  }
);

// =========================================
// 4. KNOWLEDGE BASE
// =========================================

router.get('/knowledge', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  if (!businessId) return res.status(400).json({ error: 'businessId required.' });

  const items = db.knowledgeChunks.filter(k => k.businessId === businessId);
  res.json(paginate(items, req, res));
});

router.post('/knowledge', requireAuth, requireTenantScope, async (req: Request, res: Response) => {
  const { title, type = 'faq', content, tags = [] } = req.body;
  const businessId = res.locals.businessId as string | null;
  if (!businessId || !title || !content) {
    return res.status(400).json({ error: 'businessId, title, and content are required.' });
  }

  const chunk: KnowledgeChunk = {
    id: `kc-${Date.now()}`,
    businessId,
    title,
    type,
    content,
    tags: Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()),
    createdAt: new Date().toISOString()
  };

  db.knowledgeChunks.push(chunk);
  // Index for semantic retrieval (re-indexes on change; no-op if no API key).
  indexChunk(chunk).catch(() => {/* embedding failures are non-fatal */});
  res.status(201).json(chunk);
});

router.put(
  '/knowledge/:id',
  requireAuth,
  requireResourceAccess(req => db.knowledgeChunks.find(k => k.id === req.params.id)),
  async (req: Request, res: Response) => {
    const chunk = res.locals.resource as KnowledgeChunk;
    const { title, content, tags, type } = req.body;
    if (title !== undefined) chunk.title = title;
    if (content !== undefined) chunk.content = content;
    if (type !== undefined) chunk.type = type;
    if (Array.isArray(tags)) chunk.tags = tags;
    db.knowledgeChunks.update(chunk);
    indexChunk(chunk).catch(() => {/* non-fatal */});
    res.json(chunk);
  }
);

router.delete(
  '/knowledge/:id',
  requireAuth,
  requireResourceAccess(req => db.knowledgeChunks.find(k => k.id === req.params.id)),
  (req: Request, res: Response) => {
    const chunk = res.locals.resource as KnowledgeChunk;
    const idx = db.knowledgeChunks.findIndex(k => k.id === chunk.id);
    if (idx === -1) return res.status(404).json({ error: 'Item not found.' });

    db.knowledgeChunks.splice(idx, 1);
    removeEmbedding(chunk.id).catch(() => {});
    res.json({ success: true });
  }
);

// =========================================
// 5. APPOINTMENTS
// =========================================

router.get('/appointments', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const { date, status } = req.query;
  const businessId = res.locals.businessId as string | null;
  let apps = businessId ? db.appointments.filter(a => a.businessId === businessId) : db.appointments.toJSON();

  if (date) apps = apps.filter(a => a.date === date);
  if (status) apps = apps.filter(a => a.status === status);

  res.json(paginate(apps, req, res));
});

router.post('/appointments', requireAuth, requireTenantScope, async (req: Request, res: Response) => {
  const { serviceId, customerName, customerPhone, date, startTime, notes } = req.body;
  const businessId = res.locals.businessId as string | null;
  if (!businessId) return res.status(400).json({ error: 'Invalid businessId.' });

  // Delegate to the same transactional booking engine the agent runtime uses,
  // so the REST API and the AI tool share ONE source of truth for overlap
  // prevention, service-duration end times, and business-hours validation.
  const result = await executeAgentTool('book_appointment', {
    serviceIdOrName: serviceId,
    customerName,
    customerPhone,
    date,
    startTime,
    notes
  }, { tenantId: businessId, channel: 'web_chat' });

  if (!result.success) {
    return res.status(409).json({ error: result.error });
  }
  // The tool records the appointment; return the full record for the dashboard.
  const created = db.appointments.find(a => a.id === result.data?.appointmentId);
  res.status(201).json(created ?? result.data);
});

router.put(
  '/appointments/:id',
  requireAuth,
  requireResourceAccess(req => db.appointments.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    const app = res.locals.resource as Appointment;
    // Whitelist mutable fields only. NEVER Object.assign(req.body) — that would
    // let a caller overwrite id/businessId/serviceId (tenant-isolation bypass /
    // mass-assignment) or forge completion status.
    const { status, notes } = req.body || {};
    const ALLOWED_STATUS = ['CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'];
    if (typeof status === 'string' && ALLOWED_STATUS.includes(status)) app.status = status;
    if (typeof notes === 'string') app.notes = notes.slice(0, 1000);
    db.appointments.update(app);

    if (status === 'CANCELLED') {
      db.auditLogs.push({
        id: `log-${Date.now()}`,
        businessId: app.businessId,
        action: 'APPOINTMENT_CANCELLED',
        details: `Appointment ${app.id} cancelled.`,
        timestamp: new Date().toISOString()
      });
    }
    res.json(app);
  }
);

// =========================================
// 6. PRODUCTS & ORDERS
// =========================================

router.get('/products', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const items = businessId ? db.products.filter(p => p.businessId === businessId) : db.products.toJSON();
  res.json(paginate(items, req, res));
});

router.post('/products', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const { name, sku, price, inventory, description, category } = req.body;
  const businessId = res.locals.businessId as string | null;
  const prod: Product = {
    id: `prod-${Date.now()}`,
    businessId,
    name,
    sku: sku || `SKU-${Date.now()}`,
    price: Number(price) || 0,
    inventory: Number(inventory) || 0,
    description: description || '',
    category: category || 'General'
  };
  db.products.push(prod);
  res.status(201).json(prod);
});

router.get('/orders', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const orders = businessId ? db.orders.filter(o => o.businessId === businessId) : db.orders.toJSON();
  res.json(paginate(orders, req, res));
});

// =========================================
// 7. CONVERSATIONS & HUMAN HANDOFF
// =========================================

router.get('/conversations', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const convs = businessId ? db.conversations.filter(c => c.businessId === businessId) : db.conversations.toJSON();
  res.json(paginate(convs, req, res));
});

router.get(
  '/conversations/:id/messages',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  (req: Request, res: Response) => {
    const conv = res.locals.resource as { id: string };
    const msgs = db.messages.filter(m => m.conversationId === conv.id);
    res.json(paginate(msgs, req, res));
  }
);

// Human Agent Takeover endpoint
router.post(
  '/conversations/:id/takeover',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  (req: Request, res: Response) => {
    const conv = res.locals.resource as Conversation;

    conv.status = 'HUMAN_HANDLING';
    conv.handoffStartedAt = new Date().toISOString();
    db.conversations.update(conv);

    db.messages.push({
      id: `msg-${Date.now()}-system`,
      conversationId: conv.id,
      sender: 'system',
      content: 'A human team member has joined the chat and taken over.',
      channel: conv.channel,
      timestamp: new Date().toISOString()
    });

    db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: conv.businessId,
      action: 'HUMAN_HANDOFF_ACCEPTED',
      details: `Human took over conversation ${conv.id}.`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, conversation: conv });
  }
);

// Send Human Agent Message directly
router.post(
  '/conversations/:id/message',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  (req: Request, res: Response) => {
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

    db.messages.push(msg);
    conv.lastMessageAt = new Date().toISOString();
    db.conversations.update(conv);

    res.json(msg);
  }
);

// Resolve Conversation
router.post(
  '/conversations/:id/resolve',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  (req: Request, res: Response) => {
    const conv = res.locals.resource as Conversation;

    conv.status = 'RESOLVED';
    conv.resolvedAt = new Date().toISOString();
    db.conversations.update(conv);
    res.json(conv);
  }
);

// Resume AI: re-enable the agent on a resolved/handed-off conversation.
router.post(
  '/conversations/:id/resume',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  (req: Request, res: Response) => {
    const conv = res.locals.resource as Conversation;
    // Only allow resuming from RESOLVED or HUMAN_HANDLING.
    if (conv.status !== 'RESOLVED' && conv.status !== 'HUMAN_HANDLING' && conv.status !== 'WAITING_FOR_HUMAN') {
      return res.status(400).json({ error: `Cannot resume a conversation in ${conv.status}.` });
    }
    conv.status = 'AI_HANDLING';
    db.conversations.update(conv);

    db.messages.push({
      id: `msg-${Date.now()}-system`,
      conversationId: conv.id,
      sender: 'system',
      content: 'AI assistant has resumed handling this conversation.',
      channel: conv.channel,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, conversation: conv });
  }
);

// =========================================
// 8. CHANNELS & INTEGRATIONS
// =========================================

router.get('/channels', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const chans = businessId ? db.channels.filter(c => c.businessId === businessId) : db.channels.toJSON();
  res.json(chans);
});

router.put(
  '/channels/:id',
  requireAuth,
  requireResourceAccess(req => db.channels.find(c => c.id === req.params.id)),
  (req: Request, res: Response) => {
    const chan = res.locals.resource as any;

    const { status, details, configData } = req.body;
    if (status) chan.status = status;
    if (details) chan.details = details;
    if (configData) chan.configData = configData;
    chan.updatedAt = new Date().toISOString();
    db.channels.update(chan);

    db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: chan.businessId,
      action: 'CHANNEL_UPDATED',
      details: `Channel ${chan.type} status updated to ${chan.status}.`,
      timestamp: new Date().toISOString()
    });

    res.json(chan);
  }
);

router.get('/integrations', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const items = businessId ? db.integrations.filter(i => i.businessId === businessId) : db.integrations.toJSON();
  // Never leak credentials. configData holds only non-secret config.
  res.json(items.map(({ ...i }) => i));
});

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
  (req: Request, res: Response) => {
    const integ = res.locals.resource as any;
    const { configData } = req.body;
    // Only non-secret configData is accepted; never `state`/`connected`.
    if (configData && typeof configData === 'object' && !Array.isArray(configData)) {
      integ.configData = { ...integ.configData, ...configData };
    }
    integ.updatedAt = new Date().toISOString();
    db.integrations.update(integ);
    res.json(integ);
  }
);

/**
 * Submit credentials for an integration (server-side only). Stores them in
 * process memory (never in the DB row, never returned to the client) and marks
 * the integration CONFIGURING. Does NOT set CONNECTED — that requires /validate.
 */
router.post(
  '/integrations/:id/credentials',
  requireAuth,
  requireResourceAccess(req => db.integrations.find(i => i.id === req.params.id)),
  (req: Request, res: Response) => {
    const integ = res.locals.resource as any;
    const credentials = req.body?.credentials;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      return res.status(400).json({ error: 'credentials object is required.' });
    }
    storeCredentials(integ.id, credentials);
    integ.credentialsSet = true;
    integ.state = 'CONFIGURING';
    integ.lastError = undefined;
    integ.statusMessage = 'Credentials received — pending validation.';
    integ.updatedAt = new Date().toISOString();
    db.integrations.update(integ);

    db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: integ.businessId,
      action: 'INTEGRATION_CREDENTIALS_SET',
      details: `Credentials submitted for ${integ.provider}. Validation required to connect.`,
      timestamp: new Date().toISOString()
    });

    res.json({ id: integ.id, state: integ.state, statusMessage: integ.statusMessage });
  }
);

/**
 * Validate an integration against the real provider. This is the ONLY path to
 * CONNECTED. The provider's validate() must succeed; otherwise state=ERROR.
 */
router.post(
  '/integrations/:id/validate',
  requireAuth,
  requireResourceAccess(req => db.integrations.find(i => i.id === req.params.id)),
  async (req: Request, res: Response) => {
    const integ = res.locals.resource as any;
    const provider = getProvider(integ.provider);
    const credentials = getCredentials(integ.id) || {};
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
    db.integrations.update(integ);

    db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: integ.businessId,
      action: outcome.state === 'CONNECTED' ? 'INTEGRATION_CONNECTED' : 'INTEGRATION_VALIDATION_FAILED',
      details: `Integration ${integ.provider} validation: ${outcome.statusMessage}`,
      timestamp: new Date().toISOString()
    });

    res.json({ id: integ.id, state: integ.state, statusMessage: integ.statusMessage, lastError: integ.lastError });
  }
);

/** Disconnect an integration (clears stored credentials, state=DISCONNECTED). */
router.post(
  '/integrations/:id/disconnect',
  requireAuth,
  requireResourceAccess(req => db.integrations.find(i => i.id === req.params.id)),
  (req: Request, res: Response) => {
    const integ = res.locals.resource as any;
    clearCredentials(integ.id);
    integ.credentialsSet = false;
    integ.state = 'DISCONNECTED';
    integ.statusMessage = 'Disconnected by operator.';
    integ.lastError = undefined;
    integ.updatedAt = new Date().toISOString();
    db.integrations.update(integ);
    res.json({ id: integ.id, state: integ.state, statusMessage: integ.statusMessage });
  }
);

// =========================================
// 9. ANALYTICS & TEMPLATES
// =========================================

// Cross-tenant aggregate — PLATFORM_OWNER only.
router.get('/analytics/overview', requireAuth, requireRole('PLATFORM_OWNER'), (req: Request, res: Response) => {
  const totalBusinesses = db.businesses.length;
  const activeAgents = db.agents.filter(a => a.status === 'ACTIVE').length;
  const totalConversations = db.conversations.length;
  const totalAppointments = db.appointments.length;
  const totalOrders = db.orders.length;
  
  const totalTokens = db.usageRecords.reduce((acc, u) => acc + u.tokensUsed, 0);
  const totalEstimatedCostUsd = db.usageRecords.reduce((acc, u) => acc + u.estimatedCostUsd, 0);

  res.json({
    totalBusinesses,
    activeAgents,
    inactiveAgents: db.agents.length - activeAgents,
    totalConversations,
    totalAppointments,
    totalOrders,
    totalTokens,
    totalEstimatedCostUsd,
    recentActivity: db.auditLogs.slice(-10).reverse()
  });
});

// Global UI data (industry templates) — non-sensitive, left public.
router.get('/templates', (req: Request, res: Response) => {
  res.json(db.templates);
});

// Audit logs — platform owner sees all; business users see only their own.
router.get('/audit-logs', requireAuth, (req: Request, res: Response) => {
  const { businessId } = req.query;
  const user = res.locals.user as User;

  if (businessId) {
    if (user.role !== 'PLATFORM_OWNER' && String(businessId) !== user.businessId) {
      return res.status(404).json({ error: 'Not found.' });
    }
    const logs = db.auditLogs.filter(l => l.businessId === businessId).reverse();
    return res.json(paginate(logs, req, res));
  }
  const logs = (user.role === 'PLATFORM_OWNER'
    ? db.auditLogs.toJSON()
    : db.auditLogs.filter(l => l.businessId === user.businessId)
  ).reverse();
  res.json(paginate(logs, req, res));
});
