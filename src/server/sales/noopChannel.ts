import { SalesWorker, SalesTask } from '../../types';

/**
 * No-op / test execution channel (Phase A / Task 34).
 *
 * Proves the execution substrate WITHOUT any external integration. Configurable
 * in tests to simulate success, retryable failure, permanent failure, slow
 * execution, and duplicate invocation. NOT a production sales channel and never
 * customer-facing. Counts invocations so tests can assert exactly-once-per-claim
 * execution (at-least-once task execution with idempotent enqueue).
 */

export interface ChannelResult {
  ok: boolean;
  error?: string;
  /** true = non-retryable (dead-letter immediately); false/undefined = retryable. */
  permanent?: boolean;
}

export type TestChannelMode = 'success' | 'retryable' | 'permanent' | 'slow';

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

export async function executeChannelTask(_worker: SalesWorker, _task: SalesTask): Promise<ChannelResult> {
  calls++;
  switch (mode) {
    case 'success':
      return { ok: true };
    case 'retryable':
      return { ok: false, error: 'simulated retryable failure', permanent: false };
    case 'permanent':
      return { ok: false, error: 'simulated permanent failure', permanent: true };
    case 'slow':
      await new Promise(r => setTimeout(r, 50));
      return { ok: true };
    default:
      return { ok: true };
  }
}
