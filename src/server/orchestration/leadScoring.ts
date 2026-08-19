/**
 * Deterministic lead qualification scorer (Phase C / Task 1).
 *
 * Consumes a STRUCTURED research signal set (as later produced by the Lead
 * Agent extraction layer) and returns a bounded integer score, a band, and
 * ordered human-readable reasons. This module is the spine of the
 * qualification decision: pure code, fully deterministic, and independent of
 * any LLM provider.
 *
 * Rules (mirrors the readiness-check style):
 *  - VERIFIED signals carry full weight; UNVERIFIED reduced weight;
 *    UNKNOWN/missing contribute zero (an extraction claim is never
 *    automatically true).
 *  - Component vocabularies are allow-listed; unrecognized keys are ignored
 *    and recorded as a reason (LLM output is data, never struct).
 *  - Verified disqualifiers cap the band at REVIEW regardless of score.
 *  - The final score is clamped to [0, MAX_SCORE]; NaN/Infinity/negatives
 *    are impossible.
 *  - The same input always yields byte-identical output; input is never
 *    mutated.
 *
 * NEVER: LLM calls, network, IO, DB, mutation, credentials.
 */

export type Verification = 'VERIFIED' | 'UNVERIFIED' | 'UNKNOWN';
export type AppointmentFit = 'STRONG' | 'PARTIAL' | 'NONE' | 'UNKNOWN';
export type ScoreBand = 'QUALIFY' | 'REVIEW' | 'REJECT';

export interface LeadSignalItem {
  key?: unknown;
  verification?: unknown;
}

export interface LeadChannelSignal {
  channel?: unknown;
  reachable?: unknown;
  verification?: unknown;
}

export interface LeadResearchInput {
  appointmentFit?: unknown;
  painSignals?: unknown;
  digitalGaps?: unknown;
  channels?: unknown;
  evidence?: unknown;
  disqualifiers?: unknown;
}

export interface LeadScoreComponent {
  key: 'appointmentFit' | 'pain' | 'digitalGaps' | 'channels' | 'evidence' | 'disqualifiers';
  label: string;
  /** Signed contribution (disqualifiers negative). */
  points: number;
  reason: string;
}

export interface LeadScoreResult {
  /** Bounded integer score in [0, MAX_SCORE]. */
  score: number;
  band: ScoreBand;
  components: LeadScoreComponent[];
  /** Ordered, deterministic human-readable reasons. */
  reasons: string[];
  /** Signal groups noted UNKNOWN/missing (audit visibility). */
  unknowns: string[];
}

export const MAX_SCORE = 100;
export const SCORE_BAND_THRESHOLDS = { QUALIFY: 70, REVIEW: 40 } as const;

// --- Bounded explicit weights (audit-signed) -------------------------------

const APPOINTMENT_FIT_WEIGHTS: Record<AppointmentFit, number> = {
  STRONG: 30,
  PARTIAL: 18,
  NONE: 0,
  UNKNOWN: 0
};

const PAIN_VERIFIED = 12;
const PAIN_UNVERIFIED = 6;
const PAIN_MAX = 30;

const GAP_VERIFIED = 8;
const GAP_UNVERIFIED = 4;
const GAP_MAX = 15;

const CHANNEL_VERIFIED = 5;
const CHANNEL_UNVERIFIED = 2;
const CHANNEL_MAX = 10;

const EVIDENCE_PER = 5;
const EVIDENCE_MAX = 15;

const DISQUALIFIER_VERIFIED = -25;
const DISQUALIFIER_UNVERIFIED = -10;

