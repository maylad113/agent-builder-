import { SalesWorker, SalesTask, ChannelResult, SalesChannelType } from '../../types';
import { SalesProviderAdapter, checkProspectEligibilityHelper } from './providerContract';

/**
 * No-op / test execution channel (Phase A / Task 34, hardened in Task 38).
 * Implements the structured envelope contract: it RECEIVES the attempt-scoped
 * idempotency key (attemptKey) and echoes it back, exactly as a future real
 * provider must use it as its external request-id. Deterministic and never
 * customer-facing.
 */

/** Outbound dispatch context. attemptKey is the deterministic server-side key
 *  ({taskId}:{attemptNumber}) — a future provider must use it as its external
 *  idempotency/request ID so ambiguous accept/timeout/retry never double-fires. */
export interface ChannelDispatch {
  attemptKey: string;
  payload?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Channel gate (Task 48) — the single authoritative dispatch boundary.
// ---------------------------------------------------------------------------

/** Channels with a REAL, implemented executor. Everything else is a known
 *  channel label without an adapter (phone, instagram_dm) — dispatching to it
 *  would fabricate outreach, so it is refused at the boundary. */
const IMPLEMENTED_CHANNELS: ReadonlySet<SalesChannelType> = new Set(['noop']);

/** Bounded, safe refusal reason. Never includes prospect/provider/payload. */
export const CHANNEL_NOT_IMPLEMENTED = 'Channel not implemented.';

/** True when the channel has a real implemented executor (today: only noop). */
export function isChannelImplemented(channel: unknown): channel is SalesChannelType {
  return typeof channel === 'string' && IMPLEMENTED_CHANNELS.has(channel as SalesChannelType);
}

/**
 * Authoritative channel-gated dispatch. `noop` (and only `noop`) executes the
 * existing test channel — unchanged. Any other channel label is a real channel
 * without a provider adapter: this returns a structured PERMANENT refusal
 * (REJECTED, retryable=false) and NEVER invokes the noop executor, NEVER
 * fabricates a providerId/conversationId, and NEVER reports success. The
 * dispatcher feeds this into the existing permanent failTask path
 * (DEAD_LETTERED; contact stays ACTIVE). An unknown/unsupported label fails
 * the same way — it never falls through to noop.
 */
export async function executeChannelDispatch(worker: SalesWorker, task: SalesTask, dispatch: ChannelDispatch): Promise<ChannelResult> {
  if (!isChannelImplemented(worker?.channel)) {
    return { outcome: 'REJECTED', success: false, retryable: false, error: CHANNEL_NOT_IMPLEMENTED };
  }
  return executeChannelTask(worker, task, dispatch);
}

export type TestChannelMode = 'success' | 'retryable' | 'permanent' | 'timeout' | 'slow' | 'success-conv';

let mode: TestChannelMode = 'success';
let calls = 0;

export function registerTestChannel(m: TestChannelMode): void {
  mode = m;
}

export function resetTestChannel(m: TestChannelMode = 'success'): void {
  mode = m;
  calls = 0;
}

export function testChannelCalls(): number {
  return calls;
}

export async function executeChannelTask(_worker: SalesWorker, _task: SalesTask, dispatch?: ChannelDispatch): Promise<ChannelResult> {
  calls++;
  const attemptKey = dispatch?.attemptKey ?? 'unknown';
  const payload = dispatch?.payload ?? _task.payload ?? {};
  switch (mode) {
    case 'success':
      return { outcome: 'CONNECTED', success: true, retryable: false, attemptKey, providerId: `noop-provider-${attemptKey}`, conversationId: payload.conversationId as string | undefined };
    case 'success-conv': // test support: simulates a provider returning its own conversation/thread id
      return { outcome: 'CONNECTED', success: true, retryable: false, attemptKey, providerId: `noop-provider-${attemptKey}`, conversationId: `noop-conv-${attemptKey}` };
    case 'retryable':
      return { outcome: 'ERROR', success: false, retryable: true, attemptKey, error: 'simulated retryable failure' };
    case 'permanent':
      return { outcome: 'REJECTED', success: false, retryable: false, attemptKey, error: 'simulated permanent failure' };
    case 'timeout':
      return { outcome: 'TIMEOUT', success: false, retryable: true, attemptKey, error: 'simulated ambiguous timeout', providerId: `noop-provider-${attemptKey}` };
    case 'slow':
      await new Promise(r => setTimeout(r, 50));
      return { outcome: 'CONNECTED', success: true, retryable: false, attemptKey };
    default:
      return { outcome: 'CONNECTED', success: true, retryable: false, attemptKey };
  }
}

// ---------------------------------------------------------------------------
// Task 54: Provider Eligibility Contract (Noop Adapter Implementation)
// ---------------------------------------------------------------------------

/**
 * The noop channel satisfies the SalesProviderAdapter contract.
 * It uses the same underlying executor, echoing the stable attemptKey, and
 * implements a best-effort pre-send eligibility check.
 */
export class NoopProviderAdapter implements SalesProviderAdapter {
  readonly channel = 'noop';

  async checkEligibilityBeforeSend(prospectId: string): Promise<boolean> {
    return checkProspectEligibilityHelper(prospectId);
  }

  async execute(worker: SalesWorker, task: SalesTask, dispatch: ChannelDispatch): Promise<ChannelResult> {
    return executeChannelTask(worker, task, dispatch);
  }
}

export const noopAdapter = new NoopProviderAdapter();
