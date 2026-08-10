import { Type, FunctionDeclaration } from '@google/genai';
import { db } from './db';

export interface ToolContext {
  tenantId: string;
  conversationId?: string;
  channel?: string;
}

// ---------------------------------------------------------------------------
// Time helpers (HH:MM strings). Pure functions, no I/O.
// ---------------------------------------------------------------------------

/** "14:30" -> minutes since midnight (870). Tolerant of missing minutes. */
function timeToMinutes(t: string): number {
  const [h, m] = String(t || '').split(':').map(n => parseInt(n, 10) || 0);
  return h * 60 + m;
}

/** minutes since midnight -> "HH:MM" (zero-padded). */
function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/** Add a duration in minutes to a HH:MM start time -> HH:MM end time. */
function addMinutes(start: string, durationMinutes: number): string {
  return minutesToTime(timeToMinutes(start) + Math.max(1, durationMinutes));
}

/**
 * Do two [start, end) intervals overlap? Used for appointment overlap
 * detection. Adjacent appointments (one ends exactly when the other starts) do
 * NOT overlap, so back-to-back bookings are allowed.
 */
function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return timeToMinutes(aStart) < timeToMinutes(bEnd) && timeToMinutes(bStart) < timeToMinutes(aEnd);
}

/** Type guard: narrow a transaction result to its failure branch. */
function isFail<T>(r: { ok: true } | { ok: false; error: string } | T): r is { ok: false; error: string } {
  return typeof r === 'object' && r !== null && (r as any).ok === false;
}

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
  const business = db.businesses.find(b => b.id === tenantId);
  if (!business) {
    return { success: false, error: `Unauthorized tenant ID: ${tenantId}` };
  }

  try {
    switch (toolName) {
      case 'check_business_hours': {
        const dayArg = args.day?.toLowerCase();
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
        const topic = args.topic?.toLowerCase();
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

      case 'check_availability': {
        const { date, serviceId } = args;
        const requestedDate = date || new Date().toISOString().split('T')[0];
        
        // Find day of week for requested date
        const dateObj = new Date(requestedDate);
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const dayName = dayNames[dateObj.getUTCDay()];
        
        const dayHours = business.hours.find(h => h.day === dayName);
        if (!dayHours || !dayHours.isOpen) {
          return {
            success: true,
            data: {
              date: requestedDate,
              dayOfWeek: dayName,
              isOpen: false,
              message: `The business is closed on ${dayName}s.`,
              availableSlots: []
            }
          };
        }

        // Get existing appointments for this tenant on this date
        const existingApps = db.appointments.filter(a => a.businessId === tenantId && a.date === requestedDate && a.status !== 'CANCELLED');
        const bookedTimes = new Set(existingApps.map(a => a.startTime));

        // Generate standard hourly slots between openTime and closeTime
        const openHour = parseInt(dayHours.openTime.split(':')[0], 10) || 9;
        const closeHour = parseInt(dayHours.closeTime.split(':')[0], 10) || 20;

        const availableSlots: string[] = [];
        for (let h = openHour; h < closeHour; h++) {
          const slot = `${h.toString().padStart(2, '0')}:00`;
          const slotHalf = `${h.toString().padStart(2, '0')}:30`;
          if (!bookedTimes.has(slot)) availableSlots.push(slot);
          if (h < closeHour - 1 && !bookedTimes.has(slotHalf)) availableSlots.push(slotHalf);
        }

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
        const { customerName, customerPhone, serviceIdOrName, date, startTime, notes } = args;

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

        const duration = Math.max(1, service.durationMinutes || 30);
        const endTime = addMinutes(startTime, duration);

        // Validate the slot falls within business hours for that day.
        const dateObj = new Date(`${date}T00:00:00Z`);
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const dayName = dayNames[dateObj.getUTCDay()];
        const dayHours = business.hours.find(h => h.day === dayName);
        if (!dayHours || !dayHours.isOpen) {
          return { success: false, error: `The business is closed on ${dayName}. Cannot book for ${date}.` };
        }
        if (timeToMinutes(startTime) < timeToMinutes(dayHours.openTime) || timeToMinutes(endTime) > timeToMinutes(dayHours.closeTime)) {
          return { success: false, error: `Requested time ${startTime}-${endTime} is outside opening hours (${dayHours.openTime}-${dayHours.closeTime}) on ${dayName}.` };
        }

        // TRANSACTIONAL booking with overlap prevention. The overlap check and
        // the INSERT run inside one SQLite transaction. better-sqlite3 is
        // synchronous and serializes writes, so the transaction makes the
        // check-then-insert atomic: two concurrent bookings for an overlapping
        // slot cannot both succeed — the second sees the first's row.
        const appointmentId = `app-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const customerId = `cust-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const nowIso = new Date().toISOString();

        const bookTxn = db.sqlite.transaction((): { ok: true; appointment: any } | { ok: false; error: string } => {
          // Re-check for an overlapping (not just identical) non-cancelled
          // appointment for this tenant on this date. Back-to-back (adjacent)
          // appointments are allowed; true overlaps are rejected.
          const overlapping = db.appointments.filter(
            a => a.businessId === tenantId && a.date === date && a.status !== 'CANCELLED'
          );
          for (const a of overlapping) {
            if (intervalsOverlap(startTime, endTime, a.startTime, a.endTime)) {
              return { ok: false, error: `The time ${startTime}-${endTime} on ${date} overlaps an existing appointment (${a.startTime}-${a.endTime}). Please choose another slot using check_availability.` };
            }
          }

          // Find or create the customer inside the transaction.
          let customer = db.customers.find(c => c.businessId === tenantId && c.phone === customerPhone);
          if (!customer) {
            customer = { id: customerId, businessId: tenantId, name: customerName, phone: customerPhone, createdAt: nowIso };
            db.customers.push(customer);
          }

          const staff = db.staffMembers.find(s => s.businessId === tenantId);

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
          db.appointments.push(newAppointment);

          db.auditLogs.push({
            id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            businessId: tenantId,
            action: 'APPOINTMENT_BOOKED',
            details: `Appointment #${newAppointment.id} booked for ${customerName} (${service.name} at ${startTime}-${endTime} on ${date})`,
            timestamp: nowIso
          });

          return { ok: true, appointment: newAppointment };
        });

        const result = bookTxn();

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
        const { appointmentId, customerPhone } = args;
        const app = db.appointments.find(a => 
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
        db.appointments.update(app);

        db.auditLogs.push({
          id: `log-${Date.now()}`,
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
        const { appointmentId, newDate, newTime } = args;
        if (!appointmentId || !newDate || !newTime) {
          return { success: false, error: 'appointmentId, newDate and newTime are required.' };
        }
        const app = db.appointments.find(a => a.businessId === tenantId && a.id === appointmentId);
        if (!app) {
          return { success: false, error: 'Appointment not found.' };
        }
        if (app.status === 'CANCELLED') {
          return { success: false, error: 'Cannot reschedule a cancelled appointment.' };
        }

        // Recompute end time from the service duration so the moved slot stays correct.
        const service = business.services.find(s => s.id === app.serviceId) ||
          business.services.find(s => s.name === app.serviceName);
        const duration = Math.max(1, service?.durationMinutes || 30);
        const newEndTime = addMinutes(newTime, duration);

        // Validate the new slot is within business hours.
        const dateObj = new Date(`${newDate}T00:00:00Z`);
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const dayName = dayNames[dateObj.getUTCDay()];
        const dayHours = business.hours.find(h => h.day === dayName);
        if (!dayHours || !dayHours.isOpen) {
          return { success: false, error: `The business is closed on ${dayName}.` };
        }
        if (timeToMinutes(newTime) < timeToMinutes(dayHours.openTime) || timeToMinutes(newEndTime) > timeToMinutes(dayHours.closeTime)) {
          return { success: false, error: `Requested time ${newTime}-${newEndTime} is outside opening hours on ${dayName}.` };
        }

        // Transactional overlap check (excluding the appointment being moved).
        const rescheduleTxn = db.sqlite.transaction(() => {
          const others = db.appointments.filter(
            a => a.businessId === tenantId && a.date === newDate && a.status !== 'CANCELLED' && a.id !== app.id
          );
          for (const a of others) {
            if (intervalsOverlap(newTime, newEndTime, a.startTime, a.endTime)) {
              return { ok: false as const, error: `The time ${newTime}-${newEndTime} on ${newDate} overlaps an existing appointment (${a.startTime}-${a.endTime}).` };
            }
          }
          app.date = newDate;
          app.startTime = newTime;
          app.endTime = newEndTime;
          app.status = 'RESCHEDULED';
          db.appointments.update(app);
          return { ok: true as const };
        });
        const r = rescheduleTxn();
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
        const tenantProds = db.products.filter(p => p.businessId === tenantId);
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
        const { customerName, customerPhone, items } = args;

        if (!customerName || !customerPhone || !Array.isArray(items) || items.length === 0) {
          return { success: false, error: 'customerName, customerPhone and a non-empty items list are required.' };
        }
        // Validate item shape up front (before the transaction).
        for (const item of items) {
          if (!item?.productId || !Number.isInteger(item.quantity) || item.quantity <= 0) {
            return { success: false, error: 'Each item needs a productId and a positive integer quantity.' };
          }
        }

        const orderId = `ord-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const nowIso = new Date().toISOString();

        // The transaction THROWS on any failure so better-sqlite3 rolls back
        // EVERY mutation made inside it (inventory decrements, customer create,
        // order insert). Returning a failure value does NOT roll back — only a
        // thrown exception triggers ROLLBACK. This guarantees a failed multi-
        // item order leaves inventory completely unchanged (no partial deduction).
        class OrderTxnError extends Error {
          constructor(public error: string) { super(error); this.name = 'OrderTxnError'; }
        }

        const runOrderTxn = db.sqlite.transaction((): { order: any; totalAmount: number; orderItems: any[] } => {
          const orderItems: Array<{ productId: string; productName: string; quantity: number; price: number }> = [];
          let totalAmount = 0;

          // Re-read each product inside the transaction and verify stock.
          // better-sqlite3 is synchronous so the transaction serializes these
          // writes — check + decrement are atomic, preventing two concurrent
          // orders from overselling the same stock.
          for (const item of items) {
            const product = db.products.find(p => p.businessId === tenantId && p.id === item.productId);
            if (!product) {
              throw new OrderTxnError(`Product ID ${item.productId} not found.`);
            }
            if (product.inventory < item.quantity) {
              throw new OrderTxnError(`Insufficient stock for ${product.name}. Available: ${product.inventory}, Requested: ${item.quantity}`);
            }
            product.inventory -= item.quantity;
            // Guard against negative inventory even if the check above raced.
            if (product.inventory < 0) {
              throw new OrderTxnError(`Insufficient stock for ${product.name}.`);
            }
            db.products.update(product);

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
          let customer = db.customers.find(c => c.businessId === tenantId && c.phone === customerPhone);
          if (!customer) {
            customer = { id: `cust-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`, businessId: tenantId, name: customerName, phone: customerPhone, createdAt: nowIso };
            db.customers.push(customer);
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
          db.orders.push(newOrder);

          return { order: newOrder, totalAmount, orderItems };
        });

        let result: { order: any; totalAmount: number; orderItems: any[] };
        try {
          result = runOrderTxn();
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
        const { orderId, customerPhone } = args;
        const order = db.orders.find(o => 
          o.businessId === tenantId && 
          (o.id === orderId || (customerPhone && db.customers.find(c => c.id === o.customerId)?.phone === customerPhone))
        );

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
        const { reason, customerDetails } = args;
        db.auditLogs.push({
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
        const { reason } = args;
        if (conversationId) {
          const conv = db.conversations.find(c => c.id === conversationId);
          if (conv) {
            conv.status = 'WAITING_FOR_HUMAN';
            conv.handoffReason = reason || 'Customer requested human assistance.';
            conv.handoffRequestedAt = new Date().toISOString();
            db.conversations.update(conv);
          }
        }

        db.auditLogs.push({
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
