import React, { useState, useEffect, useCallback } from 'react';
import { Agent, TelemetryEvent, TelemetryEventType } from '../types';
import {
  Activity,
  MessageSquare,
  Wrench,
  ShieldAlert,
  FlaskConical,
  RefreshCw,
  Loader2,
  Gauge,
  CheckCircle2,
  XCircle,
  TrendingUp,
  Eye,
  Filter,
  MessagesSquare,
  ArrowLeft,
  Clock,
  User
} from 'lucide-react';

/**
 * Monitoring view for a published (and draft/test) agent — surfaces REAL
 * telemetry recorded server-side from the runtime/tool/eval/correction/publish
 * paths. The UI never fabricates metrics: it shows zero/empty states when no
 * telemetry exists. All data comes from the tenant-scoped monitoring API
 * (server-side authorization remains authoritative).
 */
interface MonitoringViewProps {
  agent: Agent;
}

type ActivityFilter = 'published' | 'draft' | 'all';

export interface TelemetryMetrics {
  conversations: number;
  messages: number;
  agentResponses: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  humanHandoffs: number;
  averageLatencyMs: number;
  providerModelUsage: Record<string, number>;
  evaluationPasses: number;
  evaluationFailures: number;
  correctionCount: number;
  hasPublishedActivity: boolean;
  hasDraftActivity: boolean;
}

