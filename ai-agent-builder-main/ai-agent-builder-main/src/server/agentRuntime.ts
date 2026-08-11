import { GoogleGenAI, GenerateContentParameters, Part } from '@google/genai';
import { db } from './db';
import { agentToolDeclarations, executeAgentTool } from './tools';
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

export interface RuntimeDebugInfo {
  systemPrompt: string;
  retrievedKnowledge: string[];
  toolCalls: ToolCallRecord[];
  latencyMs: number;
  tokensUsed: number;
  model: string;
  /** Present when the LLM call itself failed (internal callers only). */
  error?: string;
}

export interface RuntimeExecutionResult {
  reply: string;
  conversationId: string;
  status: string;
  /** false when the business has no ACTIVE agent — the widget must treat it as an error, never a fake answer. */
  agentAvailable: boolean;
  /**
   * Internal debug (system prompt, retrieved knowledge, raw tool results).
   * ALWAYS null for public/unauthenticated callers — the public widget must
   * never receive system prompts or raw knowledge dumps. Only an
   * authenticated session scoped to the tenant (e.g. the in-dashboard
   * simulator) receives this.
   */
  debug: RuntimeDebugInfo | null;
}

// Honest "assistant unavailable" message returned when the business has no
// ACTIVE agent. Deliberately does NOT claim a human will follow up.
export const AGENT_UNAVAILABLE_REPLY =
  "This business's assistant is not available right now. Please try again later.";

// Retrieve relevant business knowledge for context window grounding
function retrieveKnowledgeChunks(businessId: string, query: string): string[] {
  const chunks = db.knowledgeChunks.filter(k => k.businessId === businessId);
  const qLower = query.toLowerCase();

  const matched = chunks.filter(c => {
    const titleMatch = c.title.toLowerCase().includes(qLower);
    const tagMatch = c.tags.some(t => qLower.includes(t.toLowerCase()));
    const contentMatch = c.content.toLowerCase().split(' ').some(word => word.length > 3 && qLower.includes(word));
    return titleMatch || tagMatch || contentMatch;
  });

  // If no specific match, return top 3 chunks as general business context
  const selected = matched.length > 0 ? matched : chunks.slice(0, 3);
  return selected.map(s => `[${s.type.toUpperCase()}] ${s.title}: ${s.content}`);
}

