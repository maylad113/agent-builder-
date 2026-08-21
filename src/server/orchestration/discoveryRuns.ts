import { db } from '../db';
import { DiscoveryRun, DiscoveryResult, DiscoveryCandidateInput } from '../../types';
import { resolveDiscoveryProvider } from './discoveryProviders';
import { recordOrchestrationEvent } from '../telemetry';
import { safeError } from '../logSanitizer';

/**
 * Discovery runs (Phase C / Task 4) — the durable intake layer.
 *
 * A run resolves a provider through the closed registry, executes it, and
 * persists the run + its candidate results atomically. Discovery is the
 * EVIDENCE layer only: it never triggers research, scoring, design, factory,
 * or outreach. Results are platform-owner scope (pre-tenant) and carry no
 * businessId — tenant assignment happens only later at human accept time.
 */

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RunDiscoveryParams {
  idempotencyKey: string;
  query?: string;
  location?: string;
  candidates?: DiscoveryCandidateInput[];
  /** Defaults to the free-first 'manual_list' provider. */
  provider?: string;
}

export async function findRunByIdempotencyKey(key: string): Promise<DiscoveryRun | undefined> {
  return db.discoveryRuns.find(r => r.idempotencyKey === key);
}

export async function getDiscoveryRun(id: string): Promise<DiscoveryRun | undefined> {
  return db.discoveryRuns.find(r => r.id === id);
}

export async function listDiscoveryRuns(limit = 50): Promise<DiscoveryRun[]> {
  const rows = await db.discoveryRuns.toJSON();
  return rows
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

export async function listResultsForRun(runId: string): Promise<DiscoveryResult[]> {
  const rows = await db.discoveryResults.filter(r => r.runId === runId);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Execute a discovery run. Idempotent by idempotencyKey (UNIQUE-backed).
 * Run + results are written inside ONE transaction so a partial run is
 * never observable.
 */
export async function runDiscovery(params: RunDiscoveryParams): Promise<DiscoveryRun> {
  if (!params || typeof params !== 'object') throw new Error('params are required.');
  if (!params.idempotencyKey || typeof params.idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required.');
  }
  if (params.query !== undefined && typeof params.query !== 'string') throw new Error('query must be a string.');
  if (params.location !== undefined && typeof params.location !== 'string') {
    throw new Error('location must be a string.');
  }

  const provider = resolveDiscoveryProvider(params.provider); // throws on unknown id
  if (!provider.isConfigured()) throw new Error(`Discovery provider not configured: ${provider.type}`);
  if (provider.requiresQuery && !(typeof params.query === 'string' && params.query.trim())) {
    throw new Error(`query is required for provider: ${provider.type}`);
  }

  const existing = await findRunByIdempotencyKey(params.idempotencyKey);
  if (existing) return existing;

  await recordOrchestrationEvent({
    eventType: 'DISCOVERY_RUN',
    summary: `Discovery run started (${provider.type})`
  });

  const startedAt = new Date().toISOString();
  const run: DiscoveryRun = {
    id: genId('dsc'),
    provider: provider.type,
    status: 'COMPLETED',
    resultCount: 0,
    duplicateCount: 0,
    invalidCount: 0,
    idempotencyKey: params.idempotencyKey,
    createdAt: startedAt,
    updatedAt: startedAt
  };
  const query = params.query?.trim();
  const location = params.location?.trim();
  if (query || location) run.params = { ...(query ? { query } : {}), ...(location ? { location } : {}) };

  let results: DiscoveryResult[] = [];
  try {
    // Google attempts are consumed INSIDE this same transaction (the adapter's
    // postOnce → consumePlacesAttempt), so quota check-then-increment is
    // atomic with the run's own persistence. A cap rejection throws here,
    // rolling back usage + run + results together (nothing is persisted).
    await db.client.transaction(async () => {
      const out = await provider.search({
        query: params.query,
        location: params.location,
        candidates: params.candidates
      });
      if (out.error) {
        run.status = 'FAILED';
        run.error = out.error.slice(0, 200);
      } else {
        run.resultCount = out.candidates.length;
        run.duplicateCount = out.duplicateCount;
        run.invalidCount = out.invalidCount;
        // Retention bound (e.g. Google's 30-day non-ID content limit): results
        // carry a source expiry and the acceptance bridge refuses expired ones,
        // so retention-restricted content cannot flow into a durable prospect.
        const sourceExpiresAt = provider.retentionDays
          ? new Date(new Date(startedAt).getTime() + provider.retentionDays * 86_400_000).toISOString()
          : undefined;
        results = out.candidates.map(c => ({
          id: genId('dsr'),
          runId: run.id,
          sourceProvider: provider.type,
          sourceUrl: c.sourceUrl,
          sourceType: (provider.type === 'manual_list' ? 'manual' : 'api') as 'manual' | 'api',
          raw: {
            businessName: c.businessName,
            ...(c.providerResultId ? { providerResultId: c.providerResultId } : {}),
            ...(c.location ? { location: c.location } : {}),
            ...(c.phone ? { phone: c.phone } : {}),
            ...(c.website ? { website: c.website } : {}),
            ...(c.instagramHandle ? { instagramHandle: c.instagramHandle } : {}),
            ...(c.notes ? { notes: c.notes } : {}),
            ...(c.sourceUrl ? { sourceUrl: c.sourceUrl } : {})
          },
          normalized: c,
          verification: 'UNVERIFIED' as const,
          ...(sourceExpiresAt ? { sourceExpiresAt } : {}),
          createdAt: startedAt
        }));
      }
      await db.discoveryRuns.push(run);
      for (const r of results) {
        await db.discoveryResults.push(r);
      }
    });
  } catch (e: any) {
    // Quota guard rejections are honest input errors (fail closed) — rethrow
    // verbatim so the caller sees the real reason; nothing is persisted.
    if (typeof e?.message === 'string' && e.message.includes('daily usage limit')) throw e;
    // UNIQUE backstop: the losing side of a concurrent run returns the winner.
    safeError('[orchestration] discovery write raced:', e?.message || e);
    const raced = await findRunByIdempotencyKey(params.idempotencyKey);
    if (raced) return raced;
    throw new Error('Could not persist discovery run.');
  }

  await recordOrchestrationEvent({
    eventType: run.status === 'COMPLETED' ? 'DISCOVERY_COMPLETED' : 'DISCOVERY_FAILED',
    summary:
      run.status === 'COMPLETED'
        ? `Discovery completed: ${run.resultCount} candidate(s), ${run.duplicateCount} duplicate(s), ${run.invalidCount} invalid`
        : 'Discovery failed',
    metadata: { discoveryRunId: run.id }
  });
  return run;
}
