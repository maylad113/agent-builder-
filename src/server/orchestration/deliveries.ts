import { db } from '../db';
import { Delivery, Acceptance, FactoryJob, Prospect, OnboardingArtifact, OnboardingChannel } from '../../types';
import { recordOrchestrationEvent } from '../telemetry';
import { platformPublicOrigin, normalizeWidgetOriginList } from '../widgetSecurity';

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

// ---------------------------------------------------------------------------
// Delivery onboarding artifact (Phase C / Task 19)
// ---------------------------------------------------------------------------

/**
 * Assemble the deterministic, LLM-free customer onboarding artifact for a
 * delivery. PURE READ of persisted platform state (delivery + business +
 * agent + channels + acceptance) — repeated returns are equivalent, nothing
 * is created or mutated, and no customer contact occurs. The embed snippet
 * interpolates ONLY the platform's public origin (PLATFORM_PUBLIC_URL,
 * localhost fallback in dev) and the tenant business id (the existing public
 * widget identifier, allow-listed id-shaped) into the platform-controlled
 * widget.js template — an ABSOLUTE URL, because a relative one would resolve
 * against the customer's own domain. Other channels are honestly NOT
 * configured with no snippet. No secrets/credentials/keys ever appear.
 */
export async function buildOnboardingArtifact(deliveryId: string): Promise<OnboardingArtifact> {
  const delivery = await db.deliveries.find(d => d.id === deliveryId);
  if (!delivery) throw new Error('Delivery not found.');
  const business = await db.businesses.find(b => b.id === delivery.businessId);
  const agent = await db.agents.find(a => a.id === delivery.agentId);
  const tenantChannels = await db.channels.filter(c => c.businessId === delivery.businessId);
  const acceptance = await db.acceptances.find(a => a.deliveryId === delivery.id);
  const widgetOrigin = platformPublicOrigin();
  const allowedOrigins = normalizeWidgetOriginList(business?.allowedWidgetOrigins);

  const channels: OnboardingChannel[] = tenantChannels
    .map(c => {
      if (c.type === 'web_chat' && c.status === 'connected') {
        return {
          type: 'web_chat',
          status: c.status,
          note: 'Website chat widget is available.',
          embedSnippet: `<script src="${widgetOrigin}/widget.js" data-business-id="${business?.id}"></script>`,
          allowedOrigins
        };
      }
      return {
        type: c.type,
        status: c.status === 'connected' ? 'connected' : (c.status || 'not_configured'),
        note: c.status === 'connected' ? c.details : 'Not configured — no action has been taken on this channel.'
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type));

  const web = channels.find(c => c.type === 'web_chat');
  const notConfigured = channels.filter(c => c.status !== 'connected').map(c => c.type);
  const capabilities = (agent?.structuredConfig?.goals || []).filter(g => typeof g === 'string' && g.trim()).slice(0, 8);

  const instructions: string[] = [
    `Your AI agent "${agent?.name}" is ${agent?.status === 'ACTIVE' ? 'live and ready to serve customers.' : `currently ${agent?.status?.toLowerCase()}.`}`,
    `It was built for ${business?.name}. Current delivery status: ${delivery.status}.`
  ];
  if (agent?.structuredConfig?.escalationRules?.length) {
    instructions.push('When the agent is unsure, it escalates to a human handoff.');
  }
  if (web?.embedSnippet) {
    instructions.push('To add the website chat widget to your site, paste the embed snippet shown under the web_chat channel into your website HTML.');
    if (web.allowedOrigins && web.allowedOrigins.length > 0) {
      instructions.push(`The widget is allow-listed for these website origins: ${web.allowedOrigins.join(', ')}. Embed it only on those sites.`);
    } else {
      instructions.push('No website origin is allow-listed yet — the widget will be blocked until your website origin is configured.');
    }
  } else {
    instructions.push('The website chat widget is not configured yet — configure web_chat to enable customer chat on your site.');
  }
  if (notConfigured.length > 0) {
    instructions.push(`Not configured yet: ${notConfigured.join(', ')}. Contact your platform operator to enable additional channels.`);
  }
  if (acceptance) {
    instructions.push(`Delivery was accepted by ${acceptance.acceptedBy} on ${acceptance.acceptedAt}.`);
  } else {
    instructions.push('This delivery has not been accepted yet. Use the existing acceptance workflow when you are ready to confirm receipt.');
  }

  return {
    deliveryId: delivery.id,
    deliveryStatus: delivery.status,
    deliveryMethod: delivery.deliveryMethod,
    deliveredAt: delivery.deliveredAt,
    business: { id: delivery.businessId, name: business?.name || 'Unknown business' },
    agent: {
      id: delivery.agentId,
      name: agent?.name || 'Unknown agent',
      status: agent?.status || 'DRAFT',
      capabilities
    },
    channels,
    ...(acceptance ? { acceptance: { acceptedBy: acceptance.acceptedBy, acceptedAt: acceptance.acceptedAt } } : {}),
    instructions
  };
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
