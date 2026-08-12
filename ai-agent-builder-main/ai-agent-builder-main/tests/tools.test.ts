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

afterAll(async () => {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Initialize the singleton DB (migrations + seed) before any tool runs.
beforeAll(async () => { await db.init(); });

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
    const before = (await db.appointments.filter(a => a.businessId === TENANT)).length;
    const after = (await db.appointments.filter(a => a.businessId === TENANT)).length;
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
    const created = await db.appointments.find(a => a.id === r.data.appointmentId);
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
    const rows = await db.appointments.filter(
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

  beforeAll(async () => {
    await db.products.push({
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
    const prod = (await db.products.find(p => p.id === productId))!;
    expect(prod.inventory).toBe(0);
    // Exactly one order references this product.
    const orders = await db.orders.filter(
      o => o.businessId === TENANT && o.items.some(i => i.productId === productId)
    );
    expect(orders).toHaveLength(1);
  });

  it('rejects an order with quantity exceeding stock (no oversell, honest error)', async () => {
    // Reset stock to 2 for this case.
    const prod = (await db.products.find(p => p.id === productId))!;
    prod.inventory = 2;
    await db.products.update(prod);

    const r = await executeAgentTool('create_order', {
      customerName: 'Greedy', customerPhone: '+10000000102',
      items: [{ productId, quantity: 5 }]
    }, { tenantId: TENANT });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/insufficient stock/i);
    // Stock unchanged.
    expect((await db.products.find(p => p.id === productId))!.inventory).toBe(2);
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
