# Sales Outreach: TOCTOU & Provider Idempotency Architecture

This document describes the Time-of-Check to Time-of-Use (TOCTOU) lifecycle boundary in the sales outreach dispatcher and defines the provider-side contract required for future real channel adapters.

---

## 1. The TOCTOU Window

Outreach dispatch follows a deterministic preflight sequence:

```
T0: claimNextTask (FOR UPDATE SKIP LOCKED → RUNNING)
T1: assertProspectEligible / assertDiscoveryNotDismissed (preflight check)
T2: ensureConversation (idempotent conversation binding)
T3: executeChannelDispatch (channel gate — Task 48)
T4: External provider HTTP/network request (Twilio, Meta, etc.)
T5: Provider accepts/executes external side-effect (SMS sent, call initiated)
T6: Provider responds (or response is lost / timed out)
T7: completeTask / failTask + recordAttempt (ledger write)
```

The **TOCTOU window** exists between **T1** (when the database is read to verify prospect eligibility) and **T4** (when the external provider actually initiates the outreach).

A prospect could become ineligible (e.g., marked `REJECTED`, `CONVERTED`, linked to a tenant `businessId`, or having their discovery source dismissed) after T1 but before T4.

---

## 2. Why Database Transactions Cannot Close This Window

It is tempting to attempt wrapping the entire sequence (T1 through T7) in a single database transaction. **This is fundamentally unsafe and architecturally incorrect in a distributed system:**

1. **External Side Effects Cannot Be Rolled Back**: An HTTP call to an external provider (e.g., Twilio REST API) causes real-world external side-effects (a customer's phone rings or receives an SMS). If the database transaction later rolls back (due to a serialization failure, lock timeout, or application crash), the customer was still contacted, but the database has no record of it.
2. **Connection Pool Starvation**: External network calls have variable and potentially high latency (100ms to 10s+). Holding a PostgreSQL connection open across a network I/O call starves the connection pool (default pool size ~10), blocking all other application transactions.
3. **Lock Contention & Deadlocks**: Long-lived transactions holding row locks block concurrent workers, scheduler ticks, and user interactions.
4. **No Two-Phase Commit**: External third-party APIs (Meta, Twilio, Instagram) do not participate in XA / 2PC distributed transactions with our database.

**Conclusion**: The application-level preflight eligibility check (Task 46/52) is a **best-effort preflight gate**, not a distributed mutual exclusion guarantee.

---

## 3. Existing Mitigations

### A. Stable Server-Derived Idempotency Key (Task 50)
Every outreach task receives a deterministic, server-derived idempotency key:

$$\text{attemptKey} = \text{task.id}$$

- `task.id` is immutable for the task's lifetime.
- Retries (e.g., after `TIMEOUT`) and crash-recoveries (via the stale-task reaper) reuse the **exact same `attemptKey`** byte-for-byte.
- The client payload **never** controls or overrides this key.
- Future providers MUST pass this key as their external idempotency / request identifier (e.g., `Idempotency-Key` HTTP header or client request token).

### B. Typed Error Classification (Task 52)
Deterministic business ineligibility throws `ProspectIneligibleError` (permanent `DEAD_LETTERED`, no channel call). Transient infrastructure / DB errors are rethrown into the retryable path (`QUEUED`, `ERROR` ledger, backoff).

---

## 4. Provider Contract for Future Channel Adapters

Future real channel adapters (e.g., Twilio Phone, Instagram DM) must implement the `SalesProviderAdapter` contract (`src/server/sales/providerContract.ts`):

1. **Consume `dispatch.attemptKey`**: Use it as the external provider's idempotency key.
2. **Best-Effort Pre-Send Eligibility Check**: Where the provider architecture supports it, call `checkEligibilityBeforeSend(prospectId)` immediately prior to executing the outbound network request.
3. **Handle Ambiguous Responses**: If a network timeout or 5xx occurs, return `{ outcome: 'TIMEOUT', retryable: true, providerId }` so the dispatcher can safely retry with the **same** stable key.
4. **Never Claim Exact-Once Delivery**: Acknowledge that distributed network boundaries are inherently at-least-once with provider-side deduplication.

### Known Limitation
Even when a provider checks eligibility *immediately* before sending, there is a microscopic race between the check and the network request transmission. This is an unavoidable distributed-systems limitation; the provider contract is a best-effort safety net, not a mathematically perfect lock.

---

## 5. Reconciliation & Future Mitigations

For critical compliance (e.g., TCPA/Do-Not-Call registries), the platform can optionally support post-hoc reconciliation:
- A scheduled sweeper that checks the `deliveries` / `salesAttempts` ledger against the current prospect status.
- If a prospect became ineligible after dispatch, trigger a compensating action (e.g., an automated apology/cancellation, or alert an operator for manual intervention).
