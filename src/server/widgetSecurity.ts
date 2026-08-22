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
const MAX_ORIGIN_LEN = 255;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Validate and normalize a widget origin to `scheme://host[:port]`.
 * Returns null for anything that is not a strict origin — never salvages,
 * never guesses, never introduces wildcards or credentials:
 *  - http(s) only; plain HTTP only for the localhost dev loop (matches
 *    LOCALHOST_RE); real customer origins must be HTTPS.
 *  - no path/query/fragment, no credentials, no `*`, no empty/malformed input.
 * `URL.origin` normalizes case, strips the trailing slash, and drops default
 * ports (https://EXAMPLE.com:443/ -> https://example.com).
 */
export function normalizeWidgetOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_ORIGIN_LEN) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.includes('*')) return null;
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(host)) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin;
}

/**
 * Derive a validated widget origin from a full website URL (the existing
 * prospect/design website data). `https://shop.example/services` ->
 * `https://shop.example`. Returns null when the website is absent, malformed,
 * or its origin would not pass the strict origin rules — never guesses.
 */
export function deriveOriginFromWebsite(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_ORIGIN_LEN * 4) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // url.origin is scheme://host[:port] (no path/query/credentials) or the
  // string "null" for non-special schemes, which the validator rejects.
  return normalizeWidgetOrigin(url.origin);
}

/**
 * Normalize an origin list: invalid entries are dropped, duplicates removed,
 * order preserved. Non-array input yields an empty list (never guesses).
 */
export function normalizeWidgetOriginList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const origin = normalizeWidgetOrigin(item);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * The platform's own public origin, used to build the ABSOLUTE widget embed
 * URL in the onboarding artifact (a relative `/widget.js` would resolve
 * against the customer's domain). Configured via PLATFORM_PUBLIC_URL
 * (validated by the same origin rules); falls back to the localhost dev
 * server so local development keeps working.
 */
export function platformPublicOrigin(): string {
  const configured = normalizeWidgetOrigin(process.env.PLATFORM_PUBLIC_URL);
  if (configured) return configured;
  const port = Number(process.env.PORT) || 3000;
  return `http://localhost:${port}`;
}

export async function isOriginAllowed(businessId: string, origin: string | undefined): Promise<boolean> {
  if (!origin) return false;
  const biz = await db.businesses.find(b => b.id === businessId);
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
export async function widgetCorsHeaders(businessId: string, origin: string | undefined): Promise<Record<string, string> | null> {
  if (!(await isOriginAllowed(businessId, origin))) return null;
  return {
    'Access-Control-Allow-Origin': origin as string,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-business-id',
    'Access-Control-Max-Age': '600',
  };
}
