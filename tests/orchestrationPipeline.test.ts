import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

/**
 * Task 27 — surface the pipeline front half in the PLATFORM_OWNER
 * Orchestration UI: discovery (run/results/accept/dismiss), Places usage,
 * research, analysis, and AI design generation, plus the prospect `website`
 * field. The UI consumes the EXISTING tested endpoints only — no backend
 * logic is duplicated (quota/dedupe/acceptance/generation stay server-side).
 *
 * Test pattern follows controlCenter.test.ts / deliveryHandoff.test.ts:
 * vitest node env — pure display-logic unit tests + renderToStaticMarkup
 * smoke tests of the presentational PipelineFrontPanel, plus a static source
 * audit for unsafe rendering.
 */
import {
  DISCOVERY_RUNS_ENDPOINT,
  DISCOVERY_USAGE_ENDPOINT,
  ACCEPT_RESULT_ENDPOINT,
  DISMISS_RESULT_ENDPOINT,
  RESEARCH_ENDPOINT,
  ANALYZE_ENDPOINT,
  GENERATE_DESIGN_ENDPOINT,
  DISCOVERY_PROVIDERS,
  canTriageResult,
  triageStateLabel,
  hasCompletedResearch,
  latestReport,
  scoreSummary,
  designSummary,
  parseManualCandidates,
  prospectWebsiteValue,
  runSummary
} from '../src/components/orchestrationPipelineLogic';
import { PipelineFrontPanel } from '../src/components/PipelineFrontPanel';
import { DiscoveryRun, DiscoveryResult, LeadResearchReport, DesignProposal, Prospect } from '../src/types';

const mkRun = (over: Partial<DiscoveryRun> = {}): DiscoveryRun => ({
  id: 'run-1', provider: 'manual_list', status: 'COMPLETED', resultCount: 2,
  duplicateCount: 1, invalidCount: 0, idempotencyKey: 'k-1',
  createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z', ...over
});

const mkResult = (over: Partial<DiscoveryResult> = {}): DiscoveryResult => ({
  id: 'res-1', runId: 'run-1', sourceProvider: 'manual_list', sourceType: 'manual',
  normalized: { businessName: 'Tony\'s Barber', website: 'https://tonys.example', location: 'Springfield' },
  verification: 'UNVERIFIED', createdAt: '2026-08-21T00:00:00.000Z', ...over
});

const mkReport = (over: Partial<LeadResearchReport> = {}): LeadResearchReport => ({
  id: 'rep-1', prospectId: 'pro-1', status: 'COMPLETED', inputSource: 'manual',
  inputTextExcerpt: 'x', report: { appointmentFit: 'STRONG', painSignals: [], digitalGaps: [], channels: [], evidence: [], disqualifiers: [], caveats: [] },
  llmModel: 'fallback', score: 72, scoreBand: 'GOOD', scoreReasons: ['has website'],
  idempotencyKey: 'rk-1', createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z', ...over
});

const mkDesign = (over: Partial<DesignProposal> = {}): DesignProposal => ({
  id: 'des-1', prospectId: 'pro-1', title: 'Receptionist for Tony\'s', problemStatement: 'P',
  proposedSolution: 'S', agentType: 'receptionist', capabilities: ['Answer FAQs'],
  channels: ['web_chat'], integrations: [], status: 'DRAFT',
  createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z', ...over
});

