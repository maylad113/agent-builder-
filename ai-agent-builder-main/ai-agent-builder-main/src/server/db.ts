import fs from 'fs';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import {
  Business,
  Agent,
  AgentVersion,
  KnowledgeChunk,
  Customer,
  Conversation,
  Message,
  Appointment,
  Product,
  Order,
  ChannelConfig,
  IntegrationConfig,
  AgentTemplate,
  UsageRecord,
  AuditLog,
  StaffMember,
  User,
  Session
} from '../types';
import { hashPassword } from './passwords';
import { initEmbeddingsTable } from './embeddings';

/**
 * SQLite-backed repository for the AI Agent Factory MVP.
 *
 * Design goals:
 *  - Keep the exact call-site shape the rest of the server code uses
 *    (`db.businesses.find(...)`, `db.agents.filter(...)`, `db.customers.push(...)`,
 *    `db.knowledgeChunks.splice(...)`, `db.usageRecords.reduce(...)`, ...).
 *  - Every read goes to SQLite; every write goes to SQLite. No business data
 *    lives in JS arrays.
 *  - Objects returned by `find`/`filter` are fresh parses of DB rows, so a
 *    caller that mutates the object (e.g. `conversation.status = ...`) must
 *    call `<collection>.update(record)` to persist — the call sites do that.
 *  - Nested/structured fields (arrays/objects) are stored as JSON TEXT and
 *    parsed back into the exact shapes defined in src/types/index.ts.
 */

// ---------------------------------------------------------------------------
// Table configuration
// ---------------------------------------------------------------------------

interface TableConfig {
  table: string;
  /** Field names whose value is an object/array and is stored as JSON TEXT. */
  jsonColumns: string[];
  /** Field names stored as SQLite INTEGER 0/1 but exposed as booleans. */
  booleanColumns: string[];
}

const TABLES: Record<string, TableConfig> = {
  businesses: {
    table: 'businesses',
    jsonColumns: ['hours', 'services', 'faqs', 'policies', 'holidays', 'allowedWidgetOrigins'],
    booleanColumns: []
  },
  agents: {
    table: 'agents',
    jsonColumns: ['structuredConfig'],
    booleanColumns: []
  },
  agentVersions: {
    table: 'agent_versions',
    jsonColumns: ['structuredConfig'],
    booleanColumns: []
  },
  knowledgeChunks: {
    table: 'knowledge_chunks',
    jsonColumns: ['tags'],
    booleanColumns: []
  },
  customers: {
    table: 'customers',
    jsonColumns: [],
    booleanColumns: []
  },
  conversations: {
    table: 'conversations',
    jsonColumns: [],
    booleanColumns: []
  },
  messages: {
    table: 'messages',
    jsonColumns: ['toolCalls'],
    booleanColumns: []
  },
  appointments: {
    table: 'appointments',
    jsonColumns: [],
    booleanColumns: []
  },
  staffMembers: {
    table: 'staff_members',
    jsonColumns: ['servicesHandled'],
    booleanColumns: []
  },
  products: {
    table: 'products',
    jsonColumns: [],
    booleanColumns: []
  },
  orders: {
    table: 'orders',
    jsonColumns: ['items'],
    booleanColumns: []
  },
  channels: {
    table: 'channels',
    jsonColumns: ['configData'],
    booleanColumns: []
  },
  integrations: {
    table: 'integrations',
    jsonColumns: ['configData'],
    booleanColumns: ['credentialsSet']
  },
  templates: {
    table: 'templates',
    jsonColumns: ['defaultServices', 'defaultFaqs', 'defaultAgentConfig'],
    booleanColumns: []
  },
  usageRecords: {
    table: 'usage_records',
    jsonColumns: [],
    booleanColumns: []
  },
  auditLogs: {
    table: 'audit_logs',
    jsonColumns: [],
    booleanColumns: []
  },
  users: {
    table: 'users',
    jsonColumns: [],
    booleanColumns: []
  },
  sessions: {
    table: 'sessions',
    jsonColumns: [],
    booleanColumns: []
  }
};

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

