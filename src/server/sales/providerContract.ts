import { SalesWorker, SalesTask, ChannelResult } from '../../types';
import type { ChannelDispatch } from './noopChannel';
import { assertProspectEligible, assertDiscoveryNotDismissed, isProspectIneligibleError } from './contacts';
import { db } from '../db';

/**
 * Provider-side eligibility & execution contract for sales outreach adapters.
 *
 * DISTRIBUTED-SYSTEMS NOTICE:
 * There is an inherent Time-of-Check to Time-of-Use (TOCTOU) boundary between
 * the dispatcher's preflight eligibility check and the actual external provider
 * transmission. Holding a database transaction across an external HTTP call is
 * dangerous and fundamentally incorrect.
 *
 * This contract defines the interface that future real provider adapters
 * (Twilio, Meta, etc.) must implement to perform best-effort pre-send
 * verification and consume stable idempotency keys.
 */

export interface ProviderEligibilityCheck {
  /**
   * Best-effort pre-send check immediately before executing the external network request.
   * Returns true if the prospect is still eligible, or false if they have become
   * REJECTED, CONVERTED, linked to a business tenant, or have a dismissed discovery source.
   *
   * NOTE: This is NOT an atomic lock. It narrows the race window, but cannot eliminate
   * a race where status changes while the HTTP packet is in flight.
   */
  checkEligibilityBeforeSend(prospectId: string): Promise<boolean>;
}

export interface SalesProviderAdapter extends ProviderEligibilityCheck {
  readonly channel: string;

  /**
   * Execute outreach through the external provider.
   * MUST use dispatch.attemptKey as the external idempotency/request key.
   */
  execute(worker: SalesWorker, task: SalesTask, dispatch: ChannelDispatch): Promise<ChannelResult>;
}

/**
 * Canonical helper for provider adapters to check prospect eligibility
 * against the authoritative sales/orchestration tables.
 */
export async function checkProspectEligibilityHelper(prospectId: string): Promise<boolean> {
  try {
    const prospect = await db.prospects.find(p => p.id === prospectId);
    assertProspectEligible(prospect);
    await assertDiscoveryNotDismissed(prospect!);
    return true;
  } catch (e: unknown) {
    if (isProspectIneligibleError(e)) {
      return false;
    }
    // Transient error: return false or rethrow depending on provider strategy.
    // For standard pre-send check, we rethrow so the dispatcher handles retry.
    throw e;
  }
}
