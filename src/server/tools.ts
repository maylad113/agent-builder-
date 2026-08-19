import { Type, FunctionDeclaration } from '@google/genai';
import { db } from './db';
import {
  timeToMinutes, addMinutes, intervalsOverlap, isFail,
  dayOfWeekForDate, isHoliday, validateSlot, generateAvailableSlots, findEligibleStaff
} from './appointmentEngine';

/** Names of every tool the engine can expose to an agent. Tests and the
 *  runtime use this to construct a "permit all" context when exercising the
 *  tool engine directly (production derives the enabled subset per-agent from
 *  the agent's configured `toolsEnabled`). */
export const ALL_TOOL_NAMES: string[] = [
  'check_business_hours', 'get_business_information', 'search_knowledge',
  'check_availability', 'book_appointment', 'cancel_appointment',
  'reschedule_appointment', 'search_products', 'create_order',
  'get_order_status', 'notify_business_owner', 'transfer_to_human',
];

export interface ToolContext {
  tenantId: string;
  conversationId?: string;
  channel?: string;
  /**
   * The exact set of tools enabled for the agent in scope. REQUIRED for any
   * agent-driven execution: when absent, executeAgentTool refuses to run ANY
   * tool (audit P1.1 — never default to permitting declared tools). The backend
   * enforces enablement even if the LLM (or a caller) requests a tool that was
   * not offered in the function declarations.
   */
  toolsEnabled?: string[];
  /** Tool names the agent is permitted to invoke. If provided, any tool not
   * in this set is rejected before execution — defense-in-depth against the
   * LLM hallucinating a tool call that was never declared to it. */
  allowedToolNames?: string[];
}

// ---------------------------------------------------------------------------
// Tool argument validation + bounding (audit P1.2).
// LLM-controlled arguments are NEVER trusted: each is coerced, length-bounded,
// and rejected when oversized BEFORE any database operation. This prevents a
// hallucinated megabyte-long "notes" field from blowing up a DB row or a
// malformed "customerPhone" from being stored as-is.
// ---------------------------------------------------------------------------

const ARG_LIMITS = {
  customerName: 200,
  customerPhone: 50,
  customerDetails: 500,
  notes: 2000,
  reason: 500,
  query: 500,
  topic: 100,
  day: 20,
  date: 20,
  startTime: 10,
  newDate: 20,
  newTime: 10,
  endTime: 10,
  appointmentId: 100,
  orderId: 100,
  serviceIdOrName: 200,
  serviceId: 100,
  productId: 100,
} as const;

/** Coerce to a bounded string, or undefined when absent. Throws a plain Error
 *  (caught by executeAgentTool's wrapper) when the value exceeds its limit. */
function boundedString(value: unknown, key: keyof typeof ARG_LIMITS): string | undefined {
  if (value == null) return undefined;
  const s = String(value);
  const limit = ARG_LIMITS[key];
  if (s.length > limit) {
    throw new Error(`Argument "${key}" exceeds the maximum length of ${limit} characters.`);
  }
  return s;
}

/** Validate a phone number: a bounded, trimmed string. The audit's P1.2 focus is
 *  bounding OVERSIZED LLM-controlled input (DoS / storage blowup) — a strict
 *  E.164 regex would reject legitimate partial/stub values customers may give.
 *  We bound the length and trim whitespace; further normalization happens later. */
function validPhone(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (s.length > ARG_LIMITS.customerPhone) {
    throw new Error(`Argument "customerPhone" exceeds the maximum length of ${ARG_LIMITS.customerPhone} characters.`);
  }
  return s || undefined;
}

/** Validate an integer quantity (positive, bounded). */
function validQuantity(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Quantity must be a positive integer.');
  }
  if (n > 1_000_000) {
    throw new Error('Quantity exceeds the maximum allowed (1,000,000).');
  }
  return n;
}

// Time helpers (timeToMinutes, addMinutes, intervalsOverlap, isFail, dayOfWeek,
// validateSlot, generateAvailableSlots) are imported from ./appointmentEngine
// — the single source of truth for the scheduling engine. See that module for
// the pure, unit-tested availability/overlap/notice logic.


