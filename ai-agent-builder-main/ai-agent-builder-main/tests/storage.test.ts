import { describe, it, expect, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Storage-layer persistence test.
 *
 * Uses a dynamic import so we can point the module-level `db` singleton (and
 * the default production DB path) at a throwaway temp file BEFORE the module
 * is evaluated — the test must never touch ./data/agentforge.db.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-storage-'));
process.env.DB_PATH = path.join(tmpDir, 'singleton.db');

const { AppDatabase } = await import('../src/server/db');

function testDbPath(name: string): string {
  return path.join(tmpDir, name);
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SQLite storage layer', () => {
  it('seeds the Tony\'s Barber Shop demo tenant (idempotently)', () => {
    const dbPath = testDbPath('seed.db');
    const db = new AppDatabase({ dbPath, seed: true });

    expect(db.businesses.length).toBe(1);
    const biz = db.businesses.find(b => b.id === 'biz-tonys-barber');
    expect(biz?.name).toBe("Tony's Barber Shop");
    expect(biz?.services).toHaveLength(3);
    expect(biz?.hours).toHaveLength(7);
    expect(db.agents.filter(a => a.businessId === 'biz-tonys-barber')).toHaveLength(1);
    expect(db.knowledgeChunks.filter(k => k.businessId === 'biz-tonys-barber')).toHaveLength(3);
    expect(db.customers.filter(c => c.businessId === 'biz-tonys-barber')).toHaveLength(2);
    expect(db.appointments.filter(a => a.businessId === 'biz-tonys-barber')).toHaveLength(2);
    expect(db.staffMembers.filter(s => s.businessId === 'biz-tonys-barber')).toHaveLength(2);
    expect(db.products.filter(p => p.businessId === 'biz-tonys-barber')).toHaveLength(2);
    expect(db.channels.filter(c => c.businessId === 'biz-tonys-barber')).toHaveLength(4);
    expect(db.integrations.filter(i => i.businessId === 'biz-tonys-barber')).toHaveLength(4);
    expect(db.templates.length).toBe(6);
    expect(db.conversations.length).toBe(1);
    expect(db.messages.filter(m => m.conversationId === 'conv-1')).toHaveLength(2);
    expect(db.usageRecords.length).toBe(1);
    expect(db.auditLogs.length).toBe(1);

    // Reopening with seed enabled must NOT duplicate the demo data.
    db.close();
    const dbAgain = new AppDatabase({ dbPath, seed: true });
    expect(dbAgain.businesses.length).toBe(1);
    dbAgain.close();
  });

  it('persists inserts + in-place updates across a full close/reopen', () => {
    const dbPath = testDbPath('persist.db');
    const db1 = new AppDatabase({ dbPath, seed: true });

    // Insert a new business.
    db1.businesses.push({
      id: 'biz-persist-1',
      name: 'Persistence Test Shop',
      type: 'salon',
      description: 'A shop created by the storage test.',
      location: 'Test Street 1',
      language: 'en',
      currency: '$',
      timezone: 'UTC',
      hours: [],
      services: [{ id: 'srv-x', name: 'Cut', price: 10, durationMinutes: 30, description: 'Test cut' }],
      faqs: [],
      policies: { cancellation: 'none', refund: 'none', bookingNotice: 'none' },
      communicationStyle: 'friendly',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Mutate the record in place (the pattern routes.ts/agentRuntime use) and persist via update().
    const created = db1.businesses.find(b => b.id === 'biz-persist-1');
    expect(created).toBeDefined();
    created!.name = 'Persistence Test Shop (renamed)';
    created!.services.push({ id: 'srv-y', name: 'Beard', price: 5, durationMinutes: 15, description: 'Test beard' });
    db1.businesses.update(created!);

    // A conversation + message + usage record, mimicking runtime writes.
    db1.conversations.push({
      id: 'conv-persist-1',
      businessId: 'biz-persist-1',
      customerId: 'cust-persist-1',
      customerName: 'Jane Doe',
      channel: 'web_chat',
      status: 'AI_HANDLING',
      summary: 'test',
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    db1.messages.push({
      id: 'msg-persist-1',
      conversationId: 'conv-persist-1',
      sender: 'customer',
      content: 'hello',
      channel: 'web_chat',
      timestamp: new Date().toISOString(),
    });

    db1.close();

    // Reopen with a brand-new connection (new Database instance) — everything must survive.
    const db2 = new AppDatabase({ dbPath, seed: false });
    const reread = db2.businesses.find(b => b.id === 'biz-persist-1');
    expect(reread?.name).toBe('Persistence Test Shop (renamed)');
    expect(reread?.services).toHaveLength(2);
    expect(reread?.services[1].name).toBe('Beard');
    expect(db2.conversations.find(c => c.id === 'conv-persist-1')?.status).toBe('AI_HANDLING');
    expect(db2.messages.filter(m => m.conversationId === 'conv-persist-1')).toHaveLength(1);

    // The seed data is still there too.
    expect(db2.businesses.find(b => b.id === 'biz-tonys-barber')?.name).toBe("Tony's Barber Shop");
    db2.close();
  });

  it('round-trips JSON, boolean, and numeric columns exactly', () => {
    const dbPath = testDbPath('shapes.db');
    const db1 = new AppDatabase({ dbPath, seed: true });

    // IntegrationConfig: booleans stored as 0/1, configData as JSON.
    const integ = db1.integrations.find(i => i.id === 'integ-1');
    integ!.connected = true;
    integ!.credentialsSet = true;
    integ!.configData = { calendarId: 'tonys@example.com' };
    db1.integrations.update(integ!);

    // Agent: structuredConfig as JSON.
    const agent = db1.agents.find(a => a.id === 'agent-tonys-1');
    agent!.structuredConfig.personality.tone = 'luxury';
    agent!.structuredConfig.toolsEnabled.push('create_order');
    db1.agents.update(agent!);

    // Appointment + usage numeric columns.
    const usage = db1.usageRecords.find(u => u.id === 'usr-1');
    usage!.tokensUsed = 9999;
    usage!.estimatedCostUsd = 12.34;
    db1.usageRecords.update(usage!);

    db1.close();

    const db2 = new AppDatabase({ dbPath, seed: false });
    const integ2 = db2.integrations.find(i => i.id === 'integ-1');
    expect(integ2?.connected).toBe(true);
    expect(integ2?.credentialsSet).toBe(true);
    expect(integ2?.configData).toEqual({ calendarId: 'tonys@example.com' });

    const agent2 = db2.agents.find(a => a.id === 'agent-tonys-1');
    expect(agent2?.structuredConfig.personality.tone).toBe('luxury');
    expect(agent2?.structuredConfig.toolsEnabled).toContain('create_order');

    const usage2 = db2.usageRecords.find(u => u.id === 'usr-1');
    expect(usage2?.tokensUsed).toBe(9999);
    expect(usage2?.estimatedCostUsd).toBe(12.34);
    db2.close();
  });
});
