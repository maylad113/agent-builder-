import React, { useState } from 'react';
import { DiscoveryRun, DiscoveryResult, LeadResearchReport, DesignProposal, Prospect } from '../types';
import {
  DISCOVERY_PROVIDERS,
  canTriageResult,
  triageStateLabel,
  hasCompletedResearch,
  latestReport,
  scoreSummary,
  designSummary,
  parseManualCandidates,
  runSummary
} from './orchestrationPipelineLogic';

/**
 * Pipeline front-half panel (Task 27) — presentational. Renders the EXISTING
 * discovery/research/analysis/design-generation state and invokes the
 * parent's handlers (which call the existing server routes). Quotas, dedupe,
 * acceptance, idempotency, and generation rules stay 100% server-side; this
 * component never fabricates tenant ids, never auto-approves a design, and
 * never injects candidate/design content as HTML.
 */

export interface PlacesUsageView {
  date: string;
  used: number;
  limit: number | null;
  remaining: number | null;
}

export interface PipelineFrontPanelProps {
  runs: DiscoveryRun[];
  resultsByRun: Record<string, DiscoveryResult[]>;
  usage: PlacesUsageView | null;
  busy: boolean;
  onRunDiscovery: (input: { provider: string; query?: string; location?: string; candidatesText?: string }) => void;
  onAccept: (resultId: string) => void;
  onDismiss: (resultId: string) => void;
  prospect: Prospect | null;
  researchReports: LeadResearchReport[];
  designs: DesignProposal[];
  onResearch: (input: { inputText: string }) => void;
  onAnalyze: () => void;
  onGenerateDesign: () => void;
  onApproveDesign: (designId: string) => void;
}