const PAIN_VOCABULARY = new Set([
  'missed_calls', 'no_online_booking', 'slow_response', 'staff_overwhelmed', 'no_after_hours'
]);
const GAP_VOCABULARY = new Set(['no_website', 'no_instagram', 'no_online_booking', 'stale_profile']);
const CHANNEL_VOCABULARY = new Set(['website', 'instagram', 'phone']);
const DISQUALIFIER_VOCABULARY = new Set([
  'has_ai_receptionist', 'business_closed', 'franchise_chain', 'already_partnered'
]);

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function cleanSignal(v: unknown): { key: string; verification: Verification } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as LeadSignalItem;
  if (typeof o.key !== 'string') return undefined;
  const verification: Verification =
    o.verification === 'VERIFIED' || o.verification === 'UNVERIFIED' ? o.verification : 'UNKNOWN';
  return { key: o.key, verification };
}

function weightOf(verifiedW: number, unverifiedW: number, verification: Verification): number {
  if (verification === 'VERIFIED') return verifiedW;
  if (verification === 'UNVERIFIED') return unverifiedW;
  return 0;
}

function clampInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(n);
  return Math.max(0, Math.min(MAX_SCORE, r));
}

/**
 * Score a structured research input. Never throws; malformed input scores 0
 * with an explicit manual-review reason. Input is never mutated.
 */
