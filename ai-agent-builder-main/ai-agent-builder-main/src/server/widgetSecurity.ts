import { db } from './db';

/**
 * Widget origin security (P1.2).
 *
 * The chat widget is embedded on third-party business websites. Each business
 * declares the origins allowed to host its widget (`allowedWidgetOrigins`). The
 * runtime CORS check enforces this per-tenant so a Business A widget can never
 * impersonate Business B or leak data cross-tenant.
 *
 * In development (NODE_ENV !== 'production') localhost origins are allowed when
 * a business has no explicit allow-list, so the local dev loop keeps working.
 */

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isOriginAllowed(businessId: string, origin: string | undefined): boolean {
  if (!origin) return false;
  const biz = db.businesses.find(b => b.id === businessId);
  if (!biz) return false;

  const allowed = biz.allowedWidgetOrigins;
  if (allowed && allowed.length > 0) {
    // Normalize trailing slashes for comparison.
    const norm = origin.replace(/\/$/, '');
    return allowed.some(o => o.replace(/\/$/, '') === norm);
  }
  // No explicit allow-list: in development allow localhost; in production
  // reject unknown origins (business must configure its origins).
  if (process.env.NODE_ENV !== 'production') {
    return LOCALHOST_RE.test(origin);
  }
  return false;
}

/**
 * Build the per-request CORS headers for the widget endpoint, or null if the
 * origin is not allowed (caller returns 403).
 */
export function widgetCorsHeaders(businessId: string, origin: string | undefined): Record<string, string> | null {
  if (!isOriginAllowed(businessId, origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin as string,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-business-id',
    'Access-Control-Max-Age': '600',
  };
}