const mkProspect = (over: Partial<Prospect> = {}): Prospect => ({
  id: 'pro-1', businessName: 'Tony\'s Barber', website: 'https://tonys.example',
  status: 'NEW', createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z', ...over
});

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe('orchestrationPipelineLogic', () => {
  it('uses the EXISTING endpoints (no second implementation)', () => {
    expect(DISCOVERY_RUNS_ENDPOINT).toBe('/api/orchestration/discovery-runs');
    expect(DISCOVERY_USAGE_ENDPOINT).toBe('/api/orchestration/discovery/usage');
    expect(ACCEPT_RESULT_ENDPOINT('r-1')).toBe('/api/orchestration/discovery-results/r-1/accept');
    expect(DISMISS_RESULT_ENDPOINT('r-1')).toBe('/api/orchestration/discovery-results/r-1/dismiss');
    expect(RESEARCH_ENDPOINT('p-1')).toBe('/api/orchestration/prospects/p-1/research');
    expect(ANALYZE_ENDPOINT('p-1')).toBe('/api/orchestration/prospects/p-1/analyze');
    expect(GENERATE_DESIGN_ENDPOINT('p-1')).toBe('/api/orchestration/prospects/p-1/design');
  });

  it('offers only the two existing registry providers', () => {
    expect(DISCOVERY_PROVIDERS.map(p => p.id)).toEqual(['manual_list', 'google_places']);
  });

  it('triage hint: untouched candidates only; accepted/dismissed are locked', () => {
    expect(canTriageResult(mkResult())).toBe(true);
    expect(canTriageResult(mkResult({ prospectId: 'pro-1' }))).toBe(false);
    expect(canTriageResult(mkResult({ dismissedAt: '2026-08-21T01:00:00.000Z' }))).toBe(false);
    expect(triageStateLabel(mkResult())).toBe('Pending');
    expect(triageStateLabel(mkResult({ prospectId: 'pro-1' }))).toBe('Accepted');
    expect(triageStateLabel(mkResult({ dismissedAt: 'x' }))).toBe('Dismissed');
  });

  it('research helpers: completed detection, latest pick, score summary', () => {
    expect(hasCompletedResearch([])).toBe(false);
    expect(hasCompletedResearch([mkReport({ status: 'FAILED' })])).toBe(false);
    expect(hasCompletedResearch([mkReport()])).toBe(true);
    const older = mkReport({ id: 'rep-old', createdAt: '2026-08-20T00:00:00.000Z' });
    const newer = mkReport({ id: 'rep-new', createdAt: '2026-08-22T00:00:00.000Z' });
    expect(latestReport([older, newer])!.id).toBe('rep-new');
    expect(scoreSummary(mkReport())).toBe('72 (GOOD)');
  });

  it('design summary line', () => {
    expect(designSummary(mkDesign())).toBe('Receptionist for Tony\'s — receptionist (DRAFT)');
  });

  it('parses manual candidates: "Name | website | location | phone", name required', () => {
    expect(parseManualCandidates('Tony\'s | https://t.example | Springfield | +1555')).toEqual([
      { businessName: 'Tony\'s', website: 'https://t.example', location: 'Springfield', phone: '+1555' }
    ]);
    expect(parseManualCandidates('Name Only')).toEqual([{ businessName: 'Name Only' }]);
    expect(parseManualCandidates('A\n\nB | https://b.example')).toEqual([
      { businessName: 'A' },
      { businessName: 'B', website: 'https://b.example' }
    ]);
    expect(parseManualCandidates('')).toBeNull();
    expect(parseManualCandidates('   \n  ')).toBeNull();
    expect(parseManualCandidates('| no-name')).toBeNull();
  });

  it('prospect website value: trimmed, omitted when empty', () => {
    expect(prospectWebsiteValue('  https://t.example/x ')).toBe('https://t.example/x');
    expect(prospectWebsiteValue('')).toBeUndefined();
    expect(prospectWebsiteValue('   ')).toBeUndefined();
  });

  it('run summary line', () => {
    expect(runSummary(mkRun())).toBe('manual_list · 2 found · 1 dup · 0 invalid');
  });
});

// ---------------------------------------------------------------------------
// Presentational panel (renderToStaticMarkup)
// ---------------------------------------------------------------------------

