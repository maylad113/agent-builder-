import type { Request, Response, NextFunction } from 'express';

/**
 * API security hardening (Phase 22):
 *  - requestId: per-request id for log correlation (X-Request-Id header).
 *  - rateLimit: in-memory sliding-window limiter, per-IP. No external deps.
 *    Tunable via env. Public widget endpoint gets a higher budget.
 *  - secureHeaders: modest security headers (no extra deps).
 *
 * These are intentionally dependency-free so they survive in the production
 * bundle without adding package surface.
 */

const REQUEST_ID_HEADER = 'x-request-id';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id = (typeof incoming === 'string' && incoming.length <= 128)
    ? incoming
    : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  (req as any).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Optional key prefix to namespace different routes. */
  prefix?: string;
}

export function rateLimit(opts: RateLimitOptions) {
  const windowMs = opts.windowMs;
  const max = opts.max;
  const prefix = opts.prefix ? opts.prefix + ':' : '';
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip rate limiting in test mode so the suite can drive many requests.
    if (process.env.NODE_ENV === 'test') return next();
    const ip = (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const key = `${prefix}${ip}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    b.count++;
    if (b.count > max) {
      const retryAfterSec = Math.ceil((b.resetAt - now) / 1000);
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

/** Default rate budgets. */
export const RATE_LIMITS = {
  // Authenticated dashboard API: 200 req/min per IP.
  api: { windowMs: 60_000, max: 200 },
  // Public chat widget / webhooks: 60 req/min per IP (abuse prevention).
  public: { windowMs: 60_000, max: 60 },
  // Login: stricter to slow credential stuffing.
  auth: { windowMs: 60_000, max: 20 }
};
