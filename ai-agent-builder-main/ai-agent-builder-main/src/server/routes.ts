import { Router, Request, Response } from 'express';
import { db } from './db';
import { processAgentMessage, generateSuggestedAgentConfig } from './agentRuntime';
import { Business, Agent, KnowledgeChunk, Product, Appointment, Order } from '../types';

export const router = Router();

// Health Check
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Current User Context (Mock Auth for platform owner vs tenant owner)
router.get('/auth/me', (req: Request, res: Response) => {
  res.json({
    user: {
      id: 'usr-admin-1',
      name: 'Platform Owner',
      email: 'owner@agentfactory.io',
      role: 'PLATFORM_OWNER'
    }
  });
});

// =========================================
// 1. BUSINESSES (MULTI-TENANT MANAGEMENT)
// =========================================

// Get all businesses (with optional search/type filters)
router.get('/businesses', (req: Request, res: Response) => {
  const { search, type, status } = req.query;
  let result = db.businesses.toJSON();

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

// Create Business
router.post('/businesses', (req: Request, res: Response) => {
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

// Get Business by ID
router.get('/businesses/:id', (req: Request, res: Response) => {
  const biz = db.businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Business not found.' });
  res.json(biz);
});

// Update Business
router.put('/businesses/:id', (req: Request, res: Response) => {
  const biz = db.businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Business not found.' });

  Object.assign(biz, req.body, { updatedAt: new Date().toISOString() });
  db.businesses.update(biz);
  res.json(biz);
});

// Duplicate Business & Agent Feature (Section 33 Prompt Mandate)
router.post('/businesses/:id/duplicate', (req: Request, res: Response) => {
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

// Get Agents (optionally filtered by businessId)
router.get('/agents', (req: Request, res: Response) => {
  const { businessId } = req.query;
  if (businessId) {
    const agents = db.agents.filter(a => a.businessId === businessId);
    return res.json(agents);
  }
  res.json(db.agents);
});

// Generate Suggested Agent Configuration (AI Assistant Wizard)
router.post('/agents/generate-config', async (req: Request, res: Response) => {
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

// Create Agent
router.post('/agents', (req: Request, res: Response) => {
  const { businessId, name, description, systemPrompt, structuredConfig, llmProvider = 'gemini', model = 'gemini-3.6-flash' } = req.body;

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

// Update Agent
router.put('/agents/:id', (req: Request, res: Response) => {
  const agent = db.agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found.' });

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
});

// Toggle Agent Deployment Status
router.post('/agents/:id/status', (req: Request, res: Response) => {
  const agent = db.agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found.' });

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
});

// =========================================
// 3. RUNTIME CHAT & SIMULATOR
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

router.get('/knowledge', (req: Request, res: Response) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required.' });

  const items = db.knowledgeChunks.filter(k => k.businessId === businessId);
  res.json(items);
});

router.post('/knowledge', (req: Request, res: Response) => {
  const { businessId, title, type = 'faq', content, tags = [] } = req.body;
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

router.delete('/knowledge/:id', (req: Request, res: Response) => {
  const idx = db.knowledgeChunks.findIndex(k => k.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Item not found.' });

  db.knowledgeChunks.splice(idx, 1);
  res.json({ success: true });
});

// =========================================
// 5. APPOINTMENTS
// =========================================

router.get('/appointments', (req: Request, res: Response) => {
  const { businessId, date, status } = req.query;
  let apps = db.appointments.toJSON();

  if (businessId) apps = apps.filter(a => a.businessId === businessId);
  if (date) apps = apps.filter(a => a.date === date);
  if (status) apps = apps.filter(a => a.status === status);

  res.json(apps);
});

router.post('/appointments', (req: Request, res: Response) => {
  const { businessId, serviceId, customerName, customerPhone, date, startTime, notes } = req.body;

  const biz = db.businesses.find(b => b.id === businessId);
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

router.put('/appointments/:id', (req: Request, res: Response) => {
  const app = db.appointments.find(a => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'Appointment not found.' });

  Object.assign(app, req.body);
  db.appointments.update(app);
  res.json(app);
});

// =========================================
// 6. PRODUCTS & ORDERS
// =========================================

router.get('/products', (req: Request, res: Response) => {
  const { businessId } = req.query;
  let items = db.products.toJSON();
  if (businessId) items = items.filter(p => p.businessId === businessId);
  res.json(items);
});

router.post('/products', (req: Request, res: Response) => {
  const { businessId, name, sku, price, inventory, description, category } = req.body;
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

router.get('/orders', (req: Request, res: Response) => {
  const { businessId } = req.query;
  let orders = db.orders.toJSON();
  if (businessId) orders = orders.filter(o => o.businessId === businessId);
  res.json(orders);
});

// =========================================
// 7. CONVERSATIONS & HUMAN HANDOFF
// =========================================

router.get('/conversations', (req: Request, res: Response) => {
  const { businessId } = req.query;
  let convs = db.conversations.toJSON();
  if (businessId) convs = convs.filter(c => c.businessId === businessId);
  res.json(convs);
});

router.get('/conversations/:id/messages', (req: Request, res: Response) => {
  const msgs = db.messages.filter(m => m.conversationId === req.params.id);
  res.json(msgs);
});

// Human Agent Takeover endpoint
router.post('/conversations/:id/takeover', (req: Request, res: Response) => {
  const conv = db.conversations.find(c => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

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
});

// Send Human Agent Message directly
router.post('/conversations/:id/message', (req: Request, res: Response) => {
  const conv = db.conversations.find(c => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

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
});

// Resolve Conversation
router.post('/conversations/:id/resolve', (req: Request, res: Response) => {
  const conv = db.conversations.find(c => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

  conv.status = 'RESOLVED';
  db.conversations.update(conv);
  res.json(conv);
});

// Helper for secure JWT_SECRET handling
function getSecureJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable must be set in production environment.');
  }
  // Safe development fallback - never printed in logs or sent to frontend
  return 'dev-platform-secret-key-do-not-use-in-production';
}

// =========================================
// 8. CHANNELS & INTEGRATIONS
// =========================================

router.get('/channels', (req: Request, res: Response) => {
  const { businessId } = req.query;
  let chans = db.channels.toJSON();
  if (businessId) chans = chans.filter(c => c.businessId === businessId);
  res.json(chans);
});

router.put('/channels/:id', (req: Request, res: Response) => {
  const chan = db.channels.find(c => c.id === req.params.id);
  if (!chan) return res.status(404).json({ error: 'Channel not found.' });

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
});

router.get('/integrations', (req: Request, res: Response) => {
  const { businessId } = req.query;
  let items = db.integrations.toJSON();
  if (businessId) items = items.filter(i => i.businessId === businessId);
  res.json(items);
});

router.put('/integrations/:id', (req: Request, res: Response) => {
  const integ = db.integrations.find(i => i.id === req.params.id);
  if (!integ) return res.status(404).json({ error: 'Integration not found.' });

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
});

// =========================================
// 9. ANALYTICS & TEMPLATES
// =========================================

router.get('/analytics/overview', (req: Request, res: Response) => {
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

router.get('/templates', (req: Request, res: Response) => {
  res.json(db.templates);
});

router.get('/audit-logs', (req: Request, res: Response) => {
  const { businessId } = req.query;
  if (businessId) {
    return res.json(db.auditLogs.filter(l => l.businessId === businessId).reverse());
  }
  res.json(db.auditLogs.slice(-50).reverse());
});
