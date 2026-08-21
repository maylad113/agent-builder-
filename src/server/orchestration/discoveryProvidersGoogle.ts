import {
  LeadDiscoveryProvider,
  DiscoveryProviderInput,
  DiscoveryProviderResult,
  normalizeCandidate,
  dedupeNormalized,
  validateProviderResultId
} from './discoveryProviders';
import { NormalizedDiscoveryCandidate } from '../../types';
import { resolveTimeoutMs, isAbortError } from '../llmProvider';
import { consumePlacesAttempt } from './discoveryQuota';

/**
 * Google Places API (New) — Text Search discovery adapter (Phase C / Task 7).
 *
 * NETWORK SECURITY CONTRACT (audited, Task 6 §E — do not weaken):
 *  - Exactly ONE destination: POST https://places.googleapis.com/v1/places:searchText
 *  - HTTPS only, fixed compile-time hostname, no redirects (redirect:'error')
 *  - API key in the X-Goog-Api-Key HEADER only — never in the URL, body,
 *    logs, telemetry, results, or errors
 *  - 15s AbortController timeout (DISCOVERY_PROVIDER_TIMEOUT_MS override,
 *    invalid values fall back — the timeout can never be disabled)
 *  - 256 KB response cap (Content-Length precheck + post-read length check)
 *  - <= 20 results, ONE API call per search, at most ONE retry and ONLY on
 *    HTTP 429/5xx; never retried on 4xx auth failures, network errors,
 *    timeouts, or malformed bodies
 *  - Returned text (names, URLs, categories) is UNTRUSTED DATA: it is stored,
 *    never executed, never fetched (websiteUri is never requested), never
 *    fed to an LLM as instructions
 *
 * RETENTION (Task 7 §8): Google terms restrict caching of non-ID Places
 * content (~30 days). place.id may be retained indefinitely. This adapter
 * therefore declares retentionDays = 30: runDiscovery stamps sourceExpiresAt
 * on every Google-derived result and the acceptance bridge refuses expired
 * results, so Google-derived content cannot flow into a durable prospect
 * after the retention window. We do NOT store raw API responses — only the
 * bounded mapped field subset. This is a technical mitigation, not a legal
 * opinion; operators must review Google's terms for their usage.
 */

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.types'
].join(',');
const MAX_QUERY_LEN = 160;
const MAX_LOCATION_LEN = 120;
const MAX_RESULTS = 20;
const MAX_RESPONSE_BYTES = 256 * 1024;
const RETRY_DELAY_MS = 500;

const RETENTION_DAYS = 30; // Google non-ID Places content cache bound (see header)

function timeoutMs(): number {
  return resolveTimeoutMs('DISCOVERY_PROVIDER_TIMEOUT_MS', 15000);
}

function maxResults(): number {
  const raw = Number(process.env.DISCOVERY_MAX_RESULTS);
  if (!Number.isFinite(raw) || raw < 1) return MAX_RESULTS;
  return Math.min(Math.floor(raw), MAX_RESULTS);
}

function fail(error: string): DiscoveryProviderResult {
  return { candidates: [], invalidCount: 0, duplicateCount: 0, error };
}

interface PlacesResponse {
  places?: unknown;
}

/** Structural validation + mapping of one untrusted place object. */
function mapPlace(place: unknown): NormalizedDiscoveryCandidate | undefined {
  if (!place || typeof place !== 'object') return undefined;
  const p = place as Record<string, unknown>;
  const nameObj = p.displayName as Record<string, unknown> | undefined;
  const displayName = typeof nameObj?.text === 'string' ? nameObj.text : undefined;
  if (!displayName) return undefined;
  const types = Array.isArray(p.types)
    ? p.types.filter((t): t is string => typeof t === 'string').slice(0, 3)
    : [];
  const mapped = normalizeCandidate({
    businessName: displayName,
    location: typeof p.formattedAddress === 'string' ? p.formattedAddress : undefined,
    phone:
      typeof p.nationalPhoneNumber === 'string'
        ? p.nationalPhoneNumber
        : typeof p.internationalPhoneNumber === 'string'
          ? p.internationalPhoneNumber
          : undefined,
    website: typeof p.websiteUri === 'string' ? p.websiteUri : undefined,
    notes: types.length ? `category: ${types.join(', ')}` : undefined
  });
  if (!mapped) return undefined;
  // Provider id is trusted-adapter-mapped (validated charset) and outranks
  // every other dedupe tier. Manual/untrusted input can never set it.
  const pid = validateProviderResultId(p.id);
  if (pid) {
    mapped.providerResultId = pid;
    mapped.dedupeKey = `pid:${pid}`;
  }
  return mapped;
}

interface AttemptResult {
  ok: boolean;
  body?: string;
  error?: string;
  retryable?: boolean;
  quotaExceeded?: boolean;
}

