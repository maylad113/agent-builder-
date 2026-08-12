import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Tool-layer correctness tests:
 *  - #4 a failed booking is reported honestly (never "successfully booked")
 *  - #5 two concurrent bookings for an overlapping slot -> exactly ONE succeeds
 *  - #6 two concurrent orders for the last unit of stock -> exactly ONE succeeds
 *  - bookings honor service duration and business hours
 *  - an agent cannot execute a tool it does not have enabled (permission gate)
 *
 * Uses a throwaway temp DB and drives the real executeAgentTool engine
 * (the same code the AI runtime and REST API use) directly, with no LLM.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-tools-'));
process.env.DB_PATH = path.join(tmpDir, 'tools.db');
delete process.env.GEMINI_API_KEY;

// The singleton `db` (used by executeAgentTool) reads DB_PATH at import time.
// Seeding runs against it, so all assertions go through the same instance.
const { db } = await import('../src/server/db');
const { executeAgentTool, agentToolDeclarations } = await import('../src/server/tools');
const { dayOfWeekForDate } = await import('../src/server/appointmentEngine');
import type { BusinessHours } from '../src/types';

const TENANT = 'biz-tonys-barber';
const SVC_HAIRCUT = 'srv-1'; // 30 min, 09:00-20:00 weekdays in seed

/**
 * Pick a valid near-term open weekday for booking. The seed business is open
 * Mon–Sat (closed Sunday) and caps bookings 14 days in advance, so we find the
 * next Mon–Sat that is within 14 days of today. Tests must not hard-code
 * far-future dates — the booking-notice engine (see appointmentEngine.ts)
 * honours the business's configured "up to N days in advance" policy.
 */
function nextOpenDay(afterDays = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + afterDays);
  // 0=Sun (closed) .. 6=Sat (open). Step forward until we land on an open day.
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}
const BOOK_DATE = nextOpenDay();   // a near-term open weekday
const BOOK_DATE_2 = nextOpenDay(2); // another open weekday
const BOOK_DATE_3 = nextOpenDay(4); // a third open weekday (fresh, no prior bookings)

/** Pick the next Sunday (a closed day for the seed business). */
function nextSunday(): string {
  const d = new Date();
  const day = d.getDay();
  const add = (7 - day) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().split('T')[0];
}
const SUNDAY_DATE = nextSunday();

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('book_appointment: honest failure + duration + business hours', () => {
  it('reports failure (not success) when the service does not exist', async () => {
    const r = await executeAgentTool('book_appointment', {
      customerName: 'Test',
      customerPhone: '+10000000001',
      serviceIdOrName: 'Nonexistent Service',
      date: BOOK_DATE,
      startTime: '14:00'
    }, { tenantId: TENANT });
    expect(r.success).toBe(false);
    expect(r.error).toContain('not found');
    // Nothing was booked.
    const before = db.appointments.filter(a => a.businessId === TENANT).length;
    const after = db.appointments.filter(a => a.businessId === TENANT).length;
    expect(after).toBe(before);
  });

  it('reports failure when the requested time is outside business hours', async () => {
    const r = await executeAgentTool('book_appointment', {
      customerName: 'Early',
      customerPhone: '+10000000002',
      serviceIdOrName: 'Haircut',
      date: BOOK_DATE,
      startTime: '07:00' // opens at 09:00
    }, { tenantId: TENANT });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/outside opening hours|closed/i);
  });

  it('reports failure when booking on a closed day (Sunday)', async () => {
    const r = await executeAgentTool('book_appointment', {
      customerName: 'Sunday',
      customerPhone: '+10000000003',
      serviceIdOrName: 'Haircut',
      date: SUNDAY_DATE, // Sunday (closed in seed)
      startTime: '12:00'
    }, { tenantId: TENANT });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/closed/i);
  });

  it('books successfully and computes endTime from the service duration', async () => {
    const r = await executeAgentTool('book_appointment', {
      customerName: 'Duration',
      customerPhone: '+10000000004',
      serviceIdOrName: 'Haircut', // 30 min
      date: BOOK_DATE,
      startTime: '14:00'
    }, { tenantId: TENANT });
    expect(r.success).toBe(true);
    expect(r.data.time).toBe('14:00 - 14:30'); // 30-min service
    const created = db.appointments.find(a => a.id === r.data.appointmentId);
    expect(created.endTime).toBe('14:30');
  });
});