// Gemini Function Declarations Schema for tool calling
export const agentToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'check_business_hours',
    description: 'Check official operating hours for the business for a specific day or all week.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        day: {
          type: Type.STRING,
          description: 'Day of week, e.g. monday, tuesday, etc. Omit for full week hours.'
        }
      }
    }
  },
  {
    name: 'get_business_information',
    description: 'Retrieve general business facts including location, description, policies, services catalog, and FAQs.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: {
          type: Type.STRING,
          description: 'Topic filter, e.g. "services", "pricing", "location", "faqs", "policies"'
        }
      }
    }
  },
  {
    name: 'search_knowledge',
    description: 'Search the business knowledge base (FAQs, policies, service catalog, documents) and return matching entries with title, type, content snippet and tags.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Search term, e.g. "pricing", "opening hours", "beard oil", "cancellation policy".'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'check_availability',
    description: 'Check available appointment time slots for a service on a given date.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: {
          type: Type.STRING,
          description: 'Date in YYYY-MM-DD format.'
        },
        serviceId: {
          type: Type.STRING,
          description: 'Service ID or service name being requested.'
        }
      },
      required: ['date']
    }
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment for a customer after confirming date, time, and service.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        customerName: { type: Type.STRING, description: 'Customer full name.' },
        customerPhone: { type: Type.STRING, description: 'Customer phone number.' },
        serviceIdOrName: { type: Type.STRING, description: 'Name or ID of service (e.g. Haircut, Beard trim).' },
        date: { type: Type.STRING, description: 'Date in YYYY-MM-DD format.' },
        startTime: { type: Type.STRING, description: 'Start time in HH:MM format (e.g. 14:00).' },
        notes: { type: Type.STRING, description: 'Special requests or preferences.' }
      },
      required: ['customerName', 'customerPhone', 'serviceIdOrName', 'date', 'startTime']
    }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing customer appointment.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        appointmentId: { type: Type.STRING, description: 'Appointment ID if known.' },
        customerPhone: { type: Type.STRING, description: 'Customer phone number.' }
      }
    }
  },
  {
    name: 'reschedule_appointment',
    description: 'Reschedule an existing appointment to a new date and time.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        appointmentId: { type: Type.STRING, description: 'Appointment ID.' },
        newDate: { type: Type.STRING, description: 'New date in YYYY-MM-DD.' },
        newTime: { type: Type.STRING, description: 'New time in HH:MM.' }
      },
      required: ['appointmentId', 'newDate', 'newTime']
    }
  },
  {
    name: 'search_products',
    description: 'Search available retail products, prices, and stock inventory.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search term e.g. "pomade", "beard oil", "shampoo"' }
      }
    }
  },
  {
    name: 'create_order',
    description: 'Create a retail product order for a customer.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        customerName: { type: Type.STRING, description: 'Customer name' },
        customerPhone: { type: Type.STRING, description: 'Customer phone number' },
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              productId: { type: Type.STRING, description: 'Product ID' },
              quantity: { type: Type.INTEGER, description: 'Quantity requested' }
            },
            required: ['productId', 'quantity']
          },
          description: 'List of products to order'
        }
      },
      required: ['customerName', 'customerPhone', 'items']
    }
  },
  {
    name: 'get_order_status',
    description: 'Check status of an order by order ID or phone number.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: { type: Type.STRING, description: 'Order ID' },
        customerPhone: { type: Type.STRING, description: 'Customer phone' }
      }
    }
  },
  {
    name: 'notify_business_owner',
    description: 'Send an urgent alert notification to the business owner.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: { type: Type.STRING, description: 'Reason for notification' },
        customerDetails: { type: Type.STRING, description: 'Customer name/phone/details' }
      },
      required: ['reason']
    }
  },
  {
    name: 'transfer_to_human',
    description: 'Transfer conversation to a human representative when customer requests or for complex/unresolved issues.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: { type: Type.STRING, description: 'Reason for transfer (e.g., requested human, complaint, unsupported request)' }
      },
      required: ['reason']
    }
  }
];

