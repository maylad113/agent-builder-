import React, { useEffect, useState } from 'react';
import { Prospect, DesignProposal, FactoryJob, Delivery, OnboardingArtifact } from '../types';
import { DeliveryHandoffPanel, ProvisionState } from './DeliveryHandoffPanel';
import {
  PROVISION_ENDPOINT,
  ONBOARDING_ENDPOINT,
  provisionResultFromResponse
} from './deliveryHandoffLogic';

/** Minimal owner UI for the orchestration MVP: prospects, designs, factory
 *  jobs, deliveries, acceptance. Self-fetching (platform-owner session). */

type AsyncError = string | null;

function badgeClass(status: string): string {
  if (['CONVERTED', 'APPROVED', 'COMPLETED', 'DELIVERED', 'ACCEPTED'].includes(status)) return 'bg-emerald-100 text-emerald-700';
  if (['REJECTED', 'FAILED', 'DEAD_LETTERED'].includes(status)) return 'bg-red-100 text-red-700';
  if (['IN_FACTORY', 'SUBMITTING', 'EVALUATING', 'CORRECTING', 'PUBLISHING', 'ACTIVATING', 'PENDING'].includes(status)) return 'bg-blue-100 text-blue-700';
  return 'bg-slate-100 text-slate-600';
}

