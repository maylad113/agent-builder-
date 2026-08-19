import type BetterSqlite3 from 'better-sqlite3';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Async database client abstraction (the "compatibility layer" for migrating
 * the runtime from SQLite to PostgreSQL incrementally).
 *
 * The repository layer (`Collection<T>` in db.ts) talks to this interface, so
 * the same application code runs against either:
 *   - SQLite (better-sqlite3, synchronous driver wrapped to look async) — the
 *     default dev/test backend when DATABASE_URL is absent.
 *   - PostgreSQL (node-postgres `pg`, native async) — the production backend
 *     selected when DATABASE_URL is set.
 *
 * SQL portability rules every implementation MUST follow:
 *   - `query(sql, params)` accepts `?` positional placeholders. The Postgres
 *     implementation rewrites `?` -> `$1..$n`; the SQLite implementation uses
 *     them as-is. Callers therefore always write `?`-style SQL.
 *   - `exec(sql)` runs a statement that returns no rows (DDL / multi-statement).
 *     Postgres `exec` splits on `;` when `allowMultiple` is set, because `pg`
 *     cannot run multiple statements in one `query()` call. SQLite passes the
 *     whole string to better-sqlite3 which handles multiple statements.
 *   - `getColumns(table)` returns the ordered column names for a table.
 *   - `transaction(fn)` runs `fn` inside BEGIN/COMMIT (ROLLBACK on throw).
 *
 * Both drivers use TEXT for ISO timestamps, TEXT/JSONB for JSON, INTEGER/REAL
 * for numbers — the row<->object mapping in db.ts is driver-agnostic.
 */

export interface QueryResult {
  rows: Record<string, any>[];
  changes: number;
}