// Server Tool Execution Engine with Tenant Authorization and Rules Validation
export async function executeAgentTool(
  toolName: string,
  args: Record<string, any>,
  context: ToolContext
): Promise<{ success: boolean; data?: any; error?: string }> {
  const { tenantId, conversationId } = context;

  // Validate tenant exists
  const business = await db.businesses.find(b => b.id === tenantId);
  if (!business) {
    return { success: false, error: `Unauthorized tenant ID: ${tenantId}` };
  }

  // HARD tool enablement gate (audit P1.1 — never default to permitting).
  // Authorization context (`toolsEnabled`) is REQUIRED: when absent we refuse
  // to run ANY tool rather than implicitly trusting that a declared tool is
  // permitted. `toolsEnabled` is the agent's own configured set; `allowedToolNames`
  // is the defense-in-depth set the runtime derived from the declarations it
  // actually offered the model (so a hallucinated tool never declared is also
  // rejected). Enforced for EVERY tool below — never trust the LLM/frontend.
  if (!context.toolsEnabled || !Array.isArray(context.toolsEnabled) || context.toolsEnabled.length === 0) {
    return { success: false, error: `Tool ${toolName} is not authorized: no enabled-tools context was provided.` };
  }
  if (!context.toolsEnabled.includes(toolName)) {
    return { success: false, error: `Tool ${toolName} is not enabled for this agent (not permitted).` };
  }
  if (context.allowedToolNames && !context.allowedToolNames.includes(toolName)) {
    return { success: false, error: `Tool ${toolName} was not declared to the model (not permitted).` };
  }

  try {
    switch (toolName) {
      case 'check_business_hours': {
        const dayArg = boundedString(args.day, 'day')?.toLowerCase();
        if (dayArg) {
          const dayHours = business.hours.find(h => h.day.toLowerCase() === dayArg);
          if (dayHours) {
            return {
              success: true,
              data: {
                day: dayHours.day,
                isOpen: dayHours.isOpen,
                hours: dayHours.isOpen ? `${dayHours.openTime} - ${dayHours.closeTime}` : 'Closed'
              }
            };
          }
        }
        return {
          success: true,
          data: {
            businessName: business.name,
            timezone: business.timezone,
            hours: business.hours.map(h => ({
              day: h.day,
              status: h.isOpen ? `${h.openTime} - ${h.closeTime}` : 'Closed'
            }))
          }
        };
      }

      case 'get_business_information': {
        const topic = boundedString(args.topic, 'topic')?.toLowerCase();
        let result: any = {
          name: business.name,
          type: business.type,
          description: business.description,
          location: business.location,
          currency: business.currency,
          communicationStyle: business.communicationStyle
        };

        if (!topic || topic.includes('service') || topic.includes('price')) {
          result.services = business.services;
          result.pricingNotes = business.pricingNotes;
        }
        if (!topic || topic.includes('faq')) {
          result.faqs = business.faqs;
        }
        if (!topic || topic.includes('policy')) {
          result.policies = business.policies;
        }

        return { success: true, data: result };
      }

      case 'search_knowledge': {
        const rawQuery = boundedString(args.query, 'query')?.trim() || '';
        const q = rawQuery.toLowerCase();
        if (!q) {
          return { success: true, data: { query: rawQuery, count: 0, matches: [], message: 'No search query provided.' } };
        }

        // Tenant-scoped search over THIS business's knowledge chunks only
        // (title / tags / content — same approach as retrieveKnowledgeChunks).
        const chunks = await db.knowledgeChunks
          .filter(k => k.businessId === tenantId);
        const scored = chunks
          .map(k => {
            const titleMatch = k.title.toLowerCase().includes(q);
            const tagMatch = k.tags.some(t => q.includes(t.toLowerCase()));
            const contentMatch = k.content.toLowerCase().includes(q);
            const score = (titleMatch ? 3 : 0) + (tagMatch ? 2 : 0) + (contentMatch ? 1 : 0);
            return { k, score };
          })
          .filter(m => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        return {
          success: true,
          data: {
            query: rawQuery,
            count: scored.length,
            matches: scored.map(m => ({
              id: m.k.id,
              title: m.k.title,
              type: m.k.type,
              snippet: m.k.content.length > 300 ? `${m.k.content.slice(0, 300)}…` : m.k.content,
              tags: m.k.tags
            }))
          }
        };
      }

      case 'check_availability': {
        const date = boundedString(args.date, 'date');
        const serviceId = boundedString(args.serviceId, 'serviceId');
        const requestedDate = date || new Date().toISOString().split('T')[0];
        const dayName = dayOfWeekForDate(requestedDate, business.timezone);

        // Holiday / closed-day short-circuit (engine handles both).
        if (isHoliday(business, requestedDate)) {
          return {
            success: true,
            data: { date: requestedDate, dayOfWeek: dayName, isOpen: false,
              message: `The business is closed on ${requestedDate} (holiday).`, availableSlots: [] }
          };
        }
        const dayHours = business.hours.find(h => h.day === dayName);
        if (!dayHours || !dayHours.isOpen) {
          return {
            success: true,
            data: { date: requestedDate, dayOfWeek: dayName, isOpen: false,
              message: `The business is closed on ${dayName}s.`, availableSlots: [] }
          };
        }

        // Resolve the service (default to the first one if none given) so
        // slot generation accounts for its duration + buffer.
        const service = (serviceId ? business.services.find(s => s.id === serviceId) : undefined)
          || business.services[0];
        const existingApps = await db.appointments.filter(a => a.businessId === tenantId && a.date === requestedDate && a.status !== 'CANCELLED');
        const staff = await db.staffMembers.filter(s => s.businessId === tenantId);
        const availableSlots = service
          ? generateAvailableSlots(business, staff, service, existingApps, requestedDate)
          : [];

        return {
          success: true,
          data: {
            date: requestedDate,
            dayOfWeek: dayName,
            isOpen: true,
            openHours: `${dayHours.openTime} - ${dayHours.closeTime}`,
            totalBookingsToday: existingApps.length,
            availableSlots
          }
        };
      }

      case 'book_appointment': {
        const customerName = boundedString(args.customerName, 'customerName');
        const customerPhone = validPhone(args.customerPhone);
        const serviceIdOrName = boundedString(args.serviceIdOrName, 'serviceIdOrName');
        const date = boundedString(args.date, 'date');
        const startTime = boundedString(args.startTime, 'startTime');
        const notes = boundedString(args.notes, 'notes');

        if (!customerName || !customerPhone || !serviceIdOrName || !date || !startTime) {
          return { success: false, error: 'customerName, customerPhone, serviceIdOrName, date and startTime are required to book.' };
        }

        // Service resolution (NO fabrication: if no service matches, fail honestly).
        const service = business.services.find(s =>
          s.id === serviceIdOrName ||
          s.name.toLowerCase() === String(serviceIdOrName).toLowerCase() ||
          s.name.toLowerCase().includes(String(serviceIdOrName).toLowerCase())
        );
        if (!service) {
          return { success: false, error: `Service "${serviceIdOrName}" was not found. Available services: ${business.services.map(s => s.name).join(', ') || 'none'}.` };
        }

        // Slot validation via the engine: hours, holiday, min notice, max advance.
        const slotCheck = validateSlot(business, service, date, startTime);
        if (!slotCheck.ok) {
          return { success: false, error: slotCheck.error! };
        }
        const endTime = slotCheck.endTime!;
        const bufferAfter = Math.max(0, service.bufferMinutesAfter || 0);
        // For overlap detection we block the slot PLUS its trailing buffer so
        // the staff member has the configured turnaround time.
        const blockEnd = bufferAfter > 0 ? addMinutes(endTime, bufferAfter) : endTime;

        // TRANSACTIONAL booking with overlap prevention (incl. buffer). The
        // overlap check and the INSERT run inside one DB transaction so the
        // check-then-insert is atomic. On PostgreSQL this is a real SERIALIZABLE
        // transaction; on SQLite the better-sqlite3 handle serializes writes.
        const appointmentId = `app-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const customerId = `cust-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const nowIso = new Date().toISOString();

        const result = await db.client.transaction(async (): Promise<{ ok: true; appointment: any } | { ok: false; error: string }> => {
          // PostgreSQL-safe concurrency (audit P1.3): lock the parent business
          // row FIRST. The appointments FOR UPDATE below locks only rows that
          // already exist — when no appointments exist yet for this date it
          // locks nothing, and two concurrent first-bookings would both pass
          // the overlap check (empty-set race). Locking the always-present
          // business row serializes ALL booking transactions for the tenant,
          // so exactly one concurrent booking can succeed regardless of
          // pre-existing rows. SQLite strips FOR UPDATE and serializes writes
          // via the per-connection mutex, so this is a no-op there.
          await db.client.query(
            `SELECT id FROM businesses WHERE id = ? FOR UPDATE`,
            [tenantId]
          );
          // Then lock the existing non-cancelled appointments for this
          // tenant+date with SELECT ... FOR UPDATE before the overlap check.
          // On PostgreSQL the second concurrent booking waits for the first to
          // COMMIT, then sees the new row and correctly detects the overlap.
          const lockRows = await db.client.query(
            `SELECT id, service_id, start_time, end_time FROM appointments
             WHERE business_id = ? AND date = ? AND status != 'CANCELLED' FOR UPDATE`,
            [tenantId, date]
          );
          const overlapping = lockRows.rows.map((r: any) => ({
            id: r.id,
            serviceId: r.service_id ?? r.serviceId,
            startTime: r.start_time ?? r.startTime,
            endTime: r.end_time ?? r.endTime,
          }));
          for (const a of overlapping) {
            const existingService = business.services.find(s => s.id === a.serviceId);
            const existingBuffer = Math.max(0, existingService?.bufferMinutesAfter || 0);
            const aBlockEnd = existingBuffer > 0 ? addMinutes(a.endTime, existingBuffer) : a.endTime;
            if (intervalsOverlap(startTime, blockEnd, a.startTime, aBlockEnd)) {
              return { ok: false, error: `The time ${startTime}-${endTime} on ${date} overlaps an existing appointment (${a.startTime}-${a.endTime}). Please choose another slot using check_availability.` };
            }
          }

          // Assign an eligible staff member (engine honors staff hours, services,
          // timeOff). A business with staff members requires at least one to
          // cover the slot — fail honestly BEFORE creating the customer, so a
          // rejected booking leaves no orphan rows.
          const staffList = await db.staffMembers.filter(s => s.businessId === tenantId);
          const staff = findEligibleStaff(business, staffList, service, date, startTime, endTime);
          if (staffList.length > 0 && !staff) {
            return { ok: false, error: 'No staff member is available at that time. Please choose another slot using check_availability.' };
          }

          // Find or create the customer inside the transaction.
          let customer = await db.customers.find(c => c.businessId === tenantId && c.phone === customerPhone);
          if (!customer) {
            customer = { id: customerId, businessId: tenantId, name: customerName, phone: customerPhone, createdAt: nowIso };
            await db.customers.push(customer);
          }

          const newAppointment = {
            id: appointmentId,
            businessId: tenantId,
            serviceId: service.id,
            serviceName: service.name,
            staffMemberId: staff?.id,
            staffName: staff?.name,
            customerId: customer.id,
            customerName,
            customerPhone,
            date,
            startTime,
            endTime,
            status: 'CONFIRMED' as const,
            notes: notes || 'Booked via AI Assistant',
            createdAt: nowIso
          };
          await db.appointments.push(newAppointment);

          await db.auditLogs.push({
            id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            businessId: tenantId,
            action: 'APPOINTMENT_BOOKED',
            details: `Appointment #${newAppointment.id} booked for ${customerName} (${service.name} at ${startTime}-${endTime} on ${date})`,
            timestamp: nowIso
          });

          return { ok: true, appointment: newAppointment };
        });

        if (isFail(result)) {
          return { success: false, error: result.error };
        }
        const newAppointment = result.appointment;

        return {
          success: true,
          data: {
            appointmentId: newAppointment.id,
            status: 'CONFIRMED',
            customerName,
            serviceName: service.name,
            price: service.price,
            currency: business.currency,
            date,
            time: `${startTime} - ${endTime}`,
            location: business.location,
            confirmationMessage: `Successfully booked ${service.name} for ${customerName} on ${date} at ${startTime}.`
          }
        };
      }

      case 'cancel_appointment': {
        const appointmentId = boundedString(args.appointmentId, 'appointmentId');
        const customerPhone = validPhone(args.customerPhone);
        const app = await db.appointments.find(a => 
          a.businessId === tenantId && 
          (a.id === appointmentId || a.customerPhone === customerPhone) &&
          a.status !== 'CANCELLED'
        );

        if (!app) {
          return {
            success: false,
            error: 'No active appointment found matching the provided details.'
          };
        }

        app.status = 'CANCELLED';
        await db.appointments.update(app);

        await db.auditLogs.push({
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          businessId: tenantId,
          action: 'APPOINTMENT_CANCELLED',
          details: `Appointment #${app.id} cancelled for ${app.customerName}`,
          timestamp: new Date().toISOString()
        });

        return {
          success: true,
          data: {
            appointmentId: app.id,
            status: 'CANCELLED',
            message: `Appointment for ${app.customerName} on ${app.date} at ${app.startTime} has been cancelled.`
          }
        };
      }

      case 'reschedule_appointment': {
        const appointmentId = boundedString(args.appointmentId, 'appointmentId');
        const newDate = boundedString(args.newDate, 'newDate');
        const newTime = boundedString(args.newTime, 'newTime');
        if (!appointmentId || !newDate || !newTime) {
          return { success: false, error: 'appointmentId, newDate and newTime are required.' };
        }
        const app = await db.appointments.find(a => a.businessId === tenantId && a.id === appointmentId);
        if (!app) {
          return { success: false, error: 'Appointment not found.' };
        }
        if (app.status === 'CANCELLED') {
          return { success: false, error: 'Cannot reschedule a cancelled appointment.' };
        }

        // Recompute end time from the service duration so the moved slot stays correct.
        const service = business.services.find(s => s.id === app.serviceId) ||
          business.services.find(s => s.name === app.serviceName);
        const svc = service || { id: '', name: app.serviceName, price: 0, durationMinutes: 30, description: '' };

        // Validate the new slot via the engine (hours, holiday, notice, advance).
        const slotCheck = validateSlot(business, svc, newDate, newTime);
        if (!slotCheck.ok) {
          return { success: false, error: slotCheck.error! };
        }
        const newEndTime = slotCheck.endTime!;
        const bufferAfter = Math.max(0, (svc as any).bufferMinutesAfter || 0);
        const blockEnd = bufferAfter > 0 ? addMinutes(newEndTime, bufferAfter) : newEndTime;

        // Same staff rule as booking: if the business has staff members, the new
        // slot must be covered by at least one (only when the service is known).
        if (service) {
          const staffList = await db.staffMembers.filter(s => s.businessId === tenantId);
          const staffForSlot = findEligibleStaff(business, staffList, service, newDate, newTime, newEndTime);
          if (staffList.length > 0 && !staffForSlot) {
            return { success: false, error: 'No staff member is available at that time. Please choose another slot using check_availability.' };
          }
        }

        // Transactional overlap check (excluding the appointment being moved).
        // Mirrors the booking overlap rule + uses SELECT ... FOR UPDATE row
        // locking so concurrent reschedules serialize (audit P1.3). The parent
        // business row is locked first to close the empty-set race (a FOR
        // UPDATE over zero appointment rows locks nothing).
        const r = await db.client.transaction(async () => {
          await db.client.query(
            `SELECT id FROM businesses WHERE id = ? FOR UPDATE`,
            [tenantId]
          );
          const lockRows = await db.client.query(
            `SELECT id, service_id, start_time, end_time FROM appointments
             WHERE business_id = ? AND date = ? AND status != 'CANCELLED' AND id != ? FOR UPDATE`,
            [tenantId, newDate, app.id]
          );
          const others = lockRows.rows.map((row: any) => ({
            id: row.id,
            serviceId: row.service_id ?? row.serviceId,
            startTime: row.start_time ?? row.startTime,
            endTime: row.end_time ?? row.endTime,
          }));
          for (const a of others) {
            const existingService = business.services.find(s => s.id === a.serviceId);
            const existingBuffer = Math.max(0, existingService?.bufferMinutesAfter || 0);
            const aBlockEnd = existingBuffer > 0 ? addMinutes(a.endTime, existingBuffer) : a.endTime;
            if (intervalsOverlap(newTime, blockEnd, a.startTime, aBlockEnd)) {
              return { ok: false as const, error: `The time ${newTime}-${newEndTime} on ${newDate} overlaps an existing appointment (${a.startTime}-${a.endTime}).` };
            }
          }
          app.date = newDate;
          app.startTime = newTime;
          app.endTime = newEndTime;
          app.status = 'RESCHEDULED';
          await db.appointments.update(app);
          await db.auditLogs.push({
            id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            businessId: tenantId,
            action: 'APPOINTMENT_RESCHEDULED',
            details: `Appointment #${app.id} rescheduled to ${newDate} at ${newTime}.`,
            timestamp: new Date().toISOString()
          });
          return { ok: true as const };
        });
        if (isFail(r)) return { success: false, error: r.error };

        return {
          success: true,
          data: {
            appointmentId: app.id,
            status: 'RESCHEDULED',
            newDate,
            newTime,
            newEndTime,
            message: `Appointment #${app.id} successfully rescheduled to ${newDate} at ${newTime}.`
          }
        };
      }

      case 'search_products': {
        const query = (args.query || '').toLowerCase();
        const tenantProds = await db.products.filter(p => p.businessId === tenantId);
        const matches = tenantProds.filter(p => 
          p.name.toLowerCase().includes(query) || 
          p.description.toLowerCase().includes(query) ||
          p.category.toLowerCase().includes(query)
        );

        return {
          success: true,
          data: {
            count: matches.length,
            products: matches.map(p => ({
              id: p.id,
              name: p.name,
              sku: p.sku,
              price: p.price,
              currency: business.currency,
              inStock: p.inventory > 0,
              inventory: p.inventory,
              category: p.category,
              description: p.description
            }))
          }
        };
      }

      case 'create_order': {
        const customerName = boundedString(args.customerName, 'customerName');
        const customerPhone = validPhone(args.customerPhone);
        const items = args.items;

        if (!customerName || !customerPhone || !Array.isArray(items) || items.length === 0) {
          return { success: false, error: 'customerName, customerPhone and a non-empty items list are required.' };
        }
        if (items.length > 100) {
          return { success: false, error: 'An order cannot contain more than 100 items.' };
        }
        // Validate item shape up front (before the transaction).
        for (const item of items) {
          if (!item?.productId || !Number.isInteger(item.quantity) || item.quantity <= 0) {
            return { success: false, error: 'Each item needs a productId and a positive integer quantity.' };
          }
          boundedString(item.productId, 'productId'); // throws if oversized
          validQuantity(item.quantity);
        }

        const orderId = `ord-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const nowIso = new Date().toISOString();

        // The transaction THROWS on any failure so the DB rolls back EVERY
        // mutation made inside it (inventory decrements, customer create, order
        // insert). Returning a failure value does NOT roll back — only a thrown
        // exception triggers ROLLBACK. This guarantees a failed multi-item order
        // leaves inventory completely unchanged (no partial deduction). On
        // PostgreSQL this is a real transaction; on SQLite the handle serializes.
        class OrderTxnError extends Error {
          constructor(public error: string) { super(error); this.name = 'OrderTxnError'; }
        }

        let result: { order: any; totalAmount: number; orderItems: any[] };
        try {
          result = await db.client.transaction(async (): Promise<{ order: any; totalAmount: number; orderItems: any[] }> => {
            const orderItems: Array<{ productId: string; productName: string; quantity: number; price: number }> = [];
            let totalAmount = 0;

            // ATOMIC conditional stock decrement (audit P1.4 — PostgreSQL-safe).
            // Instead of read-then-write (which races under READ COMMITTED on
            // Postgres), we issue a single UPDATE ... WHERE stock >= ? and verify
            // EXACTLY ONE row changed. The DB row lock acquired by the UPDATE
            // serializes concurrent decrements for the same product, so two
            // simultaneous orders for the last unit cannot both succeed.
            for (const item of items) {
              const product = await db.products.find(p => p.businessId === tenantId && p.id === item.productId);
              if (!product) {
                throw new OrderTxnError(`Product ID ${item.productId} not found.`);
              }
              const decRes = await db.client.query(
                `UPDATE products SET inventory = inventory - ? WHERE id = ? AND business_id = ? AND inventory >= ?`,
                [item.quantity, product.id, tenantId, item.quantity]
              );
              if (decRes.changes !== 1) {
                // Zero rows changed => stock was insufficient at decrement time
                // (either already below the requested qty or the row vanished).
                const refreshed = await db.products.find(p => p.businessId === tenantId && p.id === item.productId);
                throw new OrderTxnError(
                  `Insufficient stock for ${product.name}. Available: ${refreshed?.inventory ?? 0}, Requested: ${item.quantity}`
                );
              }

              const itemTotal = product.price * item.quantity;
              totalAmount += itemTotal;
              orderItems.push({
                productId: product.id,
                productName: product.name,
                quantity: item.quantity,
                price: product.price
              });
            }

            // Customer lookup/create inside the transaction.
            let customer = await db.customers.find(c => c.businessId === tenantId && c.phone === customerPhone);
            if (!customer) {
              customer = { id: `cust-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`, businessId: tenantId, name: customerName, phone: customerPhone, createdAt: nowIso };
              await db.customers.push(customer);
            }

            const newOrder = {
              id: orderId,
              businessId: tenantId,
              customerId: customer.id,
              customerName,
              items: orderItems,
              totalAmount,
              status: 'PENDING' as const,
              createdAt: nowIso
            };
            await db.orders.push(newOrder);

            return { order: newOrder, totalAmount, orderItems };
          });
        } catch (e) {
          if (e instanceof OrderTxnError) {
            return { success: false, error: e.error };
          }
          throw e; // unexpected — let the runtime's error handling deal with it
        }

        return {
          success: true,
          data: {
            orderId: result.order.id,
            status: 'PENDING',
            customerName,
            totalAmount: result.totalAmount,
            currency: business.currency,
            items: result.orderItems,
            message: `Order #${result.order.id} created successfully! Total: ${result.totalAmount} ${business.currency}.`
          }
        };
      }

      case 'get_order_status': {
        const orderId = boundedString(args.orderId, 'orderId');
        const customerPhone = validPhone(args.customerPhone);
        // Look up by order id (tenant-scoped), then verify ownership via the
        // customer's phone when provided. The customer lookup is a separate
        // query (cannot `await` inside the orders.filter predicate).
        let order = await db.orders.find(o => o.businessId === tenantId && o.id === orderId);
        if (!order && customerPhone) {
          // Fall back: find orders whose customer's phone matches.
          const customer = await db.customers.find(c => c.businessId === tenantId && c.phone === customerPhone);
          if (customer) {
            order = await db.orders.find(o => o.businessId === tenantId && o.customerId === customer.id);
          }
        }

        if (!order) {
          return { success: false, error: 'No order found matching criteria.' };
        }

        return {
          success: true,
          data: {
            orderId: order.id,
            status: order.status,
            customerName: order.customerName,
            totalAmount: order.totalAmount,
            currency: business.currency,
            items: order.items,
            createdAt: order.createdAt
          }
        };
      }

      case 'notify_business_owner': {
        const reason = boundedString(args.reason, 'reason');
        const customerDetails = boundedString(args.customerDetails, 'customerDetails');
        if (!reason) {
          return { success: false, error: 'reason is required.' };
        }
        await db.auditLogs.push({
          id: `log-${Date.now()}`,
          businessId: tenantId,
          action: 'OWNER_NOTIFIED',
          details: `Urgent notification: ${reason} (Customer: ${customerDetails || 'N/A'})`,
          timestamp: new Date().toISOString()
        });

        return {
          success: true,
          data: { notified: true, message: 'Business owner has been notified via dashboard logs.' }
        };
      }

      case 'transfer_to_human': {
        const reason = boundedString(args.reason, 'reason') || 'Customer requested human assistance.';
        if (conversationId) {
          const conv = await db.conversations.find(c => c.id === conversationId);
          if (conv) {
            conv.status = 'WAITING_FOR_HUMAN';
            conv.handoffReason = reason;
            conv.handoffRequestedAt = new Date().toISOString();
            await db.conversations.update(conv);
          }
        }

        await db.auditLogs.push({
          id: `log-${Date.now()}`,
          businessId: tenantId,
          action: 'HUMAN_HANDOFF_TRIGGERED',
          details: `Conversation transferred to human agent. Reason: ${reason}`,
          timestamp: new Date().toISOString()
        });

        return {
          success: true,
          data: {
            transferred: true,
            status: 'WAITING_FOR_HUMAN',
            message: 'A human team member has been notified and will take over this conversation shortly.'
          }
        };
      }

      default:
        return { success: false, error: `Unknown tool name: ${toolName}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message || 'Internal tool execution error' };
  }
}
