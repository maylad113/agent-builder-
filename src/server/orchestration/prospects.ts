import { db } from '../db';
import { Prospect, ProspectStatus } from '../../types';
import { recordOrchestrationEvent } from '../telemetry';

/**
 * Prospect pipeline (manual MVP entry). A prospect is platform-owned until
 * conversion: the only tenant link is prospect.businessId, set by the factory
 * submitter when the tenant is created. All transitions are validated against
 * the explicit map below.
 */

export const PROSPECT_TRANSITIONS: Record<ProspectStatus, ProspectStatus[]> = {
  NEW: ['DESIGN_PROPOSED', 'REJECTED'],
  DESIGN_PROPOSED: ['APPROVED', 'REJECTED'],
  APPROVED: ['IN_FACTORY', 'REJECTED'],
  IN_FACTORY: ['CONVERTED', 'REJECTED'],
  CONVERTED: [],
  REJECTED: []
};

const MAX_FIELD_LEN = 200;
const MAX_NOTES_LEN = 2000;

function genId(): string {
  return `pro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanStr(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Create a prospect. Only allow-listed fields are accepted (the body may
 *  carry additional junk keys; they are dropped before persistence). */
export async function createProspect(input: {
  businessName?: unknown;
  contactName?: unknown;
  contactEmail?: unknown;
  contactPhone?: unknown;
  website?: unknown;
  instagramHandle?: unknown;
  location?: unknown;
  notes?: unknown;
}): Promise<Prospect> {
  const businessName = cleanStr(input.businessName, MAX_FIELD_LEN);
  if (!businessName) throw new Error('businessName is required.');
  const now = new Date().toISOString();
  const prospect: Prospect = {
    id: genId(),
    businessName,
    contactName: cleanStr(input.contactName, MAX_FIELD_LEN),
    contactEmail: cleanStr(input.contactEmail, MAX_FIELD_LEN),
    contactPhone: cleanStr(input.contactPhone, MAX_FIELD_LEN),
    website: cleanStr(input.website, MAX_FIELD_LEN),
    instagramHandle: cleanStr(input.instagramHandle, MAX_FIELD_LEN),
    location: cleanStr(input.location, MAX_FIELD_LEN),
    notes: cleanStr(input.notes, MAX_NOTES_LEN),
    status: 'NEW',
    createdAt: now,
    updatedAt: now
  };
  await db.prospects.push(prospect);
  await recordOrchestrationEvent({
    eventType: 'PROSPECT_CREATED',
    prospectId: prospect.id,
    summary: `Prospect created: ${prospect.businessName}`
  });
  return prospect;
}

export async function getProspect(id: string): Promise<Prospect | undefined> {
  return db.prospects.find(p => p.id === id);
}

export async function listProspects(): Promise<Prospect[]> {
  const all = await db.prospects.toJSON();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Apply an allow-listed patch and/or a status transition. Status goes
 *  through the transition map — illegal transitions throw. */
export async function updateProspect(
  prospect: Prospect,
  patch: {
    businessName?: unknown;
    contactName?: unknown;
    contactEmail?: unknown;
    contactPhone?: unknown;
    website?: unknown;
    instagramHandle?: unknown;
    location?: unknown;
    notes?: unknown;
    status?: unknown;
  }
): Promise<Prospect> {
  if (patch.businessName !== undefined) {
    const v = cleanStr(patch.businessName, MAX_FIELD_LEN);
    if (!v) throw new Error('businessName cannot be empty.');
    prospect.businessName = v;
  }
  if (patch.contactName !== undefined) prospect.contactName = cleanStr(patch.contactName, MAX_FIELD_LEN);
  if (patch.contactEmail !== undefined) prospect.contactEmail = cleanStr(patch.contactEmail, MAX_FIELD_LEN);
  if (patch.contactPhone !== undefined) prospect.contactPhone = cleanStr(patch.contactPhone, MAX_FIELD_LEN);
  if (patch.website !== undefined) prospect.website = cleanStr(patch.website, MAX_FIELD_LEN);
  if (patch.instagramHandle !== undefined) prospect.instagramHandle = cleanStr(patch.instagramHandle, MAX_FIELD_LEN);
  if (patch.location !== undefined) prospect.location = cleanStr(patch.location, MAX_FIELD_LEN);
  if (patch.notes !== undefined) prospect.notes = cleanStr(patch.notes, MAX_NOTES_LEN);

  if (patch.status !== undefined && patch.status !== prospect.status) {
    const next = patch.status as ProspectStatus;
    const allowed = PROSPECT_TRANSITIONS[prospect.status];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid prospect transition: ${prospect.status} -> ${next}. Allowed: ${[...allowed, prospect.status].join(', ')} or keep current.`);
    }
    prospect.status = next;
  }
  prospect.updatedAt = new Date().toISOString();
  await db.prospects.update(prospect);
  return prospect;
}

/** Internal status setter used by the design/factory layers (skips the public
 *  transition map noise — still validated). Callers: design creation moves
 *  NEW -> DESIGN_PROPOSED; approval moves DESIGN_PROPOSED -> APPROVED;
 *  submission moves APPROVED -> IN_FACTORY; delivery moves IN_FACTORY ->
 *  CONVERTED. */
export async function setProspectStatus(prospect: Prospect, next: ProspectStatus): Promise<Prospect> {
  if (next !== prospect.status) {
    if (!PROSPECT_TRANSITIONS[prospect.status].includes(next)) {
      throw new Error(`Invalid prospect transition: ${prospect.status} -> ${next}.`);
    }
    prospect.status = next;
    prospect.updatedAt = new Date().toISOString();
    await db.prospects.update(prospect);
  }
  return prospect;
}