export const OrchestrationView: React.FC = () => {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [designs, setDesigns] = useState<DesignProposal[]>([]);
  const [jobs, setJobs] = useState<FactoryJob[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState<AsyncError>(null);
  const [busy, setBusy] = useState(false);

  const [prospectForm, setProspectForm] = useState({ businessName: '', contactName: '', contactPhone: '' });
  const [designForm, setDesignForm] = useState({
    title: '',
    problemStatement: '',
    proposedSolution: '',
    capabilities: '',
    configuration: ''
  });

  // Task 26 — delivery handoff. Per-delivery UI state for provisioning and
  // the read-only onboarding artifact. The one-time password lives ONLY in
  // this React state for the currently displayed result — never in storage,
  // never in a URL, and cleared when the operator closes the display.
  const [provisionStates, setProvisionStates] = useState<Record<string, ProvisionState>>({});
  const [onboardingByDelivery, setOnboardingByDelivery] = useState<Record<string, OnboardingArtifact | null>>({});

  const load = async () => {
    const [pRes, jRes, dRes] = await Promise.all([
      fetch('/api/orchestration/prospects'),
      fetch('/api/orchestration/factory-jobs'),
      fetch('/api/orchestration/deliveries')
    ]);
    if (pRes.ok) setProspects(await pRes.json());
    if (jRes.ok) setJobs(await jRes.json());
    if (dRes.ok) setDeliveries(await dRes.json());
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDesigns([]);
      return;
    }
    fetch(`/api/orchestration/prospects/${selectedId}/designs`)
      .then(r => (r.ok ? r.json() : []))
      .then(setDesigns)
      .catch(() => setDesigns([]));
  }, [selectedId]);

  const apiCall = async (url: string, method: string, body?: any): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Request failed (${res.status})`);
        return false;
      }
      return true;
    } catch (e: any) {
      setError('Network error.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createProspect = async () => {
    if (!prospectForm.businessName.trim()) {
      setError('Business name is required.');
      return;
    }
    const ok = await apiCall('/api/orchestration/prospects', 'POST', {
      businessName: prospectForm.businessName.trim(),
      contactName: prospectForm.contactName.trim() || undefined,
      contactPhone: prospectForm.contactPhone.trim() || undefined
    });
    if (ok) {
      setProspectForm({ businessName: '', contactName: '', contactPhone: '' });
      await load();
    }
  };

  const createDesign = async () => {
    if (!selectedId) return;
    let configuration: any = undefined;
    if (designForm.configuration.trim()) {
      try {
        configuration = JSON.parse(designForm.configuration);
      } catch {
        setError('Configuration must be valid JSON.');
        return;
      }
    }
    const ok = await apiCall(`/api/orchestration/prospects/${selectedId}/designs`, 'POST', {
      title: designForm.title.trim(),
      problemStatement: designForm.problemStatement.trim(),
      proposedSolution: designForm.proposedSolution.trim(),
      capabilities: designForm.capabilities.split(',').map(s => s.trim()).filter(Boolean),
      configuration
    });
    if (ok) {
      setDesignForm({ title: '', problemStatement: '', proposedSolution: '', capabilities: '', configuration: '' });
      const r = await fetch(`/api/orchestration/prospects/${selectedId}/designs`);
      if (r.ok) setDesigns(await r.json());
      await load();
    }
  };

  const approveDesign = async (designId: string) => {
    await apiCall(`/api/orchestration/designs/${designId}/approve`, 'POST');
    if (selectedId) {
      const r = await fetch(`/api/orchestration/prospects/${selectedId}/designs`);
      if (r.ok) setDesigns(await r.json());
      await load();
    }
  };

  const submitDesign = async (designId: string) => {
    await apiCall(`/api/orchestration/designs/${designId}/submit`, 'POST', {
      idempotencyKey: `design-${designId}`
    });
    await load();
  };

  const acceptDelivery = async (deliveryId: string) => {
    await apiCall(`/api/orchestration/deliveries/${deliveryId}/accept`, 'POST', {
      acceptedBy: 'platform-owner',
      acceptanceMethod: 'manual'
    });
    await load();
  };

  // Provision the delivered customer's BUSINESS_OWNER account via the
  // EXISTING Task 23 route. The server's one-time password (201 only) is held
  // in state until the operator closes the display; a replay (200) carries
  // none and is rendered as "already provisioned".
  const provisionOwner = async (deliveryId: string, input: { email: string; name: string }) => {
    setProvisionStates(s => ({ ...s, [deliveryId]: { status: 'busy' } }));
    try {
      const res = await fetch(PROVISION_ENDPOINT(deliveryId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: input.email, name: input.name })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProvisionStates(s => ({ ...s, [deliveryId]: { status: 'error', error: body.error || `Request failed (${res.status})` } }));
        return;
      }
      setProvisionStates(s => ({ ...s, [deliveryId]: { status: 'provisioned', result: provisionResultFromResponse(res.status, body) } }));
      await load(); // refresh so deliveryPayload.ownerAccountUserId is reflected
    } catch {
      setProvisionStates(s => ({ ...s, [deliveryId]: { status: 'error', error: 'Network error.' } }));
    }
  };

  // Closing the display clears the one-time password from state entirely.
  const closeProvisionResult = (deliveryId: string) => {
    setProvisionStates(s => ({ ...s, [deliveryId]: { status: 'idle' } }));
  };

  // Lazy-load the read-only onboarding artifact (existing Task 19/24 route).
  const toggleOnboarding = async (deliveryId: string) => {
    if (deliveryId in onboardingByDelivery) {
      setOnboardingByDelivery(s => ({ ...s, [deliveryId]: null }));
      return;
    }
    try {
      const res = await fetch(ONBOARDING_ENDPOINT(deliveryId));
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Request failed (${res.status})`);
        return;
      }
      setOnboardingByDelivery(s => ({ ...s, [deliveryId]: body }));
    } catch {
      setError('Network error.');
    }
  };

  const closeOnboarding = (deliveryId: string) => {
    setOnboardingByDelivery(s => ({ ...s, [deliveryId]: null }));
  };

  const selected = prospects.find(p => p.id === selectedId) || null;

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Prospects */}
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          <h3 className="font-semibold text-slate-800 mb-3">Prospects ({prospects.length})</h3>
          <div className="space-y-2 mb-4">
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              placeholder="Business name *"
              value={prospectForm.businessName}
              onChange={e => setProspectForm({ ...prospectForm, businessName: e.target.value })}
            />
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              placeholder="Contact name"
              value={prospectForm.contactName}
              onChange={e => setProspectForm({ ...prospectForm, contactName: e.target.value })}
            />
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              placeholder="Contact phone"
              value={prospectForm.contactPhone}
              onChange={e => setProspectForm({ ...prospectForm, contactPhone: e.target.value })}
            />
            <button
              onClick={createProspect}
              disabled={busy}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg py-2 disabled:opacity-50"
            >
              Create Prospect
            </button>
          </div>
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {prospects.map(p => (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-slate-50 ${selectedId === p.id ? 'bg-blue-50 border border-blue-200' : ''}`}
              >
                <div className="font-medium text-slate-800">{p.businessName}</div>
                <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full ${badgeClass(p.status)}`}>{p.status}</span>
              </button>
            ))}
            {prospects.length === 0 && <div className="text-sm text-slate-400">No prospects yet.</div>}
          </div>
        </div>

        {/* Designs */}
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          <h3 className="font-semibold text-slate-800 mb-3">
            {selected ? `Designs — ${selected.businessName}` : 'Designs'}
          </h3>
          {!selected && <div className="text-sm text-slate-400">Select a prospect to manage designs.</div>}
          {selected && (
            <div className="space-y-3">
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Design title *"
                value={designForm.title}
                onChange={e => setDesignForm({ ...designForm, title: e.target.value })}
              />
              <textarea
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Problem statement *"
                value={designForm.problemStatement}
                onChange={e => setDesignForm({ ...designForm, problemStatement: e.target.value })}
              />
              <textarea
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Proposed solution *"
                value={designForm.proposedSolution}
                onChange={e => setDesignForm({ ...designForm, proposedSolution: e.target.value })}
              />
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Capabilities (comma separated)"
                value={designForm.capabilities}
                onChange={e => setDesignForm({ ...designForm, capabilities: e.target.value })}
              />
              <textarea
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
                placeholder='Factory configuration JSON (business/agent/scenarios) — required before approval'
                value={designForm.configuration}
                onChange={e => setDesignForm({ ...designForm, configuration: e.target.value })}
                rows={4}
              />
              <button
                onClick={createDesign}
                disabled={busy}
                className="w-full bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold rounded-lg py-2 disabled:opacity-50"
              >
                Create Design Proposal
              </button>

              <div className="space-y-2 max-h-64 overflow-y-auto">
                {designs.map(d => (
                  <div key={d.id} className="border border-slate-200 rounded-lg p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-slate-800">{d.title}</div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${badgeClass(d.status)}`}>{d.status}</span>
                    </div>
                    <div className="text-slate-500 mt-1 line-clamp-2">{d.problemStatement}</div>
                    <div className="flex space-x-2 mt-2">
                      {d.status === 'DRAFT' && (
                        <button
                          onClick={() => approveDesign(d.id)}
                          disabled={busy}
                          className="px-3 py-1 text-xs font-semibold bg-emerald-600 text-white rounded-lg disabled:opacity-50"
                        >
                          Approve
                        </button>
                      )}
                      {d.status === 'APPROVED' && (
                        <button
                          onClick={() => submitDesign(d.id)}
                          disabled={busy}
                          className="px-3 py-1 text-xs font-semibold bg-blue-600 text-white rounded-lg disabled:opacity-50"
                        >
                          Submit to Factory
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {designs.length === 0 && <div className="text-sm text-slate-400">No designs yet.</div>}
              </div>
            </div>
          )}
        </div>

        {/* Jobs & deliveries */}
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
            <h3 className="font-semibold text-slate-800 mb-3">Factory Jobs ({jobs.length})</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {jobs.map(j => (
                <div key={j.id} className="border border-slate-200 rounded-lg p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-slate-500">{j.id.slice(0, 18)}…</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${badgeClass(j.status)}`}>{j.status}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">step: {j.currentStep}</div>
                  {j.lastError && <div className="text-xs text-red-600 mt-1">{j.lastError}</div>}
                </div>
              ))}
              {jobs.length === 0 && <div className="text-sm text-slate-400">No factory jobs yet.</div>}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
            <h3 className="font-semibold text-slate-800 mb-3">Deliveries ({deliveries.length})</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {deliveries.map(d => (
                <div key={d.id} className="border border-slate-200 rounded-lg p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-slate-500">{d.agentId.slice(0, 18)}…</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${badgeClass(d.status)}`}>{d.status}</span>
                  </div>
                  {d.status !== 'ACCEPTED' && (
                    <button
                      onClick={() => acceptDelivery(d.id)}
                      disabled={busy}
                      className="mt-2 px-3 py-1 text-xs font-semibold bg-emerald-600 text-white rounded-lg disabled:opacity-50"
                    >
                      Mark Accepted
                    </button>
                  )}
                  <DeliveryHandoffPanel
                    delivery={d}
                    provisionState={provisionStates[d.id] || { status: 'idle' }}
                    onProvision={input => provisionOwner(d.id, input)}
                    onProvisionClose={() => closeProvisionResult(d.id)}
                    onboarding={onboardingByDelivery[d.id] ?? null}
                    onboardingOpen={!!onboardingByDelivery[d.id]}
                    onOnboardingToggle={() => toggleOnboarding(d.id)}
                    onOnboardingClose={() => closeOnboarding(d.id)}
                  />
                </div>
              ))}
              {deliveries.length === 0 && <div className="text-sm text-slate-400">No deliveries yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
