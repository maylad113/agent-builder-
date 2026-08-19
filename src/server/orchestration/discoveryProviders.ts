import {
  DiscoveryCandidateInput,
  NormalizedDiscoveryCandidate
} from '../../types';

/**
 * Lead Discovery provider abstraction (Phase C / Task 4).
 *
 * A LeadDiscoveryProvider turns a bounded input into normalized discovery
 * CANDIDATES. Candidates are untrusted business data — providers never
 * execute them, never treat them as instructions, and never invent missing
 * facts. The orchestration layer (discoveryRuns.ts) depends only on this
 * contract, so future providers (search APIs, official platform APIs) are
 * replaceable without touching business logic.
 *
 * SECURITY CONTRACT (binding for every adapter, enforced by review + tests):
 *  - `manual_list` performs ZERO network access (no fetch/DNS/browser).
 *  - Future network-capable adapters MUST pass the egress guard contract from
 *    the Phase C audit (https-only, IP denylist incl. metadata/loopback,
 *    pinned DNS, ≤3 re-validated redirects, byte cap, timeout) BEFORE any
 *    fetch. That guard is deliberately unbuilt — network discovery is
 *    deferred.
 *  - No dynamic module loading: the registry below is a closed static map;
 *    an unknown provider id is rejected, never resolved to code.
 */

export interface DiscoveryProviderInput {
  query?: string;
  location?: string;
  candidates?: DiscoveryCandidateInput[];
}

export interface DiscoveryProviderResult {
  candidates: NormalizedDiscoveryCandidate[];
  invalidCount: number;
  duplicateCount: number;
  error?: string;
}

export interface LeadDiscoveryProvider {
  readonly type: string;
  readonly label: string;
  isConfigured(): boolean;
  /** Never throws; failures are returned as { error } with empty candidates. */
  search(input: DiscoveryProviderInput): Promise<DiscoveryProviderResult>;
}

// ---------------------------------------------------------------------------
// Deterministic normalizers (pure; no network, no locale dependence)
// ---------------------------------------------------------------------------

const MAX_FIELD = 200;

function bound(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

export function normalizeBusinessName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u2018\u2019'`]/g, '') // apostrophe variants
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePhone(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

/** String-only host extraction. Never resolves DNS, never fetches. */
export function normalizeDomain(website: string): string {
  if (!website || /\s/.test(website)) return '';
  let w = website.trim().toLowerCase();
  const schemeMatch = w.match(/^https?:\/\/(.*)$/i);
  if (w.includes('://') && !schemeMatch) return ''; // dangerous scheme — reject
  if (schemeMatch) w = schemeMatch[1];
  w = w.split('/')[0].split('?')[0].split('#')[0];
  if (w.startsWith('www.')) w = w.slice(4);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(w) ? w : '';
}

export function normalizeInstagramHandle(handle: string): string {
  const h = (handle || '').trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(h) ? h : '';
}

function normalizeLocation(location: string): string {
  return (location || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic in-run identity key. Strongest signal wins:
 * instagram handle > domain > phone ≥7 digits > normalized name+location.
 * Name-only is NEVER a key (ambiguous names stay separate per audit).
 */
export function computeDedupeKey(c: NormalizedDiscoveryCandidate): string | undefined {
  const ig = normalizeInstagramHandle(c.instagramHandle || '');
  if (ig) return `ig:${ig}`;
  const dom = normalizeDomain(c.website || '');
  if (dom) return `dom:${dom}`;
  const tel = normalizePhone(c.phone || '');
  if (tel.length >= 7) return `tel:${tel}`;
  const name = normalizeBusinessName(c.businessName);
  const loc = normalizeLocation(c.location || '');
  if (name && loc) return `nl:${name}|${loc}`;
  return undefined;
}

/** Validate + normalize one untrusted candidate. Returns undefined when invalid. */
export function normalizeCandidate(input: unknown): NormalizedDiscoveryCandidate | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const c = input as Record<string, unknown>;
  const businessName = bound(c.businessName);
  if (!businessName) return undefined;
  const out: NormalizedDiscoveryCandidate = { businessName };
  const location = bound(c.location);
  if (location) out.location = location;
  const phone = bound(c.phone);
  if (phone) out.phone = phone;
  const website = bound(c.website);
  if (website) out.website = website;
  const instagramHandle = bound(c.instagramHandle);
  if (instagramHandle) out.instagramHandle = instagramHandle;
  const notes = bound(c.notes);
  if (notes) out.notes = notes;
  const sourceUrl = bound(c.sourceUrl);
  if (sourceUrl) out.sourceUrl = sourceUrl;
  const key = computeDedupeKey(out);
  if (key) out.dedupeKey = key;
  return out;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * manual_list — operator-pasted structured candidates. The free-first,
 * zero-network adapter: string validation + deterministic normalization only.
 */
class ManualListProvider implements LeadDiscoveryProvider {
  readonly type = 'manual_list';
  readonly label = 'Manual List';
  isConfigured(): boolean {
    return true;
  }
  async search(input: DiscoveryProviderInput): Promise<DiscoveryProviderResult> {
    if (!input || !Array.isArray(input.candidates)) {
      return { candidates: [], invalidCount: 0, duplicateCount: 0, error: 'candidates array is required.' };
    }
    let invalidCount = 0;
    let duplicateCount = 0;
    const seen = new Set<string>();
    const candidates: NormalizedDiscoveryCandidate[] = [];
    for (const raw of input.candidates) {
      const normalized = normalizeCandidate(raw);
      if (!normalized) {
        invalidCount++;
        continue;
      }
      if (normalized.dedupeKey) {
        if (seen.has(normalized.dedupeKey)) {
          duplicateCount++;
          continue;
        }
        seen.add(normalized.dedupeKey);
      }
      candidates.push(normalized);
    }
    return { candidates, invalidCount, duplicateCount };
  }
}

export const manualListProvider = new ManualListProvider();

/** Closed static registry — unknown ids are rejected, never resolved to code. */
const DISCOVERY_PROVIDERS: Record<string, LeadDiscoveryProvider> = Object.freeze({
  manual_list: manualListProvider
});

export function registeredProviderTypes(): string[] {
  return Object.keys(DISCOVERY_PROVIDERS);
}

export function resolveDiscoveryProvider(type?: string): LeadDiscoveryProvider {
  const id = type || 'manual_list';
  const provider = Object.prototype.hasOwnProperty.call(DISCOVERY_PROVIDERS, id)
    ? DISCOVERY_PROVIDERS[id]
    : undefined;
  if (!provider) throw new Error(`Unknown discovery provider: ${String(id).slice(0, 64)}`);
  return provider;
}
