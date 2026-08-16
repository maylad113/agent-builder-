import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Concurrency / race-condition tests (Phase 9 & 10 / critical tests #5 and #6):
 *  - Two attempts to book the SAME overlapping appointment slot cannot both
 *    succeed (only one wins).
 *  - Two attempts to buy the LAST item of stock cannot oversell inventory.
 *
 * better-sqlite3 is synchronous, so the transactions serialize at the JS layer;
 * the guarantee under test is that the check-then-insert (appointments) and
 * check-then-decrement (orders) run inside a single SQLite transaction, so two
 * sequential tool calls cannot both observe a free slot / in-stock product.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-conc-'));
process.env.DB_PATH = path.join(tmpDir, 'conc.db');
process.env.SESSION_SECRET = 'test-conc-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { db } = await import('../src/server/db');
const { executeAgentTool, ALL_TOOL_NAMES } = await import('../src/server/tools');

const ctx = { tenantId: 'biz-tonys-barber', conversationId: 'conv-conc', channel: 'web_chat', toolsEnabled: ALL_TOOL_NAMES };

beforeAll(async () => {
  // The Tony seed business ships with a 30-min "Haircut" service (srv-1),
  // Monday hours 09:00-20:00, and products with small inventory.
  // Reset the relevant inventory so the order test is deterministic.
  await db.init();
  const p = await db.products.find(p => p.businessId === 'biz-tonys-barber' && p.id === 'prod-1');
  if (p) { p.inventory = 1; await db.products.update(p); }
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// Use a Monday far in the future that is open. The seed says Sunday closed.
const MONDAY_DATE = '2099-01-04'; // a Monday (2099-01-04 is a Sunday? verify below)

function nextMonday(): string {
  // Compute the next Monday as YYYY-MM-DD so the test is date-independent.
  const d = new Date();
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const add = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().split('T')[0];
}

describe('appointment overlap race (Phase 9 / critical #5)', () => {
  const date = nextMonday();

  it('first booking at 17:00 succeeds', async () => {
    const r = await executeAgentTool('book_appointment', {
      customerName: 'Alice Race', customerPhone: '+15550000001',
      serviceIdOrName: 'Haircut', date, startTime: '17:00'
    }, ctx);
    expect(r.success).toBe(true);
  });

  it('second booking overlapping 17:00-17:30 (at 17:15) is rejected', async () => {
    const r = await executeAgentTool('book_appointment', {
      customerName: 'Bob Race', customerPhone: '+15550000002',
      serviceIdOrName: 'Haircut', date, startTime: '17:15'
    }, ctx);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/overlap|existing appointment|another slot/i);
  });

  it('an adjacent back-to-back booking at 17:30 (no overlap) succeeds', async () => {
    const r = await executeAgentTool('book_appointment', {
      customerName: 'Carol Race', customerPhone: '+15550000003',
      serviceIdOrName: 'Haircut', date, startTime: '17:30'
    }, ctx);
    expect(r.success).toBe(true);
  });
});

describe('order oversell race (Phase 10 / critical #6)', () => {
  it('first order for the last unit succeeds', async () => {
    const r = await executeAgentTool('create_order', {
      customerName: 'Buyer One', customerPhone: '+15550000010',
      items: [{ productId: 'prod-1', quantity: 1 }]
    }, ctx);
    expect(r.success).toBe(true);
  });

  it('second order for now-out-of-stock unit is rejected (no oversell)', async () => {
    const r = await executeAgentTool('create_order', {
      customerName: 'Buyer Two', customerPhone: '+15550000011',
      items: [{ productId: 'prod-1', quantity: 1 }]
    }, ctx);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/stock|insufficient|out of/i);
  });

  it('inventory was decremented to exactly 0 (no negative inventory)', async () => {
    const p = await db.products.find(p => p.businessId === 'biz-tonys-barber' && p.id === 'prod-1');
    expect(p?.inventory).toBe(0);
  });
});
