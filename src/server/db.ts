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
  EvalRunResult,
  CorrectionResult,
  StaffMember,
  User,
  Session,
  TelemetryEvent,
  Prospect,
  DesignProposal,
  FactoryJob,
  Delivery,
  Acceptance
} from '../types';
import { hashPassword } from './passwords';
import { initEmbeddingsTable } from './embeddings';
import { embeddingProviderAvailable } from './llmProvider';
import { initEvaluationTable } from './evaluation';
import { initCorrectionTable } from './correction';
import { initTelemetryTable } from './telemetry';
import { initOrchestrationTables } from './orchestration/tables';
import { DbClient, SqliteClient, PostgresClient } from './dbClient';

/**
 * Database repository for the AI Agent Factory.
 *
 * The repository is backed by a driver-agnostic async `DbClient` (the
 * "compatibility layer" that lets the runtime migrate from SQLite to
 * PostgreSQL incrementally):
 *   - SQLite (better-sqlite3): the default dev/test backend when DATABASE_URL
 *     is absent.
 *   - PostgreSQL (node-postgres `pg`): the production backend selected when
 *     DATABASE_URL is set.
 *
 * Design goals:
 *  - Keep the exact call-site shape the rest of the server code uses
 *    (`await db.businesses.find(...)`, `await db.agents.filter(...)`,
 *    `await db.customers.push(...)`, `await db.knowledgeChunks.splice(...)`,
 *    `await db.usageRecords.reduce(...)`, ...). The collection methods are now
 *    async so the same code runs against either driver.
 *  - Every read goes to the database; every write goes to the database. No
 *    business data lives in JS arrays.
 *  - Objects returned by `find`/`filter` are fresh parses of DB rows, so a
 *    caller that mutates the object (e.g. `conversation.status = ...`) must
 *    call `await <collection>.update(record)` to persist — the call sites do.
 *  - Nested/structured fields (arrays/objects) are stored as JSON (TEXT for
 *    SQLite, JSONB for PostgreSQL) and parsed back into the exact shapes
 *    defined in src/types/index.ts.
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
    jsonColumns: ['servicesHandled', 'workingHours', 'timeOff'],
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
  evaluationResults: {
    table: 'evaluation_results',
    jsonColumns: ['scenarioResults'],
    booleanColumns: ['overallPassed']
  },
  correctionRuns: {
    table: 'correction_runs',
    jsonColumns: ['attempts'],
    booleanColumns: ['resolved', 'humanReviewRequired', 'finalEvaluationPassed']
  },
  telemetry: {
    table: 'telemetry_events',
    jsonColumns: ['metadata'],
    booleanColumns: ['isPublished', 'success']
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
  },
  prospects: {
    table: 'prospects',
    jsonColumns: [],
    booleanColumns: []
  },
  designProposals: {
    table: 'design_proposals',
    jsonColumns: ['capabilities', 'channels', 'integrations', 'configuration'],
    booleanColumns: []
  },
  factoryJobs: {
    table: 'factory_jobs',
    jsonColumns: [],
    booleanColumns: ['deadLettered']
  },
  deliveries: {
    table: 'deliveries',
    jsonColumns: ['deliveryPayload'],
    booleanColumns: []
  },
  acceptances: {
    table: 'acceptances',
    jsonColumns: ['metadata'],
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

async function runMigrations(client: DbClient, migrationsDir: string): Promise<void> {
  await client.execMany(
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

  const appliedRes = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map(r => r.name as string));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await client.execMany(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    console.log(`[db] applied migration: ${file}`);
  }
}

/** PostgreSQL migration runner: the schema_migrations table uses BIGSERIAL and
 *  a UTC timestamp default, and the migration files live under migrations/pg. */