export const PipelineFrontPanel: React.FC<PipelineFrontPanelProps> = ({
  runs,
  resultsByRun,
  usage,
  busy,
  onRunDiscovery,
  onAccept,
  onDismiss,
  prospect,
  researchReports,
  designs,
  onResearch,
  onAnalyze,
  onGenerateDesign,
  onApproveDesign
}) => {
  const [provider, setProvider] = useState<string>('manual_list');
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('');
  const [candidatesText, setCandidatesText] = useState('');
  const [researchText, setResearchText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const report = latestReport(researchReports);
  const researched = hasCompletedResearch(researchReports);

  const runDiscovery = () => {
    setFormError(null);
    if (provider === 'manual_list') {
      const candidates = parseManualCandidates(candidatesText);
      if (!candidates) {
        setFormError('Enter at least one candidate: "Name | website | location | phone" (one per line).');
        return;
      }
      onRunDiscovery({ provider, candidatesText });
      return;
    }
    onRunDiscovery({ provider, query: query.trim() || undefined, location: location.trim() || undefined });
  };

  return (
    <div className="space-y-6">
      {/* ---- Discovery ---- */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
        <h3 className="font-semibold text-slate-800 mb-3">Discovery</h3>

        {usage && (
          <div className="mb-3 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
            Places usage ({usage.date}): {usage.used} used{usage.limit === null ? ' · no daily cap' : ` · limit ${usage.limit} · ${usage.remaining} remaining`}
          </div>
        )}

        <div className="space-y-2 mb-4">
          <select
            aria-label="Discovery provider"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={provider}
            onChange={e => setProvider(e.target.value)}
          >
            {DISCOVERY_PROVIDERS.map(p => (
              <option key={p.id} value={p.id}>{p.label} ({p.id})</option>
            ))}
          </select>
          {provider === 'manual_list' ? (
            <textarea
              aria-label="Manual candidates"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              rows={3}
              placeholder={'One per line: Name | website | location | phone\nTony\'s Barber | https://tonys.example | Springfield | +1555…'}
              value={candidatesText}
              onChange={e => setCandidatesText(e.target.value)}
            />
          ) : (
            <>
              <input
                aria-label="Discovery query"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Query (e.g. barbershop)"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <input
                aria-label="Discovery location"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Location (e.g. Springfield)"
                value={location}
                onChange={e => setLocation(e.target.value)}
              />
            </>
          )}
          {formError && <div className="text-xs text-red-600">{formError}</div>}
          <button
            onClick={runDiscovery}
            disabled={busy}
            data-endpoint="/api/orchestration/discovery-runs"
            className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg py-2 disabled:opacity-50"
          >
            Run discovery
          </button>
        </div>

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {runs.map(run => (
            <div key={run.id} className="border border-slate-200 rounded-lg p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">{runSummary(run)}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${run.status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-700' : run.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>{run.status}</span>
              </div>
              <div className="mt-2 space-y-1">
                {(resultsByRun[run.id] || []).map(result => (
                  <div key={result.id} className="border border-slate-100 rounded-lg p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-800 truncate">{result.normalized.businessName}</div>
                        <div className="text-xs text-slate-500 truncate">
                          {[result.normalized.website, result.normalized.location, result.normalized.phone].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                        triageStateLabel(result) === 'Accepted' ? 'bg-emerald-100 text-emerald-700'
                        : triageStateLabel(result) === 'Dismissed' ? 'bg-red-100 text-red-700'
                        : 'bg-slate-100 text-slate-600'
                      }`}>{triageStateLabel(result)}</span>
                    </div>
                    {canTriageResult(result) && (
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => onAccept(result.id)}
                          disabled={busy}
                          data-endpoint={`/api/orchestration/discovery-results/${result.id}/accept`}
                          className="px-3 py-1 text-xs font-semibold bg-emerald-600 text-white rounded-lg disabled:opacity-50"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => onDismiss(result.id)}
                          disabled={busy}
                          data-endpoint={`/api/orchestration/discovery-results/${result.id}/dismiss`}
                          className="px-3 py-1 text-xs font-semibold bg-slate-200 text-slate-700 rounded-lg disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {(resultsByRun[run.id] || []).length === 0 && run.status === 'COMPLETED' && (
                  <div className="text-xs text-slate-400">No candidates.</div>
                )}
              </div>
            </div>
          ))}
          {runs.length === 0 && <div className="text-sm text-slate-400">No discovery runs yet.</div>}
        </div>
      </div>

      {/* ---- Research / Analysis / Design for the selected prospect ---- */}
      {prospect && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          <h3 className="font-semibold text-slate-800 mb-1">Pipeline — {prospect.businessName}</h3>
          <div className="text-xs text-slate-400 mb-3 truncate">
            {[prospect.website, prospect.location, prospect.contactPhone].filter(Boolean).join(' · ') || 'No contact details'}
          </div>

          {/* Research requires the operator to supply the source text — the
              existing route does NOT fetch the web (no fabricated research). */}
          <textarea
            aria-label="Research input text"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-2"
            rows={2}
            placeholder="Paste the business's public info (website text, reviews, posts…) — research extracts from this text; it never invents facts."
            value={researchText}
            onChange={e => setResearchText(e.target.value)}
          />
          <div className="flex flex-wrap gap-2 mb-3">
            <button
              onClick={() => onResearch({ inputText: researchText })}
              disabled={busy || !researchText.trim()}
              data-endpoint={`/api/orchestration/prospects/${prospect.id}/research`}
              className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg disabled:opacity-50"
            >
              Research
            </button>
            <button
              onClick={onAnalyze}
              disabled={busy}
              data-endpoint={`/api/orchestration/prospects/${prospect.id}/analyze`}
              className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg disabled:opacity-50"
            >
              Analyze
            </button>
            <button
              onClick={onGenerateDesign}
              disabled={busy || !researched}
              data-endpoint={`/api/orchestration/prospects/${prospect.id}/design`}
              className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg disabled:opacity-50"
              title={researched ? 'Generate a design proposal from the latest analysis' : 'Run research/analysis first'}
            >
              Generate design
            </button>
          </div>

          {report && (
            <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3">
              Latest report: <span className="font-semibold">{report.status}</span> · score {scoreSummary(report)} · {report.llmModel}
              {report.error && <div className="text-red-600 mt-1">{report.error}</div>}
            </div>
          )}

          {designs.length > 0 && (
            <div className="space-y-1">
              {designs.map(design => (
                <div key={design.id} className="border border-slate-100 rounded-lg p-2 text-sm flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-800 truncate">{design.title}</div>
                    <div className="text-xs text-slate-500">{designSummary(design)}</div>
                  </div>
                  {design.status === 'DRAFT' && (
                    <button
                      onClick={() => onApproveDesign(design.id)}
                      disabled={busy}
                      className="px-3 py-1 text-xs font-semibold bg-emerald-600 text-white rounded-lg disabled:opacity-50 shrink-0"
                    >
                      Approve
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
