import React, { useState } from 'react';
import { Delivery, OnboardingArtifact } from '../types';
import {
  canProvisionDelivery,
  isAlreadyProvisioned,
  ProvisionUiResult,
  ONE_TIME_PASSWORD_NOTICE,
  embedSnippetOf,
  allowedOriginsOf
} from './deliveryHandoffLogic';

/**
 * Presentational delivery-handoff panel (Task 26). Renders the existing
 * backend state only — provisioning eligibility, idempotency, and the
 * one-time-password semantics are decided SERVER-side by the Task 23 route;
 * this component never generates, stores, or re-displays a password.
 *
 * SECURITY: the temporary password arrives via props for display ONLY. It is
 * never written to web storage, never put in a URL, never logged, and never
 * re-rendered after the parent clears it. The embed snippet is rendered as
 * escaped text inside a <code> block — never injected as HTML.
 */

export type ProvisionState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'provisioned'; result: ProvisionUiResult }
  | { status: 'error'; error: string };

export interface DeliveryHandoffPanelProps {
  delivery: Delivery;
  provisionState: ProvisionState;
  /** Called with { email, name } — the parent performs the actual POST. */
  onProvision: (input: { email: string; name: string }) => void;
  /** Closes the one-time password display (parent clears the password). */
  onProvisionClose: () => void;
  onboarding: OnboardingArtifact | null;
  onboardingOpen: boolean;
  onOnboardingToggle: () => void;
  onOnboardingClose: () => void;
}

export const DeliveryHandoffPanel: React.FC<DeliveryHandoffPanelProps> = ({
  delivery,
  provisionState,
  onProvision,
  onProvisionClose,
  onboarding,
  onboardingOpen,
  onOnboardingToggle,
  onOnboardingClose
}) => {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const provisioned = isAlreadyProvisioned(delivery);
  const eligible = canProvisionDelivery(delivery);
  const showProvisionForm = eligible && !provisioned && provisionState.status !== 'provisioned' && provisionState.status !== 'error';
  const snippet = onboarding ? embedSnippetOf(onboarding) : undefined;
  const origins = onboarding ? allowedOriginsOf(onboarding) : [];

  const copyText = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable — the text remains selectable for manual copy */
    }
  };

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 space-y-3" data-delivery-id={delivery.id}>
      <div className="flex items-center gap-2 text-xs text-slate-400 font-mono truncate" title={delivery.id}>
        <span>delivery {delivery.id} · business {delivery.businessId}</span>
        <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{delivery.status}</span>
      </div>

      {/* --- Owner account provisioning (existing Task 23 API) --- */}
      {provisioned && provisionState.status !== 'provisioned' && (
        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          ✓ An owner account has already been provisioned for this delivery.
        </div>
      )}

      {showProvisionForm && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-600">Customer owner account</div>
          <input
            aria-label="Owner email"
            className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
            placeholder="Owner email"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
          <input
            aria-label="Owner name"
            className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
            placeholder="Owner name"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <button
            onClick={() => onProvision({ email: email.trim(), name: name.trim() })}
            disabled={provisionState.status === 'busy' || !email.trim() || !name.trim()}
            className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg disabled:opacity-50"
            data-endpoint="provision-owner-account"
          >
            {provisionState.status === 'busy' ? 'Provisioning…' : 'Provision owner account'}
          </button>
        </div>
      )}

      {provisionState.status === 'error' && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {provisionState.error}
        </div>
      )}

      {provisionState.status === 'provisioned' && (
        <div className="text-xs border rounded-lg px-3 py-2 space-y-2 bg-emerald-50 border-emerald-200">
          {provisionState.result.temporaryPassword ? (
            <>
              <div className="font-semibold text-emerald-800">Owner account created: {provisionState.result.user?.email}</div>
              <div className="text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 font-medium">
                {ONE_TIME_PASSWORD_NOTICE}
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-white border border-slate-200 rounded px-2 py-1.5 font-mono text-slate-800 select-all break-all">
                  {provisionState.result.temporaryPassword}
                </code>
                <button
                  onClick={() => copyText(provisionState.result.temporaryPassword!)}
                  className="px-2 py-1.5 text-xs font-semibold bg-slate-700 text-white rounded-lg"
                >
                  Copy
                </button>
              </div>
              <button
                onClick={onProvisionClose}
                className="px-2 py-1 text-xs text-slate-500 underline"
              >
                I have saved the password — close
              </button>
            </>
          ) : (
            <div className="text-emerald-800">
              Owner account already provisioned{provisionState.result.user?.email ? ` for ${provisionState.result.user.email}` : ''}.
              The one-time password was shown only at initial provisioning and cannot be retrieved again.
            </div>
          )}
        </div>
      )}

      {/* --- Onboarding artifact (existing Task 19/24 read-only API) --- */}
      <div>
        <button
          onClick={onboardingOpen ? onOnboardingClose : onOnboardingToggle}
          className="px-3 py-1.5 text-xs font-semibold bg-slate-600 text-white rounded-lg"
        >
          {onboardingOpen ? 'Hide onboarding' : 'View onboarding'}
        </button>
      </div>

      {onboardingOpen && onboarding && (
        <div className="space-y-3 text-xs bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="font-semibold text-slate-700">
            Onboarding — {onboarding.business.name} · agent “{onboarding.agent.name}” ({onboarding.agent.status})
          </div>

          {snippet && (
            <div className="space-y-1">
              <div className="font-semibold text-slate-600">Website embed snippet</div>
              <div className="flex items-start gap-2">
                <code className="flex-1 bg-white border border-slate-200 rounded px-2 py-1.5 font-mono text-slate-800 select-all break-all whitespace-pre-wrap">
                  {snippet}
                </code>
                <button
                  onClick={() => copyText(snippet)}
                  className="px-2 py-1.5 text-xs font-semibold bg-slate-700 text-white rounded-lg shrink-0"
                >
                  Copy
                </button>
              </div>
              {origins.length > 0 && (
                <div className="text-slate-500">
                  Allow-listed origins: {origins.join(', ')}
                </div>
              )}
            </div>
          )}

          {onboarding.instructions.length > 0 && (
            <div className="space-y-1">
              <div className="font-semibold text-slate-600">Customer instructions</div>
              <ul className="list-disc list-inside space-y-0.5 text-slate-600">
                {onboarding.instructions.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-slate-400">
            Channels: {onboarding.channels.map(c => `${c.type} (${c.status})`).join(', ')}
          </div>
        </div>
      )}
    </div>
  );
};
