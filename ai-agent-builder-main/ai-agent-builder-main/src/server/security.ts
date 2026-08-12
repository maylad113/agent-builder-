import type { Request, Response, NextFunction } from 'express';
import BetterSqlite3 from 'better-sqlite3';
import { db } from './db';

/**
 * API security hardening (Phase 22 + H1):
 *  - requestId: per-request id for log correlation (X-Request-Id header).
 *  - rateLimit: sliding-window limiter, per-IP, backed by a PLUGGABLE store.
 *    Memory in tests/local dev; SQLite by default in production so limit state
 *    survives server restarts (a restart must not reset an attacker's budget).
 *  - secureHeaders: modest security headers (no extra deps).
 *
 * These are intentionally dependency-free so they survive in the production
 * bundle without adding package surface.
 */

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Upper bound for sweep purposes: no configured window is larger than this
 * (see RATE_LIMITS), so a bucket older than `now - this` can never belong to a
 * still-active window of ANY limiter and is always safe to delete. RATE_LIMIT_
 * WINDOW_MS test overrides are also bounded by this at sweep time.
 */
const DEFAULT_MAX_RATE_LIMIT_WINDOW_MS = 60_000;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id = (typeof incoming === 'string' && incoming.length <= 128)
    ? incoming
    : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  (req as any).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

// ---------------------------------------------------------------------------
// Rate-limit stores (H1)
// ---------------------------------------------------------------------------

/**
 * A rate-limit store. Call sites (`rateLimit` middleware) depend ONLY on this
 * interface, so the backing implementation can be swapped without touching any
 * route handler:
 *
 *   - MemoryRateLimitStore — `RATE_LIMIT_STORE=memory` (default in tests and
 *     local dev; preserves the pre-H1 in-memory Map behavior).
 *   - SqliteRateLimitStore — `RATE_LIMIT_STORE=sqlite` (default in production;
 *     buckets live in the app's SQLite DB via migration 008, so a restart does
 *     NOT reset an attacker's limit state).
 *
 * A future Redis/Upstash backend is a drop-in — no call site changes:
 *
 *   class RedisRateLimitStore implements RateLimitStore {
 *     incr(key: string, windowMs: number, now: number) {
 *       // e.g. INCR key, EXPIRE key windowMs, start window on first hit
 *       return { count, windowStart };
 *     }
 *     sweep(_now: number, _maxWindowMs: number): void {
 *       // no-op: Redis TTL expires stale keys itself
 *     }
 *   }
 *
 * Register it (e.g. `setRateLimitStore(new RedisRateLimitStore())` when
 * RATE_LIMIT_STORE==='redis') and every call site is unchanged.
 */
export interface RateLimitStore {
  /**
   * Register one request for `key` in the `windowMs` window starting at
   * `windowStart`. When the previous window has expired, the bucket resets to
   * { count: 1, windowStart: now }. Must be safe for concurrent requests to
   * the same key (both shipped stores are, by virtue of Node's single thread
   * and better-sqlite3's synchronous API).
   */
  incr(key: string, windowMs: number, now: number): { count: number; windowStart: number };
  /** Best-effort cleanup of buckets older than maxWindowMs (bounded growth). */
  sweep(now: number, maxWindowMs: number): void;
}

/**
 * In-memory store: identical sliding-window semantics to the pre-H1 Map
 * implementation. Used for tests/local dev; buckets do not survive restarts
 * (that is exactly why production defaults to the SQLite store).
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; windowStart: number }>();
  private opsSinceSweep = 0;

  incr(key: string, windowMs: number, now: number): { count: number; windowStart: number } {
    this.maybeSweep(now, windowMs);
    const b = this.buckets.get(key);
    if (!b || b.windowStart + windowMs <= now) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return { count: 1, windowStart: now };
    }
    b.count++;
    return { count: b.count, windowStart: b.windowStart };
  }

  sweep(now: number, maxWindowMs: number): void {
    // Only bother once the map is large; removes only expired buckets so the
    // sliding-window semantics are unaffected.
    if (this.buckets.size < 5000) return;
    for (const [k, b] of this.buckets) {
      if (b.windowStart + maxWindowMs < now) this.buckets.delete(k);
    }
  }

  private maybeSweep(now: number, windowMs: number): void {
    this.opsSinceSweep++;
    if (this.opsSinceSweep % 64 === 0) {
      // Bound by the global max window, never the current limiter's window:
      // a small window (e.g. a test override) must not sweep another limiter's
      // still-active bucket.
      this.sweep(now, Math.max(DEFAULT_MAX_RATE_LIMIT_WINDOW_MS, windowMs));
    }
  }
}

/**
 * SQLite store: persists buckets in the app's database (migration 008) so the
 * limit state survives restarts. Uses the shared app connection by default;
 * tests may pass their own connection (e.g. over a temp DB file) to simulate a
 * restart without touching the app's connection.
 */
export class SqliteRateLimitStore implements RateLimitStore {
  private sqlite: BetterSqlite3.Database;
  private opsSinceSweep = 0;
  private getStmt: BetterSqlite3.Statement;
  private upsertStmt: BetterSqlite3.Statement;
  private updateStmt: BetterSqlite3.Statement;
  private sweepStmt: BetterSqlite3.Statement;

