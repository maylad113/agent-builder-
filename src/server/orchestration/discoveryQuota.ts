import { db } from '../db';

/**
 * Google Places usage protection (Phase C / Task 20).
 *
 * A MINIMAL, deterministic operator safety guard counting REAL Google Places
 * attempts (not manual discovery, not validation failures that never reached
 * Google). Global project scope — the quota belongs to the single shared
 * Google API project, so the counter is one row per UTC day, never
 * tenant-attributed and never monetized (this is NOT billing).
 *
 * Atomicity: check-then-increment runs inside the discovery run's own
 * transaction (SQLite per-connection mutex serializes; PostgreSQL runs on
 * the tx-bound pool client), so two concurrent runs racing for the final
 * unit produce exactly one winner and zero overage. A configured cap FAILS
 * CLOSED before any uncontrolled Google call.
 *
 * Configuration: GOOGLE_PLACES_DAILY_LIMIT (integer > 0) — absent/invalid/
 * non-positive = NO application-side limit (counting still happens; current
 * behavior preserved). Never treat this as Google's commercial quota.
 */

export function placesUsageBucket(date = new Date()): string {
  return date.toISOString().slice(0, 10); // UTC day
}

/** Current attempt count for a bucket (0 when absent). */
export async function readPlacesUsage(bucket: string): Promise<{ bucket: string; calls: number }> {
  const row = await db.placesUsage.find(r => r.bucket === bucket);
  return { bucket, calls: row?.calls ?? 0 };
}

/** Resolve the operator-side daily cap; undefined = no limit. */
export function placesDailyLimit(): number | undefined {
  const raw = process.env.GOOGLE_PLACES_DAILY_LIMIT;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Reserve ONE Google attempt inside the CALLER'S ACTIVE TRANSACTION.
 * Throws (rolls back the whole run) when the cap is already reached.
 * Callers: the google_places adapter, once per real fetch attempt.
 */
export async function consumePlacesAttempt(): Promise<void> {
  const bucket = placesUsageBucket();
  const limit = placesDailyLimit();
  const now = new Date().toISOString();
  const existing = await db.placesUsage.find(r => r.bucket === bucket);
  const current = existing?.calls ?? 0;
  if (limit !== undefined && current >= limit) {
    throw new Error(`Google Places daily usage limit reached (${current}/${limit} attempts). Try again tomorrow or raise GOOGLE_PLACES_DAILY_LIMIT.`);
  }
  if (existing) {
    await db.placesUsage.update({ ...existing, calls: current + 1, updatedAt: now });
  } else {
    await db.placesUsage.push({ id: `pu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, bucket, calls: 1, updatedAt: now });
  }
}
