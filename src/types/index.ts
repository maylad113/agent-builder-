// ---------------------------------------------------------------------------
// Auth: users & sessions
// ---------------------------------------------------------------------------

export type UserRole = 'PLATFORM_OWNER' | 'BUSINESS_OWNER' | 'BUSINESS_STAFF';

export interface User {
  id: string;
  email: string;
  passwordHash: string; // scrypt$N$r$p$salt$hash — never plaintext
  name: string;
  role: UserRole;
  /** Tenant the user is hard-scoped to; null only for PLATFORM_OWNER. */
  businessId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** User shape safe to send to the frontend (never includes passwordHash). */
export type PublicUser = Omit<User, 'passwordHash'>;

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export type BusinessType = 
  | 'barbershop'
  | 'salon'
  | 'restaurant'
  | 'dentist'
  | 'mechanic'
  | 'clothing_store'
  | 'bookstore'
  | 'real_estate'
  | 'retail'
  | 'general';

export type AgentStatus = 'DRAFT' | 'TESTING' | 'READY' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export type ToneType = 'professional' | 'friendly' | 'casual' | 'concise' | 'luxury' | 'energetic';
export type BehaviorType = 'concise' | 'detailed' | 'proactive' | 'conservative' | 'sales' | 'service';
export type LanguageType = 'en' | 'fa' | 'bilingual';

export interface ServiceItem {
  id: string;
  name: string;
  price: number; // in currency units (e.g. Toman or USD)
  durationMinutes: number;
  description: string;
  /** Optional buffer (minutes) the business needs after this service before the
   * next appointment on the same staff member. Defaults to 0. */
  bufferMinutesAfter?: number;
}

export interface BusinessHours {
  day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  isOpen: boolean;
  openTime: string; // "09:00"
  closeTime: string; // "20:00"
}

/** A single closed date (holiday / staff leave / maintenance). Stored on the
 * business so no appointments can be booked that day. */
export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

export interface FAQItem {
  id: string;
  question: string;
  answer: string;
  category?: string;
}

export interface Business {
  id: string;
  name: string;
  type: BusinessType;
  description: string;
  location: string;
  language: LanguageType;
  currency: string; // e.g. "toman" or "$"
  timezone: string;
  hours: BusinessHours[];
  services: ServiceItem[];
  pricingNotes?: string;
  faqs: FAQItem[];
  policies: {
    cancellation: string;
    refund: string;
    bookingNotice: string;
  };
  communicationStyle: string;
  status: 'ACTIVE' | 'INACTIVE' | 'PAUSED';
  /** Dates the business is closed (holidays, maintenance). No appointments may
   * be booked on these dates. */
  holidays?: Holiday[];
  /** Origins permitted to embed the chat widget for this business. Enforced by
   * the runtime CORS check on /api/runtime/chat. An empty list in development
   * allows localhost for convenience. */
  allowedWidgetOrigins?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StructuredAgentConfig {
  personality: {
    tone: ToneType;
    behavior: BehaviorType;
    language: LanguageType;
    customPrompt?: string;
  };
  goals: string[];
  allowedActions: string[];
  restrictedActions: string[];
  escalationRules: string[];
  bookingRules: string;
  orderRules: string;
  refundRules: string;
  toolsEnabled: string[];
}

export interface Agent {
  id: string;
  businessId: string;
  name: string;
  description: string;
  version: number;
  status: AgentStatus;
  /** Lifecycle state the agent was paused FROM (set on pause, cleared on unpause). */
  pausedFrom?: AgentStatus;
  systemPrompt: string;
  structuredConfig: StructuredAgentConfig;
  /** AI provider backing this agent. The platform is free-first: `ollama`
   *  runs a local/open-source model with no paid API; `gemini` is an optional
   *  cloud provider. The runtime resolves a provider adapter from this field
   *  (see src/server/llmProvider.ts) and degrades gracefully when a provider's
   *  credentials/daemon are unavailable. */
  llmProvider: 'gemini' | 'ollama';
  model: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * An immutable snapshot of an agent's configuration at a point in time.
 * Production conversations use the PUBLISHED version; DRAFT/TESTING versions
 * are only usable from the authenticated simulator. Editing a draft never
 * changes the live (PUBLISHED) agent until an explicit publish operation.
 */
export type AgentVersionStatus = 'DRAFT' | 'TESTING' | 'PUBLISHED' | 'ARCHIVED';

export interface AgentVersion {
  id: string;
  agentId: string;
  businessId: string;
  versionNumber: number;
  status: AgentVersionStatus;
  systemPrompt: string;
  structuredConfig: StructuredAgentConfig;
  model: string;
  changeNote?: string;
  createdAt: string;
  publishedAt?: string;
}

export interface KnowledgeChunk {
  id: string;
  businessId: string;
  title: string;
  type: 'faq' | 'document' | 'service_catalog' | 'policy' | 'text';
  content: string;
  tags: string[];
  createdAt: string;
}

export interface Customer {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  email?: string;
  notes?: string;
  createdAt: string;
}

export type ConversationStatus = 'AI_HANDLING' | 'WAITING_FOR_HUMAN' | 'HUMAN_HANDLING' | 'RESOLVED';
export type ChannelType = 'web_chat' | 'instagram' | 'sms' | 'voice';

export interface ToolCallRecord {
  id: string;
  toolName: string;
  args: Record<string, any>;
  result: any;
  timestamp: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: 'customer' | 'agent' | 'human_agent' | 'system';
  content: string;
  toolCalls?: ToolCallRecord[];
  channel: ChannelType;
  timestamp: string;
}

export interface Conversation {
  id: string;
  businessId: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  channel: ChannelType;
  status: ConversationStatus;
  summary?: string;
  lastMessageAt: string;
  createdAt: string;
  /** Reason captured when the AI escalated to a human. */
  handoffReason?: string;
  /** When the AI requested a human (set on WAITING_FOR_HUMAN). */
  handoffRequestedAt?: string;
  /** When a human took over (set on HUMAN_HANDLING). */
  handoffStartedAt?: string;
  /** When the conversation was resolved (set on RESOLVED). */
  resolvedAt?: string;
}

export interface StaffMember {
  id: string;
  businessId: string;
  name: string;
  role: string;
  servicesHandled: string[]; // service IDs
  /** Per-day working hours for this staff member. If absent for a day, the
   * staff member is unavailable that day. Falls back to business hours. */
  workingHours?: BusinessHours[];
  /** Dates this staff member is unavailable (vacation, sick leave). */
  timeOff?: Holiday[];
}

export interface Appointment {
  id: string;
  businessId: string;
  serviceId: string;
  serviceName: string;
  staffMemberId?: string;
  staffName?: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'RESCHEDULED';
  notes?: string;
  createdAt: string;
}

export interface Product {
  id: string;
  businessId: string;
  name: string;
  sku: string;
  price: number;
  inventory: number;
  description: string;
  category: string;
  imageUrl?: string;
}

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  businessId: string;
  customerId: string;
  customerName: string;
  items: OrderItem[];
  totalAmount: number;
  status: 'PENDING' | 'PAID' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
  createdAt: string;
}

export type IntegrationState = 'NOT_CONFIGURED' | 'CONFIGURING' | 'CONNECTED' | 'ERROR' | 'DISCONNECTED';

export type IntegrationProviderType = 'google_calendar' | 'meta_instagram' | 'twilio_sms' | 'voice_ai';

export interface ChannelConfig {
  id: string;
  businessId: string;
  type: ChannelType;
  status: 'connected' | 'not_configured' | 'configuration_required' | 'disabled';
  details: string;
  updatedAt: string;
  configData?: Record<string, string>;
}

export interface IntegrationConfig {
  id: string;
  businessId: string;
  provider: IntegrationProviderType;
  /** Lifecycle state. CONNECTED is ONLY set after the provider validates the
   * credentials via IntegrationProvider.validate(). Never trust a frontend
   * `connected: true`. */
  state: IntegrationState;
  statusMessage: string;
  /** True if credentials have been stored server-side (never returned to the
   * frontend). Does NOT imply the provider is connected — see `state`. */
  credentialsSet: boolean;
  lastSync?: string;
  lastValidatedAt?: string;
  lastError?: string;
  /** Non-secret provider configuration (e.g. selected calendar id, phone
   * number). Credentials are NEVER stored here. */
  configData?: Record<string, string>;
}

export interface AgentTemplate {
  id: string;
  name: string;
  businessType: BusinessType;
  icon: string;
  description: string;
  defaultServices: ServiceItem[];
  defaultFaqs: FAQItem[];
  defaultAgentConfig: Partial<StructuredAgentConfig>;
}

export interface UsageRecord {
  id: string;
  businessId: string;
  date: string;
  tokensUsed: number;
  estimatedCostUsd: number;
  requestsCount: number;
  voiceMinutes: number;
  smsCount: number;
  /** Real input tokens from the provider's usageMetadata (Phase 19). */
  inputTokens?: number;
  /** Real output tokens from the provider's usageMetadata. */
  outputTokens?: number;
  agentId?: string;
  model?: string;
  provider?: string;
}

export interface AuditLog {
  id: string;
  businessId: string;
  agentId?: string;
  action: string;
  details: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Agent evaluation engine
// ---------------------------------------------------------------------------

/** Structured failure categories (never free-form) used by the evaluator. */
export type FailureCategory =
  | 'MISSING_KNOWLEDGE'
  | 'BAD_INSTRUCTION'
  | 'BAD_TOOL_SELECTION'
  | 'BAD_TOOL_ARGUMENT'
  | 'MISSING_TOOL'
  | 'MISSING_INTEGRATION'
  | 'GROUNDING_FAILURE'
  | 'BUSINESS_RULE_FAILURE'
  | 'SAFETY_FAILURE'
  | 'HANDOFF_FAILURE'
  | 'OTHER';

/** Evaluation dimensions the engine covers. */
export type EvalDimension =
  | 'factual_knowledge'
  | 'hallucination'
  | 'tool_selection'
  | 'tool_argument'
  | 'business_rule'
  | 'appointment'
  | 'handoff'
  | 'safety'
  | 'prompt_injection'
  | 'unknown_handling';

export type EvalSeverity = 'critical' | 'warning';

/**
 * A test scenario executed against the REAL agent runtime. Data-driven so it
 * can be persisted and replayed. Deterministic assertions drive scoring; an
 * optional LLM judge (through the provider abstraction) may add a fuzzy
 * signal but never overrides a critical deterministic failure.
 */
export interface EvalScenario {
  id: string;
  name: string;
  /** The customer message sent to the runtime. */
  userMessage: string;
  /** Dimension this scenario primarily exercises. */
  dimension: EvalDimension;
  severity: EvalSeverity;
  description?: string;
  /** Tool names that MUST be invoked (each must appear in the captured tool calls). */
  expectedToolCalls?: string[];
  /** Tool names that MUST NOT be invoked. */
  forbiddenTools?: string[];
  /** Verify a tool was called with args containing these key/value pairs. */
  expectedToolArgs?: { tool: string; argsContain: Record<string, any> };
  /** When true, the run must escalate (WAITING_FOR_HUMAN or transfer_to_human). */
  expectHandoff?: boolean;
  /** Substrings the reply MUST contain (else grounding/knowledge failure). */
  mustContain?: string[];
  /** Substrings the reply MUST NOT contain (fabricated facts / leaked data). */
  mustNotContain?: string[];
}

export interface EvalCheckResult {
  dimension: EvalDimension;
  passed: boolean;
  detail: string;
  category: FailureCategory;
}

export interface EvalScenarioResult {
  scenarioId: string;
  scenarioName: string;
  dimension: EvalDimension;
  severity: EvalSeverity;
  passed: boolean;
  checks: EvalCheckResult[];
  failureCategories: FailureCategory[];
  /** Captured agent reply. */
  reply: string;
  /** Captured tool calls (name + args + success). */
  toolCalls: { toolName: string; args: Record<string, any>; success: boolean }[];
  conversationId: string;
  executionId: string;
  status: string;
  latencyMs: number;
  /** Present when the runtime/ provider itself errored (graceful, non-fatal to the engine). */
  error?: string;
}

export interface EvalRunResult {
  id: string;
  businessId: string;
  agentId: string;
  /** Version evaluated (DRAFT/TESTING). Never a PUBLISHED version. */
  versionId: string;
  timestamp: string;
  overallPassed: boolean;
  totalScenarios: number;
  passedScenarios: number;
  criticalFailures: number;
  /** Provider adapter used (free-first: 'ollama' when no Gemini key). */
  providerUsed: string;
  scenarioResults: EvalScenarioResult[];
}

// ---------------------------------------------------------------------------
// Agent self-correction loop
// ---------------------------------------------------------------------------

/** The kind of targeted correction the engine can apply. Safety controls are
 *  NEVER weakened automatically — a SAFETY_FAILURE only ever produces a
 *  PROPOSE_HUMAN_REVIEW proposal. */
export type CorrectionActionType =
  | 'ENABLE_TOOL'
  | 'ADD_KNOWLEDGE_FROM_SOURCE'
  | 'STRENGTHEN_GROUNDING_INSTRUCTIONS'
  | 'CORRECT_TOOL_ARGUMENT_INSTRUCTIONS'
  | 'CORRECT_BUSINESS_RULE_INSTRUCTIONS'
  | 'CORRECT_HANDOFF_INSTRUCTIONS'
  | 'PROPOSE_HUMAN_REVIEW';

/** A proposed (and, when safe, applied) correction for one failure category.
 *  Every correction is auditable: it carries the reason and the affected
 *  scenario ids. `humanReviewRequired` gates auto-application. */
export interface CorrectionProposal {
  category: FailureCategory;
  actionType: CorrectionActionType;
  reason: string;
  humanReviewRequired: boolean;
  targetScenarioIds: string[];
  /** Action-specific payload, e.g. the tool name to enable or the trusted
   *  knowledge source to add. Never carries fabricated facts. */
  details?: {
    toolName?: string;
    knowledgeTitle?: string;
    knowledgeContent?: string;
    knowledgeTags?: string[];
    instructionAppend?: string;
    ruleField?: 'bookingRules' | 'refundRules' | 'orderRules';
  };
}

/** One iteration of the correction loop: the proposal considered, the version
 *  it was applied to, the new draft it produced, and the re-evaluation. */
export interface CorrectionAttempt {
  attemptNumber: number;
  proposal: CorrectionProposal;
  appliedToVersionId: string;
  resultingVersionId: string;
  originalEvaluationId: string;
  resultingEvaluationId: string;
  status: 'APPLIED' | 'SKIPPED' | 'HUMAN_REVIEW';
  timestamp: string;
}

/** The full result of a self-correction run, persisted for auditability. */
export interface CorrectionResult {
  id: string;
  businessId: string;
  agentId: string;
  /** Version the loop started from (DRAFT/TESTING, never PUBLISHED). */
  startVersionId: string;
  /** Version the loop ended on (the last corrected draft, or the start
   *  version when no correction was needed / possible). */
  finalVersionId: string;
  resolved: boolean;
  /** True when the agent could not be auto-corrected and must be reviewed by
   *  a human (safety failure, missing tool, no trusted knowledge source, or
   *  max attempts exhausted without a pass). */
  humanReviewRequired: boolean;
  maxAttempts: number;
  attempts: CorrectionAttempt[];
  /** The final evaluation run id (null only if the very first evaluation
   *  could not be produced). */
  finalEvaluationId: string | null;
  /** True iff finalEvaluationId corresponds to a passing run. */
  finalEvaluationPassed: boolean;
  reason: string;
  timestamp: string;
}

/** A trustworthy knowledge source the owner maps to a specific scenario's
 *  missing-knowledge requirement. The engine NEVER fabricates knowledge; it
 *  only adds chunks whose content came from the owner. */
export interface TrustedKnowledgeSource {
  scenarioId: string;
  title: string;
  content: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Telemetry / Observability
//
// Durable, tenant-scoped event records emitted from the REAL agent runtime,
// tool execution, evaluation, correction, and publish paths. The LLM NEVER
// writes or modifies telemetry — recording is server-side only at well-defined
// seams. Records prefer metadata + safe summaries over raw conversation
// content, and never carry secrets/credentials.
// ---------------------------------------------------------------------------

export type TelemetryEventType =
  | 'CUSTOMER_MESSAGE'
  | 'AGENT_RESPONSE'
  | 'TOOL_EXECUTION'
  | 'HUMAN_HANDOFF'
  | 'EVALUATION_RUN'
  | 'CORRECTION_ATTEMPT'
  | 'VERSION_PUBLISHED'
  // Orchestration lifecycle (recorded server-side only; same safe-summary
  // discipline — never secrets/PII/tool-args).
  | 'PROSPECT_CREATED'
  | 'DESIGN_CREATED'
  | 'DESIGN_APPROVED'
  | 'FACTORY_JOB_STARTED'
  | 'FACTORY_JOB_STEP'
  | 'FACTORY_JOB_FAILED'
  | 'AGENT_DELIVERED'
  | 'DELIVERY_ACCEPTED'
  // Owner-account provisioning (ids only — NEVER the one-time password).
  | 'OWNER_ACCOUNT_PROVISIONED'
  // Lead research (evidence/extraction layer — never carries raw LLM prompts).
  | 'LEAD_RESEARCH_RUN'
  | 'LEAD_RESEARCH_COMPLETED'
  | 'LEAD_RESEARCH_FAILED'
// Lead discovery (candidate intake — never triggers research/scoring/outreach).
  | 'DISCOVERY_RUN'
  | 'DISCOVERY_COMPLETED'
  | 'DISCOVERY_FAILED'
// Discovery acceptance (data/lifecycle transition only — never automation).
  | 'DISCOVERY_ACCEPTED'
  | 'DISCOVERY_DISMISSED'
// Prospect analyze (thin composition over research — never a decision).
  | 'PROSPECT_ANALYZE_RUN'
  | 'PROSPECT_ANALYZE_COMPLETED'
  | 'PROSPECT_ANALYZE_FAILED'
// Designer proposal generation (DRAFT only — approval stays human).
  | 'DESIGN_GENERATE_RUN'
  | 'DESIGN_GENERATE_COMPLETED'
  | 'DESIGN_GENERATE_FAILED';

export interface TelemetryEvent {
  id: string;
  /** Tenant scope — EVERY record is business-scoped; never cross-tenant. */
  businessId: string;
  /** ISO timestamp of the event. */
  timestamp: string;
  eventType: TelemetryEventType;
  agentId?: string;
  /** Version the event pertains to (published version for prod, draft/test
   *  version for simulator/eval/correct activity). */
  versionId?: string;
  conversationId?: string;
  channel?: string;
  /** LLM provider adapter used (e.g. 'ollama', 'google'). */
  provider?: string;
  model?: string;
  /** True for REAL published-agent activity (production widget). False for
   *  DRAFT/TESTING/simulator activity. The monitoring UI separates these. */
  isPublished: boolean;
  /** Tool name (TOOL_EXECUTION only). */
  toolName?: string;
  /** Success flag (TOOL_EXECUTION, AGENT_RESPONSE). */
  success?: boolean;
  latencyMs?: number;
  /** Token usage when available (input/output/total). */
  inputTokens?: number;
  outputTokens?: number;
  tokensUsed?: number;
  /** Safe, non-sensitive summary or metadata (never secrets/raw PII). */
  summary?: string;
  /** Structured extra metadata (counts, categories, etc.). JSON-serialized. */
  metadata?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Sales & Delivery Orchestrator (Phase: orchestration MVP core)
//
// Deterministic orchestration on top of the Agent Factory. Prospects are
// platform-owned until conversion (prospect.businessId links the real tenant).
// All state machines are explicit; LLMs may produce artifacts but never
// perform transitions.
// ---------------------------------------------------------------------------

export type ProspectStatus = 'NEW' | 'DESIGN_PROPOSED' | 'APPROVED' | 'IN_FACTORY' | 'CONVERTED' | 'REJECTED';

export interface Prospect {
  id: string;
  /** Linked tenant once the prospect converts to a real factory business. */
  businessId?: string;
  businessName: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
  instagramHandle?: string;
  location?: string;
  notes?: string;
  status: ProspectStatus;
  /** One-way provenance link to the discovery result that produced this prospect (set at accept time). */
  discoveryResultId?: string;
  createdAt: string;
  updatedAt: string;
}

export type DesignStatus = 'DRAFT' | 'APPROVED' | 'SUBMITTED' | 'REJECTED';

/**
 * The structured artifact a (future) Designer agent produces and a human
 * approves. `configuration` is the factory input: business facts, agent spec,
 * evaluation scenarios, trusted knowledge sources, and knowledge chunks used
 * to satisfy the activation readiness gate.
 */
export interface DesignConfiguration {
  business: {
    name: string;
    type: string;
    description?: string;
    location?: string;
    timezone?: string;
    language?: string;
    currency?: string;
    hours?: BusinessHours[];
    services?: ServiceItem[];
    faqs?: FAQItem[];
    policies?: Business['policies'];
    communicationStyle?: string;
    allowedWidgetOrigins?: string[];
  };
  agent: {
    name: string;
    description?: string;
    systemPrompt: string;
    structuredConfig: StructuredAgentConfig;
    llmProvider?: Agent['llmProvider'];
    model?: string;
  };
  scenarios: EvalScenario[];
  trustedKnowledgeSources?: TrustedKnowledgeSource[];
  /** Optional knowledge chunks created for the tenant so the readiness gate's
   *  "Knowledge base" check can pass. */
  knowledge?: { title: string; type?: KnowledgeChunk['type']; content: string; tags?: string[] }[];
}

export interface DesignProposal {
  id: string;
  prospectId: string;
  title: string;
  problemStatement: string;
  proposedSolution: string;
  agentType: string;
  capabilities: string[];
  channels: string[];
  integrations: string[];
  configuration?: DesignConfiguration;
  status: DesignStatus;
  approvedAt?: string;
  /** Designer provenance (Task 11). Present only on generated proposals. */
  generationKey?: string;
  sourceReportId?: string;
  generatorModel?: string;
  rationale?: string;
  uncertainty?: string;
  createdAt: string;
  updatedAt: string;
}

export type FactoryJobStatus =
  | 'PENDING'
  | 'SUBMITTING'
  | 'EVALUATING'
  | 'CORRECTING'
  | 'PUBLISHING'
  | 'ACTIVATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'DEAD_LETTERED';

export interface FactoryJob {
  id: string;
  prospectId: string;
  designProposalId: string;
  businessId?: string;
  agentId?: string;
  status: FactoryJobStatus;
  currentStep: FactoryJobStatus;
  idempotencyKey: string;
  attemptCount: number;
  lastError?: string;
  deadLettered: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Sales workforce execution substrate (Phase A / Task 34)
// ---------------------------------------------------------------------------

/** Platform-level autonomous worker. INSTANCES of one architecture — role and
 *  config drive behavior; never a per-worker class. PLATFORM_OWNER-only. */
export type SalesWorkerRole = 'DISCOVERY_RESEARCH' | 'PHONE_SALES' | 'INSTAGRAM_SALES';

export type SalesWorkerStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'OFFLINE';

export type SalesChannelType = 'noop' | 'phone' | 'instagram_dm';

export interface SalesWorkerScheduleWindow {
  /** '*' or a weekday name; startMin/endMin are minutes-from-midnight. */
  day: string;
  startMin: number;
  endMin: number;
  activity: string;
}

export interface SalesWorkerSchedule {
  enabled: boolean;
  windows: SalesWorkerScheduleWindow[];
  timezone?: string;
}

export interface SalesWorkerLimits {
  maxConcurrentTasks: number;
  maxAttempts: number;
}

export interface SalesWorker {
  id: string;
  role: SalesWorkerRole;
  status: SalesWorkerStatus;
  objective?: string;
  channel: SalesChannelType;
  schedule: SalesWorkerSchedule;
  limits: SalesWorkerLimits;
  strategyVersionId?: string;
  currentTaskId?: string;
  lastActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Durable execution unit. Persisted before execution; claimed atomically. */
export type SalesTaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DEAD_LETTERED';

export interface SalesTask {
  id: string;
  workerId: string;
  type: string;
  payload?: Record<string, any>;
  status: SalesTaskStatus;
  attemptCount: number;
  /** Earliest time the task may be claimed (backoff window). */
  availableAt: string;
  claimedAt?: string;
  completedAt?: string;
  lastError?: string;
  /** UNIQUE — one logical task; duplicate enqueue returns the existing task. */
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'ACCEPTED';

export interface Delivery {
  id: string;
  prospectId: string;
  businessId: string;
  agentId: string;
  status: DeliveryStatus;
  deliveryMethod: string;
  deliveryPayload?: Record<string, any>;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Delivery onboarding artifact (Phase C / Task 19) — deterministic, LLM-free
// representation assembled at read time from persisted platform state.
// ---------------------------------------------------------------------------

export interface OnboardingChannel {
  type: string;
  /** Existing channel status (e.g. 'connected', 'not_configured'). */
  status: string;
  /** Configured capability statement (web_chat only) or an honest not-configured note. */
  note?: string;
  /** Platform-controlled ABSOLUTE embed snippet (web_chat only when connected). */
  embedSnippet?: string;
  /** Normalized widget origin allow-list (web_chat only; public, no secrets). */
  allowedOrigins?: string[];
}

export interface OnboardingArtifact {
  deliveryId: string;
  deliveryStatus: DeliveryStatus;
  deliveryMethod: string;
  deliveredAt?: string;
  business: { id: string; name: string };
  agent: {
    id: string;
    name: string;
    status: AgentStatus;
    /** Supported capabilities derived ONLY from persisted goals/tools (never fabricated). */
    capabilities: string[];
  };
  channels: OnboardingChannel[];
  /** Present only after the existing acceptance workflow ran. */
  acceptance?: { acceptedBy: string; acceptedAt: string };
  /** Deterministic owner-facing guidance (no LLM, no marketing claims). */
  instructions: string[];
}

export interface Acceptance {
  id: string;
  /** UNIQUE — one acceptance per delivery. */
  deliveryId: string;
  businessId: string;
  acceptedBy: string;
  acceptanceMethod?: string;
  acceptedAt: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

// ============================================================================
// Lead research reports (Phase C / Task 2)
// ============================================================================

export type LeadResearchStatus = 'COMPLETED' | 'FAILED';
export type LeadResearchInputSource = 'manual' | 'business_provided' | 'system_assembled';
export type Verification = 'VERIFIED' | 'UNVERIFIED' | 'UNKNOWN';
export type AppointmentFit = 'STRONG' | 'PARTIAL' | 'NONE' | 'UNKNOWN';

export interface ResearchSignal {
  key: string;
  verification: Verification;
  /** Deterministic provenance: the excerpt quoted from the source text, when
   *  any. Only a verbatim substring of the input makes a signal VERIFIED. */
  sourceExcerpt?: string;
}

export interface ResearchChannelSignal {
  channel: string;
  reachable: boolean;
  verification: Verification;
  sourceExcerpt?: string;
}

/** Structured research document (validated schema — never trust extra keys). */
export interface ResearchReportDocument {
  appointmentFit: AppointmentFit;
  painSignals: ResearchSignal[];
  digitalGaps: ResearchSignal[];
  channels: ResearchChannelSignal[];
  evidence: { url?: string; snippet?: string }[];
  disqualifiers: ResearchSignal[];
  caveats: string[];
  summary?: string;
}

export interface LeadResearchReport {
  id: string;
  prospectId: string;
  status: LeadResearchStatus;
  inputSource: LeadResearchInputSource;
  inputTextExcerpt: string;
  report: ResearchReportDocument;
  /** Model that produced the extraction (or 'fallback' when unavailable). */
  llmModel: string;
  /** Deterministic score snapshot (scorer remains the authority). */
  score: number;
  scoreBand: string;
  scoreReasons: string[];
  error?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Lead discovery (candidate intake layer — platform-owner scope, pre-tenant)
// ---------------------------------------------------------------------------

/** Manual candidate input. Every field is untrusted — data, never instructions. */
export interface DiscoveryCandidateInput {
  businessName: string;
  location?: string;
  phone?: string;
  website?: string;
  instagramHandle?: string;
  notes?: string;
  sourceUrl?: string;
}

/** Normalized candidate as persisted on a discovery result. */
export interface NormalizedDiscoveryCandidate {
  businessName: string;
  location?: string;
  phone?: string;
  website?: string;
  instagramHandle?: string;
  notes?: string;
  sourceUrl?: string;
  /** Deterministic in-run identity key (pid: / ig: / dom: / tel: / nl: prefixes) or absent when unsafe. */
  dedupeKey?: string;
  /** Stable provider result id (e.g. Google place id). Set only by trusted adapters, never by manual input. */
  providerResultId?: string;
}

export type DiscoveryRunStatus = 'COMPLETED' | 'FAILED';

export interface DiscoveryRun {
  id: string;
  /** Provider registry id (e.g. 'manual_list'). */
  provider: string;
  params?: { query?: string; location?: string };
  status: DiscoveryRunStatus;
  resultCount: number;
  duplicateCount: number;
  invalidCount: number;
  error?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveryResult {
  id: string;
  runId: string;
  /** Set only when a human later accepts the candidate into a prospect. */
  prospectId?: string;
  sourceProvider: string;
  sourceUrl?: string;
  sourceType: 'manual' | 'api';
  /** Bounded copy of the mapped candidate fields (never a raw provider response). */
  raw?: Record<string, unknown>;
  normalized: NormalizedDiscoveryCandidate;
  /** Discovery can never produce VERIFIED facts — research owns verification. */
  verification: 'UNVERIFIED';
  /** Retention bound for provider-restricted content (e.g. Google non-ID data); acceptance refused after this. */
  sourceExpiresAt?: string;
  dismissedAt?: string;
  createdAt: string;
}

/** Google Places usage counter row (one per UTC-day bucket; operator guard). */
export interface PlacesUsage {
  id: string;
  bucket: string;
  calls: number;
  updatedAt: string;
}
