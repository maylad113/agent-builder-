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

export interface RuntimeExecutionResult {
  reply: string;
  conversationId: string;
  status: string;
  debug: {
    systemPrompt: string;
    retrievedKnowledge: string[];
    toolCalls: ToolCallRecord[];
    latencyMs: number;
    tokensUsed: number;
    model: string;
  };
}

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
}): Promise<RuntimeExecutionResult> {
  const startTime = Date.now();
  const { tenantId, userMessage, channel = 'web_chat' } = params;

  // 1. Resolve Tenant & Business Information
  const business = db.businesses.find(b => b.id === tenantId);
  if (!business) {
    throw new Error(`Business not found for ID: ${tenantId}`);
  }

  // 2. Load Active Agent Configuration
  const agent = db.agents.find(a => a.businessId === tenantId && (a.status === 'ACTIVE' || a.status === 'READY' || a.status === 'TESTING'))
    || db.agents.find(a => a.businessId === tenantId); // Fallback to any agent for business

  if (!agent) {
    throw new Error(`No agent configured for business: ${business.name}`);
  }

  // 3. Resolve or Create Conversation
  let conversation = params.conversationId 
    ? db.conversations.find(c => c.id === params.conversationId)
    : null;

  if (!conversation) {
    // Find customer or create guest customer
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
    finalReply = `I'm having trouble connecting to the assistant service right now. I'll connect you with the business owner directly. (${err.message || 'AI Provider Error'})`;
    
    // Auto-escalate conversation status on AI error
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
      id: `usr-${Date.now()}`,
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

  return {
    reply: finalReply,
    conversationId: conversation.id,
    status: conversation.status,
    debug: {
      systemPrompt: fullSystemPrompt,
      retrievedKnowledge,
      toolCalls: toolCallRecords,
      latencyMs,
      tokensUsed: tokensEstimate,
      model: agent.model || 'gemini-3.6-flash'
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
- Operating Hours: ${businessInput.hours || 'Standard business hours'}
- Services: ${businessInput.services || 'General local services'}

Return a JSON object conforming strictly to this format:
{
  "agentName": "Suggested agent name",
  "systemPrompt": "Comprehensive system instructions for the AI receptionist",
  "personality": {
    "tone": "friendly",
    "behavior": "service",
    "language": "en"
  },
  "goals": ["Goal 1", "Goal 2", "Goal 3"],
  "allowedActions": ["check_business_hours", "get_business_information", "check_availability", "book_appointment", "transfer_to_human"],
  "restrictedActions": ["Do not give unauthorized discounts", "Do not promise out-of-scope work"],
  "escalationRules": ["When customer requests a human", "When customer reports a complaint"],
  "suggestedFaqs": [
    {"question": "Sample FAQ 1", "answer": "Suggested answer 1"},
    {"question": "Sample FAQ 2", "answer": "Suggested answer 2"}
  ],
  "suggestedServices": [
    {"name": "Sample Service 1", "price": 300000, "durationMinutes": 30, "description": "Sample description"}
  ]
}`;

    const res = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    if (res.text) {
      return JSON.parse(res.text);
    }
  } catch (err: any) {
    console.error('Auto Agent Gen Error:', err);
  }

  // Sensible fallback if Gemini key is not present or API call fails
  return {
    agentName: `${businessInput.name} AI Assistant`,
    systemPrompt: `You are the official AI receptionist for ${businessInput.name}. Assist customers politely, answer FAQs, and book appointments.`,
    personality: { tone: 'friendly', behavior: 'service', language: 'en' },
    goals: ['Answer customer inquiries', 'Book appointments', 'Explain services'],
    allowedActions: ['check_business_hours', 'get_business_information', 'check_availability', 'book_appointment', 'transfer_to_human'],
    restrictedActions: ['Do not make up fake prices or hours'],
    escalationRules: ['When customer requests a real human agent'],
    suggestedFaqs: [
      { question: 'What are your hours?', answer: 'We are open during regular business hours.' },
      { question: 'How can I book an appointment?', answer: 'I can assist you directly with booking an appointment right here!' }
    ],
    suggestedServices: [
      { name: 'Standard Service', price: 300000, durationMinutes: 30, description: 'General service' }
    ]
  };
}
