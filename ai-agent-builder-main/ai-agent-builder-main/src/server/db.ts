import {
  Business,
  Agent,
  KnowledgeChunk,
  Customer,
  Conversation,
  Message,
  Appointment,
  Product,
  Order,
  ChannelConfig,
  IntegrationConfig,
  AgentTemplate,
  UsageRecord,
  AuditLog,
  StaffMember
} from '../types';

class InMemoryDatabase {
  public businesses: Business[] = [];
  public agents: Agent[] = [];
  public knowledgeChunks: KnowledgeChunk[] = [];
  public customers: Customer[] = [];
  public conversations: Conversation[] = [];
  public messages: Message[] = [];
  public appointments: Appointment[] = [];
  public staffMembers: StaffMember[] = [];
  public products: Product[] = [];
  public orders: Order[] = [];
  public channels: ChannelConfig[] = [];
  public integrations: IntegrationConfig[] = [];
  public templates: AgentTemplate[] = [];
  public usageRecords: UsageRecord[] = [];
  public auditLogs: AuditLog[] = [];

  constructor() {
    this.seed();
  }

  private seed() {
    const defaultHours = [
      { day: 'monday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
      { day: 'tuesday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
      { day: 'wednesday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
      { day: 'thursday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
      { day: 'friday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
      { day: 'saturday', isOpen: true, openTime: '09:00', closeTime: '20:00' },
      { day: 'sunday', isOpen: false, openTime: '09:00', closeTime: '20:00' },
    ] as const;

    // 1. Seed Business A: Tony's Barber Shop
    const tonysBarber: Business = {
      id: 'biz-tonys-barber',
      name: "Tony's Barber Shop",
      type: 'barbershop',
      description: 'Premium local barbershop offering classic cuts, beard grooming, and hot towel treatments.',
      location: '123 Main Barber Street, Downtown',
      language: 'en',
      currency: 'toman',
      timezone: 'Asia/Tehran',
      hours: [...defaultHours],
      services: [
        { id: 'srv-1', name: 'Haircut', price: 300000, durationMinutes: 30, description: 'Classic precision haircut with styling.' },
        { id: 'srv-2', name: 'Beard trim', price: 200000, durationMinutes: 20, description: 'Sharp beard line-up, trimming, and beard oil application.' },
        { id: 'srv-3', name: 'Haircut + beard', price: 450000, durationMinutes: 45, description: 'Full grooming package: haircut, wash, beard trim & hot towel.' }
      ],
      pricingNotes: 'Prices are fixed in Toman. Tips are optional and appreciated.',
      faqs: [
        { id: 'faq-1', question: 'Do I need an appointment?', answer: 'Appointments are recommended to avoid waiting, but walk-ins are welcome if a slot is available.' },
        { id: 'faq-2', question: 'Where are you located?', answer: 'We are located at 123 Main Barber Street, Downtown (Next to Central Park).' },
        { id: 'faq-3', question: 'What payment methods do you accept?', answer: 'We accept POS card payments, cash, and online transfers.' }
      ],
      policies: {
        cancellation: 'Please cancel or reschedule at least 2 hours before your appointment.',
        refund: 'Services rendered are non-refundable. If unsatisfied, we offer a complimentary touch-up within 48 hours.',
        bookingNotice: 'Appointments can be booked up to 14 days in advance.'
      },
      communicationStyle: 'Friendly, welcoming, respectful, and direct.',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.businesses.push(tonysBarber);

    // 2. Staff Members for Tony's
    const staff1: StaffMember = {
      id: 'staff-1',
      businessId: 'biz-tonys-barber',
      name: 'Tony (Master Barber)',
      role: 'Owner & Master Barber',
      servicesHandled: ['srv-1', 'srv-2', 'srv-3']
    };
    const staff2: StaffMember = {
      id: 'staff-2',
      businessId: 'biz-tonys-barber',
      name: 'Marco (Senior Stylist)',
      role: 'Barber & Stylist',
      servicesHandled: ['srv-1', 'srv-2', 'srv-3']
    };
    this.staffMembers.push(staff1, staff2);

    // 3. Seed Agent for Tony's
    const tonysAgent: Agent = {
      id: 'agent-tonys-1',
      businessId: 'biz-tonys-barber',
      name: "Tony's AI Receptionist",
      description: 'Handles customer calls, web chats, FAQ queries, and appointment bookings.',
      version: 1,
      status: 'ACTIVE',
      llmProvider: 'gemini',
      model: 'gemini-3.6-flash',
      systemPrompt: `You are the official AI receptionist for Tony's Barber Shop. 
Your primary goal is to provide welcoming, accurate service information, answer customer questions based ONLY on official business facts, check availability, book appointments, and offer human handoff when requested or uncertain.
Never invent prices, hours, services, or availability that do not exist in the database.`,
      structuredConfig: {
        personality: {
          tone: 'friendly',
          behavior: 'service',
          language: 'en',
          customPrompt: 'Always end conversations with a polite note inviting the customer to visit.'
        },
        goals: [
          'Answer customer queries accurately',
          'Book haircuts and beard trims',
          'Explain pricing and location',
          'Transfer complex or angry queries to human owner'
        ],
        allowedActions: [
          'check_business_hours',
          'get_business_information',
          'check_availability',
          'book_appointment',
          'cancel_appointment',
          'reschedule_appointment',
          'search_products',
          'transfer_to_human'
        ],
        restrictedActions: [
          'Never give unauthorized discounts',
          'Never alter business operating hours',
          'Never promise free services'
        ],
        escalationRules: [
          'Customer requests to speak to a real person',
          'Refund dispute or complaint about a past haircut',
          'Unresolvable scheduling conflict'
        ],
        bookingRules: 'Appointments require customer full name and phone number. Maximum 14 days advance booking.',
        orderRules: 'Grooming products can be reserved for pickup in shop.',
        refundRules: 'Complimentary touch-up within 48 hours instead of cash refunds.',
        toolsEnabled: [
          'check_business_hours',
          'get_business_information',
          'check_availability',
          'book_appointment',
          'cancel_appointment',
          'reschedule_appointment',
          'search_products',
          'create_order',
          'get_order_status',
          'transfer_to_human'
        ]
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.agents.push(tonysAgent);

    // 4. Knowledge Chunks
    this.knowledgeChunks.push(
      {
        id: 'kc-1',
        businessId: 'biz-tonys-barber',
        title: 'Service & Price List',
        type: 'service_catalog',
        content: 'Haircut: 300,000 toman (30 mins). Beard trim: 200,000 toman (20 mins). Haircut + beard combo: 450,000 toman (45 mins).',
        tags: ['pricing', 'services'],
        createdAt: new Date().toISOString()
      },
      {
        id: 'kc-2',
        businessId: 'biz-tonys-barber',
        title: 'Opening Hours & Location',
        type: 'policy',
        content: 'Open Monday to Saturday from 09:00 to 20:00. Closed on Sundays. Located at 123 Main Barber Street, Downtown.',
        tags: ['hours', 'location'],
        createdAt: new Date().toISOString()
      },
      {
        id: 'kc-3',
        businessId: 'biz-tonys-barber',
        title: 'Grooming Products',
        type: 'document',
        content: 'We stock Matte Clay Pomade (150,000 toman) and Organic Cedarwood Beard Oil (120,000 toman) for home styling.',
        tags: ['products', 'pomade', 'beard oil'],
        createdAt: new Date().toISOString()
      }
    );

    // 5. Products
    this.products.push(
      {
        id: 'prod-1',
        businessId: 'biz-tonys-barber',
        name: 'Matte Clay Pomade (100g)',
        sku: 'POM-001',
        price: 150000,
        inventory: 25,
        description: 'Strong hold, matte finish pomade for modern textured hairstyles.',
        category: 'Hair Care'
      },
      {
        id: 'prod-2',
        businessId: 'biz-tonys-barber',
        name: 'Organic Cedarwood Beard Oil (50ml)',
        sku: 'OIL-002',
        price: 120000,
        inventory: 18,
        description: 'Nourishing oil that softens facial hair and reduces skin irritation.',
        category: 'Beard Care'
      }
    );

    // 6. Customers
    const cust1: Customer = {
      id: 'cust-1',
      businessId: 'biz-tonys-barber',
      name: 'Reza Ahmadi',
      phone: '+98 912 345 6789',
      notes: 'Prefers low fade with scissors on top.',
      createdAt: new Date().toISOString()
    };
    const cust2: Customer = {
      id: 'cust-2',
      businessId: 'biz-tonys-barber',
      name: 'Sina Kavoosi',
      phone: '+98 919 876 5432',
      notes: 'Regular beard trim customer.',
      createdAt: new Date().toISOString()
    };
    this.customers.push(cust1, cust2);

    // 7. Appointments
    const todayStr = new Date().toISOString().split('T')[0];
    this.appointments.push(
      {
        id: 'app-1',
        businessId: 'biz-tonys-barber',
        serviceId: 'srv-1',
        serviceName: 'Haircut',
        staffMemberId: 'staff-1',
        staffName: 'Tony (Master Barber)',
        customerId: 'cust-1',
        customerName: 'Reza Ahmadi',
        customerPhone: '+98 912 345 6789',
        date: todayStr,
        startTime: '14:00',
        endTime: '14:30',
        status: 'CONFIRMED',
        notes: 'Requested Tony specifically.',
        createdAt: new Date().toISOString()
      },
      {
        id: 'app-2',
        businessId: 'biz-tonys-barber',
        serviceId: 'srv-3',
        serviceName: 'Haircut + beard',
        staffMemberId: 'staff-2',
        staffName: 'Marco (Senior Stylist)',
        customerId: 'cust-2',
        customerName: 'Sina Kavoosi',
        customerPhone: '+98 919 876 5432',
        date: todayStr,
        startTime: '16:00',
        endTime: '16:45',
        status: 'CONFIRMED',
        notes: 'Combo booking.',
        createdAt: new Date().toISOString()
      }
    );

    // 8. Channels & Integrations for Tony's
    this.channels.push(
      {
        id: 'chan-1',
        businessId: 'biz-tonys-barber',
        type: 'web_chat',
        status: 'connected',
        details: 'Widget snippet active on website',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'chan-2',
        businessId: 'biz-tonys-barber',
        type: 'instagram',
        status: 'not_configured',
        details: 'Not configured',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'chan-3',
        businessId: 'biz-tonys-barber',
        type: 'sms',
        status: 'not_configured',
        details: 'Not configured',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'chan-4',
        businessId: 'biz-tonys-barber',
        type: 'voice',
        status: 'not_configured',
        details: 'Not configured',
        updatedAt: new Date().toISOString()
      }
    );

    this.integrations.push(
      {
        id: 'integ-1',
        businessId: 'biz-tonys-barber',
        provider: 'google_calendar',
        connected: false,
        statusMessage: 'Not configured',
        credentialsSet: false
      },
      {
        id: 'integ-2',
        businessId: 'biz-tonys-barber',
        provider: 'meta_instagram',
        connected: false,
        statusMessage: 'Not configured',
        credentialsSet: false
      },
      {
        id: 'integ-3',
        businessId: 'biz-tonys-barber',
        provider: 'twilio_sms',
        connected: false,
        statusMessage: 'Not configured',
        credentialsSet: false
      },
      {
        id: 'integ-4',
        businessId: 'biz-tonys-barber',
        provider: 'voice_ai',
        connected: false,
        statusMessage: 'Not configured',
        credentialsSet: false
      }
    );

    // 9. Conversations
    const conv1: Conversation = {
      id: 'conv-1',
      businessId: 'biz-tonys-barber',
      customerId: 'cust-1',
      customerName: 'Reza Ahmadi',
      customerPhone: '+98 912 345 6789',
      channel: 'web_chat',
      status: 'AI_HANDLING',
      summary: 'Asked about prices for Haircut + beard combo and confirmed booking for 14:00.',
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    this.conversations.push(conv1);

    this.messages.push(
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        sender: 'customer',
        content: "Hi! How much is a haircut and beard trim package?",
        channel: 'web_chat',
        timestamp: new Date(Date.now() - 3600000).toISOString()
      },
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        sender: 'agent',
        content: "Hello Reza! Our Haircut + Beard combo is 450,000 Toman and takes approximately 45 minutes. It includes a haircut, hair wash, beard trim, and hot towel treatment! Would you like to book an appointment?",
        channel: 'web_chat',
        timestamp: new Date(Date.now() - 3500000).toISOString()
      }
    );

    // 10. Pre-built Industry Templates
    this.templates.push(
      {
        id: 'tpl-barbershop',
        name: 'Barbershop & Grooming',
        businessType: 'barbershop',
        icon: 'Scissors',
        description: 'Complete receptionist for barber shops. Handles appointments, service combos, barber selection, and missed call follow-ups.',
        defaultServices: [
          { id: 's1', name: 'Haircut', price: 300000, durationMinutes: 30, description: 'Classic or modern haircut.' },
          { id: 's2', name: 'Beard Trim', price: 200000, durationMinutes: 20, description: 'Precision beard shaping.' },
          { id: 's3', name: 'Haircut + Beard Combo', price: 450000, durationMinutes: 45, description: 'Complete grooming experience.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'Do you accept walk-ins?', answer: 'Yes, walk-ins are accepted depending on barber availability.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'friendly', behavior: 'service', language: 'en' },
          goals: ['Book appointments', 'Explain services and pricing', 'Answer location & hours queries']
        }
      },
      {
        id: 'tpl-salon',
        name: 'Beauty Salon & Spa',
        businessType: 'salon',
        icon: 'Sparkles',
        description: 'AI receptionist for hair salons, nail bars, and skin care clinics.',
        defaultServices: [
          { id: 's1', name: 'Hair Styling & Blowdry', price: 500000, durationMinutes: 45, description: 'Wash, treatment, and blowdry styling.' },
          { id: 's2', name: 'Manicure & Gel Polish', price: 350000, durationMinutes: 40, description: 'Nail shaping, cuticle care, and gel polish.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'Do I need to come with washed hair?', answer: 'We include hair washing with all styling services!' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'luxury', behavior: 'service', language: 'en' },
          goals: ['Schedule beauty appointments', 'Recommend packages', 'Send reminders']
        }
      },
      {
        id: 'tpl-restaurant',
        name: 'Restaurant & Cafe',
        businessType: 'restaurant',
        icon: 'Utensils',
        description: 'Handles table reservations, menu item inquiries, dietary questions, and takeaway orders.',
        defaultServices: [
          { id: 's1', name: 'Table Reservation (2-4 guests)', price: 0, durationMinutes: 90, description: 'Reserve a table for dining in.' },
          { id: 's2', name: 'VIP Dining Room Reservation', price: 200000, durationMinutes: 120, description: 'Private room booking deposit.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'Do you have vegan options?', answer: 'Yes, we have dedicated vegan and gluten-free items on our menu.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'friendly', behavior: 'service', language: 'en' },
          goals: ['Book table reservations', 'Explain menu items', 'Provide opening hours']
        }
      },
      {
        id: 'tpl-dentist',
        name: 'Dental & Health Clinic',
        businessType: 'dentist',
        icon: 'Stethoscope',
        description: 'Professional assistant for dental clinics. Schedules consultations, cleanings, and emergency inquiries.',
        defaultServices: [
          { id: 's1', name: 'Dental Checkup & Cleaning', price: 600000, durationMinutes: 30, description: 'General oral examination and teeth cleaning.' },
          { id: 's2', name: 'Consultation & X-Ray', price: 400000, durationMinutes: 20, description: 'Diagnostic consultation.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'What should I do in a dental emergency?', answer: 'Call our direct emergency line or visit the clinic during emergency hours.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'professional', behavior: 'service', language: 'en' },
          goals: ['Book consultations', 'Explain clinic procedures', 'Handoff medical emergencies']
        }
      },
      {
        id: 'tpl-mechanic',
        name: 'Auto Repair & Mechanic',
        businessType: 'mechanic',
        icon: 'Wrench',
        description: 'Handles vehicle inspection bookings, service cost estimates, and repair status checks.',
        defaultServices: [
          { id: 's1', name: 'Oil Change & Safety Inspection', price: 400000, durationMinutes: 30, description: 'Engine oil replacement and 20-point safety check.' },
          { id: 's2', name: 'Brake Pad Replacement', price: 800000, durationMinutes: 60, description: 'Front or rear brake pad replacement.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'How long does an oil change take?', answer: 'An oil change typically takes 30 to 45 minutes.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'concise', behavior: 'service', language: 'en' },
          goals: ['Book service slots', 'Provide estimate ranges', 'Track vehicle status']
        }
      },
      {
        id: 'tpl-retail',
        name: 'Local Retail & Boutique',
        businessType: 'retail',
        icon: 'ShoppingBag',
        description: 'E-commerce and physical retail assistant. Answers product questions, checks inventory, and processes orders.',
        defaultServices: [
          { id: 's1', name: 'Personal Shopping Consultation', price: 0, durationMinutes: 30, description: 'In-store personal stylist appointment.' }
        ],
        defaultFaqs: [
          { id: 'f1', question: 'What is your return policy?', answer: 'Items can be returned within 7 days with original receipt.' }
        ],
        defaultAgentConfig: {
          personality: { tone: 'energetic', behavior: 'sales', language: 'en' },
          goals: ['Search products', 'Check stock inventory', 'Take pickup orders']
        }
      }
    );

    // 11. Initial Audit Logs & Usage
    this.auditLogs.push(
      {
        id: 'log-1',
        businessId: 'biz-tonys-barber',
        agentId: 'agent-tonys-1',
        action: 'AGENT_DEPLOYED',
        details: "Tony's AI Receptionist v1 set to ACTIVE state.",
        timestamp: new Date().toISOString()
      }
    );

    this.usageRecords.push(
      {
        id: 'usr-1',
        businessId: 'biz-tonys-barber',
        date: todayStr,
        tokensUsed: 4250,
        estimatedCostUsd: 0.0085,
        requestsCount: 14,
        voiceMinutes: 0,
        smsCount: 0
      }
    );
  }
}

export const db = new InMemoryDatabase();
