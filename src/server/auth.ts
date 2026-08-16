import crypto from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { db } from './db';
import { User, PublicUser, Session, UserRole } from '../types';

/** Wrap an async Express handler so rejected promises reach the error
 *  middleware instead of becoming unhandled rejections (Express 4 does not
 *  catch async middleware by default). */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Server-side auth + tenant isolation for the AI Agent Factory MVP.
 *
 * Session model (zero new dependencies):
 *  - A session row is stored in SQLite (`sessions` table) so sessions survive
 *    server restarts and logout truly invalidates (the row is deleted).
 *  - The browser only holds a signed HttpOnly cookie: `<sessionId>.<hmac>`.
 *    The HMAC (HMAC-SHA256 over the session id) prevents tampering/forgery;
 *    the session row is the source of truth.
 *  - Cookie flags: HttpOnly, SameSite=Lax, Secure=false (dev over HTTP
 *    localhost; flip to true behind HTTPS in production).
 *
 * Tenant isolation model:
 *  - PLATFORM_OWNER may access any business.
 *  - BUSINESS_OWNER / BUSINESS_STAFF are hard-scoped to the business_id on
 *    their user row (from the SESSION — never from query params or body).
 *  - Reads (GET/HEAD) of a resource in a business the user cannot access
 *    return 404 (never leak existence). Writes targeting another tenant's
 *    resources return 403. Role violations return 403, missing session 401.
 */

export const SESSION_COOKIE = 'af_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    // Audit P2.7: a weak/short secret makes the session HMAC forgeable. Require
    // >= 32 characters of entropy in production (the dev fallback below is only
    // used outside production).
    if (process.env.NODE_ENV === 'production' && secret.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters long in production.');
    }
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET environment variable must be set in production.');
  }
  // Development fallback — never logged, never sent to the frontend.
  return 'dev-session-secret-change-me-in-production';
}

/**
 * Eagerly validate the session secret at server startup (audit P2.7). Throwing
 * here prevents the server from booting with a weak/missing production secret,
 * rather than failing lazily on the first login attempt. No-op outside prod.
 */
export function validateProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET environment variable must be set in production.');
  }
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters long in production.');
  }
}

function sign(value: string): string {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('hex');
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Public user shape (never includes passwordHash). */
export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _ph, ...pub } = user;
  return pub;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function createSession(userId: string): Promise<Session> {
  const session: Session = {
    id: crypto.randomBytes(32).toString('hex'),
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
  await db.sessions.push(session);
  return session;
}

export async function destroySession(sessionId: string): Promise<void> {
  const idx = await db.sessions.findIndex(s => s.id === sessionId);
  if (idx !== -1) await db.sessions.splice(idx, 1);
}

export function setSessionCookie(req: Request, res: Response, sessionId: string): void {
  const value = `${sessionId}.${sign(sessionId)}`;
  res.cookie(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure cookies require HTTPS. In production we default to secure=true,
    // but honor the X-Forwarded-Proto header (set by nginx/load balancers doing
    // TLS termination) so auth works behind a proxy. COOKIE_SECURE=0 is an
    // explicit escape hatch for HTTP-only deployments/testing.
    secure: process.env.COOKIE_SECURE === '0'
      ? false
      : (process.env.NODE_ENV === 'production' && (req.protocol === 'https' || req.secure)),
    path: '/',
    maxAge: SESSION_TTL_MS
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Resolve the session cookie to a user, or null. Validates signature, row, expiry. */
export async function loadUserFromSession(req: Request): Promise<User | null> {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const sessionId = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!sessionId || !sig) return null;

  const expected = Buffer.from(sign(sessionId), 'hex');
  const actual = Buffer.from(sig, 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

  const session = await db.sessions.find(s => s.id === sessionId);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await destroySession(sessionId); // lazy cleanup of expired rows
    return null;
  }
  return (await db.users.find(u => u.id === session.userId)) ?? null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** 401 when there is no valid session. Attaches the user to res.locals.user. */
export const requireAuth = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
  const user = await loadUserFromSession(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  res.locals.user = user;
  _next();
});

/** 403 on role mismatch. Must run after requireAuth. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as User | undefined;
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action.' });
    }
    next();
  };
}

function isReadMethod(req: Request): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

/**
 * Tenant scoping for routes that identify the tenant via `businessId`
 * (query param or body field). The authorized tenant is derived from the
 * SESSION — a frontend-supplied businessId can never widen access.
 *
 *  - PLATFORM_OWNER: any requested tenant; empty -> all tenants.
 *  - BUSINESS_OWNER/STAFF: only their own tenant; requesting another tenant's
 *    id yields 404 (read) or 403 (write); empty -> their own tenant.
 *
 * Sets res.locals.businessId = the effective tenant (or null for "all").
 */
export const requireTenantScope = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const user = res.locals.user as User | undefined;
  if (!user) return res.status(401).json({ error: 'Authentication required.' });

  const requestedRaw = (req.query.businessId ?? req.body?.businessId ?? '') as string;
  const requested = String(requestedRaw);
  const isPlatformOwner = user.role === 'PLATFORM_OWNER';

  if (!isPlatformOwner && requested && requested !== user.businessId) {
    return isReadMethod(req)
      ? res.status(404).json({ error: 'Not found.' })
      : res.status(403).json({ error: 'Forbidden: you do not have access to this business.' });
  }

  res.locals.businessId = requested || (isPlatformOwner ? null : user.businessId);
  next();
});

/**
 * Resource-level tenant isolation for routes addressed by resource id
 * (`/api/<collection>/:id`). Loads the resource, verifies its business_id is
 * the authorized tenant. Must run after requireAuth.
 *
 *  - resource missing -> 404
 *  - resource belongs to another tenant -> 404 on read, 403 on write
 *  - authorized -> stores the resource in res.locals.resource and continues
 *
 * `businessIdOf` extracts the tenant from the resource (defaults to the
 * resource's `businessId` field). Businesses are their own tenant root, so
 * callers pass `(b) => b.id` for business routes.
 *
 * `lookup` is async (it queries the database); the returned middleware awaits
 * it so the tenant check is performed before the route handler runs.
 */
export function requireResourceAccess(
  lookup: (req: Request) => Promise<{ businessId?: string } | { id: string } | undefined | null>,
  businessIdOf?: (resource: any) => string | undefined
): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as User | undefined;
    if (!user) return res.status(401).json({ error: 'Authentication required.' });

    const resource = await lookup(req);
    if (!resource) {
      return res.status(404).json({ error: 'Not found.' });
    }
    const tenantOf = businessIdOf ?? ((r: any) => r.businessId);
    const resourceTenant = tenantOf(resource);
    const authorized = user.role === 'PLATFORM_OWNER' || (resourceTenant != null && user.businessId === resourceTenant);
    if (!authorized) {
      return isReadMethod(req)
        ? res.status(404).json({ error: 'Not found.' })
        : res.status(403).json({ error: 'Forbidden: you do not have access to this resource.' });
    }
    res.locals.resource = resource;
    next();
  });
}
