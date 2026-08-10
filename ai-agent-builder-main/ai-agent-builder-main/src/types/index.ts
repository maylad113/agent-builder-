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
}

export interface BusinessHours {
  day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  isOpen: boolean;
  openTime: string; // "09:00"
  closeTime: string; // "20:00"
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
}

export interface StaffMember {
  id: string;
  businessId: string;
  name: string;
  role: string;
  servicesHandled: string[]; // service IDs
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
  provider: 'google_calendar' | 'meta_instagram' | 'twilio_sms' | 'voice_ai';
  connected: boolean;
  statusMessage: string;
  credentialsSet: boolean;
  lastSync?: string;
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
}

export interface AuditLog {
  id: string;
  businessId: string;
  agentId?: string;
  action: string;
  details: string;
  timestamp: string;
}
