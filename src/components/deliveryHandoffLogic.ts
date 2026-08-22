import { Delivery, OnboardingArtifact, PublicUser } from '../types';

/**
 * Delivery handoff display logic (Task 26) — PURE helpers for the
 * OrchestrationView Deliveries panel. They decide NOTHING about
 * authorization or eligibility: the server routes
 * (provision-owner-account, onboarding) remain the sole authority. These
 * helpers only shape what the UI displays and carry the provision API
 * contract in one place so the fetch call has a single tested source.
 */

export const PROVISION_ENDPOINT = (deliveryId: string) => `/api/orchestration/deliveries/${deliveryId}/provision-owner-account`;
export const ONBOARDING_ENDPOINT = (deliveryId: string) => `/api/orchestration/deliveries/${deliveryId}/onboarding`;

/** The backend accepts DELIVERED and ACCEPTED deliveries for provisioning
 *  (PENDING is rejected server-side). Display hint only — the server decides. */
export function canProvisionDelivery(delivery: Delivery): boolean {
  return delivery.status === 'DELIVERED' || delivery.status === 'ACCEPTED';
}

/** A delivery whose payload already records a provisioned owner account.
 *  Display hint only — the server decides what a replay returns. */
export function isAlreadyProvisioned(delivery: Delivery): boolean {
  return !!delivery.deliveryPayload?.ownerAccountUserId;
}

export interface ProvisionUiResult {
  /** The one-time password to display — present ONLY on the initial 201.
   *  NEVER persisted: component state only, cleared when the panel closes. */
  temporaryPassword?: string;
  user?: PublicUser;
  alreadyProvisioned: boolean;
}

/** Map the server response to display state. A replay (200) or any response
 *  without a password field must NEVER surface a password. */
export function provisionResultFromResponse(status: number, body: any): ProvisionUiResult {
  if (status === 201 && body && typeof body.temporaryPassword === 'string') {
    return { temporaryPassword: body.temporaryPassword, user: body.user, alreadyProvisioned: false };
  }
  return { user: body?.user, alreadyProvisioned: true };
}

/** The prominent one-time warning shown next to the temporary password. */
export const ONE_TIME_PASSWORD_NOTICE =
  'This temporary password is shown ONCE. Copy it now and share it with the business owner — it will not be displayed again.';

/** Extract the web_chat embed snippet from the artifact (absent for
 *  not-configured channels). */
export function embedSnippetOf(artifact: OnboardingArtifact): string | undefined {
  return artifact.channels.find(c => c.type === 'web_chat')?.embedSnippet;
}

/** The normalized widget origin allow-list exposed by the artifact (may be empty). */
export function allowedOriginsOf(artifact: OnboardingArtifact): string[] {
  return artifact.channels.find(c => c.type === 'web_chat')?.allowedOrigins ?? [];
}