export const MonitoringView: React.FC<MonitoringViewProps> = ({ agent }) => {
  const [metrics, setMetrics] = useState<TelemetryMetrics | null>(null);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>('published');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-conversation drill-down state.
  const [conversations, setConversations] = useState<ConversationSummaryT[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [selectedConv, setSelectedConv] = useState<ConversationTimelineT | null>(null);
  const [convDetailLoading, setConvDetailLoading] = useState(false);
  const [convDetailError, setConvDetailError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    const isPublishedParam = filter === 'published' ? 'true' : filter === 'draft' ? 'false' : '';
    try {
      const [mRes, eRes] = await Promise.all([
        fetch(`/api/agents/${agent.id}/metrics${isPublishedParam ? `?isPublished=${isPublishedParam}` : ''}`),
        fetch(`/api/agents/${agent.id}/telemetry?limit=100${isPublishedParam ? `&isPublished=${isPublishedParam}` : ''}`)
      ]);
      if (!mRes.ok || !eRes.ok) throw new Error('Failed to load monitoring data.');
      setMetrics(await mRes.json());
      setEvents(await eRes.json());
    } catch (e: any) {
      setError(e?.message || 'Failed to load monitoring data.');
    } finally {
      setLoading(false);
    }
  }, [agent.id, filter]);

  useEffect(() => { refresh(); }, [refresh]);

  // Load the conversation list whenever the filter changes (or on refresh).
  const refreshConversations = useCallback(async () => {
    setConvLoading(true);
    const isPublishedParam = filter === 'published' ? 'true' : filter === 'draft' ? 'false' : '';
    try {
      const res = await fetch(`/api/agents/${agent.id}/conversations?limit=50${isPublishedParam ? `&isPublished=${isPublishedParam}` : ''}`);
      if (!res.ok) throw new Error('Failed to load conversations.');
      setConversations(await res.json());
    } catch {
      setConversations([]);
    } finally {
      setConvLoading(false);
    }
  }, [agent.id, filter]);

  useEffect(() => { refreshConversations(); }, [refreshConversations]);

  const openConversation = useCallback(async (conversationId: string) => {
    setConvDetailLoading(true); setConvDetailError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/conversations/${encodeURIComponent(conversationId)}`);
      if (res.status === 404) {
        setConvDetailError('Conversation not found.');
        setSelectedConv(null);
      } else if (!res.ok) {
        setConvDetailError('Failed to load conversation timeline.');
        setSelectedConv(null);
      } else {
        setSelectedConv(await res.json());
      }
    } catch (e: any) {
      setConvDetailError(e?.message || 'Failed to load conversation timeline.');
      setSelectedConv(null);
    } finally {
      setConvDetailLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    // Escape closes the timeline detail.
    if (!selectedConv) return;
    const handler = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setSelectedConv(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedConv]);

  const noActivity = metrics && !metrics.hasPublishedActivity && !metrics.hasDraftActivity;

  return (
    <div className="space-y-6" data-testid="monitoring-view">
      {/* Header */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center space-x-2 text-emerald-600 text-xs font-bold uppercase tracking-wider mb-1">
              <Activity className="w-4 h-4" />
              <span>Monitoring & Observability</span>
            </div>
            <h2 className="text-lg font-extrabold text-slate-900">{agent.name}</h2>
            <p className="text-xs text-slate-500 mt-1">
              Real activity recorded server-side from the agent runtime, tools, evaluation, correction, and publish paths.
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold flex items-center space-x-1.5 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span>Refresh</span>
          </button>
        </div>

        {/* Activity filter — published vs draft/test separation */}
        <div className="mt-4 flex items-center space-x-2">
          <Filter className="w-3.5 h-3.5 text-slate-400" />
          {(['published', 'draft', 'all'] as ActivityFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold transition-colors ${
                filter === f ? 'bg-emerald-600 text-white' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
              }`}
            >
              {f === 'published' ? 'Published (real customers)' : f === 'draft' ? 'Draft / Test' : 'All activity'}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="flex items-center space-x-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
          <XCircle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {/* Empty state — never fabricate metrics */}
      {noActivity && !loading && (
        <div className="bg-white p-8 rounded-2xl border border-slate-200/80 shadow-sm text-center">
          <Gauge className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-bold text-slate-700">No activity recorded yet</p>
          <p className="text-xs text-slate-500 mt-1">
            Metrics will appear here once this agent serves real conversations or runs evaluations/corrections.
            The UI never invents numbers — it shows zero until real telemetry exists.
          </p>
        </div>
      )}

      {/* Metrics grid */}
      {metrics && !noActivity && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard icon={<MessageSquare className="w-4 h-4 text-blue-600" />} label="Conversations" value={metrics.conversations} />
          <MetricCard icon={<MessageSquare className="w-4 h-4 text-slate-600" />} label="Messages" value={metrics.messages} />
          <MetricCard icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />} label="Successful tools" value={metrics.successfulToolCalls} />
          <MetricCard icon={<XCircle className="w-4 h-4 text-red-500" />} label="Failed tools" value={metrics.failedToolCalls} />
          <MetricCard icon={<ShieldAlert className="w-4 h-4 text-amber-600" />} label="Human handoffs" value={metrics.humanHandoffs} />
          <MetricCard icon={<TrendingUp className="w-4 h-4 text-indigo-600" />} label="Avg latency" value={`${metrics.averageLatencyMs}ms`} />
          <MetricCard icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />} label="Eval passes" value={metrics.evaluationPasses} />
          <MetricCard icon={<XCircle className="w-4 h-4 text-red-500" />} label="Eval failures" value={metrics.evaluationFailures} />
        </div>
      )}

      {/* Provider/model usage */}
      {metrics && Object.keys(metrics.providerModelUsage).length > 0 && (
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
          <h3 className="font-bold text-slate-900 text-sm flex items-center space-x-2 mb-3">
            <Gauge className="w-4 h-4 text-slate-600" />
            <span>Provider / Model Usage</span>
          </h3>
          <div className="space-y-2">
            {Object.entries(metrics.providerModelUsage).map(([key, count]) => (
              <div key={key} className="flex items-center justify-between text-xs">
                <span className="font-mono text-slate-700">{key}</span>
                <span className="font-bold text-slate-900">{count} responses</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Correction count + activity note */}
      {metrics && (metrics.correctionCount > 0 || (metrics.hasDraftActivity && filter !== 'published')) && (
        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm flex items-center justify-between text-xs">
          <span className="text-slate-600">Correction runs recorded: <span className="font-bold text-slate-900">{metrics.correctionCount}</span></span>
          <span className="text-[10px] text-slate-400">
            {filter === 'published'
              ? 'Draft/test activity is hidden — switch to "Draft / Test" to see evaluation & correction runs.'
              : 'Evaluation & correction runs are draft/test activity.'}
          </span>
        </div>
      )}

      {/* Activity feed */}
      {events.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 overflow-hidden shadow-sm">
          <div className="p-4 bg-slate-50 border-b border-slate-200 font-semibold text-xs text-slate-700 flex items-center space-x-2">
            <Eye className="w-4 h-4" />
            <span>Recent Activity (newest first)</span>
          </div>
          <div className="divide-y divide-slate-100 max-h-[480px] overflow-y-auto">
            {events.map(ev => (
              <ActivityRow key={ev.id} ev={ev} />
            ))}
          </div>
        </div>
      )}

      {events.length === 0 && metrics && !noActivity && (
        <div className="text-center text-xs text-slate-400 py-4">
          No individual events match the current filter — adjust the activity filter above.
        </div>
      )}

      {/* Conversation list — per-conversation drill-down entry point. */}
      {metrics && !noActivity && (
        <div className="bg-white rounded-2xl border border-slate-200/80 overflow-hidden shadow-sm" data-testid="conversation-list">
          <div className="p-4 bg-slate-50 border-b border-slate-200 font-semibold text-xs text-slate-700 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <MessagesSquare className="w-4 h-4" />
              <span>Conversations</span>
            </div>
            <span className="text-[10px] text-slate-400 font-normal">Click a conversation to open its timeline</span>
          </div>
          {convLoading && (
            <div className="p-6 flex items-center justify-center text-xs text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading conversations…
            </div>
          )}
          {!convLoading && conversations.length === 0 && (
            <div className="p-6 text-center text-xs text-slate-400">
              No conversations match the current filter.
            </div>
          )}
          {!convLoading && conversations.length > 0 && (
            <div className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
              {conversations.map(c => (
                <button
                  key={c.conversationId}
                  onClick={() => openConversation(c.conversationId)}
                  className="w-full p-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors"
                  data-testid="conversation-row"
                  data-conv-id={c.conversationId}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-900 flex items-center space-x-2">
                      <User className="w-3.5 h-3.5 text-slate-400" />
                      <span>{c.customerName || 'Unknown customer'}</span>
                      {c.status && (
                        <span className="text-[10px] font-mono text-slate-400">· {c.status}</span>
                      )}
                    </p>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleString() : 'Unknown time'}
                      {c.agentName && <span className="ml-1.5">· {c.agentName}</span>}
                      <span className="ml-1.5">· {c.messageCount} msgs / {c.agentResponseCount} responses</span>
                      {c.toolCallCount > 0 && <span className="ml-1.5">· {c.successfulToolCalls}✓ {c.failedToolCalls}✗</span>}
                      {c.handoffCount > 0 && <span className="ml-1.5 text-red-500">· {c.handoffCount} handoff</span>}
                    </p>
                  </div>
                  <div className="flex flex-col items-end flex-shrink-0">
                    <span className={`text-[9px] font-bold uppercase ${c.hasPublishedActivity ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {c.hasPublishedActivity ? 'PUBLISHED' : 'DRAFT/TEST'}
                    </span>
                    <span className="text-[10px] text-slate-300 mt-0.5 font-mono">{c.conversationId.slice(-8)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Conversation timeline detail (drill-down). */}
      {selectedConv && (
        <ConversationTimelineView
          timeline={selectedConv}
          loading={convDetailLoading}
          onClose={() => { setSelectedConv(null); setConvDetailError(null); }}
        />
      )}
      {convDetailError && !selectedConv && (
        <div className="flex items-center space-x-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
          <XCircle className="w-4 h-4" />
          <span>{convDetailError}</span>
        </div>
      )}
    </div>
  );
};

const MetricCard: React.FC<{ icon: React.ReactNode; label: string; value: number | string }> = ({ icon, label, value }) => (
  <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm">
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-slate-400 font-semibold uppercase">{label}</span>
      {icon}
    </div>
    <p className="text-2xl font-extrabold text-slate-900 mt-2">{value}</p>
  </div>
);

function eventTypeMeta(type: TelemetryEventType): { icon: React.ReactNode; label: string; color: string } {
  switch (type) {
    case 'CUSTOMER_MESSAGE': return { icon: <MessageSquare className="w-3.5 h-3.5" />, label: 'Customer message', color: 'text-blue-600' };
    case 'AGENT_RESPONSE': return { icon: <MessageSquare className="w-3.5 h-3.5" />, label: 'Agent response', color: 'text-slate-700' };
    case 'TOOL_EXECUTION': return { icon: <Wrench className="w-3.5 h-3.5" />, label: 'Tool execution', color: 'text-amber-600' };
    case 'HUMAN_HANDOFF': return { icon: <ShieldAlert className="w-3.5 h-3.5" />, label: 'Human handoff', color: 'text-red-600' };
    case 'EVALUATION_RUN': return { icon: <FlaskConical className="w-3.5 h-3.5" />, label: 'Evaluation run', color: 'text-indigo-600' };
    case 'CORRECTION_ATTEMPT': return { icon: <Wrench className="w-3.5 h-3.5" />, label: 'Correction attempt', color: 'text-purple-600' };
    case 'VERSION_PUBLISHED': return { icon: <CheckCircle2 className="w-3.5 h-3.5" />, label: 'Version published', color: 'text-emerald-600' };
    default: return { icon: <Activity className="w-3.5 h-3.5" />, label: type, color: 'text-slate-600' };
  }
}

const ActivityRow: React.FC<{ ev: TelemetryEvent }> = ({ ev }) => {
  const meta = eventTypeMeta(ev.eventType);
  return (
    <div className="p-3.5 flex items-start justify-between gap-3 text-xs">
      <div className="flex items-start space-x-2.5 min-w-0">
        <span className={`${meta.color} mt-0.5 flex-shrink-0`}>{meta.icon}</span>
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">
            {meta.label}
            {ev.toolName && <span className="font-mono text-slate-500 ml-1.5">· {ev.toolName}</span>}
          </p>
          <p className="text-[10px] text-slate-400 mt-0.5 truncate">
            {new Date(ev.timestamp).toLocaleString()}
            {ev.provider && ev.model && <span className="ml-1.5 font-mono">· {ev.provider}/{ev.model}</span>}
            {ev.conversationId && <span className="ml-1.5">· conv {ev.conversationId.slice(-6)}</span>}
          </p>
          {ev.summary && <p className="text-slate-500 mt-1 italic truncate">"{ev.summary}"</p>}
        </div>
      </div>
      <div className="flex flex-col items-end flex-shrink-0">
        {ev.latencyMs != null && <span className="text-[10px] text-slate-400">{ev.latencyMs}ms</span>}
        {ev.success === true && <span className="text-[10px] font-bold text-emerald-600">OK</span>}
        {ev.success === false && <span className="text-[10px] font-bold text-red-500">FAIL</span>}
        <span className={`text-[9px] font-bold uppercase mt-0.5 ${ev.isPublished ? 'text-emerald-600' : 'text-amber-600'}`}>
          {ev.isPublished ? 'PUBLISHED' : 'DRAFT/TEST'}
        </span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Per-conversation drill-down — types + timeline view (mirrors the server's
// ConversationTimeline / ConversationSummary). The UI NEVER authorizes — it
// only renders what the tenant-scoped API returns. Tool args / secrets are
// never present in the API response.
// ---------------------------------------------------------------------------
type TimelineActor = 'CUSTOMER' | 'AGENT' | 'TOOL' | 'SYSTEM' | 'HANDOFF';

interface ConversationTimelineEntryT {
  id: string;
  timestamp: string;
  eventType: TelemetryEventType;
  actor: TimelineActor;
  summary?: string;
  toolName?: string;
  success?: boolean;
  latencyMs?: number;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  tokensUsed?: number;
  agentId?: string;
  agentName?: string;
  versionId?: string;
  versionNumber?: number;
  versionStatus?: string;
  isPublished: boolean;
  channel?: string;
  metadata?: Record<string, any>;
}

interface ConversationSummaryT {
  conversationId: string;
  businessId: string;
  agentId?: string;
  agentName?: string;
  status?: string;
  customerName?: string;
  channel?: string;
  createdAt?: string;
  lastActivityAt?: string;
  hasPublishedActivity: boolean;
  hasTestActivity: boolean;
  eventCount: number;
  messageCount: number;
  agentResponseCount: number;
  toolCallCount: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  handoffCount: number;
}

interface ConversationTimelineT {
  conversationId: string;
  businessId: string;
  conversation: {
    status?: string;
    customerName?: string;
    channel?: string;
    createdAt?: string;
    lastMessageAt?: string;
    summary?: string;
    handoffReason?: string;
  } | null;
  agentId?: string;
  agentName?: string;
  hasPublishedActivity: boolean;
  hasTestActivity: boolean;
  timeline: ConversationTimelineEntryT[];
}

function actorMeta(actor: TimelineActor, eventType: TelemetryEventType): { icon: React.ReactNode; label: string; color: string; bg: string } {
  switch (actor) {
    case 'CUSTOMER':
      return { icon: <User className="w-4 h-4" />, label: 'Customer', color: 'text-blue-700', bg: 'bg-blue-50' };
    case 'AGENT':
      return { icon: <MessageSquare className="w-4 h-4" />, label: 'Agent', color: 'text-slate-700', bg: 'bg-slate-50' };
    case 'TOOL':
      return { icon: <Wrench className="w-4 h-4" />, label: 'Tool', color: 'text-amber-700', bg: 'bg-amber-50' };
    case 'HANDOFF':
      return { icon: <ShieldAlert className="w-4 h-4" />, label: 'Handoff', color: 'text-red-700', bg: 'bg-red-50' };
    case 'SYSTEM':
    default:
      return { icon: <Activity className="w-4 h-4" />, label: eventType, color: 'text-indigo-700', bg: 'bg-indigo-50' };
  }
}

const ConversationTimelineView: React.FC<{ timeline: ConversationTimelineT; loading: boolean; onClose: () => void }> = ({ timeline, loading, onClose }) => {
  const conv = timeline.conversation;
  const publishedBadge = timeline.hasPublishedActivity
    ? <span className="text-[9px] font-bold uppercase text-emerald-600">PUBLISHED (real customers)</span>
    : <span className="text-[9px] font-bold uppercase text-amber-600">DRAFT / TEST</span>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40" data-testid="conversation-timeline">
      <div className="bg-white w-full max-w-2xl max-h-[90vh] rounded-2xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0">
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-600" aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h3 className="font-extrabold text-slate-900 text-sm flex items-center space-x-2">
                <MessagesSquare className="w-4 h-4 text-slate-500" />
                <span>{conv?.customerName || 'Unknown customer'}</span>
              </h3>
              <p className="text-[10px] text-slate-400 font-mono mt-0.5">{timeline.conversationId}</p>
            </div>
          </div>
          <div className="flex flex-col items-end">
            {publishedBadge}
            {timeline.agentName && <span className="text-[10px] text-slate-500 mt-0.5">Agent: {timeline.agentName}</span>}
          </div>
        </div>

        {/* Conversation metadata */}
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600 space-y-1">
          {!conv && (
            <p className="italic text-slate-400">Conversation record unavailable — showing telemetry events only.</p>
          )}
          {conv && (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {conv.status && <span><b className="text-slate-700">Status:</b> <span className="font-mono">{conv.status}</span></span>}
                {conv.channel && <span><b className="text-slate-700">Channel:</b> {conv.channel}</span>}
                {conv.createdAt && <span><b className="text-slate-700">Started:</b> {new Date(conv.createdAt).toLocaleString()}</span>}
                {conv.lastMessageAt && <span><b className="text-slate-700">Last message:</b> {new Date(conv.lastMessageAt).toLocaleString()}</span>}
              </div>
              {conv.handoffReason && <p className="text-red-600"><b>Handoff reason:</b> {conv.handoffReason}</p>}
            </>
          )}
        </div>

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center text-xs text-slate-400 py-8">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading timeline…
            </div>
          )}
          {!loading && timeline.timeline.length === 0 && (
            <div className="text-center py-8">
              <Activity className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-xs font-semibold text-slate-700">No telemetry events recorded</p>
              <p className="text-[11px] text-slate-400 mt-1">
                This conversation may have ended before the agent was ready (early fallback), or no events were captured.
              </p>
            </div>
          )}
          {!loading && timeline.timeline.length > 0 && (
            timeline.timeline.map(entry => {
              const meta = actorMeta(entry.actor, entry.eventType);
              return (
                <div key={entry.id} className={`p-3 rounded-xl border border-slate-200/70 ${meta.bg}`} data-testid="timeline-entry" data-actor={entry.actor}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <span className={meta.color}>{meta.icon}</span>
                      <span className="text-xs font-bold text-slate-800">{meta.label}</span>
                      {entry.toolName && <span className="text-[11px] font-mono text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200">{entry.toolName}</span>}
                    </div>
                    <div className="flex items-center space-x-2 text-[10px] text-slate-400">
                      <Clock className="w-3 h-3" />
                      <span>{new Date(entry.timestamp).toLocaleString()}</span>
                    </div>
                  </div>
                  {entry.summary && (
                    <p className="text-[11px] text-slate-600 mt-2 italic">"{entry.summary}"</p>
                  )}
                  {/* Tool execution: name + success/failure ONLY (never args). */}
                  {entry.actor === 'TOOL' && (
                    <div className="mt-2 flex items-center space-x-2 text-[10px]">
                      {entry.success === true && <span className="font-bold text-emerald-600">✓ Succeeded</span>}
                      {entry.success === false && <span className="font-bold text-red-500">✗ Failed</span>}
                      <span className="text-slate-400">Tool arguments are never exposed — only the tool name + outcome.</span>
                    </div>
                  )}
                  {/* Metadata strip: agent/version, provider/model, latency, tokens. */}
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400">
                    {entry.agentName && <span>Agent: {entry.agentName}</span>}
                    {entry.versionNumber != null && (
                      <span>Version: <span className="font-mono">v{entry.versionNumber}</span>{entry.versionStatus ? ` (${entry.versionStatus})` : ''}</span>
                    )}
                    {entry.provider && entry.model && <span className="font-mono">{entry.provider}/{entry.model}</span>}
                    {entry.latencyMs != null && <span>{entry.latencyMs}ms</span>}
                    {entry.tokensUsed != null && <span>{entry.tokensUsed} tokens</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