function isQuotaExceeded(err: any): boolean {
  return typeof err?.message === 'string' && err.message.includes('daily usage limit');
}

async function postOnce(apiKey: string, textQuery: string): Promise<AttemptResult> {
  // Count the real attempt (operator safety guard) INSIDE the caller's
  // active transaction. A cap rejection before the FIRST attempt throws
  // (rolls the whole run back — nothing was attempted). A cap rejection at a
  // LATER attempt is returned as an honest quota error so the charged first
  // attempt stays counted and the run records a truthful FAILED state.
  try {
    await consumePlacesAttempt();
  } catch (e: any) {
    if (isQuotaExceeded(e)) return { ok: false, error: e.message, retryable: false, quotaExceeded: true };
    throw e;
  }
  const controller = new AbortController();
  const ms = timeoutMs();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const resp = await fetch(PLACES_URL, {
      method: 'POST',
      redirect: 'error', // never follow redirects
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey, // header only — never URL/body
        'X-Goog-FieldMask': FIELD_MASK
      },
      body: JSON.stringify({ textQuery, pageSize: maxResults() })
    });
    const contentLength = Number(resp.headers.get('content-length') || 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      return { ok: false, error: 'Provider response too large.', retryable: false };
    }
    const body = await resp.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      return { ok: false, error: 'Provider response too large.', retryable: false };
    }
    if (resp.status === 429 || resp.status >= 500) {
      return { ok: false, error: `Provider unavailable (HTTP ${resp.status}).`, retryable: true };
    }
    if (resp.status !== 200) {
      // 4xx (incl. auth failures): fail loud, never retry. Body may echo the
      // key — it is deliberately NOT included in the error.
      return { ok: false, error: `Provider rejected the request (HTTP ${resp.status}).`, retryable: false };
    }
    return { ok: true, body };
  } catch (err: any) {
    if (isAbortError(err) || err?.name === 'AbortError') {
      return { ok: false, error: `Provider request timed out after ${ms}ms.`, retryable: false };
    }
    return { ok: false, error: 'Provider request failed (network error).', retryable: false };
  } finally {
    clearTimeout(timer);
  }
}

class GooglePlacesProvider implements LeadDiscoveryProvider {
  readonly type = 'google_places';
  readonly label = 'Google Places';
  readonly requiresQuery = true;
  readonly retentionDays = RETENTION_DAYS;

  isConfigured(): boolean {
    return !!process.env.GOOGLE_PLACES_API_KEY;
  }

  async search(input: DiscoveryProviderInput): Promise<DiscoveryProviderResult> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) return fail('Google Places provider is not configured.');

    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    if (!query) return fail('query is required.');
    if (query.length > MAX_QUERY_LEN) return fail(`query exceeds ${MAX_QUERY_LEN} characters.`);
    const location = typeof input?.location === 'string' ? input.location.trim() : '';
    if (location.length > MAX_LOCATION_LEN) return fail(`location exceeds ${MAX_LOCATION_LEN} characters.`);
    // The query is DATA sent to Google — it can never influence the destination.
    const textQuery = location ? `${query} ${location}` : query;

    let attempt = await postOnce(apiKey, textQuery);
    if (!attempt.ok && attempt.quotaExceeded) {
      // Cap hit before the FIRST attempt: nothing was attempted — throw so the
      // whole run rolls back (no usage charged, no run/result persisted).
      throw new Error(attempt.error);
    }
    if (!attempt.ok) {
      if (attempt.retryable) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        attempt = await postOnce(apiKey, textQuery);
        if (!attempt.ok && attempt.quotaExceeded) {
          // First attempt was REAL and charged; the retry hit the cap. Record
          // an honest FAILED run (usage stays charged — the attempt happened).
          return fail(attempt.error);
        }
      }
      if (!attempt.ok) return fail(attempt.error);
    }

    let parsed: PlacesResponse;
    try {
      parsed = JSON.parse(attempt.body);
    } catch {
      return fail('Provider returned malformed JSON.');
    }
    if (parsed === null || typeof parsed !== 'object') return fail('Provider returned malformed JSON.');
    // Google omits `places` when there are zero results — an honest empty set.
    if (parsed.places === undefined || parsed.places === null) {
      return { candidates: [], invalidCount: 0, duplicateCount: 0 };
    }
    if (!Array.isArray(parsed.places)) return fail('Provider returned a malformed result set.');

    let invalidCount = 0;
    const mapped: NormalizedDiscoveryCandidate[] = [];
    for (const place of parsed.places.slice(0, MAX_RESULTS)) {
      const candidate = mapPlace(place);
      if (!candidate) {
        invalidCount++;
        continue;
      }
      mapped.push(candidate);
    }
    const { candidates, duplicateCount } = dedupeNormalized(mapped);
    return { candidates, invalidCount, duplicateCount };
  }
}

export const googlePlacesProvider = new GooglePlacesProvider();