async function runPostgresMigrations(client: DbClient, migrationsDir: string): Promise<void> {
  await client.execMany(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id BIGSERIAL PRIMARY KEY,
       name TEXT NOT NULL UNIQUE,
       applied_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
     )`
  );

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const appliedRes = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map(r => r.name as string));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await client.execMany(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    console.log(`[db] applied migration: ${file}`);
  }
}

// ---------------------------------------------------------------------------
// Collection: array-like facade over a database table (async, driver-agnostic)
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

class Collection<T extends { id: string }> {
  private cachedColumns: string[] | null = null;

  constructor(
    private client: DbClient,
    private config: TableConfig
  ) {}

  private async columnNames(): Promise<string[]> {
    if (this.cachedColumns) return this.cachedColumns;
    this.cachedColumns = await this.client.getColumns(this.config.table);
    return this.cachedColumns;
  }

  private rowToObject(row: Row): T {
    const jsonSet = new Set(this.config.jsonColumns);
    const boolSet = new Set(this.config.booleanColumns);
    const obj: Record<string, any> = {};
    for (const [col, value] of Object.entries(row)) {
      const field = snakeToCamel(col);
      if (jsonSet.has(field)) {
        // JSONB (PG) returns already-parsed objects/arrays; TEXT (SQLite)
        // returns strings that must be JSON.parse'd. Handle both.
        if (typeof value === 'string') {
          obj[field] = value === '' ? undefined : safeJsonParse(value);
        } else if (value == null) {
          obj[field] = undefined;
        } else {
          obj[field] = value;
        }
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
  private async allRows(): Promise<T[]> {
    // SQLite: ORDER BY rowid preserves insertion order. PostgreSQL has no
    // rowid, so we order by the ctid-independent created_at when present is
    // not enough for id-less tables; we order by id as a stable fallback that
    // matches the legacy "insertion-ish" order closely enough for the
    // array-facade semantics callers rely on. (Callers needing a specific
    // order pass their own ORDER BY via filterWhere.)
    const order = this.client.dialect === 'sqlite' ? 'ORDER BY rowid' : 'ORDER BY id';
    const res = await this.client.query(`SELECT * FROM ${this.config.table} ${order}`);
    return res.rows.map(r => this.rowToObject(r));
  }

  async find(predicate: (item: T) => boolean): Promise<T | undefined> {
    const rows = await this.allRows();
    return rows.find(predicate);
  }

  async filter(predicate: (item: T) => boolean): Promise<T[]> {
    const rows = await this.allRows();
    return rows.filter(predicate);
  }

  async findIndex(predicate: (item: T) => boolean): Promise<number> {
    const rows = await this.allRows();
    return rows.findIndex(predicate);
  }

  async push(...items: T[]): Promise<number> {
    const columns = await this.columnNames();
    const allowed = new Set(columns);
    const colsNoId = columns.filter(c => c !== 'id');
    const placeholders = columns.map(() => '?').join(', ');
    const colList = columns.join(', ');
    for (const item of items) {
      const row = this.objectToRow(item);
      const values = columns.map(c => (c === 'id' ? row.id : allowed.has(c) ? row[c] ?? null : null));
      await this.client.query(
        `INSERT INTO ${this.config.table} (${colList}) VALUES (${placeholders})`,
        values
      );
    }
    return this.length();
  }

  /** Persist the current state of a record that a caller mutated in place. */
  async update(item: T): Promise<void> {
    const columns = (await this.columnNames()).filter(c => c !== 'id');
    const row = this.objectToRow(item);
    const setClause = columns.map(c => `${c} = ?`).join(', ');
    const values = columns.map(c => row[c] ?? null);
    values.push(item.id);
    const res = await this.client.query(
      `UPDATE ${this.config.table} SET ${setClause} WHERE id = ?`,
      values
    );
    if (res.changes === 0) {
      throw new Error(`Cannot update: no row with id '${item.id}' in ${this.config.table}`);
    }
  }

  /** Array semantics: delete rows between start and start+deleteCount. */
  async splice(start: number, deleteCount?: number): Promise<T[]> {
    const rows = await this.allRows();
    const removed = rows.splice(start, deleteCount === undefined ? rows.length - start : deleteCount);
    for (const r of removed) {
      await this.client.query(`DELETE FROM ${this.config.table} WHERE id = ?`, [r.id]);
    }
    return removed;
  }

  async slice(start?: number, end?: number): Promise<T[]> {
    const rows = await this.allRows();
    return rows.slice(start, end);
  }

  async reduce<U>(callback: (acc: U, item: T) => U, initial: U): Promise<U> {
    const rows = await this.allRows();
    return rows.reduce(callback, initial);
  }

  async length(): Promise<number> {
    const res = await this.client.query(`SELECT COUNT(*) AS c FROM ${this.config.table}`);
    const c = res.rows[0]?.c;
    return typeof c === 'number' ? c : Number(c ?? 0);
  }

  /** Lets `res.json(await db.<collection>.toJSON())` serialize as a plain array. */
  async toJSON(): Promise<T[]> {
    return this.allRows();
  }

  // --- DB-side query helpers (P4: avoid materializing whole tables) --------

  /** Return rows matching a WHERE clause + params, ordered, with optional
   *  LIMIT/OFFSET pagination. `where` must use `?` placeholders. This is the
   *  preferred path for high-volume collections (messages, conversations,
   *  customers, usage, appointments). */
  async filterWhere(where: string, params: any[], opts: { orderBy?: string; limit?: number; offset?: number; desc?: boolean } = {}): Promise<T[]> {
    let sql = `SELECT * FROM ${this.config.table} WHERE ${where}`;
    if (opts.orderBy) {
      const dir = opts.desc ? 'DESC' : 'ASC';
      // orderBy is a trusted column name passed by callers; validate it.
      const cols = await this.columnNames();
      if (!cols.includes(opts.orderBy)) throw new Error(`Invalid order column: ${opts.orderBy}`);
      sql += ` ORDER BY ${opts.orderBy} ${dir}`;
    } else if (this.client.dialect === 'sqlite') {
      sql += ' ORDER BY rowid';
    }
    if (opts.limit != null) {
      sql += ` LIMIT ${Number(opts.limit) | 0}`;
      if (opts.offset != null) sql += ` OFFSET ${Number(opts.offset) | 0}`;
    }
    const res = await this.client.query(sql, params);
    return res.rows.map(r => this.rowToObject(r));
  }

  /** Count rows matching a WHERE clause without loading them. */
  async countWhere(where: string, params: any[]): Promise<number> {
    const res = await this.client.query(`SELECT COUNT(*) AS c FROM ${this.config.table} WHERE ${where}`, params);
    const c = res.rows[0]?.c;
    return typeof c === 'number' ? c : Number(c ?? 0);
  }

  /** Find the first row matching a WHERE clause + params (single DB round-trip). */
  async findOneWhere(where: string, params: any[]): Promise<T | undefined> {
    const rows = await this.filterWhere(where, params, { limit: 1 });
    return rows[0];
  }

  /** DB-side pagination for a tenant-scoped query (audit P2.9). Returns the page
   *  and total count in ONE structure so routes can set X-Total-Count without
   *  materializing the whole table. Avoids the legacy in-memory `paginate`
   *  slice over `filter()` (which loaded every row). */
  async paginateWhere(
    where: string,
    params: any[],
    opts: { orderBy?: string; desc?: boolean; limit: number; offset: number }
  ): Promise<{ rows: T[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.filterWhere(where, params, { orderBy: opts.orderBy, desc: opts.desc, limit: opts.limit, offset: opts.offset }),
      this.countWhere(where, params),
    ]);
    return { rows, total };
  }
}

function safeJsonParse(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// AppDatabase
// ---------------------------------------------------------------------------

export interface AppDatabaseOptions {
  dbPath?: string;
  migrationsDir?: string;
  seed?: boolean;
  /** Override the database URL (otherwise from process.env.DATABASE_URL). When
   *  set, the database runs on PostgreSQL instead of SQLite. */
  databaseUrl?: string;
}

export class AppDatabase {
  /** The async DB client (SQLite or PostgreSQL). Raw-SQL call sites that used
   *  the old `db.sqlite` handle now use `db.client`. */
  public client!: DbClient;
  /** The raw better-sqlite3 handle, available only for the SQLite dialect.
   *  Undefined when running on PostgreSQL. Kept for the embeddings module and
   *  a couple of low-level call sites that branch on dialect. */
  public sqlite: BetterSqlite3.Database | undefined;
  public readonly dbPath: string;
  public readonly migrationsDir: string;
  public readonly dialect: 'sqlite' | 'postgres';
  private initialized = false;

  public businesses!: Collection<Business>;
  public agents!: Collection<Agent>;
  public agentVersions!: Collection<AgentVersion>;
  public knowledgeChunks!: Collection<KnowledgeChunk>;
  public customers!: Collection<Customer>;
  public conversations!: Collection<Conversation>;
  public messages!: Collection<Message>;
  public appointments!: Collection<Appointment>;
  public staffMembers!: Collection<StaffMember>;
  public products!: Collection<Product>;
  public orders!: Collection<Order>;
  public channels!: Collection<ChannelConfig>;
  public integrations!: Collection<IntegrationConfig>;
  public templates!: Collection<AgentTemplate>;
  public usageRecords!: Collection<UsageRecord>;
  public auditLogs!: Collection<AuditLog>;
  public evaluationResults!: Collection<EvalRunResult>;
  public correctionRuns!: Collection<CorrectionResult>;
  public telemetry!: Collection<TelemetryEvent>;
  public users!: Collection<User>;
  public sessions!: Collection<Session>;
  public prospects!: Collection<Prospect>;
  public designProposals!: Collection<DesignProposal>;
  public factoryJobs!: Collection<FactoryJob>;
  public deliveries!: Collection<Delivery>;
  public acceptances!: Collection<Acceptance>;

  constructor(opts: AppDatabaseOptions = {}) {
    // Select the driver. DATABASE_URL (postgres://...) -> PostgreSQL production
    // backend; otherwise better-sqlite3 (dev/test default). Optional provider
    // env vars never gate startup (see noOptionalEnv tests).
    const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
    if (databaseUrl) {
      this.dialect = 'postgres';
      this.dbPath = '';
      this.migrationsDir = opts.migrationsDir || process.env.MIGRATIONS_DIR || path.join(process.cwd(), 'migrations', 'pg');
      this.client = new PostgresClient({ connectionString: databaseUrl });
    } else {
      this.dialect = 'sqlite';
      let dbPath = opts.dbPath || process.env.DB_PATH || path.join(process.cwd(), 'data', 'agentforge.db');
      // If DB_PATH points at an existing directory, append a default filename
      // so the server doesn't crash with SQLITE_CANTOPEN (common deployment mistake).
      try {
        if (fs.statSync(dbPath).isDirectory()) {
          dbPath = path.join(dbPath, 'agentfactory.db');
        }
      } catch {
        // path doesn't exist yet — that's fine, better-sqlite3 will create it
      }
      this.dbPath = dbPath;
      this.migrationsDir = opts.migrationsDir || process.env.MIGRATIONS_DIR || path.join(process.cwd(), 'migrations');
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      const sqlite = new BetterSqlite3(this.dbPath);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      this.sqlite = sqlite;
      this.client = new SqliteClient(sqlite);
    }

    this.businesses = new Collection<Business>(this.client, TABLES.businesses);
    this.agents = new Collection<Agent>(this.client, TABLES.agents);
    this.agentVersions = new Collection<AgentVersion>(this.client, TABLES.agentVersions);
    this.knowledgeChunks = new Collection<KnowledgeChunk>(this.client, TABLES.knowledgeChunks);
    this.customers = new Collection<Customer>(this.client, TABLES.customers);
    this.conversations = new Collection<Conversation>(this.client, TABLES.conversations);
    this.messages = new Collection<Message>(this.client, TABLES.messages);
    this.appointments = new Collection<Appointment>(this.client, TABLES.appointments);
    this.staffMembers = new Collection<StaffMember>(this.client, TABLES.staffMembers);
    this.products = new Collection<Product>(this.client, TABLES.products);
    this.orders = new Collection<Order>(this.client, TABLES.orders);
    this.channels = new Collection<ChannelConfig>(this.client, TABLES.channels);
    this.integrations = new Collection<IntegrationConfig>(this.client, TABLES.integrations);
    this.templates = new Collection<AgentTemplate>(this.client, TABLES.templates);
    this.usageRecords = new Collection<UsageRecord>(this.client, TABLES.usageRecords);
    this.auditLogs = new Collection<AuditLog>(this.client, TABLES.auditLogs);
    this.evaluationResults = new Collection<EvalRunResult>(this.client, TABLES.evaluationResults);
    this.correctionRuns = new Collection<CorrectionResult>(this.client, TABLES.correctionRuns);
    this.telemetry = new Collection<TelemetryEvent>(this.client, TABLES.telemetry);
    this.users = new Collection<User>(this.client, TABLES.users);
    this.sessions = new Collection<Session>(this.client, TABLES.sessions);
    this.prospects = new Collection<Prospect>(this.client, TABLES.prospects);
    this.designProposals = new Collection<DesignProposal>(this.client, TABLES.designProposals);
    this.factoryJobs = new Collection<FactoryJob>(this.client, TABLES.factoryJobs);
    this.deliveries = new Collection<Delivery>(this.client, TABLES.deliveries);
    this.acceptances = new Collection<Acceptance>(this.client, TABLES.acceptances);
  }

  /** Run migrations, initialize the embeddings table, and seed demo data.
   *  Idempotent. Must be awaited before the database is used (the server and
   *  tests do this at startup / in beforeAll). For SQLite it resolves on the
   *  microtask queue; for PostgreSQL it runs real async migrations. */
  async init(opts: { seed?: boolean } = {}): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const shouldSeed = opts.seed !== false;

    if (this.dialect === 'sqlite') {
      await runMigrations(this.client, this.migrationsDir);
    } else {
      await runPostgresMigrations(this.client, this.migrationsDir);
    }
    await initEmbeddingsTable(this.client);
    await initEvaluationTable(this.client);
    await initCorrectionTable(this.client);
    await initTelemetryTable(this.client);
    await initOrchestrationTables(this.client);

    if (shouldSeed) {
      await this.seed();
      await this.seedUsers();
    }

    // Best-effort background indexing of seeded knowledge when an embedding
    // provider is available (free-first: a local Ollama embedding model OR a
    // configured Gemini key). Fire-and-forget: failures are non-fatal (keyword
    // fallback remains) and we must not block startup for optional providers.
    // `embeddingProviderAvailable()` avoids hammering a dead daemon when no
    // provider is intended (plain machine with no key and no Ollama config).
    if (embeddingProviderAvailable()) {
      import('./embeddings').then(async ({ indexChunk }) => {
        try {
          const chunks = await this.knowledgeChunks.toJSON();
          for (const c of chunks) {
            indexChunk(c).catch(() => {});
          }
        } catch { /* non-fatal */ }
      }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    try { await this.client.close(); } catch { /* ignore */ }
  }

  /** Seed the Tony's Barber Shop demo tenant. Idempotent: only runs when the DB is empty. */
  private async seed(): Promise<void> {
    const businessCount = await this.businesses.length();

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
    await this.businesses.push(tonysBarber);

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
    await this.staffMembers.push(staff1, staff2);

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
          'search_knowledge',
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
          'search_knowledge',
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
    await this.agents.push(tonysAgent);

    // Seed a PUBLISHED version snapshot so the versioning system is consistent
    // for the demo tenant (runtime reads the agent row, but the dashboard +
    // simulator rely on version records existing).
    await this.agentVersions.push({
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
    await this.knowledgeChunks.push(
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
    await this.products.push(
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
    await this.customers.push(cust1, cust2);

    // 7. Appointments
    const todayStr = new Date().toISOString().split('T')[0];
    await this.appointments.push(
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
    await this.channels.push(
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

    await this.integrations.push(
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
    await this.conversations.push(conv1);

    await this.messages.push(
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
    await this.templates.push(
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
    await this.auditLogs.push(
      {
        id: 'log-1',
        businessId: 'biz-tonys-barber',
        agentId: 'agent-tonys-1',
        action: 'AGENT_DEPLOYED',
        details: "Tony's AI Receptionist v1 set to ACTIVE state.",
        timestamp: new Date().toISOString()
      }
    );

    await this.usageRecords.push(
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
  private async seedUsers(): Promise<void> {
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
    // Use INSERT ... ON CONFLICT DO NOTHING so seeding is idempotent on both
    // SQLite (supports ON CONFLICT since 3.24) and PostgreSQL.
    const upsertSql =
      `INSERT INTO users (id, email, password_hash, name, role, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (email) DO NOTHING`;
    for (const u of demoUsers) {
      // Only hash + insert when the email isn't already present.
      const existing = await this.users.findOneWhere('email = ?', [u.email]);
      if (existing) continue;
      await this.client.query(upsertSql, [
        u.id, u.email, hashPassword(demoPassword), u.name, u.role, u.businessId, now, now
      ]);
    }
  }
}

// Singleton used by routes.ts / agentRuntime.ts / tools.ts (same shape as before).
export const db = new AppDatabase();
