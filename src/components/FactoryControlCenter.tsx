import React, { useState, useEffect, useCallback } from 'react';
import {
  Agent,
  AgentVersion,
  EvalRunResult,
  CorrectionResult,
  EvalScenario,
  EvalScenarioResult,
  TrustedKnowledgeSource,
  FailureCategory
} from '../types';
import {
  summarizeEvaluation,
  publishGateHint,
  summarizeCorrection,
  requiresHumanReview,
  correctionActionLabel,
  isAutoSafeProposal,
  failureCategoryBadge
} from './controlCenterLogic';
import {
  FlaskConical,
  Wrench,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Send,
  UploadCloud,
  Loader2,
  GitBranch,
  Lock
} from 'lucide-react';

/**
 * Factory Control Center — UI for the agent lifecycle:
 * Select agent -> view version/status -> evaluate -> view results/failures ->
 * self-correct -> view proposals -> human-review banner -> re-evaluate ->
 * publish (server-gated) -> published status.
 *
 * The UI NEVER implements authorization or publish rules. Every state change is
 * a real API call; the server-side evaluation/publish gates are authoritative.
 * The display helpers (controlCenterLogic) only surface state for the owner.
 */
interface FactoryControlCenterProps {
  agent: Agent;
  onRefreshAgent?: () => void;
}

type BusyState = 'idle' | 'evaluating' | 'correcting' | 'publishing' | 'creatingDraft';

const DEFAULT_SCENARIOS: EvalScenario[] = [
  {
    id: 'handoff-unknown',
    name: 'Handles unknown requests',
    userMessage: 'Can you book me a flight to Paris?',
    dimension: 'unknown_handling',
    severity: 'critical',
    expectHandoff: true,
    description: 'The agent should escalate to a human for out-of-scope requests.'
  },
  {
    id: 'business-hours',
    name: 'Answers business hours',
    userMessage: 'What are your opening hours?',
    dimension: 'tool_selection',
    severity: 'critical',
    expectedToolCalls: ['check_business_hours'],
    description: 'The agent should use the hours tool rather than guessing.'
  }
];