export function computeLeadScore(input: LeadResearchInput | undefined | null): LeadScoreResult {
  const unknowns: string[] = [];
  const reasons: string[] = [];
  const ignored: string[] = [];
  const o = (input && typeof input === 'object' ? input : {}) as LeadResearchInput;

  // --- appointmentFit ------------------------------------------------------
  const fitRaw = typeof o.appointmentFit === 'string' ? o.appointmentFit : 'UNKNOWN';
  const fit: AppointmentFit =
    fitRaw === 'STRONG' || fitRaw === 'PARTIAL' || fitRaw === 'NONE' ? (fitRaw as AppointmentFit) : 'UNKNOWN';
  const fitPoints = APPOINTMENT_FIT_WEIGHTS[fit];
  if (fit === 'UNKNOWN') unknowns.push('appointmentFit');
  const fitReason =
    fit === 'UNKNOWN'
      ? 'appointmentFit: unknown — no credit.'
      : `appointmentFit: ${fit.toLowerCase()} fit (+${fitPoints}).`;

  // --- pain / digitalGaps (verification-weighed, vocabulary-allow-listed) --
  const scoredGroup = (
    list: LeadSignalItem[] | unknown,
    vocab: Set<string>,
    vW: number, uW: number, cap: number
  ): { points: number; unknown: boolean; notes: string[] } => {
    let total = 0;
    const notes: string[] = [];
    let hasUsableKey = false; // verified or unverified — UNKNOWN never counts as usable
    for (const raw of asList(list)) {
      const s = cleanSignal(raw);
      if (!s) continue;
      if (!vocab.has(s.key)) {
        ignored.push(s.key);
        notes.push(`"${s.key}" unrecognized — ignored.`);
        continue;
      }
      if (s.verification !== 'UNKNOWN') hasUsableKey = true;
      total += weightOf(vW, uW, s.verification);
      if (s.verification === 'UNKNOWN') notes.push(`"${s.key}" unknown — no credit.`);
    }
    return { points: Math.min(cap, total), unknown: !hasUsableKey, notes };
  };

  const pain = scoredGroup(o.painSignals, PAIN_VOCABULARY, PAIN_VERIFIED, PAIN_UNVERIFIED, PAIN_MAX);
  if (pain.unknown) unknowns.push('painSignals');
  const gap = scoredGroup(o.digitalGaps, GAP_VOCABULARY, GAP_VERIFIED, GAP_UNVERIFIED, GAP_MAX);
  if (gap.unknown) unknowns.push('digitalGaps');

  // --- channels ------------------------------------------------------------
  let channelPoints = 0;
  const channelNotes: string[] = [];
  let channelKnown = false;
  for (const raw of asList(o.channels)) {
    if (!raw || typeof raw !== 'object') continue;
    const ch = raw as LeadChannelSignal;
    if (typeof ch.channel !== 'string') continue;
    if (!CHANNEL_VOCABULARY.has(ch.channel)) {
      ignored.push(String(ch.channel));
      channelNotes.push(`"${String(ch.channel)}" unrecognized — ignored.`);
      continue;
    }
    if (ch.reachable !== true) continue; // unreachable channels earn nothing.
    channelKnown = true;
    const verification: Verification =
      ch.verification === 'VERIFIED' || ch.verification === 'UNVERIFIED' ? ch.verification : 'UNKNOWN';
    channelPoints += weightOf(CHANNEL_VERIFIED, CHANNEL_UNVERIFIED, verification);
    if (verification === 'UNKNOWN') channelNotes.push(`"${String(ch.channel)}" unknown — no credit.`);
  }
  const channelsPoints = Math.min(CHANNEL_MAX, channelPoints);
  if (!channelKnown) unknowns.push('channels');

  // --- evidence ------------------------------------------------------------
  let citations = 0;
  for (const raw of asList(o.evidence)) {
    if (raw && typeof raw === 'object' && (raw as any).url !== undefined) citations += 1;
  }
  const evidencePoints = Math.min(EVIDENCE_MAX, EVIDENCE_PER * citations);
  if (citations === 0) unknowns.push('evidence');

  // --- disqualifiers -------------------------------------------------------
  let disqPoints = 0;
  const disqNotes: string[] = [];
  let verifiedDisq = false;
  for (const raw of asList(o.disqualifiers)) {
    const s = cleanSignal(raw);
    if (!s) continue;
    if (!DISQUALIFIER_VOCABULARY.has(s.key)) continue; // unknown disqualifiers earn nothing
    if (s.verification === 'UNKNOWN') continue;
    const w = weightOf(DISQUALIFIER_VERIFIED, DISQUALIFIER_UNVERIFIED, s.verification);
    disqPoints += w;
    disqNotes.push(`"${s.key}" (${s.verification.toLowerCase()}) detractor ${w}.`);
    if (s.verification === 'VERIFIED') verifiedDisq = true;
  }

  // --- assemble (fixed component order = deterministic output) -------------
  const components: LeadScoreComponent[] = [
    { key: 'appointmentFit', label: 'Appointment fit', points: fitPoints, reason: fitReason },
    { key: 'pain', label: 'Pain signals', points: pain.points, reason: `pain: ${pain.points} point(s). ${pain.notes.join(' ')}`.trim() },
    { key: 'digitalGaps', label: 'Digital gaps', points: gap.points, reason: `digitalGaps: ${gap.points} point(s). ${gap.notes.join(' ')}`.trim() },
    { key: 'channels', label: 'Reachable channels', points: channelsPoints, reason: `channels: ${channelsPoints} point(s). ${channelNotes.join(' ')}`.trim() },
    { key: 'evidence', label: 'Evidence citations', points: evidencePoints, reason: `evidence: ${citations} citation(s) (+${evidencePoints}).` },
    {
      key: 'disqualifiers',
      label: 'Disqualifiers',
      points: disqPoints,
      reason: disqNotes.length > 0 ? `disqualifiers: ${disqNotes.join(' ')}` : 'disqualifiers: none.'
    }
  ];

  const raw = fitPoints + pain.points + gap.points + channelsPoints + evidencePoints + disqPoints;
  const total = clampInt(raw);

  if (total === 0) reasons.push('No usable signals — manual review required.');
  for (const c of components) reasons.push(c.reason);

  let band: ScoreBand =
    total >= SCORE_BAND_THRESHOLDS.QUALIFY ? 'QUALIFY' :
    total >= SCORE_BAND_THRESHOLDS.REVIEW ? 'REVIEW' : 'REJECT';
  if (band === 'QUALIFY' && verifiedDisq) {
    band = 'REVIEW';
    reasons.push('Verified detractor present — band capped at REVIEW pending human check.');
  }
  if (unknowns.length > 0) reasons.push(`Unknowns: ${unknowns.join(', ')}.`);

  return { score: total, band, components, reasons, unknowns };
}
