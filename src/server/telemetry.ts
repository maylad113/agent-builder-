import { db } from './db';
import { safeError } from './logSanitizer';
import { TelemetryEvent, TelemetryEventType, ChannelType } from '../types';

/**
 * Usage Monitoring + Observability.
 *
 * Records REAL events from the agent runtime, tool execution, evaluation,
 * correction, and publish paths. Every record is tenant-scoped (business_id).
 *
 * SECURITY INVARIANTS:
 *  - Telemetry is recorded SERVER-SIDE ONLY at well-defined seams. The LLM
 *    never writes or modifies telemetry. No public route exposes a write.
 *  - Records never carry secrets, credentials, or raw PII. Tool args are NOT
 *    stored; only the tool name + success + a safe error summary.
 *  - Conversation content is NOT duplicated here — the messages table remains
 *    the content store. Telemetry stores a safe truncated summary + metadata
 *    for observability only.
 *  - Tenant isolation: every query is scoped by business_id; no cross-tenant
 *    reads are possible through the query API.
 *  - Recording is best-effort and never throws into the request path: a
 *    telemetry failure must NOT break a customer conversation or a publish.
 */

/** Create the telemetry_events table if missing (self-healing, idempotent).
 *  Mirrors the embeddings/evaluation/correction init pattern. */
export async function initTelemetryTable(client: {
  execMany: (sql: string) => Promise<void>;
  dialect: 'sqlite' | 'postgres';
}): Promise<void> {
  const boolType = client.dialect === 'postgres' ? 'BOOLEAN' : 'INTEGER';
  const jsonType = client.dialect === 'postgres' ? 'JSONB' : 'TEXT';
  const jsonDefault = client.dialect === 'postgres' ? "'{}'::jsonb" : "'{}'";
  await client.execMany(
    `CREATE TABLE IF NOT EXISTS telemetry_events (
       id            TEXT PRIMARY KEY,
       business_id   TEXT NOT NULL,
       timestamp     TEXT NOT NULL,
       event_type    TEXT NOT NULL,
       agent_id      TEXT,
       version_id    TEXT,
       conversation_id TEXT,
       channel       TEXT,
       provider      TEXT,
       model         TEXT,
       is_published  ${boolType} NOT NULL DEFAULT 0,
       tool_name     TEXT,
       success       ${boolType},
       latency_ms    INTEGER,
       input_tokens  INTEGER,
       output_tokens INTEGER,
       tokens_used   INTEGER,
       summary       TEXT,
       metadata      ${jsonType} NOT NULL DEFAULT ${jsonDefault}
     )`
  );
  await client.execMany('CREATE INDEX IF NOT EXISTS idx_telemetry_business ON telemetry_events(business_id, timestamp)');
  await client.execMany('CREATE INDEX IF NOT EXISTS idx_telemetry_agent ON telemetry_events(agent_id, timestamp)');
  await client.execMany('CREATE INDEX IF NOT EXISTS idx_telemetry_version ON telemetry_events(version_id)');
  await client.execMany('CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry_events(business_id, event_type, timestamp)');
  // Conversation drill-down: events are grouped/looked up by (business_id,
  // conversation_id) — the tenant scope + the durable conversation id.
  await client.execMany('CREATE INDEX IF NOT EXISTS idx_telemetry_conversation ON telemetry_events(business_id, conversation_id, timestamp)');
}

