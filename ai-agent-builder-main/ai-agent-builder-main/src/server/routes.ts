import { Router, Request, Response } from 'express';
import { db } from './db';
import { processAgentMessage, generateSuggestedAgentConfig } from './agentRuntime';
import { Business, Agent, KnowledgeChunk, Product, Appointment, Order, User, Conversation } from '../types';
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
// sets the signed HttpOnly cookie.
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
  const session = createSession(user.id);
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
      connected: false,
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
    Object.assign(biz, req.body, { updatedAt: new Date().toISOString() });
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

// Update Agent — resource belongs to the authorized tenant
router.put(
  '/agents/:id',
  requireAuth,
  requireResourceAccess(req => db.agents.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    const agent = res.locals.resource as Agent;

    // Increment version on update
    const newVersion = agent.version + 1;
    Object.assign(agent, req.body, {
      version: newVersion,
      updatedAt: new Date().toISOString()
    });
    db.agents.update(agent);

    db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: agent.businessId,
      agentId: agent.id,
      action: 'AGENT_UPDATED',
      details: `Updated agent "${agent.name}" to version v${newVersion}.`,
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

    // Validate readiness before setting ACTIVE
    if (status === 'ACTIVE') {
      const biz = db.businesses.find(b => b.id === agent.businessId);
      if (!biz) return res.status(400).json({ error: 'Cannot activate agent: Business not found.' });
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

// =========================================
// 3. RUNTIME CHAT & SIMULATOR (PUBLIC — customer-facing widget, no login)
// =========================================

router.post('/runtime/chat', async (req: Request, res: Response) => {
  const { tenantId, userMessage, conversationId, channel, customerName, customerPhone } = req.body;

  if (!tenantId || !userMessage) {
    return res.status(400).json({ error: 'tenantId and userMessage are required.' });
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

    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      error: err.message || 'Agent runtime processing failed',
      fallbackMessage: "I am having trouble processing your request right now. I will connect you with a team member."
    });
  }
});

// =========================================
// 4. KNOWLEDGE BASE
// =========================================

router.get('/knowledge', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  if (!businessId) return res.status(400).json({ error: 'businessId required.' });

  const items = db.knowledgeChunks.filter(k => k.businessId === businessId);
  res.json(items);
});

router.post('/knowledge', requireAuth, requireTenantScope, (req: Request, res: Response) => {
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
  res.status(201).json(chunk);
});

router.delete(
  '/knowledge/:id',
  requireAuth,
  requireResourceAccess(req => db.knowledgeChunks.find(k => k.id === req.params.id)),
  (req: Request, res: Response) => {
    const chunk = res.locals.resource as KnowledgeChunk;
    const idx = db.knowledgeChunks.findIndex(k => k.id === chunk.id);
    if (idx === -1) return res.status(404).json({ error: 'Item not found.' });

    db.knowledgeChunks.splice(idx, 1);
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

  res.json(apps);
});

router.post('/appointments', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const { serviceId, customerName, customerPhone, date, startTime, notes } = req.body;
  const businessId = res.locals.businessId as string | null;

  const biz = businessId ? db.businesses.find(b => b.id === businessId) : undefined;
  if (!biz) return res.status(400).json({ error: 'Invalid businessId.' });

  const service = biz.services.find(s => s.id === serviceId) || biz.services[0];

  const app: Appointment = {
    id: `app-${Date.now()}`,
    businessId,
    serviceId: service ? service.id : 'srv-1',
    serviceName: service ? service.name : 'Service',
    customerId: `cust-${Date.now()}`,
    customerName,
    customerPhone,
    date,
    startTime,
    endTime: `${parseInt(startTime.split(':')[0]) + 1}:00`,
    status: 'CONFIRMED',
    notes,
    createdAt: new Date().toISOString()
  };

  db.appointments.push(app);
  res.status(201).json(app);
});

router.put(
  '/appointments/:id',
  requireAuth,
  requireResourceAccess(req => db.appointments.find(a => a.id === req.params.id)),
  (req: Request, res: Response) => {
    const app = res.locals.resource as Appointment;

    Object.assign(app, req.body);
    db.appointments.update(app);
    res.json(app);
  }
);

// =========================================
// 6. PRODUCTS & ORDERS
// =========================================

router.get('/products', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const items = businessId ? db.products.filter(p => p.businessId === businessId) : db.products.toJSON();
  res.json(items);
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
  res.json(orders);
});

// =========================================
// 7. CONVERSATIONS & HUMAN HANDOFF
// =========================================

router.get('/conversations', requireAuth, requireTenantScope, (req: Request, res: Response) => {
  const businessId = res.locals.businessId as string | null;
  const convs = businessId ? db.conversations.filter(c => c.businessId === businessId) : db.conversations.toJSON();
  res.json(convs);
});

router.get(
  '/conversations/:id/messages',
  requireAuth,
  requireResourceAccess(req => db.conversations.find(c => c.id === req.params.id)),
  (req: Request, res: Response) => {
    const conv = res.locals.resource as { id: string };
    const msgs = db.messages.filter(m => m.conversationId === conv.id);
    res.json(msgs);
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
    db.conversations.update(conv);

    db.messages.push({
      id: `msg-${Date.now()}-system`,
      conversationId: conv.id,
      sender: 'system',
      content: 'A human team member has joined the chat and taken over.',
      channel: conv.channel,
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
    const conv = res.locals.resource as any;

    conv.status = 'RESOLVED';
    db.conversations.update(conv);
    res.json(conv);
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
  res.json(items);
});

router.put(
  '/integrations/:id',
  requireAuth,
  requireResourceAccess(req => db.integrations.find(i => i.id === req.params.id)),
  (req: Request, res: Response) => {
    const integ = res.locals.resource as any;

    const { connected, statusMessage, credentialsSet, configData } = req.body;
    if (typeof connected === 'boolean') integ.connected = connected;
    if (statusMessage) integ.statusMessage = statusMessage;
    if (typeof credentialsSet === 'boolean') integ.credentialsSet = credentialsSet;
    if (configData) integ.configData = configData;
    integ.lastSync = new Date().toISOString();
    db.integrations.update(integ);

    db.auditLogs.push({
      id: `log-${Date.now()}`,
      businessId: integ.businessId,
      action: 'INTEGRATION_UPDATED',
      details: `Integration ${integ.provider} set to ${integ.connected ? 'Configured/Connected' : 'Not configured'}.`,
      timestamp: new Date().toISOString()
    });

    res.json(integ);
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
    return res.json(db.auditLogs.filter(l => l.businessId === businessId).reverse());
  }
  const logs = user.role === 'PLATFORM_OWNER'
    ? db.auditLogs.toJSON()
    : db.auditLogs.filter(l => l.businessId === user.businessId);
  res.json(logs.slice(-50).reverse());
});