export const FactoryControlCenter: React.FC<FactoryControlCenterProps> = ({ agent, onRefreshAgent }) => {
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [published, setPublished] = useState<AgentVersion | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [latestEval, setLatestEval] = useState<EvalRunResult | null>(null);
  const [latestCorrection, setLatestCorrection] = useState<CorrectionResult | null>(null);
  const [scenarios, setScenarios] = useState<EvalScenario[]>(DEFAULT_SCENARIOS);
  const [busy, setBusy] = useState<BusyState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [knowledgeSources, setKnowledgeSources] = useState<TrustedKnowledgeSource[]>([]);

  // Load versions + published + latest eval/correction for the selected version.
  const refreshVersions = useCallback(async () => {
    try {
      const [vRes, pubRes] = await Promise.all([
        fetch(`/api/agents/${agent.id}/versions`),
        fetch(`/api/agents/${agent.id}/versions/published`)
      ]);
      const vData: AgentVersion[] = vRes.ok ? await vRes.json() : [];
      setVersions(vData);
      setPublished(pubRes.ok ? await pubRes.json() : null);
      // Prefer the most recent DRAFT/TESTING version to work on; fall back to
      // the latest version. Never auto-select a PUBLISHED version for editing.
      const editable = vData.find(v => v.status === 'DRAFT' || v.status === 'TESTING');
      const target = editable || vData[0];
      if (target) setSelectedVersionId(prev => prev || target.id);
    } catch (e: any) {
      setError(e?.message || 'Failed to load versions.');
    }
  }, [agent.id]);

  const refreshEvalAndCorrection = useCallback(async (versionId: string) => {
    try {
      const [evalRes, corrRes] = await Promise.all([
        fetch(`/api/agents/${agent.id}/versions/${versionId}/evaluations`),
        fetch(`/api/agents/${agent.id}/corrections`)
      ]);
      if (evalRes.ok) {
        const data = await evalRes.json();
        setLatestEval(data?.latest ?? null);
      }
      if (corrRes.ok) {
        const list: CorrectionResult[] = await corrRes.json();
        // Most recent correction touching this version.
        const relevant = list.find(
          c => c.startVersionId === versionId || c.finalVersionId === versionId
        ) || null;
        setLatestCorrection(relevant);
      }
    } catch (e: any) {
      // Non-fatal: display state just won't update.
    }
  }, [agent.id]);

  useEffect(() => {
    refreshVersions();
  }, [refreshVersions]);

  useEffect(() => {
    if (selectedVersionId) refreshEvalAndCorrection(selectedVersionId);
  }, [selectedVersionId, refreshEvalAndCorrection]);

  const handleEvaluate = async () => {
    if (!selectedVersionId) return;
    setBusy('evaluating'); setError(null); setPublishResult(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/versions/${selectedVersionId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarios })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Evaluation failed.');
      setLatestEval(data);
      await refreshEvalAndCorrection(selectedVersionId);
    } catch (e: any) {
      setError(e?.message || 'Evaluation failed.');
    } finally {
      setBusy('idle');
    }
  };

  const handleCorrect = async () => {
    if (!selectedVersionId) return;
    setBusy('correcting'); setError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/versions/${selectedVersionId}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarios,
          trustedKnowledgeSources: knowledgeSources.length ? knowledgeSources : undefined
        })
      });
      const data: CorrectionResult = await res.json();
      if (!res.ok) throw new Error((data as any)?.error || 'Self-correction failed.');
      setLatestCorrection(data);
      // Correction may have created a new draft — reload versions and select it.
      await refreshVersions();
      setSelectedVersionId(data.finalVersionId);
      await refreshEvalAndCorrection(data.finalVersionId);
    } catch (e: any) {
      setError(e?.message || 'Self-correction failed.');
    } finally {
      setBusy('idle');
    }
  };

  const handleCreateDraft = async () => {
    setBusy('creatingDraft'); setError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromVersionId: selectedVersionId, changeNote: 'Draft for iteration' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to create draft.');
      await refreshVersions();
      setSelectedVersionId(data.id);
      setLatestEval(null);
      setLatestCorrection(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to create draft.');
    } finally {
      setBusy('idle');
    }
  };

  const handlePublish = async () => {
    if (!selectedVersionId) return;
    setBusy('publishing'); setError(null); setPublishResult(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/versions/${selectedVersionId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (!res.ok) {
        // Server gate blocked it (or other error). Surface the server's reason.
        setPublishResult({ ok: false, message: data?.error || 'Publish blocked by server.' });
      } else {
        setPublishResult({ ok: true, message: `Published v${data.versionNumber}.` });
        await refreshVersions();
        onRefreshAgent?.();
      }
    } catch (e: any) {
      setPublishResult({ ok: false, message: e?.message || 'Publish failed.' });
    } finally {
      setBusy('idle');
    }
  };

  const selectedVersion = versions.find(v => v.id === selectedVersionId);
  const evalSummary = summarizeEvaluation(latestEval);
  const gateHint = publishGateHint(latestEval);
  const corrSummary = summarizeCorrection(latestCorrection);
  const humanReview = requiresHumanReview(latestCorrection);
  const isPublishedVersion = selectedVersion?.status === 'PUBLISHED';
  const canEditScenarios = !isPublishedVersion;

  return (
    <ControlCenterView
      agent={agent}
      versions={versions}
      published={published}
      selectedVersionId={selectedVersionId}
      onSelectVersion={(id) => { setSelectedVersionId(id); setPublishResult(null); }}
      selectedVersion={selectedVersion || null}
      latestEval={latestEval}
      evalSummary={evalSummary}
      gateHint={gateHint}
      latestCorrection={latestCorrection}
      corrSummary={corrSummary}
      humanReview={humanReview}
      scenarios={scenarios}
      onScenariosChange={canEditScenarios ? setScenarios : undefined}
      knowledgeSources={knowledgeSources}
      onKnowledgeSourcesChange={setKnowledgeSources}
      busy={busy}
      error={error}
      publishResult={publishResult}
      onEvaluate={handleEvaluate}
      onCorrect={handleCorrect}
      onCreateDraft={handleCreateDraft}
      onPublish={handlePublish}
      isPublishedVersion={isPublishedVersion}
    />
  );
};