  constructor(sqlite?: BetterSqlite3.Database) {
    this.sqlite = sqlite ?? db.sqlite;
    this.getStmt = this.sqlite.prepare(
      'SELECT window_start AS windowStart, count FROM rate_limit_buckets WHERE key = ?'
    );
    this.upsertStmt = this.sqlite.prepare(
      'INSERT OR REPLACE INTO rate_limit_buckets (key, window_start, count) VALUES (?, ?, ?)'
    );
    this.updateStmt = this.sqlite.prepare(
      'UPDATE rate_limit_buckets SET count = ? WHERE key = ?'
    );
    this.sweepStmt = this.sqlite.prepare(
      'DELETE FROM rate_limit_buckets WHERE window_start < ?'
    );
  }

  incr(key: string, windowMs: number, now: number): { count: number; windowStart: number } {
    this.maybeSweep(now, windowMs);
    // better-sqlite3 is synchronous, so read-modify-write is atomic within the
    // process — no transaction needed for a single key.
    const row = this.getStmt.get(key) as { windowStart: number; count: number } | undefined;
    if (!row || row.windowStart + windowMs <= now) {
      this.upsertStmt.run(key, now, 1);
      return { count: 1, windowStart: now };
    }
    this.updateStmt.run(row.count + 1, key);
    return { count: row.count + 1, windowStart: row.windowStart };
  }

  sweep(now: number, maxWindowMs: number): void {
    this.sweepStmt.run(now - maxWindowMs);
  }

  private maybeSweep(now: number, windowMs: number): void {
    this.opsSinceSweep++;
    if (this.opsSinceSweep % 64 === 0) {
      // Same global-max bound as the memory store (see note there).
      this.sweep(now, Math.max(DEFAULT_MAX_RATE_LIMIT_WINDOW_MS, windowMs));
    }
  }
}

/**
 * Store selection (explicit env wins; production defaults to SQLite for
 * restart-persistence, everything else keeps the legacy in-memory behavior):
 *
 *   RATE_LIMIT_STORE=memory  → MemoryRateLimitStore (tests/local dev)
 *   RATE_LIMIT_STORE=sqlite  → SqliteRateLimitStore (production default)
 *   unset + NODE_ENV=production → SqliteRateLimitStore
 *   unset + anything else      → MemoryRateLimitStore
 */
function selectStore(): RateLimitStore {
  const env = process.env.RATE_LIMIT_STORE;
  if (env === 'sqlite') return new SqliteRateLimitStore();
  if (env === 'memory') return new MemoryRateLimitStore();
  return process.env.NODE_ENV === 'production'
    ? new SqliteRateLimitStore()
    : new MemoryRateLimitStore();
}

let store: RateLimitStore = selectStore();

/**
 * Replace the active store. Used by tests to simulate a restart over a re-opened
 * DB file and by ops to swap in a Redis backend without touching call sites.
 */
export function setRateLimitStore(next: RateLimitStore): void {
  store = next;
}

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Optional key prefix to namespace different routes. */
  prefix?: string;
}

export function rateLimit(opts: RateLimitOptions) {
  const max = opts.max;
  const prefix = opts.prefix ? opts.prefix + ':' : '';
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip rate limiting in test mode so the suite can drive many requests.
    // Tests that WANT to exercise the limiter opt in with RATE_LIMIT_TEST=1.
    if (process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_TEST !== '1') return next();
    // RATE_LIMIT_WINDOW_MS overrides the window (test-only hook; tiny windows
    // make expiry tests fast). Ignored when unset/NaN.
    const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || opts.windowMs;
    const ip = (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const key = `${prefix}${ip}`;
    const now = Date.now();
    const { count, windowStart } = store.incr(key, windowMs, now);
    if (count > max) {
      const retryAfterSec = Math.ceil((windowStart + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'Too many requests. Please slow down.',
        retryAfter: retryAfterSec
      });
      return;
    }
    next();
  };
}

export function secureHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // HSTS only over https; harmless on http but set when behind TLS.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/**
 * Default rate budgets. Every window ≤ MAX_RATE_LIMIT_WINDOW_MS so the SQLite
 * store can safely sweep rows older than that bound. RATE_LIMIT_WINDOW_MS (test
 * hook) is bounded the same way at sweep time.
 */
export const RATE_LIMITS = {
  // Authenticated dashboard API: 200 req/min per IP.
  api: { windowMs: 60_000, max: 200 },
  // Public chat widget / webhooks: 60 req/min per IP (abuse prevention).
  public: { windowMs: 60_000, max: 60 },
  // Login: stricter to slow credential stuffing.
  auth: { windowMs: 60_000, max: 20 },
  // LLM config generation: every call burns Gemini tokens, so a tighter budget
  // than the dashboard API (applied before auth so unauthenticated hammering
  // is throttled too).
  generate: { windowMs: 60_000, max: 20 },
  // Provider webhooks (Meta/Twilio): generous ceiling so legitimate provider
  // bursts are never dropped, while still throttling IP-level abuse. Signature
  // verification remains the primary gate.
  webhooks: { windowMs: 60_000, max: 300 }
};
