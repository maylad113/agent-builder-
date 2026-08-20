import { db } from '../db';
import { DiscoveryResult, Prospect } from '../../types';
import { createProspect, getProspect } from './prospects';
import {
  normalizeInstagramHandle,
  normalizeDomain,
  normalizePhone
} from './discoveryProviders';
import { recordOrchestrationEvent } from '../telemetry';
import { safeError } from '../logSanitizer';

/**
 * Discovery acceptance bridge (Phase C / Task 5).
 *
 * The controlled lifecycle transition discovery_result -> prospect.
 * Acceptance is a DATA transition only: it never triggers research, scoring,
 * design, factory, outreach, or any automation — the new prospect enters the
 * pipeline at status NEW and waits for the existing downstream workflow.
 *
 * Semantics:
 *  - Idempotent: re-accepting a linked result returns the same prospect.
 *    The partial UNIQUE index on prospects.discovery_result_id backstops
 *    concurrent acceptance (loser re-reads and returns the winner's prospect).
 *  - Deterministic association: a result with a strong identity key
 *    (instagram handle / domain / phone >= 7 digits) matching exactly one
 *    UNCONVERTED prospect associates with it instead of creating a duplicate.
 *    Name-only is never a merge key; >1 strong-key match is ambiguous and
 *    rejected (never guessed).
 *  - No verification upgrade: accepted data stays UNVERIFIED business data;
 *    the research layer owns fact verification.
 *  - Atomic: prospect create/link + result link happen in ONE transaction.
 */

export interface AcceptanceOutcome {
  prospect: Prospect;
  result: DiscoveryResult;
  /** A new prospect row was created. */
  created: boolean;
  /** The result was associated with a pre-existing prospect. */
  associated: boolean;
}

/** Strong deterministic identity keys of a candidate/prospect. */
function strongKeys(c: { instagramHandle?: string; website?: string; contactPhone?: string; phone?: string }): Set<string> {
  const keys = new Set<string>();
  const ig = normalizeInstagramHandle(c.instagramHandle || '');
  if (ig) keys.add(`ig:${ig}`);
  const dom = normalizeDomain(c.website || '');
  if (dom) keys.add(`dom:${dom}`);
  const tel = normalizePhone(c.contactPhone || c.phone || '');
  // Last 10 digits: deterministic country-code-insensitive identity.
  if (tel.length >= 7) keys.add(`tel:${tel.slice(-10)}`);
  return keys;
}

/** Find unconverted prospects sharing a strong identity key with the candidate. */
async function findIdentityMatches(candidate: DiscoveryResult['normalized']): Promise<Prospect[]> {
  const keys = strongKeys(candidate);
  if (keys.size === 0) return [];
  const prospects = await db.prospects.toJSON();
  const matches: Prospect[] = [];
  for (const p of prospects) {
    if (p.businessId) continue; // converted/tenant-owned — never relink
    if (p.discoveryResultId) continue; // already claimed by another result
    const pKeys = strongKeys(p);
    for (const k of keys) {
      if (pKeys.has(k)) {
        matches.push(p);
        break;
      }
    }
  }
  return matches;
}

async function readResult(id: string): Promise<DiscoveryResult | undefined> {
  return db.discoveryResults.find(r => r.id === id);
}

async function finishLinked(result: DiscoveryResult, prospect: Prospect, created: boolean, associated: boolean): Promise<AcceptanceOutcome> {
  return { prospect, result, created, associated };
}

/**
 * Accept a discovery result as a prospect. Owner-scope operation (routes gate
 * on PLATFORM_OWNER). Throws module-authored safe messages on validation
 * failure; never throws stack traces into responses.
 */
export async function acceptDiscoveryResult(resultId: string): Promise<AcceptanceOutcome> {
  if (!resultId || typeof resultId !== 'string') throw new Error('discovery result id is required.');

  const existing = await readResult(resultId);
  if (!existing) throw new Error('Discovery result not found.');
  if (existing.prospectId) {
    const prospect = await getProspect(existing.prospectId);
    if (prospect) return finishLinked(existing, prospect, false, false);
  }
  if (existing.dismissedAt) throw new Error('Discovery result is dismissed and not eligible for acceptance.');
  if (existing.sourceExpiresAt && existing.sourceExpiresAt <= new Date().toISOString()) {
    // Retention-restricted source content (e.g. Google non-ID Places data)
    // must not flow into a durable prospect after its retention window.
    throw new Error('Discovery result source data has expired and is not eligible for acceptance.');
  }
  if (!existing.normalized?.businessName) throw new Error('Discovery result has no usable business identity.');

  try {
    return await db.client.transaction(async () => {
      // Re-read inside the transaction: a concurrent acceptance may have
      // committed the link since the pre-check.
      const current = await readResult(resultId);
      if (!current) throw new Error('Discovery result not found.');
      if (current.prospectId) {
        const prospect = await getProspect(current.prospectId);
        if (prospect) return finishLinked(current, prospect, false, false);
      }

      const matches = await findIdentityMatches(current.normalized);
      if (matches.length > 1) {
        throw new Error('Ambiguous identity: multiple existing prospects share a strong identity key.');
      }

      let prospect: Prospect;
      let created = false;
      let associated = false;
      if (matches.length === 1) {
        prospect = matches[0];
        associated = true;
        const now = new Date().toISOString();
        prospect = { ...prospect, discoveryResultId: resultId, updatedAt: now };
        await db.prospects.update(prospect);
      } else {
        prospect = await createProspect({
          businessName: current.normalized.businessName,
          contactPhone: current.normalized.phone,
          website: current.normalized.website,
          instagramHandle: current.normalized.instagramHandle,
          location: current.normalized.location,
          notes: current.normalized.notes
        }, { discoveryResultId: resultId });
        created = true;
      }

      await db.discoveryResults.update({ ...current, prospectId: prospect.id });
      await recordOrchestrationEvent({
        eventType: 'DISCOVERY_ACCEPTED',
        prospectId: prospect.id,
        summary: created
          ? 'Discovery result accepted: prospect created'
          : 'Discovery result accepted: associated with existing prospect',
        metadata: { discoveryRunId: current.runId }
      });
      const linked = { ...current, prospectId: prospect.id };
      return finishLinked(linked, prospect, created, associated);
    });
  } catch (e: any) {
    // UNIQUE backstop: the losing side of a concurrent acceptance re-reads the
    // committed link and returns the winner's prospect (idempotent).
    safeError('[orchestration] acceptance raced or failed:', e?.message || e);
    if (e?.message?.includes('Ambiguous') || e?.message?.includes('not found')) throw e;
    const raced = await readResult(resultId);
    if (raced?.prospectId) {
      const prospect = await getProspect(raced.prospectId);
      if (prospect) return finishLinked(raced, prospect, false, false);
    }
    throw e;
  }
}