export async function processAgentMessage(params: {
  tenantId: string;
  userMessage: string;
  conversationId?: string;
  channel?: ChannelType;
  customerName?: string;
  customerPhone?: string;
  /**
   * Internal (simulator) use: run a SPECIFIC agent regardless of status.
   * Routes must verify the caller is authenticated AND scoped to the agent's
   * tenant before passing this — the runtime trusts no one.
   */
  agentId?: string;
  /** Include internal debug (system prompt / knowledge / tool results) in the result. */
  includeDebug?: boolean;
}): Promise<RuntimeExecutionResult> {
  const startTime = Date.now();
  const { tenantId, userMessage, channel = 'web_chat' } = params;

  // 1. Resolve Tenant & Business Information
  const business = db.businesses.find(b => b.id === tenantId);
  if (!business) {
    throw new Error(`Business not found for ID: ${tenantId}`);
  }

  // 2. Resolve or Create Conversation (before agent selection so the
  //    "assistant unavailable" path can still record the exchange honestly)
  let conversation = params.conversationId
    ? db.conversations.find(c => c.id === params.conversationId)
    : null;

  if (!conversation) {
    const name = params.customerName || 'Customer';
    const phone = params.customerPhone || '+1000000000';
    let customer = db.customers.find(c => c.businessId === tenantId && (c.phone === phone || c.name === name));
    if (!customer) {
      customer = {
        id: `cust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        businessId: tenantId,
        name,
        phone,
        createdAt: new Date().toISOString()
      };
      db.customers.push(customer);
    }

    conversation = {
      id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  // Save incoming customer message
  db.messages.push({
    id: `msg-${Date.now()}-user`,
    conversationId: conversation.id,
    sender: 'customer',
    content: userMessage,
    channel,
    timestamp: new Date().toISOString()
  });

  // 3. Load Agent — PUBLIC path: ONLY an ACTIVE agent may serve customers.
  //    No fallback to any agent: a DRAFT/READY/TESTING/PAUSED agent must
  //    never answer the public widget. The simulator passes `agentId` to run
  //    a specific (possibly not-yet-ACTIVE) agent after route-level checks.
  const agent = params.agentId
    ? db.agents.find(a => a.id === params.agentId && a.businessId === tenantId)
    : db.agents.find(a => a.businessId === tenantId && a.status === 'ACTIVE');

  if (!agent) {
    if (params.agentId) {
      throw new Error(`Agent not found for business: ${tenantId}`);
    }
    // Honest unavailable result — never a fake answer. 200 + agentAvailable:false
    // so the widget can render it as an error state.
    conversation.lastMessageAt = new Date().toISOString();
    conversation.summary = `Last exchange: "${userMessage.substring(0, 30)}..." -> assistant unavailable`;
    db.conversations.update(conversation);

    db.messages.push({
      id: `msg-${Date.now()}-agent`,
      conversationId: conversation.id,
      sender: 'agent',
      content: AGENT_UNAVAILABLE_REPLY,
      channel,
      timestamp: new Date().toISOString()
    });

    return {
      reply: AGENT_UNAVAILABLE_REPLY,
      conversationId: conversation.id,
      status: conversation.status,
      agentAvailable: false,
      debug: null
    };
  }

  // 4. Retrieve RAG Knowledge Chunks
  const retrievedKnowledge = retrieveKnowledgeChunks(tenantId, userMessage);

  // 5. Build Grounded System Prompt
  const structured = agent.structuredConfig;
  const fullSystemPrompt = `${agent.systemPrompt}

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
4. Keep answers clear, helpful, and polite.
5. HONEST FAILURE: If a tool reports failure (success: false), tell the customer the truth — e.g. "I could not complete the booking because the time is already taken" — and NEVER claim the action succeeded or was confirmed.
6. Never claim a booking, order, or transfer happened unless the backend tool response confirmed it (success: true).`;

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
  let runtimeError: string | undefined;

  try {
    const ai = getGeminiClient();

    // Call Gemini Model
    const reqParameters: GenerateContentParameters = {
      model: agent.model || 'gemini-3.6-flash',
      contents: contents as any,
      config: {
        systemInstruction: fullSystemPrompt,
        temperature: structured.personality.tone === 'energetic' ? 0.7 : 0.2,
        tools: activeTools.length > 0 ? [{ functionDeclarations: activeTools }] : undefined
      }
    };

    let response = await ai.models.generateContent(reqParameters);

    // Handle Tool Execution Loop (up to 3 iterations for multi-step tool calls)
    let maxToolLoops = 3;
    while (response.functionCalls && response.functionCalls.length > 0 && maxToolLoops > 0) {
      maxToolLoops--;
      const functionCalls = response.functionCalls;

      const functionResponseParts: Part[] = [];

      for (const call of functionCalls) {
        const toolName = call.name;
        const args = (call.args as Record<string, any>) || {};

        // Execute Tool safely on backend with tenant isolation + hard
        // enablement enforcement (toolsEnabled is passed so executeAgentTool
        // refuses tools the agent does not have enabled).
        const result = await executeAgentTool(toolName, args, {
          tenantId,
          conversationId: conversation.id,
          channel,
          toolsEnabled: structured.toolsEnabled
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
        model: agent.model || 'gemini-3.6-flash',
        contents: contents as any,
        config: {
          systemInstruction: fullSystemPrompt,
          tools: activeTools.length > 0 ? [{ functionDeclarations: activeTools }] : undefined
        }
      });
    }

    finalReply = response.text || "I'm sorry, I couldn't process that request properly. How else may I assist you?";
  } catch (err: any) {
    console.error('Gemini Agent Runtime Error:', err);
    runtimeError = err?.message || 'AI Provider Error';
    // Honest fallback: report the outage, never claim any action succeeded.
    // Internal error details stay server-side (and in debug for internal callers).
    finalReply = "I'm sorry, I'm having trouble connecting to the assistant service right now. Please try again in a moment.";
    conversation.status = 'WAITING_FOR_HUMAN';
  }

  const latencyMs = Date.now() - startTime;
  const tokensEstimate = Math.ceil((fullSystemPrompt.length + userMessage.length + finalReply.length) / 4);

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

  // Track Usage
  const todayStr = new Date().toISOString().split('T')[0];
  let usage = db.usageRecords.find(u => u.businessId === tenantId && u.date === todayStr);
  if (!usage) {
    usage = {
      id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      businessId: tenantId,
      date: todayStr,
      tokensUsed: 0,
      estimatedCostUsd: 0,
      requestsCount: 0,
      voiceMinutes: 0,
      smsCount: 0
    };
    db.usageRecords.push(usage);
  }
  usage.tokensUsed += tokensEstimate;
  usage.estimatedCostUsd += (tokensEstimate / 1000) * 0.0001; // $0.0001 per 1k tokens estimate
  usage.requestsCount += 1;
  db.usageRecords.update(usage);

  const debug: RuntimeDebugInfo | null = params.includeDebug
    ? {
        systemPrompt: fullSystemPrompt,
        retrievedKnowledge,
        toolCalls: toolCallRecords,
        latencyMs,
        tokensUsed: tokensEstimate,
        model: agent.model || 'gemini-3.6-flash',
        ...(runtimeError ? { error: runtimeError } : {})
      }
    : null;

  return {
    reply: finalReply,
    conversationId: conversation.id,
    status: conversation.status,
    agentAvailable: true,
    debug
  };
}

// Generate Agent Configuration Wizard helper (AI Configuration Auto-Generator)
//
// The generator is a PROPOSAL factory — it never auto-activates anything and
// it NEVER invents business facts. The LLM receives only the business input
// the owner actually provided; anything missing is reported as a NEEDS_INPUT
// entry, never as a fabricated value. The fallback path (no API key, or a
// model error) follows the same rule.
export async function generateSuggestedAgentConfig(businessInput: {
  name: string;
  type: string;
  description: string;
  hours?: string;
  services?: string;
  faqs?: string;
}): Promise<any> {
  // Anything not provided by the owner is a NEEDS_INPUT entry, not a guess.
  const needsInput: Array<{ field: string; label: string }> = [];
  if (!businessInput.hours || !businessInput.hours.trim()) {
    needsInput.push({ field: 'hours', label: 'Operating hours (open/close times per day)' });
  }
  if (!businessInput.services || !businessInput.services.trim()) {
    needsInput.push({ field: 'services', label: 'Service list with exact prices and durations' });
  }
  if (!businessInput.description || !businessInput.description.trim()) {
    needsInput.push({ field: 'description', label: 'Business description' });
  }

  try {
    const ai = getGeminiClient();

    const prompt = `You are an expert AI Agent Architect designing the configuration for a new AI receptionist agent.

You receive ONLY the business facts the owner provided. You must NEVER invent facts.

BUSINESS FACTS PROVIDED:
- Name: ${businessInput.name}
- Type: ${businessInput.type}
- Description: ${businessInput.description || 'NOT PROVIDED'}
- Operating hours: ${businessInput.hours || 'NOT PROVIDED'}
- Services: ${businessInput.services || 'NOT PROVIDED'}
- FAQs: ${businessInput.faqs || 'NOT PROVIDED'}

CRITICAL RULES:
1. NEVER invent prices, operating hours, addresses, policies, services, or any business fact. If a fact was not provided, do NOT fabricate it.
2. For every business fact that is missing (e.g. exact prices, operating hours, policies, address), add an entry to the "needsInput" array with a short "field" name and a human-readable "label".
3. Only fill suggestedServices / suggestedFaqs with information the owner actually provided. If not provided, leave them empty arrays.
4. You MAY propose: agent name, personality (tone/behavior/language), goals, allowedActions (tool names), restrictedActions, escalationRules, and a systemPrompt written in generic, safe language.
5. The systemPrompt must instruct the agent to never invent facts, to use tools for hours/prices/availability, and to tell the customer the truth when a tool reports failure (never claim a booking or action succeeded unless the backend confirmed it).

Return ONLY a JSON object (no markdown, no prose, no code fences) with exactly this shape:
{
  "agentName": "Suggested agent name",
  "systemPrompt": "Comprehensive but fact-safe system instructions",
  "personality": { "tone": "friendly", "behavior": "service", "language": "en" },
  "goals": ["Goal 1", "Goal 2", "Goal 3"],
  "allowedActions": ["check_business_hours", "get_business_information", "check_availability", "book_appointment", "search_knowledge", "transfer_to_human"],
  "restrictedActions": ["Never invent prices, hours, addresses, or policies"],
  "escalationRules": ["When customer requests a human", "When asked for facts not provided"],
  "suggestedFaqs": [],
  "suggestedServices": [],
  "needsInput": [{ "field": "prices", "label": "Exact prices for each service" }]
}`;

    const res = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    if (res.text) {
      const parsed = parseJsonFromModel(res.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Merge: computed NEEDS_INPUT (from what the route received) wins if
        // the model did not report its own, otherwise keep the model's.
        const modelNeedsInput = Array.isArray(parsed.needsInput) ? parsed.needsInput : [];
        return {
          ...parsed,
          needsInput: modelNeedsInput.length > 0 ? modelNeedsInput : needsInput
        };
      }
      throw new Error('Model did not return a JSON object');
    }
  } catch (err: any) {
    console.error('Auto Agent Gen Error:', err);
  }

  // Honest fallback (no key / model error / invalid JSON): reflects ONLY the
  // input the owner provided — no invented prices, hours, services or FAQs.
  const factLines: string[] = [];
  if (businessInput.description && businessInput.description.trim()) {
    factLines.push(`- Business description: ${businessInput.description.trim()}`);
  }
  if (businessInput.hours && businessInput.hours.trim()) {
    factLines.push(`- Operating hours (as provided by the owner): ${businessInput.hours.trim()}`);
  }
  if (businessInput.services && businessInput.services.trim()) {
    factLines.push(`- Services (as provided by the owner): ${businessInput.services.trim()}`);
  }
  if (businessInput.faqs && businessInput.faqs.trim()) {
    factLines.push(`- FAQs (as provided by the owner): ${businessInput.faqs.trim()}`);
  }

  const factsBlock = factLines.length > 0
    ? `\nBUSINESS FACTS (provided by the owner — never extend these):\n${factLines.join('\n')}`
    : '\nBUSINESS FACTS: none provided yet. If a fact is missing, say you do not know rather than guessing.';

  return {
    agentName: `${businessInput.name} AI Assistant`,
    systemPrompt: `You are the AI receptionist for ${businessInput.name} (${businessInput.type}). Answer customer questions politely and helpfully.${factsBlock}

CRITICAL MANDATES:
1. NEVER invent business facts. Do not state prices, operating hours, addresses, policies, or services that are not in the BUSINESS FACTS above or retrievable via your tools.
2. If you do not know a fact, say so honestly and offer to connect the customer with a human team member.
3. Use your tools to check hours, prices, availability, and to book appointments.
4. HONEST FAILURE: If a tool reports failure, tell the customer the truth (e.g. "I could not complete the booking because ...") and NEVER claim the action succeeded.
5. Transfer to a human when asked, or when you are unsure.`,
    personality: { tone: 'friendly', behavior: 'service', language: 'en' },
    goals: ['Answer customer questions honestly', 'Book appointments', 'Explain services'],
    allowedActions: [
      'check_business_hours',
      'get_business_information',
      'check_availability',
      'book_appointment',
      'search_knowledge',
      'transfer_to_human'
    ],
    restrictedActions: [
      'Never invent prices, hours, addresses, or policies',
      'Never claim a booking or action succeeded unless a tool confirmed it'
    ],
    escalationRules: [
      'Customer requests a real human agent',
      'Customer asks for a business fact that was not provided'
    ],
    suggestedFaqs: [],
    suggestedServices: [],
    needsInput
  };
}

/**
 * Parse model output as JSON, tolerating markdown code fences (```json ... ```)
 * and stray prose around the JSON object. Throws when no valid JSON is found.
 */
function parseJsonFromModel(text: string): any {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new Error('Model did not return valid JSON.');
  }
}
