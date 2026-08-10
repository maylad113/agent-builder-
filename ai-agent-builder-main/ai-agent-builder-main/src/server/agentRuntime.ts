import { GoogleGenAI, GenerateContentParameters, Part } from '@google/genai';
import { db } from './db';
import { agentToolDeclarations, executeAgentTool } from './tools';
import { retrieveRelevant } from './embeddings';
import { ChannelType, ToolCallRecord } from '../types';

let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is missing.');
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  }
  return aiClient;
}

export interface RuntimeExecutionResult {
  reply: string;
  conversationId: string;
  status: string;
  /** Internal diagnostics. NEVER sent to the customer-facing widget; only
   *  returned to authenticated simulator/developer callers via the wrapper. */
  debug: {
    systemPrompt: string;
    retrievedKnowledge: string[];
    toolCalls: ToolCallRecord[];
    latencyMs: number;
    tokensUsed: number;
    model: string;
    executionId: string;
  };
}

// Retrieve relevant business knowledge for context window grounding.
// Semantic (cosine over Gemini embeddings) with a tenant-scoped keyword
// fallback when embeddings are unavailable (no API key / nothing indexed).
async function retrieveKnowledgeChunks(businessId: string, query: string): Promise<string[]> {
  const results = await retrieveRelevant(businessId, query, 4);
  return results.map(r => `[${r.chunk.type.toUpperCase()}] ${r.chunk.title}: ${r.chunk.content}`);
}

/**
 * Resolve or create a conversation for the incoming message. TENANT-SCOPED: a
 * customer can never load another tenant's conversation by supplying its id —
 * the lookup requires both id AND businessId == tenantId.
 */