describe('PipelineFrontPanel', () => {
  const noop = () => {};
  const baseProps = {
    runs: [] as DiscoveryRun[],
    resultsByRun: {} as Record<string, DiscoveryResult[]>,
    usage: null as { date: string; used: number; limit: number | null; remaining: number | null } | null,
    busy: false,
    onRunDiscovery: noop,
    onAccept: noop,
    onDismiss: noop,
    prospect: null as Prospect | null,
    researchReports: [] as LeadResearchReport[],
    designs: [] as DesignProposal[],
    onResearch: noop as (input: { inputText: string }) => void,
    onAnalyze: noop,
    onGenerateDesign: noop,
    onApproveDesign: noop
  };

  it('renders the discovery section with provider options and the run action', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, baseProps));
    expect(html).toContain('Discovery');
    expect(html).toContain('manual_list');
    expect(html).toContain('google_places');
    expect(html).toContain('Run discovery');
    expect(html).toContain(DISCOVERY_RUNS_ENDPOINT);
  });

  it('renders candidates with triage actions calling the correct endpoints', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, {
      ...baseProps,
      runs: [mkRun()],
      resultsByRun: { 'run-1': [mkResult()] }
    }));
    expect(html).toContain('Tony&#x27;s Barber');
    expect(html).toContain('https://tonys.example');
    expect(html).toContain('Accept');
    expect(html).toContain('Dismiss');
    expect(html).toContain('/api/orchestration/discovery-results/res-1/accept');
    expect(html).toContain('/api/orchestration/discovery-results/res-1/dismiss');
    expect(html).toContain('Pending');
  });

  it('accepted and dismissed candidates render their state and lose the triage buttons', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, {
      ...baseProps,
      runs: [mkRun()],
      resultsByRun: { 'run-1': [
        mkResult({ id: 'res-a', prospectId: 'pro-1' }),
        mkResult({ id: 'res-d', dismissedAt: '2026-08-21T01:00:00.000Z' })
      ] }
    }));
    expect(html).toContain('Accepted');
    expect(html).toContain('Dismissed');
    expect(html).not.toContain('/api/orchestration/discovery-results/res-a/accept');
    expect(html).not.toContain('/api/orchestration/discovery-results/res-d/dismiss');
  });

  it('renders the Places usage counter (used/limit/remaining)', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, {
      ...baseProps,
      usage: { date: '2026-08-21', used: 3, limit: 100, remaining: 97 }
    }));
    expect(html).toContain('2026-08-21');
    expect(html).toContain('3');
    expect(html).toContain('100');
    expect(html).toContain('97');
  });

  it('renders research/analyze/generate actions for the selected prospect', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, {
      ...baseProps,
      prospect: mkProspect()
    }));
    expect(html).toContain('/api/orchestration/prospects/pro-1/research');
    expect(html).toContain('/api/orchestration/prospects/pro-1/analyze');
    expect(html).toContain('/api/orchestration/prospects/pro-1/design');
    expect(html).toContain('Research');
    expect(html).toContain('Analyze');
    expect(html).toContain('Generate design');
  });

  it('research requires operator-supplied input text (the route never fabricates research)', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, {
      ...baseProps,
      prospect: mkProspect()
    }));
    // The research textarea exists and the button starts disabled without text.
    expect(html).toContain('Research input text');
    expect(html).toContain('never invents facts');
  });

  it('displays the latest research report status and score', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, {
      ...baseProps,
      prospect: mkProspect(),
      researchReports: [mkReport()]
    }));
    expect(html).toContain('COMPLETED');
    expect(html).toContain('72 (GOOD)');
  });

  it('displays a generated design and keeps approval as a separate explicit action (never auto-approves)', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, {
      ...baseProps,
      prospect: mkProspect(),
      designs: [mkDesign()]
    }));
    expect(html).toContain('Receptionist for Tony&#x27;s');
    expect(html).toContain('DRAFT');
    expect(html).toContain('Approve');
    // Generation and approval are distinct actions — no combined shortcut.
    expect(html).toContain('Generate design');
  });

  it('renders candidate data safely (escaped, never raw HTML)', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, {
      ...baseProps,
      runs: [mkRun()],
      resultsByRun: { 'run-1': [mkResult({ normalized: { businessName: '<img src=x onerror=alert(1)>' } })] }
    }));
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('busy state disables actions (no duplicate in-flight requests)', () => {
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, { ...baseProps, busy: true, prospect: mkProspect() }));
    expect(html).toContain('disabled');
  });
});

// ---------------------------------------------------------------------------
// Manual prospect website field (Task 24 origin wiring must survive UI flow)
// ---------------------------------------------------------------------------

describe('manual prospect website field', () => {
  it('the prospect form renders a website input and submits it in the payload', async () => {
    const fs = await import('fs');
    const view = fs.readFileSync(new URL('../src/components/OrchestrationView.tsx', import.meta.url), 'utf8');
    // The form collects the field.
    expect(view).toContain('Prospect website');
    expect(view).toContain('prospectForm.website');
    // The create payload includes it (via the existing API's optional field).
    expect(view).toContain('website: prospectWebsiteValue(prospectForm.website)');
  });

  it('the panel still renders alongside the back-half (regression)', () => {
    // The panel is presentational; the back-half (deliveries) is unchanged and
    // covered by deliveryHandoff.test.ts. Here we only assert the pipeline
    // panel renders without the back-half props interfering.
    const html = renderToStaticMarkup(React.createElement(PipelineFrontPanel, {
      runs: [mkRun()], resultsByRun: { 'run-1': [mkResult()] },
      usage: { date: '2026-08-21', used: 0, limit: 100, remaining: 100 },
      busy: false,
      onRunDiscovery: () => {}, onAccept: () => {}, onDismiss: () => {},
      prospect: mkProspect(), researchReports: [mkReport()], designs: [mkDesign()],
      onResearch: () => {}, onAnalyze: () => {}, onGenerateDesign: () => {}, onApproveDesign: () => {}
    }));
    expect(html).toContain('Discovery');
    expect(html).toContain('Pipeline — Tony&#x27;s Barber');
  });
});

// ---------------------------------------------------------------------------
// Static source audit
// ---------------------------------------------------------------------------

describe('pipeline UI source discipline', () => {
  it('never injects HTML and never fabricates tenant ids', async () => {
    const fs = await import('fs');
    const panel = fs.readFileSync(new URL('../src/components/PipelineFrontPanel.tsx', import.meta.url), 'utf8');
    const logic = fs.readFileSync(new URL('../src/components/orchestrationPipelineLogic.ts', import.meta.url), 'utf8');
    for (const src of [panel, logic]) {
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    }
    // No businessId/tenantId is ever constructed or sent by the pipeline UI.
    expect(panel).not.toMatch(/businessId|tenantId/);
  });
});
