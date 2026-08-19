import { db } from '../db';
import { Delivery, Acceptance, FactoryJob, Prospect } from '../../types';
import { recordOrchestrationEvent } from '../telemetry';

/**
 * Deliveries + acceptances. A delivery record is created exactly once — by
 * the factory submitter on successful activation. Acceptance is a route-local
 * mutation: it verifies the delivery exists, verifies the business
 * relationship (prospect.businessId must equal delivery.businessId when the
 * prospect has converted), and creates the acceptance row (UNIQUE on
 * deliveryId — duplicates are rejected deterministically).
 */

const MAX_METHOD_LEN = 100;
const MAX_ACCEPTED_BY_LEN = 200;

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanStr(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Called by the factory submitter after ACTIVATING completes. */
export async function createDelivery(prospect: Prospect, job: FactoryJob): Promise<Delivery> {
  if (!job.businessId || !job.agentId) {
    throw new Error('Delivery requires a completed factory job with business and agent.');
  }
  const now = new Date().toISOString();
  const delivery: Delivery = {
    id: genId('del'),
    prospectId: prospect.id,
    businessId: job.businessId,
    agentId: job.agentId,
    status: 'DELIVERED',
    deliveryMethod: 'manual',
    deliveryPayload: {
      note: 'Agent activated and ready for handover to the business owner.',
      agentId: job.agentId,
      businessId: job.businessId
    },
    deliveredAt: now,
    createdAt: now,
    updatedAt: now
  };
  await db.deliveries.push(delivery);
  await recordOrchestrationEvent({
    eventType: 'AGENT_DELIVERED',
    prospectId: prospect.id,
    businessId: delivery.businessId,
    agentId: delivery.agentId,
    metadata: { deliveryId: delivery.id, jobId: job.id },
    summary: 'Agent delivered (activation complete)'
  });
  return delivery;
}

export async function getDelivery(id: string): Promise<Delivery | undefined> {
  return db.deliveries.find(d => d.id === id);
}

export async function listDeliveries(): Promise<Delivery[]> {
  const all = await db.deliveries.toJSON();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Accept a delivery. Throws a client-safe Error when the delivery does not
 * exist, violates the business relationship, or was already accepted. On
 * success returns the created Acceptance (and marks the delivery ACCEPTED).
 */
export async function acceptDelivery(
  prospect: Prospect | undefined,
  delivery: Delivery | undefined,
  input: { acceptedBy?: unknown; acceptanceMethod?: unknown; metadata?: unknown }
): Promise<Acceptance> {
  if (!delivery) throw new Error('Delivery not found.');
  // Business relationship: a converted prospect must match the delivery tenant.
  if (prospect && prospect.businessId && prospect.businessId !== delivery.businessId) {
    throw new Error('Delivery does not belong to this prospect’s business.');
  }
  if (delivery.status === 'ACCEPTED') {
    throw new Error('Delivery has already been accepted.');
  }
  const acceptedBy = cleanStr(input.acceptedBy, MAX_ACCEPTED_BY_LEN);
  if (!acceptedBy) throw new Error('acceptedBy is required.');
  const now = new Date().toISOString();
  const acceptance: Acceptance = {
    id: genId('acc'),
    deliveryId: delivery.id,
    businessId: delivery.businessId,
    acceptedBy,
    acceptanceMethod: cleanStr(input.acceptanceMethod, MAX_METHOD_LEN),
    acceptedAt: now,
    metadata: (input.metadata && typeof input.metadata === 'object') ? input.metadata as Record<string, any> : undefined,
    createdAt: now
  };
  try {
    await db.acceptances.push(acceptance);
  } catch (e: any) {
    // UNIQUE(delivery_id) backstop — concurrent/duplicate acceptance is rejected.
    const existing = await db.acceptances.find(a => a.deliveryId === delivery.id);
    if (existing) throw new Error('Delivery has already been accepted.');
    throw new Error('Acceptance could not be recorded.');
  }
  delivery.status = 'ACCEPTED';
  delivery.updatedAt = now;
  await db.deliveries.update(delivery);

  await recordOrchestrationEvent({
    eventType: 'DELIVERY_ACCEPTED',
    prospectId: delivery.prospectId,
    businessId: delivery.businessId,
    agentId: delivery.agentId,
    metadata: { deliveryId: delivery.id, acceptanceId: acceptance.id },
    summary: 'Delivery accepted by business owner'
  });
  return acceptance;
}
