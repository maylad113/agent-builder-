import { db } from '../db';
import { SalesWorkerScheduleWindow } from '../../types';

/**
 * Scheduler + execution limits for the sales workforce (Phase B / Task 35).
 *
 * Timezone-aware schedule windows (evaluated via the host's Intl engine —
 * DST-safe, never server-local time), one authoritative global concurrency
 * cap, and a controlled single-process tick loop (configurable interval, no
 * overlapping ticks, graceful start/stop, resilient to a failing tick).
 * The no-op channel remains the only execution channel.
 */

export const GLOBAL_CONCURRENCY_LIMIT = 10;
let globalConcurrencyLimit = GLOBAL_CONCURRENCY_LIMIT;

export function getGlobalConcurrencyLimit(): number {
  return globalConcurrencyLimit;
}

export async function setGlobalConcurrencyLimit(n: number): Promise<void> {
  if (!Number.isFinite(n) || n < 1) throw new Error('Global concurrency limit must be a positive integer.');
  globalConcurrencyLimit = Math.floor(n);
}

/** Total in-flight (RUNNING) tasks across the whole workforce — the global
 *  safety ceiling so one scheduling bug can't execute unlimited work. */
export async function globalRunningTaskCount(): Promise<number> {
  const r = await db.client.query("SELECT COUNT(*) AS n FROM sales_tasks WHERE status = 'RUNNING'", []);
  return Number(r.rows[0]?.n ?? 0);
}

export function globalCapacityAvailable(running: number): boolean {
  return running < globalConcurrencyLimit;
}

// ---------------------------------------------------------------------------
// Timezone-aware schedule evaluation
// ---------------------------------------------------------------------------

/** Compute weekday + minute-from-midnight in an arbitrary IANA timezone
 *  using the host Intl engine (DST-safe; never server-local time). */
const DAY_FULL: Record<string, string> = {
  sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday'
};

export function zonedMinuteInDay(date: Date, timeZone: string): { day: string; minute: number } {
  let tz = 'UTC';
  try {
    // Validate the timezone; fall back to UTC for an unrecognised value.
    new Intl.DateTimeFormat('en-US', { timeZone });
    tz = timeZone;
  } catch {
    tz = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value;
  const day = DAY_FULL[(get('weekday') || '').toLowerCase()] || 'sunday';
  const hour = parseInt(get('hour') || '0', 10) % 24;
  const minute = hour * 60 + parseInt(get('minute') || '0', 10);
  return { day, minute };
}

/** A window includes [startMin, endMin) — start inclusive, end exclusive.
 *  Crossing-midnight windows (endMin <= startMin) are NOT supported; such a
 *  window never matches (explicit, documented semantics — split it into two). */
export function scheduleWindowIncludes(
  w: SalesWorkerScheduleWindow, day: string, minute: number
): boolean {
  if (w.day !== '*' && w.day !== day) return false;
  if (w.endMin <= w.startMin) return false; // no midnight-crossing support
  return minute >= w.startMin && minute < w.endMin;
}

// ---------------------------------------------------------------------------
// Controlled tick loop
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  intervalMs?: number;
  /** Test seam: the tick function (defaults to the real dispatcher). */
  tick?: () => Promise<unknown>;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let inFlight = false;

export function schedulerIsRunning(): boolean {
  return running;
}

/**
 * Start the periodic tick loop. Uses a recursive setTimeout (never overlapping
 * ticks, never a runaway timer). A failing tick is caught and logged so the
 * loop survives transient errors. A duplicate start is a no-op.
 */
export function startScheduler(opts: SchedulerOptions = {}): void {
  if (running) return; // no duplicate loops
  running = true;
  const intervalMs = Math.max(10, Number(opts.intervalMs) || 5000);
  const tick = opts.tick ?? (async () => {
    const { runDispatcherTick } = await import('./workforce');
    return runDispatcherTick();
  });
  const loop = async () => {
    if (!running) return;
    if (!inFlight) {
      inFlight = true;
      try {
        await tick();
      } catch (e: any) {
        // A failing tick must not kill the scheduler; next tick still runs.
        try { (await import('../logSanitizer')).safeError('[sales/scheduler] tick failed:', e?.message || e); } catch { /* ignore */ }
      } finally {
        inFlight = false;
      }
    }
    if (running) timer = setTimeout(loop, intervalMs);
  };
  timer = setTimeout(loop, intervalMs);
}

/** Stop the loop gracefully: no new ticks are scheduled; an in-flight tick is
 *  allowed to finish (its result is simply not followed by another tick). */
export function stopScheduler(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
