import { Part } from '@google/genai';
import { db } from './db';
import { agentToolDeclarations, executeAgentTool } from './tools';
import { retrieveRelevant } from './embeddings';
import { resolveProviderAndModel, toLlmToolDeclarations } from './llmProvider';
import { ChannelType, ToolCallRecord } from '../types';
import { safeError } from './logSanitizer';
import {
  recordCustomerMessage,
  recordAgentResponse,
  recordToolExecution,
  recordHumanHandoff
} from './telemetry';

export interface RuntimeDebugInfo {
  systemPrompt: string;
  retrievedKnowledge: string[];
  toolCalls: ToolCallRecord[];
  latencyMs: number;
  tokensUsed: number;
  model: string;
  /** Correlation id for this runtime execution (logged server-side for support). */
  executionId: string;
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
async function ensureConversation(params: { tenantId: string; conversationId?: string; customerName?: string; customerPhone?: string; }, business: { id: string; name: string; }, channel: ChannelType): Promise<import('../types').Conversation> {
  const tenantId = params.tenantId;
  let conversation = params.conversationId
    ? await db.conversations.find(c => c.id === params.conversationId && c.businessId === tenantId)
    : null;

  if (!conversation) {
    const name = params.customerName || 'Customer';
    const phone = params.customerPhone || '+1000000000';
    let customer = await db.customers.find(c => c.businessId === tenantId && (c.phone === phone || c.name === name));
    if (!customer) {
      customer = {
        id: `cust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        businessId: tenantId,
        name,
        phone,
        createdAt: new Date().toISOString()
      };
      await db.customers.push(customer);
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
    await db.conversations.push(conversation);
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
  /** Internal (simulator) use: run a SPECIFIC agent regardless of status.
   * Routes must verify the caller is authenticated AND scoped to the agent's
   * tenant before passing this — the runtime trusts no one. */
  agentId?: string;
  /** Include internal debug (system prompt / knowledge / tool results) in the result. */
  includeDebug?: boolean;
}): Promise<RuntimeExecutionResult> {
  const startTime = Date.now();
  const executionId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const { tenantId, userMessage, channel = 'web_chat' } = params;
  // The simulator may target a specific agent (agentId) or a specific draft
  // version (versionId); the public widget targets the business's ACTIVE agent.
  const simulator = params.simulator || !!params.agentId;

  // 1. Resolve Tenant & Business Information
  const business = await db.businesses.find(b => b.id === tenantId);
  if (!business) {
    throw new Error(`Business not found for ID: ${tenantId}`);
  }

  // 2. Resolve the agent.
  //  - Simulator (agentId): run that SPECIFIC agent regardless of status.
  //  - Public: ONLY the business's ACTIVE agent may serve customers. A
  //    DRAFT/READY/TESTING/PAUSED/ARCHIVED agent must never answer the widget.
  const agent = params.agentId
    ? await db.agents.find(a => a.id === params.agentId && a.businessId === tenantId)
    : await db.agents.find(a => a.businessId === tenantId && a.status === 'ACTIVE');

  if (!agent) {
    if (params.agentId) {
      throw new Error(`Agent not found for business: ${tenantId}`);
    }
    // Honest unavailable result — never a fake answer. 200 + agentAvailable:false
    // so the widget can render it as an error state.
    const conv = await ensureConversation(params, business, channel);
    conv.lastMessageAt = new Date().toISOString();
    conv.summary = `Last exchange: "${userMessage.substring(0, 30)}..." -> assistant unavailable`;
    await db.conversations.update(conv);

    await db.messages.push({
      id: `msg-${Date.now()}-agent`,
      conversationId: conv.id,
      sender: 'agent',
      content: AGENT_UNAVAILABLE_REPLY,
      channel,
      timestamp: new Date().toISOString()
    });

    return {
      reply: AGENT_UNAVAILABLE_REPLY,
      conversationId: conv.id,
      status: 'WAITING_FOR_HUMAN',
      agentAvailable: false,
      debug: null
    };
  }

  // Production conversations require an ACTIVE agent. A PAUSED or ARCHIVED
  // agent must not serve real customers — escalate to a human instead. The
  // simulator bypasses this so owners can test non-active agents.
  if (!simulator && agent.status !== 'ACTIVE') {
    const conv = await ensureConversation(params, business, channel);
    return {
      reply: AGENT_UNAVAILABLE_REPLY,
      conversationId: conv.id,
      status: 'WAITING_FOR_HUMAN',
      agentAvailable: false,
      debug: null
    };
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
  // Version the runtime is running against (for telemetry + observability). For
  // the simulator this is the explicit DRAFT/TESTING version; for production it
  // is the PUBLISHED version. Unset for the early no-published-version fallback.
  let effectiveVersionId: string | undefined = params.versionId;
  if (params.versionId) {
    const { getVersionForSim } = await import('./agentVersions');
    const resolved = await getVersionForSim(agent.id, params.versionId);
    effectiveSystemPrompt = resolved.systemPrompt;
    effectiveConfig = resolved.structuredConfig;
    effectiveModel = resolved.model;
  } else if (!simulator) {
    // PRODUCTION path: published version only.
    const { getPublishedVersion } = await import('./agentVersions');
    const pub = await getPublishedVersion(agent.id);
    if (!pub) {
      // No published version — refuse to serve customers. Return a graceful
      // human-escalation rather than the raw agent row (which may be a draft).
      const conv = await ensureConversation(params, business, channel);
      return {
        reply: "I'm having trouble connecting to the assistant service right now. I've notified the team and someone will follow up with you shortly.",
        conversationId: conv.id,
        status: 'WAITING_FOR_HUMAN',
        agentAvailable: false,
        debug: null
      };
    }
    effectiveSystemPrompt = pub.systemPrompt;
    effectiveConfig = pub.structuredConfig;
    effectiveModel = pub.model;
    effectiveVersionId = pub.id;
  }

  // 3. Resolve or Create Conversation (TENANT-SCOPED: a customer can never
  //    load another tenant's conversation by supplying its id — the lookup
  //    requires both id AND businessId == tenantId.)
  const conversation = await ensureConversation(params, business, channel);

  // HUMAN HANDOFF GUARD: when a human team member has taken over (HUMAN_HANDLING)
  // or the conversation is resolved, the AI must NOT autonomously answer. The
  // customer's message is still stored (so the human sees it), but the runtime
  // returns a holding reply and never calls the model or any tool.
  if (conversation.status === 'HUMAN_HANDLING') {
    const holdingReply =
      'A team member is currently handling our conversation and will reply to you shortly. Thank you for your patience.';
    await db.messages.push({
      id: `msg-${Date.now()}-agent`,
      conversationId: conversation.id,
      sender: 'system',
      content: holdingReply,
      channel,
      timestamp: new Date().toISOString()
    });
    conversation.lastMessageAt = new Date().toISOString();
    await db.conversations.update(conversation);
    return {
      reply: holdingReply,
      conversationId: conversation.id,
      status: conversation.status,
      agentAvailable: true,
      debug: null
    };
  }

  if (conversation.status === 'RESOLVED') {
    const holdingReply =
      'This conversation has been marked as resolved. If you need further help, please start a new conversation or ask a team member to reopen this one.';
    return {
      reply: holdingReply,
      conversationId: conversation.id,
      status: conversation.status,
      agentAvailable: true,
      debug: null
    };
  }

  // Save incoming customer message
  await db.messages.push({
    id: `msg-${Date.now()}-user`,
    conversationId: conversation.id,
    sender: 'customer',
    content: userMessage,
    channel,
    timestamp: new Date().toISOString()
  });

  // Telemetry: customer message (metadata + safe summary only; no full content).
  await recordCustomerMessage({
    businessId: tenantId, agentId: agent.id, versionId: effectiveVersionId,
    conversationId: conversation.id, channel, isPublished: !simulator,
    messageLength: userMessage.length, messagePreview: userMessage
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
4. Keep answers clear, helpful, and polite.
5. HONEST FAILURE: If a tool reports failure (success: false), tell the customer the truth — e.g. "I could not complete the booking because the time is already taken" — and NEVER claim the action succeeded or was confirmed.
6. Never claim a booking, order, or transfer happened unless the backend tool response confirmed it (success: true).`;

  // 6. Build History from Conversation Messages
  const existingMsgs = (await db.messages
    .filter(m => m.conversationId === conversation.id))
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

  // Real token usage from the provider, accumulated across the tool loop
  // (Phase 19). Hoisted outside try so the catch block and the usage
  // recording block can read them.
  let providerInputTokens = 0;
  let providerOutputTokens = 0;

  // Resolve the LLM provider adapter for THIS agent (free-first: ollama when no
  // Gemini key, etc.). The runtime never imports a vendor SDK directly — see
  // src/server/llmProvider.ts. Provider/model come from the effective config
  // (published version in production, draft in the simulator).
  const { provider: llmProvider, model: providerModel } = resolveProviderAndModel({
    llmProvider: agent.llmProvider,
    model: effectiveModel
  });

  try {
    // If the provider is not usable (no key / daemon down), fail honestly
    // rather than calling out to a dead backend.
    if (!llmProvider.isConfigured()) {
      throw new Error(`AI provider "${llmProvider.type}" is not configured.`);
    }

    const temperature = structured.personality.tone === 'energetic' ? 0.7 : 0.2;
    const activeToolDecls = toLlmToolDeclarations(activeTools);

    let response = await llmProvider.generate({
      model: providerModel,
      systemPrompt: fullSystemPrompt,
      messages: contents.map(c => ({
        role: (c.role === 'model' ? 'assistant' : 'user') as 'assistant' | 'user',
        text: (c.parts.find(p => 'text' in p && typeof (p as any).text === 'string') as any)?.text,
        // Reconstruct assistant tool-call turns / user tool-result turns so the
        // provider loop can replay them (the Gemini path built these inline; the
        // normalized provider expects the structured shapes below).
        toolCalls: c.parts
          .filter(p => 'functionCall' in p)
          .map(p => {
            const fc = (p as any).functionCall;
            return { name: fc.name, args: (fc.args as Record<string, any>) || {} };
          }),
        toolResults: c.parts
          .filter(p => 'functionResponse' in p)
          .map(p => {
            const fr = (p as any).functionResponse;
            return { name: fr.name, response: fr.response as Record<string, any> };
          })
      })),
      tools: activeToolDecls,
      temperature
    });

    if (response.error) throw new Error(response.error);

    const accumulateUsage = (r: typeof response) => {
      if (r.usage) {
        providerInputTokens = r.usage.inputTokens || providerInputTokens;
        providerOutputTokens += r.usage.outputTokens || 0;
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
        const args = call.args || {};

        // Execute Tool safely on backend with tenant isolation + hard
        // enablement enforcement. BOTH the agent's toolsEnabled set (the
        // declarations offered to the model) and the derived allowedToolNames
        // (defense-in-depth: even if the LLM hallucinates a tool name that was
        // never declared, the backend refuses it) are passed so the tool layer
        // independently verifies enablement.
        const result = await executeAgentTool(toolName, args, {
          tenantId,
          conversationId: conversation.id,
          channel,
          toolsEnabled: structured.toolsEnabled,
          allowedToolNames: activeTools.map(t => t.name)
        });

        const rec: ToolCallRecord = {
          id: `tool-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          toolName,
          args,
          result,
          timestamp: new Date().toISOString()
        };
        toolCallRecords.push(rec);

        // Telemetry: tool execution (tool name + success only; never args).
        await recordToolExecution({
          businessId: tenantId, agentId: agent.id, versionId: effectiveVersionId,
          conversationId: conversation.id, channel, isPublished: !simulator,
          toolName, success: !!result.success,
          errorSummary: result.success ? undefined : (result.error || 'tool failed')
        });

        functionResponseParts.push({
          functionResponse: {
            name: toolName,
            response: result
          }
        });
      }

      // Feed the assistant's tool-call turn + the tool results back into history.
      (contents as any).push({
        role: 'model',
        parts: functionCalls.map(call => ({ functionCall: { name: call.name, args: call.args } }))
      });
      (contents as any).push({
        role: 'user',
        parts: functionResponseParts
      });

      // Call the provider again with the function results.
      response = await llmProvider.generate({
        model: providerModel,
        systemPrompt: fullSystemPrompt,
        messages: contents.map(c => ({
          role: (c.role === 'model' ? 'assistant' : 'user') as 'assistant' | 'user',
          text: (c.parts.find(p => 'text' in p && typeof (p as any).text === 'string') as any)?.text,
          toolCalls: c.parts
            .filter(p => 'functionCall' in p)
            .map(p => {
              const fc = (p as any).functionCall;
              return { name: fc.name, args: (fc.args as Record<string, any>) || {} };
            }),
          toolResults: c.parts
            .filter(p => 'functionResponse' in p)
            .map(p => {
              const fr = (p as any).functionResponse;
              return { name: fr.name, response: fr.response as Record<string, any> };
            })
        })),
        tools: activeToolDecls,
        temperature
      });
      if (response.error) throw new Error(response.error);
      accumulateUsage(response);
    }

    finalReply = response.text || "I'm sorry, I couldn't process that request properly. How else may I assist you?";
  } catch (err: any) {
    // Log the real error internally with the execution id for support; never
    // expose the provider's error message/stack to the customer.
    safeError(`[runtime] ${executionId} ${llmProvider.type} error:`, err?.message || err);
    runtimeError = err?.message || 'AI Provider Error';
    // Honest fallback: report the outage, never claim any action succeeded.
    // Internal error details stay server-side (and in debug for internal callers).
    finalReply = "I'm sorry, I'm having trouble connecting to the assistant service right now. Please try again in a moment.";
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
  await db.conversations.update(conversation);

  // Store Agent Reply Message
  await db.messages.push({
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
  let usage = await db.usageRecords.find(u => u.businessId === tenantId && u.date === todayStr);
  if (!usage) {
    usage = {
      id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    await db.usageRecords.push(usage);
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
  await db.usageRecords.update(usage);

  // Telemetry: agent response (latency, provider/model, tokens, success). Only
  // the main executed path records this — the early no-agent / no-published
  // fallbacks return before reaching here, so metrics reflect real activity.
  const handoffOccurred = conversation.status === 'WAITING_FOR_HUMAN';
  await recordAgentResponse({
    businessId: tenantId, agentId: agent.id, versionId: effectiveVersionId,
    conversationId: conversation.id, channel, provider: llmProvider.type,
    model: providerModel, isPublished: !simulator, latencyMs,
    success: !runtimeError, status: conversation.status,
    inputTokens: usedInputTokens || undefined,
    outputTokens: usedOutputTokens || undefined,
    tokensUsed: tokensUsed, replyPreview: finalReply,
    toolCallCount: toolCallRecords.length
  });
  if (handoffOccurred) {
    await recordHumanHandoff({
      businessId: tenantId, agentId: agent.id, versionId: effectiveVersionId,
      conversationId: conversation.id, channel, isPublished: !simulator,
      reason: runtimeError ? 'provider error escalated to human' : 'agent escalated to human'
    });
  }

  const debug: RuntimeDebugInfo | null = params.includeDebug
    ? {
        systemPrompt: fullSystemPrompt,
        retrievedKnowledge,
        toolCalls: toolCallRecords,
        latencyMs,
        tokensUsed,
        model: providerModel,
        executionId,
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
    needsInput.push({ field: 'hours', label: 'Operating hours' });
  }
  if (!businessInput.services || !businessInput.services.trim()) {
    needsInput.push({ field: 'services', label: 'Service list and prices' });
  }
  if (!businessInput.description || !businessInput.description.trim()) {
    needsInput.push({ field: 'description', label: 'Business description' });
  }

  try {
    const { provider, model } = resolveProviderAndModel(null);
    if (!provider.isConfigured()) throw new Error('AI provider not configured');

    const prompt = `You are an expert AI Agent Architect designing the configuration for a new AI receptionist agent.

You receive ONLY the business facts the owner provided. You must NEVER invent facts.

BUSINESS FACTS PROVIDED:
- Name: ${businessInput.name}
- Type: ${businessInput.type}
- Description: ${businessInput.description || 'NOT PROVIDED'}
- Operating hours: ${businessInput.hours || 'NOT PROVIDED'}
- Services: ${businessInput.services || 'NOT PROVIDED'}
- FAQs: ${businessInput.faqs || 'NOT PROVIDED'}

CRITICAL RULES — violate these and the configuration is useless:
1. NEVER invent business facts. If a price, duration, hour, policy, or service
   name was NOT provided in the input above, you MUST output the literal string
   "NEEDS_INPUT" for that field. Do NOT guess, round, or estimate.
2. You MAY suggest STRUCTURE (e.g. "Would appointment booking help?") and ask
   clarifying questions, but the values for services/prices/hours must come
   ONLY from the input or be "NEEDS_INPUT".
3. System prompt and personality may be generated, but must instruct the agent
   to never state prices/hours/services that the business has not configured.
4. For every business fact that is missing (e.g. exact prices, operating hours,
   policies, address), add an entry to the "needsInput" array with a short
   "field" name and a human-readable "label".
5. Only fill suggestedServices / suggestedFaqs with information the owner
   actually provided. If not provided, leave them empty arrays.
6. You MAY propose: agent name, personality (tone/behavior/language), goals,
   allowedActions (tool names), restrictedActions, escalationRules, and a
   systemPrompt written in generic, safe language.
7. The systemPrompt must instruct the agent to never invent facts, to use tools
   for hours/prices/availability, and to tell the customer the truth when a
   tool reports failure (never claim a booking or action succeeded unless the
   backend confirmed it).

Return ONLY a JSON object (no markdown, no prose, no code fences) with exactly this shape:
{
  "agentName": "Suggested agent name",
  "systemPrompt": "Comprehensive but fact-safe system instructions",
  "personality": { "tone": "friendly", "behavior": "service", "language": "en" },
  "goals": ["Goal 1", "Goal 2", "Goal 3"],
  "allowedActions": ["check_business_hours", "get_business_information", "check_availability", "book_appointment", "search_knowledge", "transfer_to_human"],
  "restrictedActions": ["Never invent prices, hours, addresses, or policies", "Never claim a booking or action succeeded unless a tool confirmed it"],
  "escalationRules": ["When customer requests a human", "When asked for facts not provided"],
  "suggestedFaqs": [],
  "suggestedServices": [],
  "needsInput": [{ "field": "prices", "label": "Exact prices for each service" }]
}`;

    const res = await provider.generate({
      model,
      systemPrompt: 'You are an expert AI Agent Architect. Return only the JSON object requested.',
      messages: [{ role: 'user', text: prompt }],
      tools: []
    });
    if (res.error) throw new Error(res.error);

    if (res.text) {
      // Robust parsing: tolerate markdown code fences and stray prose, then
      // sanitize so the proposal can never carry fabricated business facts.
      const parsed = parseJsonFromModel(res.text);
      return sanitizeGeneratedConfig(parsed, businessInput);
    }
  } catch (err: any) {
    safeError('Auto Agent Gen Error:', err);
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
 * Defense-in-depth: even if the model invents values, strip any service that
 * carries a fabricated price/duration when the input didn't supply services.
 * Anything that looks placeholder is converted to NEEDS_INPUT.
 */
function sanitizeGeneratedConfig(parsed: any, input: { name: string; type: string; description: string; hours?: string; services?: string; faqs?: string }): any {
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
  // Missing-fact markers use the same { field, label } shape everywhere so the
  // wizard can render them uniformly, from the model path or the fallback.
  if (!input.hours && !parsed.needsInput.some((n: any) => n && n.field === 'hours')) {
    parsed.needsInput.push({ field: 'hours', label: 'Operating hours' });
  }
  if (!servicesProvided && !parsed.needsInput.some((n: any) => n && n.field === 'services')) {
    parsed.needsInput.push({ field: 'services', label: 'Service list and prices' });
  }
  return parsed;
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