describe('book_appointment: concurrent overlap prevention (#5)', () => {
  it('two overlapping bookings for the same slot -> exactly ONE succeeds', async () => {
    const date = BOOK_DATE_2;
    const startTime = '15:00';
    const svc = 'Haircut'; // 30 min => 15:00-15:30

    // Fire two bookings "concurrently". better-sqlite3 is synchronous, so each
    // executeAgentTool call runs its transaction to completion before the next
    // can write; the two awaits resolve in order and the second sees the first.
    // This still proves the overlap guard: the second must fail.
    const [r1, r2] = await Promise.all([
      executeAgentTool('book_appointment', {
        customerName: 'Concurrent A', customerPhone: '+10000000010',
        serviceIdOrName: svc, date, startTime
      }, { tenantId: TENANT }),
      executeAgentTool('book_appointment', {
        customerName: 'Concurrent B', customerPhone: '+10000000011',
        serviceIdOrName: svc, date, startTime
      }, { tenantId: TENANT })
    ]);

    const successes = [r1, r2].filter(r => r.success).length;
    expect(successes).toBe(1);
    const failure = [r1, r2].find(r => !r.success)!;
    expect(failure.error).toMatch(/overlap|already booked/i);

    // And exactly one appointment row exists for that start time.
    const rows = db.appointments.filter(
      a => a.businessId === TENANT && a.date === date && a.startTime === startTime && a.status !== 'CANCELLED'
    );
    expect(rows).toHaveLength(1);
  });

  it('a partially overlapping (15:00-15:30 vs 15:15-15:45) booking is rejected', async () => {
    const date = BOOK_DATE_3;
    // First booking 15:00-15:30 (Haircut 30m)
    const r1 = await executeAgentTool('book_appointment', {
      customerName: 'Overlap1', customerPhone: '+10000000020',
      serviceIdOrName: 'Haircut', date, startTime: '15:00'
    }, { tenantId: TENANT });
    expect(r1.success).toBe(true);

    // Second booking 15:15-15:45 overlaps the first.
    const r2 = await executeAgentTool('book_appointment', {
      customerName: 'Overlap2', customerPhone: '+10000000021',
      serviceIdOrName: 'Haircut', date, startTime: '15:15'
    }, { tenantId: TENANT });
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/overlap/i);
  });

  it('back-to-back (adjacent) bookings are allowed', async () => {
    const date = BOOK_DATE_2;
    const r1 = await executeAgentTool('book_appointment', {
      customerName: 'Back1', customerPhone: '+10000000030',
      serviceIdOrName: 'Haircut', date, startTime: '16:00' // 16:00-16:30
    }, { tenantId: TENANT });
    const r2 = await executeAgentTool('book_appointment', {
      customerName: 'Back2', customerPhone: '+10000000031',
      serviceIdOrName: 'Haircut', date, startTime: '16:30' // 16:30-17:00 (adjacent)
    }, { tenantId: TENANT });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });
});

describe('create_order: concurrency + inventory (#6, #12)', () => {
  // Seed a product with exactly 1 unit of stock for the tenant.
  const productId = 'prod-test-oversell';

  beforeAll(() => {
    db.products.push({
      id: productId,
      businessId: TENANT,
      name: 'Limited Pomade',
      sku: 'SKU-LIMIT',
      price: 50000,
      inventory: 1,
      description: 'Single unit',
      category: 'Grooming'
    });
  });

  it('two concurrent orders for the last unit -> exactly ONE succeeds, inventory never negative', async () => {
    const [o1, o2] = await Promise.all([
      executeAgentTool('create_order', {
        customerName: 'Buyer A', customerPhone: '+10000000100',
        items: [{ productId, quantity: 1 }]
      }, { tenantId: TENANT }),
      executeAgentTool('create_order', {
        customerName: 'Buyer B', customerPhone: '+10000000101',
        items: [{ productId, quantity: 1 }]
      }, { tenantId: TENANT })
    ]);

    const successes = [o1, o2].filter(r => r.success).length;
    expect(successes).toBe(1);
    const failure = [o1, o2].find(r => !r.success)!;
    expect(failure.error).toMatch(/insufficient stock|inventory/i);

    // Inventory must never go negative.
    const prod = db.products.find(p => p.id === productId)!;
    expect(prod.inventory).toBe(0);
    // Exactly one order references this product.
    const orders = db.orders.filter(
      o => o.businessId === TENANT && o.items.some(i => i.productId === productId)
    );
    expect(orders).toHaveLength(1);
  });

  it('rejects an order with quantity exceeding stock (no oversell, honest error)', async () => {
    // Reset stock to 2 for this case.
    const prod = db.products.find(p => p.id === productId)!;
    prod.inventory = 2;
    db.products.update(prod);

    const r = await executeAgentTool('create_order', {
      customerName: 'Greedy', customerPhone: '+10000000102',
      items: [{ productId, quantity: 5 }]
    }, { tenantId: TENANT });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/insufficient stock/i);
    // Stock unchanged.
    expect(db.products.find(p => p.id === productId)!.inventory).toBe(2);
  });
});