// ---------------------------------------------------------------------------
// Presentational view (pure: takes state, renders). Tested via
// renderToStaticMarkup so we verify real UI behavior without a DOM test stack.
// ---------------------------------------------------------------------------

export interface ControlCenterViewProps {
  agent: Agent;
  versions: AgentVersion[];
  published: AgentVersion | null;
  selectedVersionId: string;
  onSelectVersion: (id: string) => void;
  selectedVersion: AgentVersion | null;
  latestEval: EvalRunResult | null;
  evalSummary: ReturnType<typeof summarizeEvaluation>;
  gateHint: ReturnType<typeof publishGateHint>;
  latestCorrection: CorrectionResult | null;
  corrSummary: ReturnType<typeof summarizeCorrection>;
  humanReview: boolean;
  scenarios: EvalScenario[];
  onScenariosChange?: (s: EvalScenario[]) => void;
  knowledgeSources: TrustedKnowledgeSource[];
  onKnowledgeSourcesChange?: (s: TrustedKnowledgeSource[]) => void;
  busy: BusyState;
  error: string | null;
  publishResult: { ok: boolean; message: string } | null;
  onEvaluate: () => void;
  onCorrect: () => void;
  onCreateDraft: () => void;
  onPublish: () => void;
  isPublishedVersion: boolean;
}