export interface DbClient {
  /** Dialect identifier. */
  readonly dialect: 'sqlite' | 'postgres';
  /** Run a parameterized query (`?` placeholders). Returns rows + changes. */
  query(sql: string, params?: any[]): Promise<QueryResult>;
  /** Run a statement that returns no rows. */
  exec(sql: string, params?: any[]): Promise<QueryResult>;
  /** Run multiple statements (DDL / migration scripts). */
  execMany(sql: string): Promise<void>;
  /** Ordered column names for a table. */
  getColumns(table: string): Promise<string[]>;
  /** Run `fn` inside a transaction. ROLLS BACK on throw. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Health probe used by /health. */
  ping(): Promise<void>;
  /** Release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQLite client (better-sqlite3 is synchronous; we wrap calls in
// Promise.resolve so the Collection layer can be uniformly async).
// ---------------------------------------------------------------------------

export class SqliteClient implements DbClient {
  readonly dialect = 'sqlite' as const;
  constructor(public sqlite: BetterSqlite3.Database) {}

  // SQLite only allows one active transaction per connection, and the async
  // transaction body can interleave with another awaited transaction (e.g. two
  // concurrent tool calls under Promise.all). Serialize transactions on a
  // per-connection mutex so BEGIN/COMMIT/ROLLBACK never nest. Non-transactional
  // queries are unaffected. This mirrors better-sqlite3's own sync semantics.
  private _txTail: Promise<unknown> = Promise.resolve();

  async query(sql: string, params: any[] = []): Promise<QueryResult> {
    // SQLite does not understand `FOR UPDATE` (it is a syntax error), but the
    // locking semantics it expresses are a no-op here anyway: writes already
    // serialize on the per-connection mutex. Strip a trailing FOR UPDATE
    // clause so application code can use the same portable SQL on both
    // dialects (Postgres honors it for row-level locking; SQLite ignores it).
    const portable = stripForUpdate(sql);
    const stmt = this.sqlite.prepare(portable);
    // SELECT vs INSERT/UPDATE/DELETE: better-sqlite3 exposes .all()/.run().
    // We detect by trying .all() first when the statement returns rows.
    const info = stmt.reader ? stmt.all(...params) : stmt.run(...params) as any;
    if (stmt.reader) {
      return { rows: info as Record<string, any>[], changes: 0 };
    }
    return { rows: [], changes: (info as { changes: number }).changes ?? 0 };
  }

  async exec(sql: string, params: any[] = []): Promise<QueryResult> {
    if (params.length) {
      const stmt = this.sqlite.prepare(stripForUpdate(sql));
      const r = stmt.run(...params) as { changes: number };
      return { rows: [], changes: r.changes };
    }
    this.sqlite.exec(stripForUpdate(sql));
    return { rows: [], changes: 0 };
  }

  async execMany(sql: string): Promise<void> {
    this.sqlite.exec(sql);
  }

  async getColumns(table: string): Promise<string[]> {
    const rows = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Acquire the per-connection mutex so concurrent awaited transactions run
    // strictly one after another (SQLite is single-writer anyway). This also
    // prevents the "cannot start a transaction within a transaction" error that
    // would otherwise occur when an interleaving transaction issues BEGIN while
    // another is still open.
    const ticket = this._txTail.then(() => this._runTransaction(fn));
    this._txTail = ticket.catch(() => { /* prevent unhandled rejections from breaking the chain */ });
    return ticket as Promise<T>;
  }

  private async _runTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // better-sqlite3's synchronous transaction() cannot wrap an async fn.
    // We drive BEGIN/COMMIT/ROLLBACK manually so the body can be async.
    this.sqlite.exec('BEGIN');
    try {
      const result = await fn();
      this.sqlite.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.sqlite.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  async ping(): Promise<void> {
    this.sqlite.prepare('SELECT 1').get();
  }

  async close(): Promise<void> {
    this.sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL client (node-postgres). Rewrites `?` -> `$n`, splits
// multi-statement scripts, and wraps transactions with BEGIN/COMMIT.
// ---------------------------------------------------------------------------

let PoolCtor: any;
async function getPoolCtor(): Promise<any> {
  if (PoolCtor) return PoolCtor;
  // `pg` is a CommonJS module; dynamic import avoids ESM/CJS friction.
  const pg = await import('pg');
  PoolCtor = (pg as any).Pool ?? (pg.default as any)?.Pool;
  if (!PoolCtor) throw new Error('pg.Pool not found — is the `pg` package installed?');
  return PoolCtor;
}

export interface PostgresClientOptions {
  connectionString: string;
  /** Max pool connections. */
  max?: number;
}

export class PostgresClient implements DbClient {
  readonly dialect = 'postgres' as const;
  private pool: any;
  private readonly opts: PostgresClientOptions;
  // Holds the checked-out pg client for the currently executing transaction.
  // query()/exec()/execMany()/getColumns() consult this store FIRST so every
  // statement issued inside a transaction callback (including Collection
  // methods, which only know this DbClient) runs on the SAME connection as
  // the BEGIN/COMMIT — otherwise callback writes auto-commit on random pooled
  // connections and the transaction is a no-op (no atomicity, no rollback,
  // FOR UPDATE locks released immediately). AsyncLocalStorage scopes the
  // binding per async context, so concurrent transactions each see their own
  // client and run safely in parallel.
  private readonly txStore = new AsyncLocalStorage<any>();

  constructor(opts: PostgresClientOptions) {
    this.opts = opts;
  }

  /** The connection to use for ad-hoc statements: the active transaction's
   *  client when inside `transaction(fn)`, otherwise the pool. */
  private conn(): any {
    return this.txStore.getStore() ?? this.pool;
  }

  private async getPool(): Promise<any> {
    if (this.pool) return this.pool;
    const Pool = await getPoolCtor();
    this.pool = new Pool({ connectionString: this.opts.connectionString, max: this.opts.max ?? 10 });
    // Surface pool errors so connections don't fail silently.
    this.pool.on('error', (err: Error) => {
      console.error('[pg] idle client error:', err.message);
    });
    return this.pool;
  }

  /** Rewrite `?` placeholders to Postgres `$1..$n` (ignores `?` inside string
   *  literals / quoted identifiers). */
  private toPgParams(sql: string, params: any[]): { text: string; values: any[] } {
    let out = '';
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let n = 1;
    while (i < sql.length) {
      const ch = sql[i];
      if (inSingle) {
        out += ch;
        if (ch === "'" && sql[i + 1] !== "'") inSingle = false;
        else if (ch === "'" && sql[i + 1] === "'") { out += sql[i + 1]; i++; }
        i++;
        continue;
      }
      if (inDouble) {
        out += ch;
        if (ch === '"') inDouble = false;
        i++;
        continue;
      }
      if (ch === "'") { inSingle = true; out += ch; i++; continue; }
      if (ch === '"') { inDouble = true; out += ch; i++; continue; }
      if (ch === '?') {
        out += '$' + n++;
        i++;
        continue;
      }
      out += ch;
      i++;
    }
    return { text: out, values: params };
  }

  async query(sql: string, params: any[] = []): Promise<QueryResult> {
    await this.getPool();
    const { text, values } = this.toPgParams(sql, params);
    const res = await this.conn().query(text, values);
    return { rows: res.rows ?? [], changes: res.rowCount ?? 0 };
  }

  async exec(sql: string, params: any[] = []): Promise<QueryResult> {
    return this.query(sql, params);
  }

  async execMany(sql: string): Promise<void> {
    await this.getPool();
    // pg cannot run multiple statements in one query() — split on `;` at the
    // top level (ignoring `;` inside string literals and comments).
    const statements = splitStatements(sql);
    // Inside a transaction, run on the transaction's client; otherwise take a
    // dedicated pooled client so the statements stay on one connection.
    const txClient = this.txStore.getStore();
    const client = txClient ?? await this.pool.connect();
    try {
      for (const stmt of statements) {
        if (!stmt.trim()) continue;
        await client.query(stmt);
      }
    } finally {
      if (!txClient) client.release();
    }
  }

  async getColumns(table: string): Promise<string[]> {
    // `table` is a trusted hardcoded identifier from TABLES config — safe to
    // interpolate, but we still validate it against an allow-list of chars.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table identifier: ${table}`);
    }
    await this.getPool();
    const res = await this.conn().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    return (res.rows as Array<{ column_name: string }>).map(r => r.column_name);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Nested call inside an active transaction on this client: join the
    // enclosing transaction (a second BEGIN would only emit a warning on
    // PostgreSQL and a premature COMMIT would break atomicity). No call site
    // nests transactions today; this is a safety net, not a feature.
    if (this.txStore.getStore()) {
      return fn();
    }
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Run the callback with this client bound into the async context so
      // every query it issues (directly or via Collection methods) executes
      // inside THIS transaction on THIS connection.
      const result = await this.txStore.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    const pool = await this.getPool();
    await pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

/** Remove a trailing `FOR UPDATE` clause from a single SQL statement. SQLite
 *  treats FOR UPDATE as a syntax error; Postgres honors it for row locking.
 *  Only a trailing (possibly `NOWAIT`/`SKIP LOCKED`-suffixed) FOR UPDATE is
 *  stripped, so it never touches string literals. */
export function stripForUpdate(sql: string): string {
  // Quick exit — no need to scan the common case.
  if (!/for update/i.test(sql)) return sql;
  // Strip a trailing FOR UPDATE [NOWAIT|SKIP LOCKED] (case-insensitive).
  return sql.replace(/\s+for\s+update(?:\s+(?:nowait|skip\s+locked))?$/i, '');
}

/** Split a SQL script into individual statements on top-level `;`, respecting
 *  single/double-quoted string literals AND `--` / `/* *\/` comments, so `;`
 *  inside strings or comments never splits a statement. (Migration scripts
 *  contain semicolons inside comments; splitting there produced fragments
 *  like `when ...` that PostgreSQL rejects with a syntax error.) */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      buf += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buf += ch;
      if (ch === '*' && sql[i + 1] === '/') { buf += '/'; i++; inBlockComment = false; }
      continue;
    }
    if (inSingle) {
      buf += ch;
      if (ch === "'" && sql[i + 1] === "'") { buf += sql[i + 1]; i++; }
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      buf += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { inLineComment = true; buf += ch; continue; }
    if (ch === '/' && sql[i + 1] === '*') { inBlockComment = true; buf += ch; continue; }
    if (ch === "'") { inSingle = true; buf += ch; continue; }
    if (ch === '"') { inDouble = true; buf += ch; continue; }
    if (ch === ';') { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  // Drop fragments that contain only comments/whitespace — PostgreSQL accepts
  // them, but skipping avoids pointless round-trips and keeps error positions
  // aligned with real statements.
  return out.filter(s => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0);
}
