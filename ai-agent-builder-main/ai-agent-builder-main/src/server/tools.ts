import { Type, FunctionDeclaration } from '@google/genai';
import { db } from './db';

export interface ToolContext {
  tenantId: string;
  conversationId?: string;
  channel?: string;
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

        // Service resolution
        const service = business.services.find(s => 
          s.id === serviceIdOrName || 
          s.name.toLowerCase().includes(String(serviceIdOrName).toLowerCase())
        ) || business.services[0]; // fallback to primary service if match ambiguous

        // Check if slot is already occupied
        const existing = db.appointments.find(a => 
          a.businessId === tenantId && 
          a.date === date && 
          a.startTime === startTime && 
          a.status !== 'CANCELLED'
        );

        if (existing) {
          return {
            success: false,
            error: `The slot at ${startTime} on ${date} is already booked. Please choose another time slot using check_availability.`
          };
        }

        // Find or create customer
        let customer = db.customers.find(c => c.businessId === tenantId && c.phone === customerPhone);
        if (!customer) {
          customer = {
            id: `cust-${Date.now()}`,
            businessId: tenantId,
            name: customerName,
            phone: customerPhone,
            createdAt: new Date().toISOString()
          };
          db.customers.push(customer);
        }

        // Calculate end time
        const startHour = parseInt(startTime.split(':')[0], 10);
        const startMin = parseInt(startTime.split(':')[1] || '0', 10);
        const totalMinutes = startHour * 60 + startMin + (service?.durationMinutes || 30);
        const endHour = Math.floor(totalMinutes / 60);
        const endMin = totalMinutes % 60;
        const endTime = `${endHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}`;

        // Select staff member if available
        const staff = db.staffMembers.find(s => s.businessId === tenantId);

        const newAppointment = {
          id: `app-${Date.now()}`,
          businessId: tenantId,
          serviceId: service ? service.id : 'srv-1',
          serviceName: service ? service.name : 'Haircut',
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
          createdAt: new Date().toISOString()
        };

        db.appointments.push(newAppointment);

        // Audit Log
        db.auditLogs.push({
          id: `log-${Date.now()}`,
          businessId: tenantId,
          action: 'APPOINTMENT_BOOKED',
          details: `Appointment #${newAppointment.id} booked for ${customerName} (${service.name} at ${startTime} on ${date})`,
          timestamp: new Date().toISOString()
        });

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
        const app = db.appointments.find(a => a.businessId === tenantId && a.id === appointmentId);

        if (!app) {
          return { success: false, error: 'Appointment not found.' };
        }

        app.date = newDate;
        app.startTime = newTime;
        app.status = 'RESCHEDULED';
        db.appointments.update(app);

        return {
          success: true,
          data: {
            appointmentId: app.id,
            status: 'RESCHEDULED',
            newDate,
            newTime,
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
        const orderItems: Array<{ productId: string; productName: string; quantity: number; price: number }> = [];
        let totalAmount = 0;

        for (const item of items) {
          const product = db.products.find(p => p.businessId === tenantId && p.id === item.productId);
          if (!product) {
            return { success: false, error: `Product ID ${item.productId} not found.` };
          }
          if (product.inventory < item.quantity) {
            return { success: false, error: `Insufficient stock for ${product.name}. Available: ${product.inventory}, Requested: ${item.quantity}` };
          }

          product.inventory -= item.quantity; // Deduct inventory safely
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

        // Customer lookup
        let customer = db.customers.find(c => c.businessId === tenantId && c.phone === customerPhone);
        if (!customer) {
          customer = {
            id: `cust-${Date.now()}`,
            businessId: tenantId,
            name: customerName,
            phone: customerPhone,
            createdAt: new Date().toISOString()
          };
          db.customers.push(customer);
        }

        const newOrder = {
          id: `ord-${Date.now()}`,
          businessId: tenantId,
          customerId: customer.id,
          customerName,
          items: orderItems,
          totalAmount,
          status: 'PENDING' as const,
          createdAt: new Date().toISOString()
        };

        db.orders.push(newOrder);

        return {
          success: true,
          data: {
            orderId: newOrder.id,
            status: 'PENDING',
            customerName,
            totalAmount,
            currency: business.currency,
            items: orderItems,
            message: `Order #${newOrder.id} created successfully! Total: ${totalAmount} ${business.currency}.`
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