function runMigrations(sqlite: BetterSqlite3.Database, migrationsDir: string): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL UNIQUE,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  );

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const appliedRows = sqlite.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>;
  const applied = new Set(appliedRows.map(r => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sqlite.exec(sql);
    sqlite.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    console.log(`[db] applied migration: ${file}`);
  }
}

// ---------------------------------------------------------------------------
// Collection: array-like facade over a SQLite table
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

class Collection<T extends { id: string }> {
  constructor(
    private sqlite: BetterSqlite3.Database,
    private config: TableConfig
  ) {}

  private columnNames(): string[] {
    const rows = this.sqlite.prepare(`PRAGMA table_info(${this.config.table})`).all() as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  private rowToObject(row: Row): T {
    const jsonSet = new Set(this.config.jsonColumns);
    const boolSet = new Set(this.config.booleanColumns);
    const obj: Record<string, any> = {};
    for (const [col, value] of Object.entries(row)) {
      const field = snakeToCamel(col);
      if (jsonSet.has(field)) {
        obj[field] = value == null ? undefined : JSON.parse(value);
      } else if (boolSet.has(field)) {
        obj[field] = value === 1 || value === true;
      } else {
        obj[field] = value;
      }
    }
    return obj as T;
  }

  private objectToRow(obj: T): Row {
    const jsonSet = new Set(this.config.jsonColumns);
    const boolSet = new Set(this.config.booleanColumns);
    const row: Row = {};
    for (const [field, value] of Object.entries(obj as Record<string, any>)) {
      if (field === 'id') {
        row.id = value;
        continue;
      }
      const col = camelToSnake(field);
      if (jsonSet.has(field)) {
        row[col] = value == null ? null : JSON.stringify(value);
      } else if (boolSet.has(field)) {
        row[col] = value ? 1 : 0;
      } else {
        row[col] = value == null ? null : value;
      }
    }
    return row;
  }

  /** Load every row (insertion order), parsed to domain objects. */
  private allRows(): T[] {
    const rows = this.sqlite.prepare(`SELECT * FROM ${this.config.table} ORDER BY rowid`).all() as Row[];
    return rows.map(r => this.rowToObject(r));
  }

  find(predicate: (item: T) => boolean): T | undefined {
    return this.allRows().find(predicate);
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.allRows().filter(predicate);
  }

  findIndex(predicate: (item: T) => boolean): number {
    return this.allRows().findIndex(predicate);
  }

  push(...items: T[]): number {
    const columns = this.columnNames();
    const allowed = new Set(columns);
    const insert = this.sqlite.prepare(
      `INSERT INTO ${this.config.table} (id, ${columns.filter(c => c !== 'id').join(', ')}) VALUES (${columns
        .map(() => '?')
        .join(', ')})`
    );
    for (const item of items) {
      const row = this.objectToRow(item);
      const values = columns.map(c => (c === 'id' ? row.id : allowed.has(c) ? row[c] ?? null : null));
      insert.run(values);
    }
    return this.length;
  }

  /** Persist the current state of a record that a caller mutated in place. */
  update(item: T): void {
    const columns = this.columnNames().filter(c => c !== 'id');
    const row = this.objectToRow(item);
    const setClause = columns.map(c => `${c} = ?`).join(', ');
    const stmt = this.sqlite.prepare(`UPDATE ${this.config.table} SET ${setClause} WHERE id = ?`);
    const result = stmt.run([...columns.map(c => row[c] ?? null), item.id]);
    if (result.changes === 0) {
      throw new Error(`Cannot update: no row with id '${item.id}' in ${this.config.table}`);
    }
  }

  /** Array semantics: delete rows between start and start+deleteCount. */
  splice(start: number, deleteCount?: number): T[] {
    const rows = this.allRows();
    const removed = rows.splice(start, deleteCount === undefined ? rows.length - start : deleteCount);
    const del = this.sqlite.prepare(`DELETE FROM ${this.config.table} WHERE id = ?`);
    for (const r of removed) {
      del.run(r.id);
    }
    return removed;
  }

  slice(start?: number, end?: number): T[] {
    return this.allRows().slice(start, end);
  }

  reduce<U>(callback: (acc: U, item: T) => U, initial: U): U {
    return this.allRows().reduce(callback, initial);
  }

  get length(): number {
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS c FROM ${this.config.table}`).get() as { c: number };
    return row.c;
  }

  /** Lets `res.json(db.<collection>)` serialize as the plain array it always was. */
  toJSON(): T[] {
    return this.allRows();
  }

  [Symbol.iterator](): Iterator<T> {
    return this.allRows()[Symbol.iterator]();
  }
}

// ---------------------------------------------------------------------------
// AppDatabase
// ---------------------------------------------------------------------------

export interface AppDatabaseOptions {
  dbPath?: string;
  migrationsDir?: string;
  seed?: boolean;
}

export class AppDatabase {
  public sqlite: BetterSqlite3.Database;
  public readonly dbPath: string;
  public readonly migrationsDir: string;

  public businesses: Collection<Business>;
  public agents: Collection<Agent>;
  public agentVersions: Collection<AgentVersion>;
  public knowledgeChunks: Collection<KnowledgeChunk>;
  public customers: Collection<Customer>;
  public conversations: Collection<Conversation>;
  public messages: Collection<Message>;
  public appointments: Collection<Appointment>;
  public staffMembers: Collection<StaffMember>;
  public products: Collection<Product>;
  public orders: Collection<Order>;
  public channels: Collection<ChannelConfig>;
  public integrations: Collection<IntegrationConfig>;
  public templates: Collection<AgentTemplate>;
  public usageRecords: Collection<UsageRecord>;
  public auditLogs: Collection<AuditLog>;
  public users: Collection<User>;
  public sessions: Collection<Session>;

  constructor(opts: AppDatabaseOptions = {}) {
    this.dbPath = opts.dbPath || process.env.DB_PATH || path.join(process.cwd(), 'data', 'agentforge.db');
    this.migrationsDir = opts.migrationsDir || process.env.MIGRATIONS_DIR || path.join(process.cwd(), 'migrations');

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.sqlite = new BetterSqlite3(this.dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');

    runMigrations(this.sqlite, this.migrationsDir);
    initEmbeddingsTable(this.sqlite);

    this.businesses = new Collection<Business>(this.sqlite, TABLES.businesses);
    this.agents = new Collection<Agent>(this.sqlite, TABLES.agents);
    this.agentVersions = new Collection<AgentVersion>(this.sqlite, TABLES.agentVersions);
    this.knowledgeChunks = new Collection<KnowledgeChunk>(this.sqlite, TABLES.knowledgeChunks);
    this.customers = new Collection<Customer>(this.sqlite, TABLES.customers);
    this.conversations = new Collection<Conversation>(this.sqlite, TABLES.conversations);
    this.messages = new Collection<Message>(this.sqlite, TABLES.messages);
    this.appointments = new Collection<Appointment>(this.sqlite, TABLES.appointments);
    this.staffMembers = new Collection<StaffMember>(this.sqlite, TABLES.staffMembers);
    this.products = new Collection<Product>(this.sqlite, TABLES.products);
    this.orders = new Collection<Order>(this.sqlite, TABLES.orders);
    this.channels = new Collection<ChannelConfig>(this.sqlite, TABLES.channels);
    this.integrations = new Collection<IntegrationConfig>(this.sqlite, TABLES.integrations);
    this.templates = new Collection<AgentTemplate>(this.sqlite, TABLES.templates);
    this.usageRecords = new Collection<UsageRecord>(this.sqlite, TABLES.usageRecords);
    this.auditLogs = new Collection<AuditLog>(this.sqlite, TABLES.auditLogs);
    this.users = new Collection<User>(this.sqlite, TABLES.users);
    this.sessions = new Collection<Session>(this.sqlite, TABLES.sessions);

    if (opts.seed !== false) {
      this.seed();
      this.seedUsers();
    }

    // Best-effort background indexing of seeded knowledge when an embedding
    // key is configured. Fire-and-forget: failures are non-fatal (keyword
    // fallback remains) and we must not block startup for optional providers.
    if (process.env.GEMINI_API_KEY) {
      import('./embeddings').then(({ indexChunk }) => {
        for (const c of this.knowledgeChunks.toJSON()) {
          indexChunk(c).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  close(): void {
    this.sqlite.close();
  }

  /** Seed the Tony's Barber Shop demo tenant. Idempotent: only runs when the DB is empty. */
  private seed(): void {
    const businessCount = (this.sqlite.prepare('SELECT COUNT(*) AS c FROM businesses').get() as { c: number }).c;
    if (businessCount > 0) {
      return;
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

    // 1. Seed Business A: Tony's Barber Shop
    const tonysBarber: Business = {
      id: 'biz-tonys-barber',
      name: "Tony's Barber Shop",
      type: 'barbershop',
      description: 'Premium local barbershop offering classic cuts, beard grooming, and hot towel treatments.',
      location: '123 Main Barber Street, Downtown',
      language: 'en',
      currency: 'toman',
      timezone: 'Asia/Tehran',
      hours: [...defaultHours],
      services: [
        { id: 'srv-1', name: 'Haircut', price: 300000, durationMinutes: 30, description: 'Classic precision haircut with styling.' },
        { id: 'srv-2', name: 'Beard trim', price: 200000, durationMinutes: 20, description: 'Sharp beard line-up, trimming, and beard oil application.' },
        { id: 'srv-3', name: 'Haircut + beard', price: 450000, durationMinutes: 45, description: 'Full grooming package: haircut, wash, beard trim & hot towel.' }
      ],
      pricingNotes: 'Prices are fixed in Toman. Tips are optional and appreciated.',
      faqs: [
        { id: 'faq-1', question: 'Do I need an appointment?', answer: 'Appointments are recommended to avoid waiting, but walk-ins are welcome if a slot is available.' },
        { id: 'faq-2', question: 'Where are you located?', answer: 'We are located at 123 Main Barber Street, Downtown (Next to Central Park).' },
        { id: 'faq-3', question: 'What payment methods do you accept?', answer: 'We accept POS card payments, cash, and online transfers.' }
      ],
      policies: {
        cancellation: 'Please cancel or reschedule at least 2 hours before your appointment.',
        refund: 'Services rendered are non-refundable. If unsatisfied, we offer a complimentary touch-up within 48 hours.',
        bookingNotice: 'Appointments can be booked up to 14 days in advance.'
      },
      communicationStyle: 'Friendly, welcoming, respectful, and direct.',
      status: 'ACTIVE',
      holidays: [],
      allowedWidgetOrigins: [], // empty => localhost allowed in dev (widget security)
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.businesses.push(tonysBarber);

    // 2. Staff Members for Tony's
    const staff1: StaffMember = {
      id: 'staff-1',
      businessId: 'biz-tonys-barber',
      name: 'Tony (Master Barber)',
      role: 'Owner & Master Barber',
      servicesHandled: ['srv-1', 'srv-2', 'srv-3']
    };
    const staff2: StaffMember = {
      id: 'staff-2',
      businessId: 'biz-tonys-barber',
      name: 'Marco (Senior Stylist)',
      role: 'Barber & Stylist',
      servicesHandled: ['srv-1', 'srv-2', 'srv-3']
    };
    this.staffMembers.push(staff1, staff2);

    // 3. Seed Agent for Tony's
    const tonysAgent: Agent = {
      id: 'agent-tonys-1',
      businessId: 'biz-tonys-barber',
      name: "Tony's AI Receptionist",
      description: 'Handles customer calls, web chats, FAQ queries, and appointment bookings.',
      version: 1,
      status: 'ACTIVE',
      llmProvider: 'gemini',
      model: 'gemini-3.6-flash',
      systemPrompt: `You are the official AI receptionist for Tony's Barber Shop. 
Your primary goal is to provide welcoming, accurate service information, answer customer questions based ONLY on official business facts, check availability, book appointments, and offer human handoff when requested or uncertain.
Never invent prices, hours, services, or availability that do not exist in the database.`,
      structuredConfig: {
        personality: {
          tone: 'friendly',
          behavior: 'service',
          language: 'en',
          customPrompt: 'Always end conversations with a polite note inviting the customer to visit.'
        },
        goals: [
          'Answer customer queries accurately',
          'Book haircuts and beard trims',
          'Explain pricing and location',
          'Transfer complex or angry queries to human owner'
        ],
        allowedActions: [
          'check_business_hours',
          'get_business_information',
          'check_availability',
          'book_appointment',
          'cancel_appointment',
          'reschedule_appointment',
          'search_products',
          'transfer_to_human'
        ],
        restrictedActions: [
          'Never give unauthorized discounts',
          'Never alter business operating hours',
          'Never promise free services'
        ],
        escalationRules: [
          'Customer requests to speak to a real person',
          'Refund dispute or complaint about a past haircut',
          'Unresolvable scheduling conflict'
        ],
        bookingRules: 'Appointments require customer full name and phone number. Maximum 14 days advance booking.',
        orderRules: 'Grooming products can be reserved for pickup in shop.',
        refundRules: 'Complimentary touch-up within 48 hours instead of cash refunds.',
        toolsEnabled: [
          'check_business_hours',
          'get_business_information',
          'check_availability',
          'book_appointment',
          'cancel_appointment',
          'reschedule_appointment',
          'search_products',
          'create_order',
          'get_order_status',
          'transfer_to_human'
        ]
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.agents.push(tonysAgent);

    // Seed a PUBLISHED version snapshot so the versioning system is consistent
    // for the demo tenant (runtime reads the agent row, but the dashboard +
    // simulator rely on version records existing).
    this.agentVersions.push({
      id: 'ver-tonys-1',
      agentId: 'agent-tonys-1',
      businessId: 'biz-tonys-barber',
      versionNumber: 1,
      status: 'PUBLISHED',
      systemPrompt: tonysAgent.systemPrompt,
      structuredConfig: tonysAgent.structuredConfig,
      model: tonysAgent.model,
      changeNote: 'Initial published version',
      createdAt: new Date().toISOString(),
      publishedAt: new Date().toISOString()
    });
    // 4. Knowledge Chunks
    this.knowledgeChunks.push(
      {
        id: 'kc-1',
        businessId: 'biz-tonys-barber',
        title: 'Service & Price List',
        type: 'service_catalog',
        content: 'Haircut: 300,000 toman (30 mins). Beard trim: 200,000 toman (20 mins). Haircut + beard combo: 450,000 toman (45 mins).',
        tags: ['pricing', 'services'],
        createdAt: new Date().toISOString()
      },
      {
        id: 'kc-2',
        businessId: 'biz-tonys-barber',
        title: 'Opening Hours & Location',
        type: 'policy',
        content: 'Open Monday to Saturday from 09:00 to 20:00. Closed on Sundays. Located at 123 Main Barber Street, Downtown.',
        tags: ['hours', 'location'],
        createdAt: new Date().toISOString()
      },
      {
        id: 'kc-3',
        businessId: 'biz-tonys-barber',
        title: 'Grooming Products',
        type: 'document',
        content: 'We stock Matte Clay Pomade (150,000 toman) and Organic Cedarwood Beard Oil (120,000 toman) for home styling.',
        tags: ['products', 'pomade', 'beard oil'],
        createdAt: new Date().toISOString()
      }
    );

    // 5. Products
    this.products.push(
      {
        id: 'prod-1',
        businessId: 'biz-tonys-barber',
        name: 'Matte Clay Pomade (100g)',
        sku: 'POM-001',
        price: 150000,
        inventory: 25,
        description: 'Strong hold, matte finish pomade for modern textured hairstyles.',
        category: 'Hair Care'
      },
      {
        id: 'prod-2',
        businessId: 'biz-tonys-barber',
        name: 'Organic Cedarwood Beard Oil (50ml)',
        sku: 'OIL-002',
        price: 120000,
        inventory: 18,
        description: 'Nourishing oil that softens facial hair and reduces skin irritation.',
        category: 'Beard Care'
      }
    );

    // 6. Customers
    const cust1: Customer = {
      id: 'cust-1',
      businessId: 'biz-tonys-barber',
      name: 'Reza Ahmadi',
      phone: '+98 912 345 6789',
      notes: 'Prefers low fade with scissors on top.',
      createdAt: new Date().toISOString()
    };
    const cust2: Customer = {
      id: 'cust-2',
      businessId: 'biz-tonys-barber',
      name: 'Sina Kavoosi',
      phone: '+98 919 876 5432',
      notes: 'Regular beard trim customer.',
      createdAt: new Date().toISOString()
    };
    this.customers.push(cust1, cust2);

    // 7. Appointments
    const todayStr = new Date().toISOString().split('T')[0];
    this.appointments.push(
      {
        id: 'app-1',
        businessId: 'biz-tonys-barber',
        serviceId: 'srv-1',
        serviceName: 'Haircut',
        staffMemberId: 'staff-1',
        staffName: 'Tony (Master Barber)',
        customerId: 'cust-1',
        customerName: 'Reza Ahmadi',
        customerPhone: '+98 912 345 6789',
        date: todayStr,
        startTime: '14:00',
        endTime: '14:30',
        status: 'CONFIRMED',
        notes: 'Requested Tony specifically.',
        createdAt: new Date().toISOString()
      },
      {
        id: 'app-2',
        businessId: 'biz-tonys-barber',
        serviceId: 'srv-3',
        serviceName: 'Haircut + beard',
        staffMemberId: 'staff-2',
        staffName: 'Marco (Senior Stylist)',
        customerId: 'cust-2',
        customerName: 'Sina Kavoosi',
        customerPhone: '+98 919 876 5432',
        date: todayStr,
        startTime: '16:00',
        endTime: '16:45',
        status: 'CONFIRMED',
        notes: 'Combo booking.',
        createdAt: new Date().toISOString()
      }
    );

    // 8. Channels & Integrations for Tony's
    this.channels.push(
      {
        id: 'chan-1',
        businessId: 'biz-tonys-barber',
        type: 'web_chat',
        status: 'connected',
        details: 'Widget snippet active on website',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'chan-2',
        businessId: 'biz-tonys-barber',
        type: 'instagram',
        status: 'not_configured',
        details: 'Not configured',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'chan-3',
        businessId: 'biz-tonys-barber',
        type: 'sms',
        status: 'not_configured',
        details: 'Not configured',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'chan-4',
        businessId: 'biz-tonys-barber',
        type: 'voice',
        status: 'not_configured',
        details: 'Not configured',
        updatedAt: new Date().toISOString()
      }
    );

    this.integrations.push(
      {
        id: 'integ-1',
        businessId: 'biz-tonys-barber',
        provider: 'google_calendar',
        state: 'NOT_CONFIGURED',
        statusMessage: 'Not configured',
        credentialsSet: false
      },
      {
        id: 'integ-2',
        businessId: 'biz-tonys-barber',
        provider: 'meta_instagram',
        state: 'NOT_CONFIGURED',
        statusMessage: 'Not configured',
        credentialsSet: false
      },
      {
        id: 'integ-3',
        businessId: 'biz-tonys-barber',
        provider: 'twilio_sms',
        state: 'NOT_CONFIGURED',
        statusMessage: 'Not configured',
        credentialsSet: false
      },
      {
        id: 'integ-4',
        businessId: 'biz-tonys-barber',
        provider: 'voice_ai',
        state: 'NOT_CONFIGURED',
        statusMessage: 'Not configured',
        credentialsSet: false
      }
    );

    // 9. Conversations
    const conv1: Conversation = {
      id: 'conv-1',
      businessId: 'biz-tonys-barber',
      customerId: 'cust-1',
      customerName: 'Reza Ahmadi',
      customerPhone: '+98 912 345 6789',
      channel: 'web_chat',
      status: 'AI_HANDLING',
      summary: 'Asked about prices for Haircut + beard combo and confirmed booking for 14:00.',
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    this.conversations.push(conv1);

    this.messages.push(
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        sender: 'customer',
        content: "Hi! How much is a haircut and beard trim package?",
        channel: 'web_chat',
        timestamp: new Date(Date.now() - 3600000).toISOString()
      },
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        sender: 'agent',
        content: "Hello Reza! Our Haircut + Beard combo is 450,000 Toman and takes approximately 45 minutes. It includes a haircut, hair wash, beard trim, and hot towel treatment! Would you like to book an appointment?",
        channel: 'web_chat',
        timestamp: new Date(Date.now() - 3500000).toISOString()
      }
    );

    // 10. Pre-built Industry Templates
    this.templates.push(
      {
        id: 'tpl-barbershop',
        name: 'Barbershop & Grooming',
        businessType: 'barbershop',
        icon: 'Scissors',
        description: 'Complete receptionist for barber shops. Handles appointments, service combos, barber selection, and missed call follow-ups.',
        defaultServices: [
          { id: 's1', name: 'Haircut', price: 300000, durationMinutes: 30, description: 'Classic or modern haircut.' },
          { id: 's2', name: 'Beard Trim', price: 200000, durationMinutes: 20, description: 'Precision beard shaping.' },
          { id: 's3', name: 'Haircut + Beard Combo', price: 450000, durationMinutes: 45, description: 'Complete grooming experience.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'Do you accept walk-ins?', answer: 'Yes, walk-ins are accepted depending on barber availability.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'friendly', behavior: 'service', language: 'en' },
          goals: ['Book appointments', 'Explain services and pricing', 'Answer location & hours queries']
        }
      },
      {
        id: 'tpl-salon',
        name: 'Beauty Salon & Spa',
        businessType: 'salon',
        icon: 'Sparkles',
        description: 'AI receptionist for hair salons, nail bars, and skin care clinics.',
        defaultServices: [
          { id: 's1', name: 'Hair Styling & Blowdry', price: 500000, durationMinutes: 45, description: 'Wash, treatment, and blowdry styling.' },
          { id: 's2', name: 'Manicure & Gel Polish', price: 350000, durationMinutes: 40, description: 'Nail shaping, cuticle care, and gel polish.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'Do I need to come with washed hair?', answer: 'We include hair washing with all styling services!' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'luxury', behavior: 'service', language: 'en' },
          goals: ['Schedule beauty appointments', 'Recommend packages', 'Send reminders']
        }
      },
      {
        id: 'tpl-restaurant',
        name: 'Restaurant & Cafe',
        businessType: 'restaurant',
        icon: 'Utensils',
        description: 'Handles table reservations, menu item inquiries, dietary questions, and takeaway orders.',
        defaultServices: [
          { id: 's1', name: 'Table Reservation (2-4 guests)', price: 0, durationMinutes: 90, description: 'Reserve a table for dining in.' },
          { id: 's2', name: 'VIP Dining Room Reservation', price: 200000, durationMinutes: 120, description: 'Private room booking deposit.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'Do you have vegan options?', answer: 'Yes, we have dedicated vegan and gluten-free items on our menu.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'friendly', behavior: 'service', language: 'en' },
          goals: ['Book table reservations', 'Explain menu items', 'Provide opening hours']
        }
      },
      {
        id: 'tpl-dentist',
        name: 'Dental & Health Clinic',
        businessType: 'dentist',
        icon: 'Stethoscope',
        description: 'Professional assistant for dental clinics. Schedules consultations, cleanings, and emergency inquiries.',
        defaultServices: [
          { id: 's1', name: 'Dental Checkup & Cleaning', price: 600000, durationMinutes: 30, description: 'General oral examination and teeth cleaning.' },
          { id: 's2', name: 'Consultation & X-Ray', price: 400000, durationMinutes: 20, description: 'Diagnostic consultation.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'What should I do in a dental emergency?', answer: 'Call our direct emergency line or visit the clinic during emergency hours.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'professional', behavior: 'service', language: 'en' },
          goals: ['Book consultations', 'Explain clinic procedures', 'Handoff medical emergencies']
        }
      },
      {
        id: 'tpl-mechanic',
        name: 'Auto Repair & Mechanic',
        businessType: 'mechanic',
        icon: 'Wrench',
        description: 'Handles vehicle inspection bookings, service cost estimates, and repair status checks.',
        defaultServices: [
          { id: 's1', name: 'Oil Change & Safety Inspection', price: 400000, durationMinutes: 30, description: 'Engine oil replacement and 20-point safety check.' },
          { id: 's2', name: 'Brake Pad Replacement', price: 800000, durationMinutes: 60, description: 'Front or rear brake pad replacement.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'How long does an oil change take?', answer: 'An oil change typically takes 30 to 45 minutes.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'concise', behavior: 'service', language: 'en' },
          goals: ['Book service slots', 'Provide estimate ranges', 'Track vehicle status']
        }
      },
      {
        id: 'tpl-retail',
        name: 'Local Retail & Boutique',
        businessType: 'retail',
        icon: 'ShoppingBag',
        description: 'E-commerce and physical retail assistant. Answers product questions, checks inventory, and processes orders.',
        defaultServices: [
          { id: 's1', name: 'Personal Shopping Consultation', price: 0, durationMinutes: 30, description: 'In-store personal stylist appointment.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'What is your return policy?', answer: 'Items can be returned within 7 days with original receipt.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'energetic', behavior: 'sales', language: 'en' },
          goals: ['Search products', 'Check stock inventory', 'Take pickup orders']
        }
      }
    );

    // 11. Initial Audit Logs & Usage
    this.auditLogs.push(
      {
        id: 'log-1',
        businessId: 'biz-tonys-barber',
        agentId: 'agent-tonys-1',
        action: 'AGENT_DEPLOYED',
        details: "Tony's AI Receptionist v1 set to ACTIVE state.",
        timestamp: new Date().toISOString()
      }
    );

    this.usageRecords.push(
      {
        id: 'usr-1',
        businessId: 'biz-tonys-barber',
        date: todayStr,
        tokensUsed: 4250,
        estimatedCostUsd: 0.0085,
        requestsCount: 14,
        voiceMinutes: 0,
        smsCount: 0
      }
    );
  }

  /**
   * Seed the demo user accounts. Idempotent: INSERT OR IGNORE by email, so a
   * partially-seeded DB self-heals and a reseeded DB never duplicates. Passwords
   * are scrypt-hashed and only computed for emails that are actually missing.
   */
  private seedUsers(): void {
    const now = new Date().toISOString();
    const demoUsers: Array<Omit<User, 'createdAt' | 'updatedAt' | 'passwordHash'>> = [
      {
        id: 'usr-platform-1',
        email: 'owner@agentfactory.io',
        name: 'Platform Owner',
        role: 'PLATFORM_OWNER',
        businessId: null
      },
      {
        id: 'usr-tony-1',
        email: 'tony@tonysbarber.com',
        name: 'Tony (Owner)',
        role: 'BUSINESS_OWNER',
        businessId: 'biz-tonys-barber'
      },
      {
        id: 'usr-tony-staff-1',
        email: 'staff@tonysbarber.com',
        name: 'Marco (Staff)',
        role: 'BUSINESS_STAFF',
        businessId: 'biz-tonys-barber'
      }
    ];
    // Demo password for all seeded accounts (documented in the report).
    const demoPassword = 'Password123!';
    const existsStmt = this.sqlite.prepare('SELECT 1 FROM users WHERE email = ?');
    const insertStmt = this.sqlite.prepare(
      `INSERT OR IGNORE INTO users (id, email, password_hash, name, role, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const u of demoUsers) {
      if (existsStmt.get(u.email)) continue;
      insertStmt.run(u.id, u.email, hashPassword(demoPassword), u.name, u.role, u.businessId, now, now);
    }
  }
}

// Singleton used by routes.ts / agentRuntime.ts / tools.ts (same shape as before).
export const db = new AppDatabase();
