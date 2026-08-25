import { SalesWorker, SalesTask, ChannelResult } from '../../types';

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

export type TestChannelMode = 'success' | 'retryable' | 'permanent' | 'timeout' | 'slow';

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
