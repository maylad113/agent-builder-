import { DiscoveryRun, DiscoveryResult, LeadResearchReport, DesignProposal } from '../types';

/**
 * Pipeline front-half display logic (Task 27) — PURE helpers for the
 * OrchestrationView discovery/research/analysis/design sections. They decide
 * NOTHING about authorization, quotas, dedupe, acceptance, or generation:
 * the server routes remain the sole authority. These helpers carry the
 * existing API contract in one tested place and shape what the UI displays.
 */

export const DISCOVERY_RUNS_ENDPOINT = '/api/orchestration/discovery-runs';
export const DISCOVERY_USAGE_ENDPOINT = '/api/orchestration/discovery/usage';
export const ACCEPT_RESULT_ENDPOINT = (resultId: string) => `/api/orchestration/discovery-results/${resultId}/accept`;
export const DISMISS_RESULT_ENDPOINT = (resultId: string) => `/api/orchestration/discovery-results/${resultId}/dismiss`;
export const RESEARCH_ENDPOINT = (prospectId: string) => `/api/orchestration/prospects/${prospectId}/research`;
export const ANALYZE_ENDPOINT = (prospectId: string) => `/api/orchestration/prospects/${prospectId}/analyze`;
export const GENERATE_DESIGN_ENDPOINT = (prospectId: string) => `/api/orchestration/prospects/${prospectId}/design`;

/** The two discovery providers in the existing closed static registry
 *  (discoveryProviders.ts). The UI offers only these — never a new one. */
export const DISCOVERY_PROVIDERS = [
  { id: 'manual_list', label: 'Manual List' },
  { id: 'google_places', label: 'Google Places' }
] as const;

/** A candidate can be triaged (accept/dismiss) only while it is untouched:
 *  not yet accepted into a prospect and not dismissed. Display hint only —
 *  the server enforces the real transition rules and retention expiry. */
export function canTriageResult(result: DiscoveryResult): boolean {
  return !result.prospectId && !result.dismissedAt;
}

/** Triage badge text for a discovery result (accepted / dismissed / pending). */
export function triageStateLabel(result: DiscoveryResult): 'Accepted' | 'Dismissed' | 'Pending' {
  if (result.prospectId) return 'Accepted';
  if (result.dismissedAt) return 'Dismissed';
  return 'Pending';
}

/** A research report can feed analysis only when it completed. Display hint
 *  only — the server's analyze/design preconditions remain authoritative. */
export function hasCompletedResearch(reports: LeadResearchReport[]): boolean {
  return reports.some(r => r.status === 'COMPLETED');
}

/** Latest report first (reports are returned newest-first by the API, but
 *  the UI never relies on server ordering for a pick). */
export function latestReport(reports: LeadResearchReport[]): LeadResearchReport | undefined {
  return reports.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Short score summary for display, e.g. "72 (GOOD)". */
export function scoreSummary(report: LeadResearchReport): string {
  return `${report.score} (${report.scoreBand})`;
}

/** The generated proposal summary line (title + type + status). */
export function designSummary(design: DesignProposal): string {
  return `${design.title} — ${design.agentType} (${design.status})`;
}

/** Parse a pasted manual-candidates block: one candidate per line as
 *  "Name | website | location | phone" (only name is required; later parts
 *  optional). Returns the candidate array for the EXISTING API shape. Lines
 *  that are empty are skipped; a line with no name yields null for that line
 *  so the caller can surface a form error before calling the server. */
export function parseManualCandidates(text: string): DiscoveryCandidateInput[] | null {
  const out: DiscoveryCandidateInput[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('|').map(p => p.trim());
    const businessName = parts[0] || '';
    if (!businessName) return null;
    const candidate: DiscoveryCandidateInput = { businessName };
    if (parts[1]) candidate.website = parts[1];
    if (parts[2]) candidate.location = parts[2];
    if (parts[3]) candidate.phone = parts[3];
    out.push(candidate);
  }
  return out.length > 0 ? out : null;
}

/** The website value the prospect form submits (trimmed, omitted when empty
 *  so the backend's optional-field semantics are preserved). */
export function prospectWebsiteValue(raw: string): string | undefined {
  const v = raw.trim();
  return v ? v : undefined;
}

/** Shape of the existing discovery candidate input (untrusted data, never
 *  instructions). */
export interface DiscoveryCandidateInput {
  businessName: string;
  website?: string;
  location?: string;
  phone?: string;
}

/** Compact run summary for display, e.g. "manual_list · 3 found · 1 dup · 0 invalid". */
export function runSummary(run: DiscoveryRun): string {
  return `${run.provider} · ${run.resultCount} found · ${run.duplicateCount} dup · ${run.invalidCount} invalid`;
}