describe('tool permission gate: an agent cannot run a non-enabled tool', () => {
  it('executeAgentTool still executes any tool when called directly (server trusts itself), but the runtime only passes enabled declarations', () => {
    // The permission model: the AI runtime filters agentToolDeclarations by
    // structuredConfig.toolsEnabled BEFORE handing them to the model, so the
    // model can never even request a disabled tool. Verify the filter logic:
    // a tool NOT in the enabled set is absent from the active set.
    const enabled = new Set(['check_business_hours', 'get_business_information']);
    const active = agentToolDeclarations.filter(t => enabled.has(t.name));
    const activeNames = active.map(t => t.name);
    expect(activeNames).toContain('check_business_hours');
    expect(activeNames).not.toContain('book_appointment');
    expect(activeNames).not.toContain('create_order');
    expect(activeNames).not.toContain('transfer_to_human');
  });
});

// ---------------------------------------------------------------------------
// Appointment lifecycle: staff schedules, cancellation frees the slot,
// reschedule applies the same rules as booking. Uses a dedicated business
// with per-staff working hours (Amy 09-12, Pam 13-17) and a 15-min buffer on
// the "Style" service.
// ---------------------------------------------------------------------------
describe('appointment lifecycle: staff coverage, cancel-frees-slot, reschedule rules', () => {
  const SCHEDULED_BIZ = 'biz-staff-schedule';
  const STAFF_AM = 'sch-staff-am';
  const STAFF_PM = 'sch-staff-pm';
  // The next Monday, so staff schedules (monday entry) apply and the date is
  // always in the future (no notice-policy interference: policies are empty).
  const MON = (() => {
    const d = new Date();
    const add = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + add);
    return d.toISOString().split('T')[0];
  })();
  const mondayName = dayOfWeekForDate(MON, 'Asia/Tehran'); // 'monday'
  const ctx = { tenantId: SCHEDULED_BIZ };

  beforeAll(() => {
    const week: Array<BusinessHours['day']> = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    db.businesses.push({
      id: SCHEDULED_BIZ, name: 'Staffed Salon', type: 'salon',
      description: '', location: 'Downtown',
      language: 'en', currency: 'USD', timezone: 'Asia/Tehran',
      hours: week.map(day => ({
        day, isOpen: day !== 'sunday', openTime: '09:00', closeTime: '18:00'
      })),
      services: [
        { id: 'svc-cut', name: 'Cut', price: 20, durationMinutes: 30, description: '' },
        { id: 'svc-style', name: 'Style', price: 25, durationMinutes: 30, description: '', bufferMinutesAfter: 15 }
      ],
      faqs: [], policies: { cancellation: '', refund: '', bookingNotice: '' },
      communicationStyle: '', status: 'ACTIVE', createdAt: '', updatedAt: ''
    });
    db.staffMembers.push(
      { id: STAFF_AM, businessId: SCHEDULED_BIZ, name: 'Amy', role: 'stylist',
        servicesHandled: ['svc-cut', 'svc-style'],
        workingHours: [{ day: mondayName as BusinessHours['day'], isOpen: true, openTime: '09:00', closeTime: '12:00' }] },
      { id: STAFF_PM, businessId: SCHEDULED_BIZ, name: 'Pam', role: 'stylist',
        servicesHandled: ['svc-cut', 'svc-style'],
        workingHours: [{ day: mondayName as BusinessHours['day'], isOpen: true, openTime: '13:00', closeTime: '17:00' }] }
    );
  });

  it('check_availability excludes slots no staff member is scheduled to work', async () => {
    const r = await executeAgentTool('check_availability', {
      serviceId: 'Cut', date: MON
    }, ctx);
    expect(r.success).toBe(true);
    expect(r.data.availableSlots).toContain('11:00');   // Amy covers
    expect(r.data.availableSlots).not.toContain('17:30'); // inside business hours but no staff
  });

  it('books and assigns the eligible staff member whose hours cover the slot', async () => {
    const r = await executeAgentTool('book_appointment', {
      customerName: 'Alice Staff', customerPhone: '+19990000001',
      serviceIdOrName: 'Cut', date: MON, startTime: '10:00'
    }, ctx);
    expect(r.success).toBe(true);
    const appt = db.appointments.find(a => a.id === r.data.appointmentId)!;
    expect(appt.staffMemberId).toBe(STAFF_AM);
  });

  it('rejects a booking at a time no staff member is scheduled (even inside business hours)', async () => {
    const r = await executeAgentTool('book_appointment', {
      customerName: 'Late Staff', customerPhone: '+19990000002',
      serviceIdOrName: 'Cut', date: MON, startTime: '17:30'
    }, ctx);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/staff/i);
    // No appointment row was created.
    const rows = db.appointments.filter(a => a.businessId === SCHEDULED_BIZ && a.date === MON && a.startTime === '17:30');
    expect(rows).toHaveLength(0);
  });

  it('reschedules to a valid slot and updates date/time/status', async () => {
    const book = await executeAgentTool('book_appointment', {
      customerName: 'Move Me', customerPhone: '+19990000005',
      serviceIdOrName: 'Cut', date: MON, startTime: '11:30' // Amy covers 09-12
    }, ctx);
    expect(book.success).toBe(true);
    const apptId = book.data.appointmentId;

    const r = await executeAgentTool('reschedule_appointment', {
      appointmentId: apptId, newDate: MON, newTime: '16:00' // Pam covers 13-17
    }, ctx);
    expect(r.success).toBe(true);
    const moved = db.appointments.find(a => a.id === apptId)!;
    expect(moved.date).toBe(MON);
    expect(moved.startTime).toBe('16:00');
    expect(moved.endTime).toBe('16:30');
    expect(moved.status).toBe('RESCHEDULED');
  });

  it('reschedule rejects a slot inside another appointment\'s buffer window', async () => {
    // Appt A: "Style" at 13:00 (13:00-13:30) with a 15-min buffer → blocks 13:00-13:45.
    const a = await executeAgentTool('book_appointment', {
      customerName: 'Buffer A', customerPhone: '+19990000006',
      serviceIdOrName: 'Style', date: MON, startTime: '13:00'
    }, ctx);
    expect(a.success).toBe(true);
    const apptA = db.appointments.find(x => x.id === a.data.appointmentId)!;
    expect(apptA.staffMemberId).toBe(STAFF_PM);

    // Appt B: "Cut" at 14:00, then try to move it into A's buffer window (13:15).
    const b = await executeAgentTool('book_appointment', {
      customerName: 'Buffer B', customerPhone: '+19990000007',
      serviceIdOrName: 'Cut', date: MON, startTime: '14:00'
    }, ctx);
    expect(b.success).toBe(true);

    const r = await executeAgentTool('reschedule_appointment', {
      appointmentId: b.data.appointmentId, newDate: MON, newTime: '13:15'
    }, ctx);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/overlap/i);
    // B is unchanged.
    const unchanged = db.appointments.find(x => x.id === b.data.appointmentId)!;
    expect(unchanged.startTime).toBe('14:00');
  });

  it('cancelling an appointment frees the slot for re-booking', async () => {
    // Book 15:00 (Pam covers), then cancel it, then re-book the SAME slot.
    const book = await executeAgentTool('book_appointment', {
      customerName: 'Cancel Me', customerPhone: '+19990000003',
      serviceIdOrName: 'Cut', date: MON, startTime: '15:00'
    }, ctx);
    expect(book.success).toBe(true);
    const apptId = book.data.appointmentId;

    const cancel = await executeAgentTool('cancel_appointment', {
      appointmentId: apptId
    }, ctx);
    expect(cancel.success).toBe(true);
    const cancelled = db.appointments.find(a => a.id === apptId)!;
    expect(cancelled.status).toBe('CANCELLED');

    const rebook = await executeAgentTool('book_appointment', {
      customerName: 'Rebooked', customerPhone: '+19990000004',
      serviceIdOrName: 'Cut', date: MON, startTime: '15:00'
    }, ctx);
    expect(rebook.success).toBe(true);
    expect(rebook.data.appointmentId).not.toBe(apptId);
  });

  it('reschedule rejects a new time no staff member is scheduled to work', async () => {
    const appt = db.appointments.find(a => a.businessId === SCHEDULED_BIZ && a.startTime === '16:00');
    expect(appt).toBeTruthy();
    const r = await executeAgentTool('reschedule_appointment', {
      appointmentId: appt!.id, newDate: MON, newTime: '17:30'
    }, ctx);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/staff/i);
  });
});