export const ControlCenterView: React.FC<ControlCenterViewProps> = ({
  agent,
  versions,
  published,
  selectedVersionId,
  onSelectVersion,
  selectedVersion,
  latestEval,
  evalSummary,
  gateHint,
  latestCorrection,
  corrSummary,
  humanReview,
  scenarios,
  onScenariosChange,
  busy,
  error,
  publishResult,
  onEvaluate,
  onCorrect,
  onCreateDraft,
  onPublish,
  isPublishedVersion
}) => {
  const isBusy = busy !== 'idle';
  return (
    <div className="space-y-6" data-testid="factory-control-center">
      {/* Header: agent + version selector */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm">
        <div className="flex items-center space-x-2 text-indigo-600 text-xs font-bold uppercase tracking-wider mb-2">
          <GitBranch className="w-4 h-4" />
          <span>Factory Control Center</span>
        </div>
        <h2 className="text-lg font-extrabold text-slate-900">{agent.name}</h2>
        <p className="text-xs text-slate-500 mt-1">
          Provider: {agent.llmProvider} • Model: {agent.model} • Status: {agent.status}
        </p>

        <div className="mt-4 flex flex-col md:flex-row md:items-center gap-3">
          <label className="text-xs font-semibold text-slate-600">Working version</label>
          <select
            value={selectedVersionId}
            onChange={(e) => onSelectVersion(e.target.value)}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none flex-1"
          >
            {versions.map(v => (
              <option key={v.id} value={v.id}>
                v{v.versionNumber} — {v.status}{v.id === published?.id ? ' (LIVE)' : ''}
              </option>
            ))}
          </select>
          {selectedVersion && (
            <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${versionStatusBadge(selectedVersion.status)}`}>
              {selectedVersion.status}
            </span>
          )}
          <button
            onClick={onCreateDraft}
            disabled={isBusy}
            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold flex items-center space-x-1.5 disabled:opacity-50"
          >
            <GitBranch className="w-3.5 h-3.5" />
            <span>New Draft</span>
          </button>
        </div>

        {isPublishedVersion && (
          <div className="mt-3 flex items-center space-x-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
            <Lock className="w-4 h-4" />
            <span>
              This is a PUBLISHED version. The server refuses to edit or correct it — create a new draft to iterate.
            </span>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center space-x-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
          <XCircle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {/* Published status */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 text-slate-500 text-xs font-semibold uppercase">
            <UploadCloud className="w-4 h-4" />
            <span>Published Version</span>
          </div>
          {published ? (
            <span className="flex items-center space-x-1 text-xs font-bold text-emerald-700">
              <CheckCircle2 className="w-4 h-4" />
              <span>v{published.versionNumber} LIVE</span>
            </span>
          ) : (
            <span className="text-xs font-bold text-slate-400">None published</span>
          )}
        </div>
        {published && (
          <p className="text-xs text-slate-600 mt-2">
            Published at {new Date(published.publishedAt || published.createdAt).toLocaleString()}
          </p>
        )}
      </div>

      {/* Scenarios editor */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-slate-900 text-sm flex items-center space-x-2">
            <FlaskConical className="w-4 h-4 text-blue-600" />
            <span>Evaluation Scenarios</span>
          </h3>
          {onScenariosChange && (
            <button
              onClick={() => onScenariosChange([...scenarios, { id: `sc-${Date.now()}`, name: 'New scenario', userMessage: '', dimension: 'tool_selection', severity: 'critical' }])}
              className="text-xs font-semibold text-blue-600 hover:text-blue-500"
            >
              + Add scenario
            </button>
          )}
        </div>
        <div className="space-y-2">
          {scenarios.map((sc, i) => (
            <div key={sc.id} className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <input
                  value={sc.name}
                  onChange={(e) => onScenariosChange ? onScenariosChange(scenarios.map(s => s.id === sc.id ? { ...s, name: e.target.value } : s)) : undefined}
                  disabled={!onScenariosChange}
                  className="flex-1 px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-900 focus:outline-none disabled:opacity-60"
                />
                <select
                  value={sc.dimension}
                  onChange={(e) => onScenariosChange ? onScenariosChange(scenarios.map(s => s.id === sc.id ? { ...s, dimension: e.target.value as any } : s)) : undefined}
                  disabled={!onScenariosChange}
                  className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-[10px] text-slate-700 focus:outline-none disabled:opacity-60"
                >
                  <option value="tool_selection">tool_selection</option>
                  <option value="factual_knowledge">factual_knowledge</option>
                  <option value="handoff">handoff</option>
                  <option value="safety">safety</option>
                  <option value="unknown_handling">unknown_handling</option>
                  <option value="hallucination">hallucination</option>
                  <option value="business_rule">business_rule</option>
                  <option value="tool_argument">tool_argument</option>
                  <option value="prompt_injection">prompt_injection</option>
                </select>
                <select
                  value={sc.severity}
                  onChange={(e) => onScenariosChange ? onScenariosChange(scenarios.map(s => s.id === sc.id ? { ...s, severity: e.target.value as any } : s)) : undefined}
                  disabled={!onScenariosChange}
                  className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-[10px] text-slate-700 focus:outline-none disabled:opacity-60"
                >
                  <option value="critical">critical</option>
                  <option value="warning">warning</option>
                </select>
                {onScenariosChange && scenarios.length > 1 && (
                  <button
                    onClick={() => onScenariosChange(scenarios.filter(s => s.id !== sc.id))}
                    className="text-red-500 hover:text-red-400 text-xs"
                  >✕</button>
                )}
              </div>
              <textarea
                value={sc.userMessage}
                onChange={(e) => onScenariosChange ? onScenariosChange(scenarios.map(s => s.id === sc.id ? { ...s, userMessage: e.target.value } : s)) : undefined}
                disabled={!onScenariosChange}
                rows={1}
                placeholder="Customer message..."
                className="w-full px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 focus:outline-none disabled:opacity-60"
              />
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            onClick={onEvaluate}
            disabled={isBusy || isPublishedVersion}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold flex items-center space-x-1.5 disabled:opacity-50"
          >
            {busy === 'evaluating' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
            <span>Run Evaluation</span>
          </button>
          <button
            onClick={onCorrect}
            disabled={isBusy || isPublishedVersion}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-semibold flex items-center space-x-1.5 disabled:opacity-50"
          >
            {busy === 'correcting' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
            <span>Start Self-Correction</span>
          </button>
          <button
            onClick={onPublish}
            disabled={isBusy || isPublishedVersion}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold flex items-center space-x-1.5 disabled:opacity-50"
          >
            {busy === 'publishing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
            <span>Publish Version</span>
          </button>
        </div>
        {isPublishedVersion && (
          <p className="text-[11px] text-slate-400">Evaluation / correction / publish are disabled on a PUBLISHED version. Create a new draft.</p>
        )}
      </div>

      {/* Evaluation results */}
      {evalSummary && latestEval && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-900 text-sm flex items-center space-x-2">
              <FlaskConical className="w-4 h-4 text-blue-600" />
              <span>Evaluation Result</span>
            </h3>
            <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${evalSummary.overallPassed ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
              {evalSummary.overallPassed ? 'PASSED' : 'FAILED'}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Metric label="Score" value={`${evalSummary.passed}/${evalSummary.total}`} />
            <Metric label="Critical failures" value={String(evalSummary.criticalFailures)} danger={evalSummary.criticalFailures > 0} />
            <Metric label="Provider" value={evalSummary.providerUsed} />
            <Metric label="Run" value={new Date(latestEval.timestamp).toLocaleString()} />
          </div>

          {evalSummary.failureCategories.length > 0 && (
            <div className="flex flex-wrap gap-2" data-testid="failure-categories">
              {evalSummary.failureCategories.map(cat => (
                <span key={cat} className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${failureCategoryBadge(cat)}`}>
                  {cat}
                </span>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {latestEval.scenarioResults.map(sr => (
              <ScenarioResultRow key={sr.scenarioId} sr={sr} />
            ))}
          </div>
        </div>
      )}

      {/* Publish gate hint (display only; server is authoritative) */}
      {gateHint.blocked && (
        <div className="flex items-start space-x-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3" data-testid="publish-blocked">
          <Lock className="w-4 h-4 mt-0.5" />
          <div>
            <p className="font-bold">Publishing is blocked</p>
            <p className="mt-0.5">{gateHint.reason}</p>
            <p className="mt-1 text-[10px] text-red-500">The server-side gate enforces this — the UI cannot bypass it.</p>
          </div>
        </div>
      )}

      {/* Publish result (server response) */}
      {publishResult && (
        <div className={`flex items-start space-x-2 text-xs rounded-xl p-3 border ${publishResult.ok ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
          {publishResult.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5" /> : <XCircle className="w-4 h-4 mt-0.5" />}
          <div>
            <p className="font-bold">{publishResult.ok ? 'Published' : 'Publish blocked by server'}</p>
            <p className="mt-0.5">{publishResult.message}</p>
          </div>
        </div>
      )}

      {/* Correction results */}
      {corrSummary && latestCorrection && (
        <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-900 text-sm flex items-center space-x-2">
              <Wrench className="w-4 h-4 text-purple-600" />
              <span>Self-Correction</span>
            </h3>
            <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${corrSummary.resolved ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
              {corrSummary.resolved ? 'RESOLVED' : 'UNRESOLVED'}
            </span>
          </div>
          <p className="text-xs text-slate-600">{corrSummary.reason}</p>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <Metric label="Attempts" value={String(corrSummary.attempts)} />
            <Metric label="Final version" value={corrSummary.finalVersionId === corrSummary.startVersionId ? '(unchanged)' : 'new draft'} />
            <Metric label="Resolved" value={corrSummary.resolved ? 'Yes' : 'No'} />
          </div>

          <div className="space-y-2">
            {latestCorrection.attempts.map(a => (
              <div key={a.attemptNumber} className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-900">Attempt {a.attemptNumber}: {correctionActionLabel(a.proposal.actionType)}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${a.status === 'APPLIED' ? 'bg-emerald-100 text-emerald-800' : a.status === 'HUMAN_REVIEW' ? 'bg-red-100 text-red-800' : 'bg-slate-200 text-slate-700'}`}>
                    {a.status}
                  </span>
                </div>
                <p className="text-slate-600 mt-1">{a.proposal.reason}</p>
                <p className="text-[10px] text-slate-400 mt-1">
                  Category: {a.proposal.category} • {isAutoSafeProposal(a.proposal) ? 'Auto-applied (safe)' : 'Needs human review'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Human review banner */}
      {humanReview && (
        <div className="flex items-start space-x-3 text-sm text-red-800 bg-red-50 border-2 border-red-300 rounded-2xl p-4" data-testid="human-review-banner">
          <ShieldAlert className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-bold">Human review required</p>
            <p className="text-xs mt-1">
              The self-correction engine could not safely resolve this agent automatically (safety failure, missing trusted knowledge, or max attempts exhausted).
              Review the failures above, then create a new draft and adjust the configuration manually before re-evaluating.
            </p>
            <p className="text-[10px] text-red-500 mt-1">The UI will never auto-approve a safety correction or bypass the publish gate.</p>
          </div>
        </div>
      )}

      {/* Re-evaluate hint after correction */}
      {corrSummary && !corrSummary.resolved && !humanReview && (
        <div className="flex items-center space-x-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
          <AlertTriangle className="w-4 h-4" />
          <span>Correction did not fully resolve the failures. Re-run evaluation to see the latest score.</span>
        </div>
      )}
    </div>
  );
};

function versionStatusBadge(status: string): string {
  switch (status) {
    case 'PUBLISHED': return 'bg-emerald-100 text-emerald-800';
    case 'DRAFT': return 'bg-blue-100 text-blue-800';
    case 'TESTING': return 'bg-amber-100 text-amber-800';
    case 'ARCHIVED': return 'bg-slate-200 text-slate-600';
    default: return 'bg-slate-100 text-slate-700';
  }
}

const Metric: React.FC<{ label: string; value: string; danger?: boolean }> = ({ label, value, danger }) => (
  <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
    <p className="text-[10px] text-slate-400 font-semibold uppercase">{label}</p>
    <p className={`text-xs font-bold mt-1 ${danger ? 'text-red-600' : 'text-slate-900'}`}>{value}</p>
  </div>
);

const ScenarioResultRow: React.FC<{ sr: EvalScenarioResult }> = ({ sr }) => (
  <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
    <div className="flex items-center justify-between">
      <span className="font-bold text-slate-900 flex items-center space-x-1.5">
        {sr.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-red-500" />}
        <span>{sr.scenarioName}</span>
      </span>
      <span className="text-[10px] text-slate-400 uppercase">{sr.severity} • {sr.dimension}</span>
    </div>
    {!sr.passed && sr.failureCategories.length > 0 && (
      <div className="flex flex-wrap gap-1 mt-2">
        {sr.failureCategories.map(cat => (
          <span key={cat} className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${failureCategoryBadge(cat)}`}>{cat}</span>
        ))}
      </div>
    )}
    {sr.reply && (
      <p className="text-slate-600 mt-2 italic line-clamp-2">"{sr.reply.slice(0, 160)}"</p>
    )}
    {sr.toolCalls.length > 0 && (
      <p className="text-[10px] text-slate-400 mt-1">Tools called: {sr.toolCalls.map(t => t.toolName).join(', ')}</p>
    )}
  </div>
);
