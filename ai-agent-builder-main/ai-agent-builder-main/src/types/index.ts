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
  systemPrompt: string;
  structuredConfig: StructuredAgentConfig;
  llmProvider: 'gemini' | 'openai' | 'anthropic';
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