function genId(): string {
  return `tel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Safe truncated summary (never store full content). */
function safeSummary(text: string | undefined, max = 80): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

/** Internal recorder — never throws into the caller's path. */
async function record(event: Omit<TelemetryEvent, 'id' | 'timestamp'> & Partial<Pick<TelemetryEvent, 'timestamp'>>): Promise<void> {
  try {
    // Build the full event: spread caller fields first, then set id + timestamp
    // AFTER so an explicit caller timestamp wins but an undefined one does NOT
    // clobber the computed timestamp (spreading {timestamp: undefined} would).
    const full: TelemetryEvent = {
      ...event,
      id: genId(),
      timestamp: event.timestamp || new Date().toISOString()
    } as TelemetryEvent;
    await db.telemetry.push(full);
  } catch (err: any) {
    // Observability must never break the runtime. Log server-side only.
    safeError('[telemetry] failed to record event:', err?.message || err);
  }
}

/**
 * Orchestration lifecycle recorder. Orchestration events are platform-level:
 * before a prospect converts they have no tenant, so they are scoped to the
 * sentinel business id 'platform' (`telemetry_events.business_id` is NOT NULL
 * and has no FK — it is a scope tag, not a constraint). Once a prospect has
 * converted, pass its real businessId. Never throws; safe summaries only.
 */
export async function recordOrchestrationEvent(params: {
  eventType:
    | 'PROSPECT_CREATED'
    | 'DESIGN_CREATED'
    | 'DESIGN_APPROVED'
    | 'FACTORY_JOB_STARTED'
    | 'FACTORY_JOB_STEP'
    | 'FACTORY_JOB_FAILED'
    | 'AGENT_DELIVERED'
    | 'DELIVERY_ACCEPTED'
    | 'OWNER_ACCOUNT_PROVISIONED'
    | 'LEAD_RESEARCH_RUN'
    | 'LEAD_RESEARCH_COMPLETED'
    | 'LEAD_RESEARCH_FAILED'
    | 'DISCOVERY_RUN'
    | 'DISCOVERY_COMPLETED'
    | 'DISCOVERY_FAILED'
    | 'DISCOVERY_ACCEPTED'
    | 'DISCOVERY_DISMISSED'
    | 'PROSPECT_ANALYZE_RUN'
    | 'PROSPECT_ANALYZE_COMPLETED'
    | 'PROSPECT_ANALYZE_FAILED'
    | 'DESIGN_GENERATE_RUN'
    | 'DESIGN_GENERATE_COMPLETED'
    | 'DESIGN_GENERATE_FAILED'
    | 'SALES_ASSIGNED'
    | 'OUTREACH_ATTEMPTED'
    | 'OUTREACH_COMPLETED'
    | 'SALES_CONVERSATION_OPENED'
    | 'SALES_CONVERSATION_ESCALATED'
    | 'SALES_CONVERSATION_CLOSED'
    | 'SALES_TASK_PARKED'
    | 'SALES_TASK_RESUMED';
  /** Absent for pre-prospect discovery events. */
  prospectId?: string;
  businessId?: string;
  agentId?: string;
  /** Ids of related orchestration entities (never PII). */
  metadata?: {
    jobId?: string;
    designId?: string;
    deliveryId?: string;
    acceptanceId?: string;
    researchReportId?: string;
    discoveryRunId?: string;
    discoveryResultId?: string;
    step?: string;
  };
  summary?: string;
  timestamp?: string;
}): Promise<void> {
  await record({
    businessId: params.businessId || 'platform',
    eventType: params.eventType,
    agentId: params.agentId,
    isPublished: false,
    summary: safeSummary(params.summary),
    metadata: {
      prospectId: params.prospectId,
      ...(params.metadata || {})
    },
    timestamp: params.timestamp
  });
}

// ---------------------------------------------------------------------------
// Domain-specific recorders (called from the runtime/eval/correction/publish
// seams). Each is async but fire-and-forget-safe; callers may await or not.
// ---------------------------------------------------------------------------

/** Record an incoming customer message (metadata + safe summary, no full content). */
export async function recordCustomerMessage(params: {
  businessId: string; agentId: string; versionId?: string; conversationId: string;
  channel?: string; isPublished: boolean; messageLength: number; messagePreview: string;
  timestamp?: string;
}): Promise<void> {
  await record({
    businessId: params.businessId,
    eventType: 'CUSTOMER_MESSAGE',
    agentId: params.agentId,
    versionId: params.versionId,
    conversationId: params.conversationId,
    channel: params.channel,
    isPublished: params.isPublished,
    summary: safeSummary(params.messagePreview, 60),
    metadata: { messageLength: params.messageLength },
    timestamp: params.timestamp
  });
}

/** Record an agent response (latency, provider/model, tokens, success/handoff). */
export async function recordAgentResponse(params: {
  businessId: string; agentId: string; versionId?: string; conversationId: string;
  channel?: string; provider?: string; model?: string; isPublished: boolean;
  latencyMs: number; success: boolean; status: string; inputTokens?: number;
  outputTokens?: number; tokensUsed?: number; replyPreview?: string;
  toolCallCount?: number; timestamp?: string;
}): Promise<void> {
  await record({
    businessId: params.businessId,
    eventType: 'AGENT_RESPONSE',
    agentId: params.agentId,
    versionId: params.versionId,
    conversationId: params.conversationId,
    channel: params.channel,
    provider: params.provider,
    model: params.model,
    isPublished: params.isPublished,
    latencyMs: Math.round(params.latencyMs),
    success: params.success,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    tokensUsed: params.tokensUsed,
    summary: safeSummary(params.replyPreview, 80),
    metadata: { status: params.status, toolCallCount: params.toolCallCount ?? 0 },
    timestamp: params.timestamp
  });
}

/** Record a single tool execution (tool name + success only; never args). */
export async function recordToolExecution(params: {
  businessId: string; agentId: string; versionId?: string; conversationId: string;
  channel?: string; isPublished: boolean; toolName: string; success: boolean;
  latencyMs?: number; errorSummary?: string; timestamp?: string;
}): Promise<void> {
  await record({
    businessId: params.businessId,
    eventType: 'TOOL_EXECUTION',
    agentId: params.agentId,
    versionId: params.versionId,
    conversationId: params.conversationId,
    channel: params.channel,
    isPublished: params.isPublished,
    toolName: params.toolName,
    success: params.success,
    latencyMs: params.latencyMs != null ? Math.round(params.latencyMs) : undefined,
    summary: params.success ? undefined : safeSummary(params.errorSummary, 120),
    metadata: {},
    timestamp: params.timestamp
  });
}

/** Record a human handoff (escalation to a human). */
export async function recordHumanHandoff(params: {
  businessId: string; agentId: string; versionId?: string; conversationId: string;
  channel?: string; isPublished: boolean; reason?: string; timestamp?: string;
}): Promise<void> {
  await record({
    businessId: params.businessId,
    eventType: 'HUMAN_HANDOFF',
    agentId: params.agentId,
    versionId: params.versionId,
    conversationId: params.conversationId,
    channel: params.channel,
    isPublished: params.isPublished,
    success: false,
    summary: safeSummary(params.reason, 120),
    metadata: {},
    timestamp: params.timestamp
  });
}

/** Record an evaluation run (pass/fail + counts). */
export async function recordEvaluationRun(params: {
  businessId: string; agentId: string; versionId: string; evaluationId: string;
  overallPassed: boolean; totalScenarios: number; passedScenarios: number;
  criticalFailures: number; providerUsed: string;
}): Promise<void> {
  await record({
    businessId: params.businessId,
    eventType: 'EVALUATION_RUN',
    agentId: params.agentId,
    versionId: params.versionId,
    isPublished: false,
    success: params.overallPassed,
    provider: params.providerUsed,
    metadata: {
      evaluationId: params.evaluationId,
      totalScenarios: params.totalScenarios,
      passedScenarios: params.passedScenarios,
      criticalFailures: params.criticalFailures
    }
  });
}

/** Record a correction attempt/run (resolved + human-review + attempts count). */
export async function recordCorrectionAttempt(params: {
  businessId: string; agentId: string; versionId: string; correctionId: string;
  resolved: boolean; humanReviewRequired: boolean; attempts: number;
  finalVersionId?: string; reason?: string;
}): Promise<void> {
  await record({
    businessId: params.businessId,
    eventType: 'CORRECTION_ATTEMPT',
    agentId: params.agentId,
    versionId: params.versionId,
    isPublished: false,
    success: params.resolved,
    summary: safeSummary(params.reason, 120),
    metadata: {
      correctionId: params.correctionId,
      humanReviewRequired: params.humanReviewRequired,
      attempts: params.attempts,
      finalVersionId: params.finalVersionId
    }
  });
}

/** Record a version publication. */
export async function recordVersionPublished(params: {
  businessId: string; agentId: string; versionId: string; versionNumber: number;
}): Promise<void> {
  await record({
    businessId: params.businessId,
    eventType: 'VERSION_PUBLISHED',
    agentId: params.agentId,
    versionId: params.versionId,
    isPublished: true,
    success: true,
    metadata: { versionNumber: params.versionNumber }
  });
}

// ---------------------------------------------------------------------------
// Tenant-scoped querying + aggregation
// ---------------------------------------------------------------------------

export interface TelemetryQuery {
  businessId: string;
  agentId?: string;
  versionId?: string;
  /** Inclusive lower bound (ISO). */
  from?: string;
  /** Exclusive/inclusive upper bound (ISO); treated as inclusive end-of-day. */
  to?: string;
  /** When true, only published-agent activity; when false, only draft/test
   *  activity; when undefined, both. */
  isPublished?: boolean;
  /** Limit (default 50, max 200). */
  limit?: number;
}

function eventMatchesQuery(e: TelemetryEvent, q: TelemetryQuery): boolean {
  if (e.businessId !== q.businessId) return false;
  if (q.agentId && e.agentId !== q.agentId) return false;
  if (q.versionId && e.versionId !== q.versionId) return false;
  if (q.isPublished !== undefined && e.isPublished !== q.isPublished) return false;
  if (q.from && e.timestamp < q.from) return false;
  if (q.to && e.timestamp > q.to) return false;
  return true;
}

/** List telemetry events (tenant-scoped, newest first). */
export async function listTelemetryEvents(query: TelemetryQuery): Promise<TelemetryEvent[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const all = await db.telemetry.filter(e => eventMatchesQuery(e, query));
  return all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, limit);
}

export interface TelemetryMetrics {
  businessId: string;
  conversations: number;
  messages: number;
  agentResponses: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  humanHandoffs: number;
  averageLatencyMs: number;
  /** provider/model -> response count (where available). */
  providerModelUsage: Record<string, number>;
  evaluationPasses: number;
  evaluationFailures: number;
  correctionCount: number;
  /** Whether any real published-agent activity exists. */
  hasPublishedActivity: boolean;
  /** Whether any draft/test activity exists. */
  hasDraftActivity: boolean;
}

/** Compute aggregate metrics for a tenant-scoped query. Never fabricates —
 *  returns zeros when no events exist. */
export async function computeMetrics(query: Omit<TelemetryQuery, 'limit'>): Promise<TelemetryMetrics> {
  const all = await db.telemetry.filter(e => eventMatchesQuery(e, query));
  const latencies: number[] = [];
  const conversationIds = new Set<string>();
  let messages = 0;
  let agentResponses = 0;
  let successfulToolCalls = 0;
  let failedToolCalls = 0;
  let humanHandoffs = 0;
  let evaluationPasses = 0;
  let evaluationFailures = 0;
  let correctionCount = 0;
  const providerModelUsage: Record<string, number> = {};
  let hasPublishedActivity = false;
  let hasDraftActivity = false;

  for (const e of all) {
    if (e.isPublished) hasPublishedActivity = true; else hasDraftActivity = true;
    if (e.conversationId) conversationIds.add(e.conversationId);
    switch (e.eventType) {
      case 'CUSTOMER_MESSAGE':
        messages++;
        break;
      case 'AGENT_RESPONSE':
        agentResponses++;
        if (typeof e.latencyMs === 'number') latencies.push(e.latencyMs);
        if (e.provider && e.model) {
          const key = `${e.provider}/${e.model}`;
          providerModelUsage[key] = (providerModelUsage[key] || 0) + 1;
        }
        break;
      case 'TOOL_EXECUTION':
        if (e.success) successfulToolCalls++; else failedToolCalls++;
        break;
      case 'HUMAN_HANDOFF':
        humanHandoffs++;
        break;
      case 'EVALUATION_RUN':
        if (e.success) evaluationPasses++; else evaluationFailures++;
        break;
      case 'CORRECTION_ATTEMPT':
        correctionCount++;
        break;
      default:
        break;
    }
  }

  const avg = latencies.length > 0
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
    : 0;

  return {
    businessId: query.businessId,
    conversations: conversationIds.size,
    messages,
    agentResponses,
    successfulToolCalls,
    failedToolCalls,
    humanHandoffs,
    averageLatencyMs: avg,
    providerModelUsage,
    evaluationPasses,
    evaluationFailures,
    correctionCount,
    hasPublishedActivity,
    hasDraftActivity
  };
}

/** Count events of a given type for a tenant (used for smoke/tests). */
export async function countTelemetry(businessId: string, eventType?: TelemetryEventType): Promise<number> {
  const all = await db.telemetry.filter(e =>
    e.businessId === businessId && (!eventType || e.eventType === eventType)
  );
  return all.length;
}

// ===========================================================================
// PER-CONVERSATION DRILL-DOWN
// ===========================================================================
// The durable conversation/session identifier is the EXISTING Conversation.id
// (created in ensureConversation). Every telemetry event already carries
// conversationId, so related events are already grouped — no new session id
// or duplicate data is introduced. These helpers derive a conversation list
// and a chronological timeline from existing telemetry + conversation rows,
// tenant-scoped by business_id on every lookup.

/** Timeline actor — used to color/icon the entry in the UI. */
export type TimelineActor = 'CUSTOMER' | 'AGENT' | 'TOOL' | 'SYSTEM' | 'HANDOFF';

function actorFor(eventType: TelemetryEventType): TimelineActor {
  switch (eventType) {
    case 'CUSTOMER_MESSAGE': return 'CUSTOMER';
    case 'AGENT_RESPONSE': return 'AGENT';
    case 'TOOL_EXECUTION': return 'TOOL';
    case 'HUMAN_HANDOFF': return 'HANDOFF';
    case 'EVALUATION_RUN':
    case 'CORRECTION_ATTEMPT':
    case 'VERSION_PUBLISHED': return 'SYSTEM';
    default: return 'SYSTEM';
  }
}

/** A single chronological timeline entry. Mirrors the privacy-safe telemetry
 *  record — tool name + success + safe summary, NEVER args/secrets. */
export interface ConversationTimelineEntry {
  id: string;
  timestamp: string;
  eventType: TelemetryEventType;
  actor: TimelineActor;
  /** Safe truncated summary (never full content / secrets / args). */
  summary?: string;
  /** TOOL_EXECUTION only — tool name + success, NEVER the args. */
  toolName?: string;
  success?: boolean;
  latencyMs?: number;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  tokensUsed?: number;
  agentId?: string;
  agentName?: string;
  versionId?: string;
  versionNumber?: number;
  versionStatus?: string;
  /** Whether this event was real published-agent activity (true) or
   *  test/simulator/eval/correction activity (false). */
  isPublished: boolean;
  channel?: string;
  /** Structured extra metadata (counts, handoff reason, etc.). Safe. */
  metadata?: Record<string, any>;
}

/** Summary of a conversation for list views. Derived from telemetry grouping +
 *  the conversation row (status/customerName/etc.) when available. */
export interface ConversationSummary {
  conversationId: string;
  businessId: string;
  /** Agent the conversation was served by (when known from events). */
  agentId?: string;
  agentName?: string;
  /** Conversation metadata, when the conversation row exists. */
  status?: string;
  customerName?: string;
  channel?: ChannelType | string;
  createdAt?: string;
  lastActivityAt?: string;
  /** Whether the conversation had ANY published-agent activity. A conversation
   *  may contain a mix if a draft simulator ran against the same id, but in
   *  practice production widget conversations are all isPublished=true. */
  hasPublishedActivity: boolean;
  hasTestActivity: boolean;
  eventCount: number;
  messageCount: number;
  agentResponseCount: number;
  toolCallCount: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  handoffCount: number;
}

export interface ConversationListQuery {
  businessId: string;
  /** Optional agent filter. */
  agentId?: string;
  /** Optional published/test filter. */
  isPublished?: boolean;
  /** Optional inclusive lower bound (ISO). */
  from?: string;
  /** Optional inclusive upper bound (ISO). */
  to?: string;
  /** Limit (default 50, max 200). */
  limit?: number;
}

/** Resolve agent name + version label for display enrichment (server-side only). */
async function resolveAgentLabel(agentId?: string): Promise<string | undefined> {
  if (!agentId) return undefined;
  const agent = await db.agents.find(a => a.id === agentId);
  return agent?.name;
}

async function resolveVersionLabel(versionId?: string): Promise<{ versionNumber?: number; versionStatus?: string } | undefined> {
  if (!versionId) return undefined;
  const v = await db.agentVersions.find(vr => vr.id === versionId);
  if (!v) return undefined;
  return { versionNumber: v.versionNumber, versionStatus: v.status };
}

function toTimelineEntry(e: TelemetryEvent, agentName?: string, versionLabel?: { versionNumber?: number; versionStatus?: string }): ConversationTimelineEntry {
  return {
    id: e.id,
    timestamp: e.timestamp,
    eventType: e.eventType,
    actor: actorFor(e.eventType),
    summary: e.summary,
    toolName: e.toolName,
    success: e.success,
    latencyMs: e.latencyMs,
    provider: e.provider,
    model: e.model,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    tokensUsed: e.tokensUsed,
    agentId: e.agentId,
    agentName,
    versionId: e.versionId,
    versionNumber: versionLabel?.versionNumber,
    versionStatus: versionLabel?.versionStatus,
    isPublished: e.isPublished,
    channel: e.channel,
    metadata: e.metadata
  };
}

/** List conversations (with telemetry activity) for a tenant. Derived from
 *  telemetry events grouped by conversationId, enriched with the conversation
 *  row when it exists. Tenant-scoped by businessId; never returns another
 *  tenant's conversations. Newest activity first. */
export async function listConversationsFromTelemetry(query: ConversationListQuery): Promise<ConversationSummary[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const all = await db.telemetry.filter(e => {
    if (e.businessId !== query.businessId) return false;
    if (query.agentId && e.agentId !== query.agentId) return false;
    if (query.isPublished !== undefined && e.isPublished !== query.isPublished) return false;
    if (!e.conversationId) return false;
    if (query.from && e.timestamp < query.from) return false;
    if (query.to && e.timestamp > query.to) return false;
    return true;
  });

  const byConv = new Map<string, TelemetryEvent[]>();
  for (const e of all) {
    const arr = byConv.get(e.conversationId!) ?? [];
    arr.push(e);
    byConv.set(e.conversationId!, arr);
  }

  // Enrich with conversation rows (status/customerName/etc.) + agent name.
  const conversationIds = [...byConv.keys()];
  const convRows = await Promise.all(
    conversationIds.map(id => db.conversations.find(c => c.id === id && c.businessId === query.businessId))
  );
  const convMap = new Map<string, NonNullable<typeof convRows[number]>>();
  for (const c of convRows) if (c) convMap.set(c.id, c);

  const summaries: ConversationSummary[] = [];
  for (const [convId, events] of byConv) {
    const conv = convMap.get(convId);
    const agentId = events.find(e => e.agentId)?.agentId;
    const agentName = agentId ? await resolveAgentLabel(agentId) : undefined;
    const sorted = events.slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const hasPublishedActivity = events.some(e => e.isPublished);
    const hasTestActivity = events.some(e => !e.isPublished);
    const messageCount = events.filter(e => e.eventType === 'CUSTOMER_MESSAGE').length;
    const agentResponseCount = events.filter(e => e.eventType === 'AGENT_RESPONSE').length;
    const toolEvents = events.filter(e => e.eventType === 'TOOL_EXECUTION');
    const handoffCount = events.filter(e => e.eventType === 'HUMAN_HANDOFF').length;
    summaries.push({
      conversationId: convId,
      businessId: query.businessId,
      agentId,
      agentName,
      status: conv?.status,
      customerName: conv?.customerName,
      channel: conv?.channel ?? events.find(e => e.channel)?.channel,
      createdAt: conv?.createdAt ?? sorted[0]?.timestamp,
      lastActivityAt: sorted[sorted.length - 1]?.timestamp ?? sorted[0]?.timestamp,
      hasPublishedActivity,
      hasTestActivity,
      eventCount: events.length,
      messageCount,
      agentResponseCount,
      toolCallCount: toolEvents.length,
      successfulToolCalls: toolEvents.filter(e => e.success).length,
      failedToolCalls: toolEvents.filter(e => !e.success).length,
      handoffCount
    });
  }

  return summaries
    .sort((a, b) => new Date(b.lastActivityAt ?? 0).getTime() - new Date(a.lastActivityAt ?? 0).getTime())
    .slice(0, limit);
}

export interface ConversationTimeline {
  conversationId: string;
  businessId: string;
  /** Conversation metadata when the row exists; null when only telemetry
   *  exists (honest — the UI shows "conversation record unavailable"). */
  conversation: {
    status?: string;
    customerName?: string;
    channel?: ChannelType | string;
    createdAt?: string;
    lastMessageAt?: string;
    summary?: string;
    handoffReason?: string;
  } | null;
  /** Agent the conversation was served by (resolved from events). */
  agentId?: string;
  agentName?: string;
  /** Whether ANY published-agent activity occurred (real customer traffic). */
  hasPublishedActivity: boolean;
  hasTestActivity: boolean;
  /** Chronological (ascending) timeline entries. May be empty (honest empty
   *  state — e.g. an early-fallback conversation that returned before
   *  recording). */
  timeline: ConversationTimelineEntry[];
}

/** Retrieve a single conversation + its chronological timeline. TENANT-SCOPED:
 *  returns null when the conversation does not exist OR belongs to a different
 *  tenant — the caller MUST 404 in either case (no existence leak). Never
 *  exposes secrets or tool args (mirrors the privacy-safe telemetry record). */
export async function getConversationTimeline(
  businessId: string,
  conversationId: string
): Promise<ConversationTimeline | null> {
  // Tenant-scoped lookup: require BOTH id AND businessId match.
  const conv = await db.conversations.find(c => c.id === conversationId && c.businessId === businessId);

  // Even if the conversation row is missing (shouldn't normally happen since
  // ensureConversation creates it), we still scope events by business_id so a
  // caller cannot read another tenant's telemetry by guessing an id.
  const events = await db.telemetry.filter(
    e => e.businessId === businessId && e.conversationId === conversationId
  );

  // If neither the conversation nor any telemetry exists for this tenant,
  // treat as not found (no leak).
  if (!conv && events.length === 0) return null;

  const sorted = events.slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Enrich entries with agent name + version label (display-only, server-side).
  const agentId = sorted.find(e => e.agentId)?.agentId;
  const agentName = agentId ? await resolveAgentLabel(agentId) : undefined;
  const versionIds = [...new Set(sorted.map(e => e.versionId).filter(Boolean))] as string[];
  const versionLabels = await Promise.all(versionIds.map(id => resolveVersionLabel(id).then(label => [id, label] as const)));
  const versionMap = new Map<string, { versionNumber?: number; versionStatus?: string }>();
  for (const [id, label] of versionLabels) if (label) versionMap.set(id, label);

  const timeline: ConversationTimelineEntry[] = sorted.map(e =>
    toTimelineEntry(e, agentName, e.versionId ? versionMap.get(e.versionId) : undefined)
  );

  return {
    conversationId,
    businessId,
    conversation: conv ? {
      status: conv.status,
      customerName: conv.customerName,
      channel: conv.channel,
      createdAt: conv.createdAt,
      lastMessageAt: conv.lastMessageAt,
      summary: conv.summary,
      handoffReason: conv.handoffReason
    } : null,
    agentId,
    agentName,
    hasPublishedActivity: events.some(e => e.isPublished),
    hasTestActivity: events.some(e => !e.isPublished),
    timeline
  };
}