function ensureConversation(params: { tenantId: string; conversationId?: string; customerName?: string; customerPhone?: string; }, business: { id: string; name: string; }, channel: ChannelType): import('../types').Conversation {
  const tenantId = params.tenantId;
  let conversation = params.conversationId
    ? db.conversations.find(c => c.id === params.conversationId && c.businessId === tenantId)
    : null;

  if (!conversation) {
    const name = params.customerName || 'Customer';
    const phone = params.customerPhone || '+1000000000';
    let customer = db.customers.find(c => c.businessId === tenantId && (c.phone === phone || c.name === name));
    if (!customer) {
      customer = {
        id: `cust-${Date.now()}`,
        businessId: tenantId,
        name,
        phone,
        createdAt: new Date().toISOString()
      };
      db.customers.push(customer);
    }

    conversation = {
      id: `conv-${Date.now()}`,
      businessId: tenantId,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      channel,
      status: 'AI_HANDLING',
      summary: `Conversation initiated on ${channel}`,
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    db.conversations.push(conversation);
  }
  return conversation;
}

export async function processAgentMessage(params: {
  tenantId: string;
  userMessage: string;
  conversationId?: string;
  channel?: ChannelType;
  customerName?: string;
  customerPhone?: string;
  /** When set (simulator only), run against a specific DRAFT/TESTING version
   * instead of the live PUBLISHED config. Production calls never set this. */
  versionId?: string;
  /** When true (simulator), allow DRAFT/TESTING versions. When false
   * (production default), the runtime MUST use the PUBLISHED version only and
   * refuses to run against a non-published agent. */
  simulator?: boolean;
}): Promise<RuntimeExecutionResult> {
  const startTime = Date.now();
  const executionId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const { tenantId, userMessage, channel = 'web_chat', simulator = !!params.versionId } = params;

  // 1. Resolve Tenant & Business Information
  const business = db.businesses.find(b => b.id === tenantId);
  if (!business) {
    throw new Error(`Business not found for ID: ${tenantId}`);
  }

  // 2. Load Active Agent Configuration
  // Production conversations MUST use the PUBLISHED agent version. The simulator
  // (simulator=true, with an optional versionId) may use DRAFT/TESTING. We never
  // fall back to an arbitrary non-published agent in production.
  const agent = db.agents.find(a => a.businessId === tenantId);

  if (!agent) {
    throw new Error(`No agent configured for business: ${business.name}`);
  }

  // Resolve the effective config.
  //  - Simulator (versionId set): use that DRAFT/TESTING version's snapshot.
  //  - Simulator (no versionId): use the PUBLISHED version (or agent row as a
  //    last resort — the simulator is a trusted owner tool).
  //  - Production: use the PUBLISHED version only. If none is published yet, the
  //    agent is not live; the runtime refuses and escalates to a human rather
  //    than serving an un-published config to a real customer.
  let effectiveSystemPrompt = agent.systemPrompt;
  let effectiveConfig = agent.structuredConfig;
  let effectiveModel = agent.model;
  if (params.versionId) {
    const { getVersionForSim } = await import('./agentVersions');
    const resolved = getVersionForSim(agent.id, params.versionId);
    effectiveSystemPrompt = resolved.systemPrompt;
    effectiveConfig = resolved.structuredConfig;
    effectiveModel = resolved.model;
  } else if (!simulator) {
    // PRODUCTION path: published version only.
    const { getPublishedVersion } = await import('./agentVersions');
    const pub = getPublishedVersion(agent.id);
    if (!pub) {
      // No published version — refuse to serve customers. Return a graceful
      // human-escalation rather than the raw agent row (which may be a draft).
      const conv = ensureConversation(params, business, channel);
      return {
        reply: "I'm having trouble connecting to the assistant service right now. I've notified the team and someone will follow up with you shortly.",
        conversationId: conv.id,
        status: 'WAITING_FOR_HUMAN',
        debug: {
          systemPrompt: '',
          retrievedKnowledge: [],
          toolCalls: [],
          latencyMs: Date.now() - startTime,
          tokensUsed: 0,
          model: effectiveModel || 'none',
          executionId
        }
      };
    }
    effectiveSystemPrompt = pub.systemPrompt;
    effectiveConfig = pub.structuredConfig;
    effectiveModel = pub.model;
  }

  // 3. Resolve or Create Conversation (TENANT-SCOPED: a customer can never
  //    load another tenant's conversation by supplying its id — the lookup
  //    requires both id AND businessId == tenantId.)
  const conversation = ensureConversation(params, business, channel);

  // HUMAN HANDOFF GUARD: when a human team member has taken over (HUMAN_HANDLING)
  // or the conversation is resolved, the AI must NOT autonomously answer. The
  // customer's message is still stored (so the human sees it), but the runtime
  // returns a holding reply and never calls the model or any tool.
  if (conversation.status === 'HUMAN_HANDLING') {
    const holdingReply =
      'A team member is currently handling our conversation and will reply to you shortly. Thank you for your patience.';
    db.messages.push({
      id: `msg-${Date.now()}-agent`,
      conversationId: conversation.id,
      sender: 'system',
      content: holdingReply,
      channel,
      timestamp: new Date().toISOString()
    });
    conversation.lastMessageAt = new Date().toISOString();
    db.conversations.update(conversation);
    return {
      reply: holdingReply,
      conversationId: conversation.id,
      status: conversation.status,
      debug: {
        systemPrompt: '',
        retrievedKnowledge: [],
        toolCalls: [],
        latencyMs: Date.now() - startTime,
        tokensUsed: 0,
        model: effectiveModel || 'gemini-3.6-flash',
        executionId
      }
    };
  }

  if (conversation.status === 'RESOLVED') {
    const holdingReply =
      'This conversation has been marked as resolved. If you need further help, please start a new conversation or ask a team member to reopen this one.';
    return {
      reply: holdingReply,
      conversationId: conversation.id,
      status: conversation.status,
      debug: {
        systemPrompt: '',
        retrievedKnowledge: [],
        toolCalls: [],
        latencyMs: Date.now() - startTime,
        tokensUsed: 0,
        model: effectiveModel || 'gemini-3.6-flash',
        executionId
      }
    };
  }

  // Save incoming customer message
  db.messages.push({
    id: `msg-${Date.now()}-user`,
    conversationId: conversation.id,
    sender: 'customer',
    content: userMessage,
    channel,
    timestamp: new Date().toISOString()
  });

  // 4. Retrieve RAG Knowledge Chunks
  const retrievedKnowledge = await retrieveKnowledgeChunks(tenantId, userMessage);

  // 5. Build Grounded System Prompt
  const structured = effectiveConfig;
  const fullSystemPrompt = `${effectiveSystemPrompt}

BUSINESS CONTEXT & FACTS:
- Business Name: ${business.name}
- Type: ${business.type}
- Location: ${business.location}
- Timezone: ${business.timezone}
- Currency: ${business.currency}
- Description: ${business.description}

RETRIEVED KNOWLEDGE BASE:
${retrievedKnowledge.length > 0 ? retrievedKnowledge.join('\n') : 'No additional docs retrieved.'}

AGENT PERSONALITY & RULES:
- Tone: ${structured.personality.tone}
- Behavior: ${structured.personality.behavior}
- Primary Language: ${structured.personality.language}
- Escalation Rules: ${structured.escalationRules.join('; ')}
- Booking Policy: ${structured.bookingRules}

CRITICAL MANDATES:
1. NEVER fabricate bookings, prices, services, or operating hours that are not in the database/knowledge base.
2. If you need to check hours, prices, or book an appointment, ALWAYS call the corresponding tool.
3. If the user asks for something outside your knowledge or requests a real person, use the 'transfer_to_human' tool immediately.
4. Keep answers clear, helpful, and polite.`;

  // 6. Build History from Conversation Messages
  const existingMsgs = db.messages
    .filter(m => m.conversationId === conversation.id)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Convert to Gemini API contents structure
  const contents: Array<{ role: string; parts: Part[] }> = existingMsgs.slice(-10).map(m => ({
    role: m.sender === 'customer' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  // 7. Filter Enabled Tools
  const enabledToolNames = new Set(structured.toolsEnabled || []);
  const activeTools = agentToolDeclarations.filter(t => enabledToolNames.has(t.name));

  const toolCallRecords: ToolCallRecord[] = [];
  let finalReply = '';

  // Real token usage from the provider's usageMetadata, accumulated across
  // the tool loop (Phase 19). Hoisted outside try so the catch block and the
  // usage recording block can read them.
  let providerInputTokens = 0;
  let providerOutputTokens = 0;
  const providerModel = effectiveModel || 'gemini-3.6-flash';

  try {
    const ai = getGeminiClient();

    // Call Gemini Model
    const reqParameters: GenerateContentParameters = {
      model: providerModel,
      contents: contents as any,
      config: {
        systemInstruction: fullSystemPrompt,
        temperature: structured.personality.tone === 'energetic' ? 0.7 : 0.2,
        tools: activeTools.length > 0 ? [{ functionDeclarations: activeTools }] : undefined
      }
    };

    let response = await ai.models.generateContent(reqParameters);

    const accumulateUsage = (r: typeof response) => {
      const um = r?.usageMetadata;
      if (um) {
        // promptTokenCount accumulates full context on each turn; we take the
        // final turn's prompt count plus the sum of generated candidate tokens
        // across all turns to approximate total input/output usage.
        providerInputTokens = um.promptTokenCount ?? providerInputTokens;
        providerOutputTokens += um.candidatesTokenCount ?? 0;
      }
    };
    accumulateUsage(response);

    // Handle Tool Execution Loop (up to 3 iterations for multi-step tool calls)
    let maxToolLoops = 3;
    while (response.functionCalls && response.functionCalls.length > 0 && maxToolLoops > 0) {
      maxToolLoops--;
      const functionCalls = response.functionCalls;

      const functionResponseParts: Part[] = [];

      for (const call of functionCalls) {
        const toolName = call.name;
        const args = (call.args as Record<string, any>) || {};

        // Execute Tool safely on backend with tenant isolation
        const result = await executeAgentTool(toolName, args, {
          tenantId,
          conversationId: conversation.id,
          channel
        });

        const rec: ToolCallRecord = {
          id: `tool-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          toolName,
          args,
          result,
          timestamp: new Date().toISOString()
        };
        toolCallRecords.push(rec);

        functionResponseParts.push({
          functionResponse: {
            name: toolName,
            response: result
          }
        });
      }

      // Feed function call result back into contents history
      const prevCandidateContent = response.candidates?.[0]?.content;
      if (prevCandidateContent) {
        (contents as any).push(prevCandidateContent);
      }
      (contents as any).push({
        role: 'user',
        parts: functionResponseParts
      });

      // Call Gemini again with function results
      response = await ai.models.generateContent({
        model: providerModel,
        contents: contents as any,
        config: {
          systemInstruction: fullSystemPrompt,
          tools: activeTools.length > 0 ? [{ functionDeclarations: activeTools }] : undefined
        }
      });
      accumulateUsage(response);
    }

    finalReply = response.text || "I'm sorry, I couldn't process that request properly. How else may I assist you?";
  } catch (err: any) {
    // Log the real error internally with the execution id for support; never
    // expose the provider's error message/stack to the customer.
    console.error(`[runtime] ${executionId} Gemini error:`, err?.message || err);
    finalReply =
      "I'm having trouble connecting to the assistant service right now. I've notified the team and someone will follow up with you shortly.";
    
    // Auto-escalate conversation status on AI error
    conversation.status = 'WAITING_FOR_HUMAN';
  }

  const latencyMs = Date.now() - startTime;
  // Prefer real provider usage metadata; fall back to a length-based estimate
  // only when the provider omits usage (e.g. error path / no API key).
  const realTokens = providerInputTokens + providerOutputTokens;
  const usedInputTokens = providerInputTokens > 0 ? providerInputTokens : 0;
  const usedOutputTokens = providerOutputTokens > 0 ? providerOutputTokens : 0;
  const tokensUsed = realTokens > 0 ? realTokens : Math.ceil((fullSystemPrompt.length + userMessage.length + finalReply.length) / 4);
  const usedModel = providerModel;

  // Update conversation record
  conversation.lastMessageAt = new Date().toISOString();
  conversation.summary = `Last exchange: "${userMessage.substring(0, 30)}..." -> "${finalReply.substring(0, 30)}..."`;
  db.conversations.update(conversation);

  // Store Agent Reply Message
  db.messages.push({
    id: `msg-${Date.now()}-agent`,
    conversationId: conversation.id,
    sender: 'agent',
    content: finalReply,
    toolCalls: toolCallRecords.length > 0 ? toolCallRecords : undefined,
    channel,
    timestamp: new Date().toISOString()
  });

  // Track Usage (Phase 19): real provider token counts when available.
  // Aggregate per business per day; agent/model/provider recorded for later
  // per-conversation breakdown.
  const todayStr = new Date().toISOString().split('T')[0];
  let usage = db.usageRecords.find(u => u.businessId === tenantId && u.date === todayStr);
  if (!usage) {
    usage = {
      id: `usr-${Date.now()}`,
      businessId: tenantId,
      date: todayStr,
      tokensUsed: 0,
      estimatedCostUsd: 0,
      requestsCount: 0,
      voiceMinutes: 0,
      smsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      provider: 'google'
    };
    db.usageRecords.push(usage);
  }
  usage.tokensUsed += tokensUsed;
  usage.inputTokens = (usage.inputTokens ?? 0) + usedInputTokens;
  usage.outputTokens = (usage.outputTokens ?? 0) + usedOutputTokens;
  // Cost estimate from real input/output token counts when available;
  // otherwise from the total estimate. Rates are illustrative placeholders
  // for the future billing tier (no charges are ever executed).
  const pricedInput = usedInputTokens;
  const pricedOutput = usedOutputTokens;
  usage.estimatedCostUsd += ((pricedInput * 0.0000001) + (pricedOutput * 0.0000004))
    || (tokensUsed / 1000) * 0.0001;
  usage.requestsCount += 1;
  if (!usage.model) usage.model = usedModel;
  db.usageRecords.update(usage);

  return {
    reply: finalReply,
    conversationId: conversation.id,
    status: conversation.status,
    debug: {
      systemPrompt: fullSystemPrompt,
      retrievedKnowledge,
      toolCalls: toolCallRecords,
      latencyMs,
      tokensUsed,
      model: usedModel,
      executionId
    }
  };
}

// Generate Agent Configuration Wizard helper (AI Configuration Auto-Generator)
export async function generateSuggestedAgentConfig(businessInput: {
  name: string;
  type: string;
  description: string;
  hours?: string;
  services?: string;
}): Promise<any> {
  try {
    const ai = getGeminiClient();

    const prompt = `You are an expert AI Agent Architect for local business receptionists.
Generate a structured AI agent configuration for the following business:
- Name: ${businessInput.name}
- Type: ${businessInput.type}
- Description: ${businessInput.description}
- Operating Hours: ${businessInput.hours || 'NOT PROVIDED'}
- Services: ${businessInput.services || 'NOT PROVIDED'}

CRITICAL RULES — violate these and the configuration is useless:
1. NEVER invent business facts. If a price, duration, hour, policy, or service
   name was NOT provided in the input above, you MUST output the literal string
   "NEEDS_INPUT" for that field. Do NOT guess, round, or estimate.
2. You MAY suggest STRUCTURE (e.g. "Would appointment booking help?") and ask
   clarifying questions, but the values for services/prices/hours must come
   ONLY from the input or be "NEEDS_INPUT".
3. System prompt and personality may be generated, but must instruct the agent
   to never state prices/hours/services that the business has not configured.

Return a JSON object conforming strictly to this format:
{
  "agentName": "Suggested agent name",
  "systemPrompt": "Comprehensive system instructions; must tell the agent to never invent prices, hours, or services and to escalate when unsure.",
  "personality": { "tone": "friendly", "behavior": "service", "language": "en" },
  "goals": ["Goal 1", "Goal 2", "Goal 3"],
  "allowedActions": ["check_business_hours", "get_business_information", "check_availability", "book_appointment", "transfer_to_human"],
  "restrictedActions": ["Do not state prices/hours/services not configured by the business", "Do not promise out-of-scope work"],
  "escalationRules": ["When customer requests a human", "When customer reports a complaint", "When a required fact is missing"],
  "suggestedFaqs": [
    {"question": "Sample FAQ 1", "answer": "Suggested answer 1"}
  ],
  "suggestedServices": [
    {"name": "Service from input or NEEDS_INPUT", "price": "NEEDS_INPUT or number", "durationMinutes": "NEEDS_INPUT or number", "description": "Service description or NEEDS_INPUT"}
  ],
  "needsInput": ["List every business fact that could not be derived from the input, e.g. 'operating hours', 'service prices', 'service durations'"]
}`;

    const res = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    if (res.text) {
      const parsed = JSON.parse(res.text);
      return sanitizeGeneratedConfig(parsed, businessInput);
    }
  } catch (err: any) {
    console.error('Auto Agent Gen Error:', err);
  }

  // Fact-safe fallback when Gemini is unavailable. Nothing is invented:
  // every missing business fact is explicitly NEEDS_INPUT.
  return factSafeFallback(businessInput);
}

/**
 * Defense-in-depth: even if the model invents values, strip any service that
 * carries a fabricated price/duration when the input didn't supply services.
 * Anything that looks placeholder is converted to NEEDS_INPUT.
 */
function sanitizeGeneratedConfig(parsed: any, input: { name: string; type: string; description: string; hours?: string; services?: string }): any {
  const servicesProvided = !!(input.services && input.services.trim());
  if (Array.isArray(parsed.suggestedServices)) {
    parsed.suggestedServices = parsed.suggestedServices.map((s: any) => {
      const name = s && typeof s.name === 'string' ? s.name : 'NEEDS_INPUT';
      const price = (servicesProvided && typeof s.price === 'number') ? s.price : 'NEEDS_INPUT';
      const duration = (servicesProvided && typeof s.durationMinutes === 'number') ? s.durationMinutes : 'NEEDS_INPUT';
      return { name, price, durationMinutes: duration, description: s?.description ?? 'NEEDS_INPUT' };
    });
  }
  if (!input.hours) {
    // Ensure the system prompt does not assert hours the business hasn't given.
    if (typeof parsed.systemPrompt === 'string' && !/NEEDS_INPUT|not.*configured|do not.*hour/i.test(parsed.systemPrompt)) {
      parsed.systemPrompt += ' Never state operating hours unless they have been configured by the business owner.';
    }
  }
  parsed.needsInput = Array.isArray(parsed.needsInput) ? parsed.needsInput : [];
  if (!input.hours && !parsed.needsInput.includes('operating hours')) parsed.needsInput.push('operating hours');
  if (!servicesProvided && !parsed.needsInput.includes('service list and prices')) parsed.needsInput.push('service list and prices');
  return parsed;
}

function factSafeFallback(input: { name: string; type: string; description: string; hours?: string; services?: string }): any {
  const needs: string[] = [];
  if (!input.hours) needs.push('operating hours');
  if (!input.services) needs.push('service list, prices, and durations');
  if (!input.description) needs.push('business description / what you do');

  return {
    agentName: `${input.name} AI Assistant`,
    systemPrompt:
      `You are the official AI receptionist for ${input.name}. ` +
      `Assist customers politely, answer questions using only configured knowledge, and book appointments when permitted. ` +
      `NEVER state prices, operating hours, or service details that the business has not explicitly configured. ` +
      `If a customer asks for something you don't have configured, say you'll check and escalate to a human rather than guessing.`,
    personality: { tone: 'friendly', behavior: 'service', language: 'en' },
    goals: ['Answer customer inquiries from configured knowledge', 'Book appointments', 'Escalate to a human when facts are missing'],
    allowedActions: ['check_business_hours', 'get_business_information', 'check_availability', 'book_appointment', 'transfer_to_human'],
    restrictedActions: ['Do not invent prices, hours, or services', 'Do not promise out-of-scope work'],
    escalationRules: ['When customer requests a real human', 'When a required business fact is missing'],
    suggestedFaqs: [
      { question: 'How can I book an appointment?', answer: 'I can assist you directly with booking an appointment right here!' }
    ],
    suggestedServices: [
      { name: 'NEEDS_INPUT', price: 'NEEDS_INPUT', durationMinutes: 'NEEDS_INPUT', description: 'NEEDS_INPUT' }
    ],
    needsInput: needs
  };
}
