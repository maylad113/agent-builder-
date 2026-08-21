import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Google Places usage/quota protection tests (Phase C / Task 20).
 *
 * Counts REAL Google attempts (not manual runs, not dry validation), fails
 * CLOSED at the operator-side safety cap, and is atomic under concurrency
 * (final slot consumed by exactly one caller). Manual discovery, retention,
 * and the 20/min app rate limit are untouched. All network is mocked.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-quota-'));
process.env.DB_PATH = path.join(tmpDir, 'quota.db');
process.env.SESSION_SECRET = 'test-discovery-quota-secret';
delete process.env.GEMINI_API_KEY;
process.env.GOOGLE_PLACES_API_KEY = 'test-quota-key-fake';

const { db } = await import('../src/server/db');
const { runDiscovery, listResultsForRun } = await import('../src/server/orchestration/discoveryRuns');
const findRunByKey = async (key: string) => db.discoveryRuns.find(r => r.idempotencyKey === key);
const { googlePlacesProvider } = await import('../src/server/orchestration/discoveryProvidersGoogle');
const { readPlacesUsage, placesUsageBucket } = await import('../src/server/orchestration/discoveryQuota');

const KEY = 'test-quota-key-fake';
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';

function okResp(body: any) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
const place = (id: string) => ({ id, displayName: { text: `Biz ${id}` } });

let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await db.init({ seed: true });
});
afterAll(async () => {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(async () => {
  // Reset the global counter for a clean slate each test.
  await db.client.exec('DELETE FROM places_usage');
  fetchSpy = vi.fn(async () => okResp({ places: [place('p1')] }));
  vi.stubGlobal('fetch', fetchSpy);
  process.env.GOOGLE_PLACES_API_KEY = KEY;
  delete process.env.GOOGLE_PLACES_DAILY_LIMIT;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_PLACES_DAILY_LIMIT;
});

describe('usage counting', () => {
  it('a real google run increments the counter by the actual attempt count', async () => {
    await runDiscovery({ idempotencyKey: 'q-1', provider: 'google_places', query: 'barbers' });
    const usage = await readPlacesUsage(placesUsageBucket());
    expect(usage.calls).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('manual_list never increments the google counter', async () => {
    await runDiscovery({ idempotencyKey: 'q-2', candidates: [{ businessName: 'M', instagramHandle: 'm1' }] });
    const usage = await readPlacesUsage(placesUsageBucket());
    expect(usage.calls).toBe(0);
  });

  it('a failed attempt that REACHED google still counts (status 500 after retry)', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 500 }));
    const run = await runDiscovery({ idempotencyKey: 'q-3', provider: 'google_places', query: 'x' });
    expect(run.status).toBe('FAILED');
    const usage = await readPlacesUsage(placesUsageBucket());
    expect(usage.calls).toBe(2); // attempt + its single bounded retry
  });

  it('a request that never reached google (query validation) does NOT count', async () => {
    await expect(runDiscovery({ idempotencyKey: 'q-4', provider: 'google_places' })).rejects.toThrow();
    const usage = await readPlacesUsage(placesUsageBucket());
    expect(usage.calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the bucket is the current UTC day', () => {
    expect(placesUsageBucket()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('limit behavior (fail closed)', () => {
  it('allows calls below the cap and at the exact boundary', async () => {
    process.env.GOOGLE_PLACES_DAILY_LIMIT = '2';
    await runDiscovery({ idempotencyKey: 'q-5', provider: 'google_places', query: 'a' }); // 1
    await runDiscovery({ idempotencyKey: 'q-6', provider: 'google_places', query: 'b' }); // 2 (== cap, allowed)
    expect((await readPlacesUsage(placesUsageBucket())).calls).toBe(2);
  });

  it('rejects over-cap BEFORE any google call; idempotent replay still works', async () => {
    process.env.GOOGLE_PLACES_DAILY_LIMIT = '1';
    await runDiscovery({ idempotencyKey: 'q-7', provider: 'google_places', query: 'a' });
    fetchSpy.mockClear();
    await expect(runDiscovery({ idempotencyKey: 'q-8', provider: 'google_places', query: 'b' }))
      .rejects.toThrow(/quota|limit|exceed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Same-key replay of the FIRST (completed) run remains free and correct.
    const replay = await runDiscovery({ idempotencyKey: 'q-7', provider: 'google_places', query: 'a' });
    expect(replay.status).toBe('COMPLETED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a bounded retry that would exceed the cap stops honestly (no overage, honest failure)', async () => {
    process.env.GOOGLE_PLACES_DAILY_LIMIT = '1';
    fetchSpy.mockResolvedValue(new Response('rate limited', { status: 429 }));
    // First attempt consumes the unit and is REAL (charged); the retry hits
    // the cap → the run honestly records FAILED with usage committed.
    const run = await runDiscovery({ idempotencyKey: 'q-9', provider: 'google_places', query: 'x' });
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/usage limit/i);
    const usage = await readPlacesUsage(placesUsageBucket());
    expect(usage.calls).toBe(1); // exactly one attempt charged; no overage
    expect(await findRunByKey('q-9')).toBeTruthy();
  });

  it('invalid/missing limit config = safe documented behavior (no limit enforced, never disables counting)', async () => {
    process.env.GOOGLE_PLACES_DAILY_LIMIT = 'banana';
    await runDiscovery({ idempotencyKey: 'q-10', provider: 'google_places', query: 'a' });
    expect((await readPlacesUsage(placesUsageBucket())).calls).toBe(1);
    process.env.GOOGLE_PLACES_DAILY_LIMIT = '0';
    await runDiscovery({ idempotencyKey: 'q-11', provider: 'google_places', query: 'b' });
    expect((await readPlacesUsage(placesUsageBucket())).calls).toBe(2); // 0/negative = no limit
  });
});

describe('concurrency (final slot)', () => {
  it('two concurrent runs racing for the last unit: exactly one wins, no overage', async () => {
    process.env.GOOGLE_PLACES_DAILY_LIMIT = '1';
    const [a, b] = await Promise.allSettled([
      runDiscovery({ idempotencyKey: 'q-c1', provider: 'google_places', query: 'a' }),
      runDiscovery({ idempotencyKey: 'q-c2', provider: 'google_places', query: 'b' })
    ]);
    const fulfilled = [a, b].filter(r => r.status === 'fulfilled').length;
    const rejected = [a, b].filter(r => r.status === 'rejected').length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    expect((await readPlacesUsage(placesUsageBucket())).calls).toBe(1);
    expect(fetchSpy.mock.calls.length).toBe(1);
  });
});

describe('security', () => {
  it('usage rows and telemetry never contain the api key', async () => {
    await runDiscovery({ idempotencyKey: 'q-12', provider: 'google_places', query: 'x' });
    const usage = await db.placesUsage.toJSON();
    expect(JSON.stringify(usage)).not.toContain(KEY);
    const run = await db.discoveryRuns.find(r => r.idempotencyKey === 'q-12');
    const results = await listResultsForRun(run!.id);
    expect(JSON.stringify({ run, results })).not.toContain(KEY);
  });

  it('manual + google flows stay intact after quota (no cross-contamination)', async () => {
    process.env.GOOGLE_PLACES_DAILY_LIMIT = '1';
    await runDiscovery({ idempotencyKey: 'q-13', provider: 'google_places', query: 'x' });
    const manual = await runDiscovery({ idempotencyKey: 'q-14', candidates: [{ businessName: 'Still Works', instagramHandle: 'sw1' }] });
    expect(manual.status).toBe('COMPLETED');
    expect((await listResultsForRun(manual.id)).length).toBe(1);
  });
});
