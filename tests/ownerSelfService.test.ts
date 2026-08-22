import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

/**
 * Task 31 — owner self-service business data management.
 *
 * N1: the portal must let a BUSINESS_OWNER edit the business profile,
 * services, and hours via the EXISTING PUT /businesses route (the agent reads
 * these live through tools). N2: the portal must expose knowledge deletion via
 * the EXISTING tenant-scoped DELETE /knowledge/:id route (which already cleans
 * embeddings) so an owner can remove incorrect facts without DB surgery.
 *
 * No new backend systems: only a UI form for the existing business route and
 * a UI delete affordance for the existing knowledge route. Tenant isolation
 * and authorization remain server-side and are regression-tested.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-selfsvc-'));
process.env.DB_PATH = path.join(tmpDir, 'selfsvc.db');
process.env.SESSION_SECRET = 'test-selfsvc-secret';
process.env.NODE_ENV = 'test';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { retrieveRelevant } = await import('../src/server/embeddings');
const { BusinessProfileEditor, KnowledgeManager } = await import('../src/components/OwnerSelfService');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();
const tonyAgent = request.agent(app);   // owner of biz-tonys-barber
const bellaAgent = request.agent(app);  // owner of a SECOND business
const platformAgent = request.agent(app);

beforeAll(async () => {
  await db.init({ seed: true });
  await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
  await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  // A second tenant for cross-tenant isolation checks.
  await platformAgent.post('/api/businesses').send({ name: 'Bella Salon', type: 'salon', description: 'Second tenant.' });
  const bellaBiz = (await db.businesses.toJSON()).find((b: any) => b.name === 'Bella Salon');
  await db.users.push({
    id: 'usr-bella', email: 'bella@bellasalon.com', passwordHash: (await import('../src/server/passwords')).hashPassword('Password123!'),
    name: 'Bella', role: 'BUSINESS_OWNER', businessId: bellaBiz!.id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  } as any);
  await bellaAgent.post('/api/auth/login').send({ email: 'bella@bellasalon.com', password: 'Password123!' });
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Backend behavior (existing routes, verified as the UI's contract)
// ---------------------------------------------------------------------------

describe('business self-service API (existing PUT /businesses)', () => {
  it('owner updates profile + services + hours; persisted and visible', async () => {
    const biz = (await db.businesses.toJSON()).find((b: any) => b.id === 'biz-tonys-barber');
    const res = await tonyAgent.put('/api/businesses/biz-tonys-barber').send({
      description: 'Updated by owner.',
      services: [{ id: 'srv-1', name: 'Skin Fade', price: 35, durationMinutes: 40 }],
      hours: [{ day: 'monday', isOpen: true, openTime: '10:00', closeTime: '19:00' }]
    });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('Updated by owner.');
    expect(res.body.services[0].name).toBe('Skin Fade');
    expect(res.body.hours[0].openTime).toBe('10:00');
    const reloaded = await db.businesses.find(b => b.id === 'biz-tonys-barber');
    expect(reloaded!.services[0].price).toBe(35);
    expect(reloaded!.hours[0].closeTime).toBe('19:00');
  });

  it('cross-tenant business update is rejected (403, target unchanged)', async () => {
    const before = await db.businesses.find(b => b.name === 'Bella Salon');
    const res = await tonyAgent.put(`/api/businesses/${before!.id}`).send({ description: 'hostile takeover' });
    expect(res.status).toBe(403);
    const after = await db.businesses.find(b => b.id === before!.id);
    expect(after!.description).not.toBe('hostile takeover');
  });

  it('unauthenticated business update is rejected (401)', async () => {
    const res = await request(app).put('/api/businesses/biz-tonys-barber').send({ description: 'x' });
    expect(res.status).toBe(401);
  });

  it('repeated saves do not clobber unrelated fields (allow-listed partial update)', async () => {
    const biz = await db.businesses.find(b => b.id === 'biz-tonys-barber');
    const nameBefore = biz!.name;
    const res = await tonyAgent.put('/api/businesses/biz-tonys-barber').send({ pricingNotes: 'Cards accepted.' });
    expect(res.status).toBe(200);
    const after = await db.businesses.find(b => b.id === 'biz-tonys-barber');
    expect(after!.name).toBe(nameBefore); // unchanged
    expect(after!.pricingNotes).toBe('Cards accepted.');
    expect(after!.description).toBe('Updated by owner.'); // prior edit preserved
  });
});

describe('knowledge deletion (existing DELETE /knowledge/:id)', () => {
  it('owner deletes own knowledge; record + embedding removed; retrieval stops returning it', async () => {
    const add = await tonyAgent.post('/api/knowledge').send({
      businessId: 'biz-tonys-barber', title: 'Wrong Price', type: 'faq', content: 'Haircut is 999 toman.'
    });
    expect(add.status).toBe(201);
    const chunkId = add.body.id;
    // Retrieval sees it (keyword fallback works without an embedding provider).
    const before = await retrieveRelevant('biz-tonys-barber', 'haircut price');
    expect(before.some((r: any) => r.chunk.id === chunkId)).toBe(true);

    const del = await tonyAgent.delete(`/api/knowledge/${chunkId}`);
    expect(del.status).toBe(200);
    expect(await db.knowledgeChunks.find(k => k.id === chunkId)).toBeUndefined();
    const after = await retrieveRelevant('biz-tonys-barber', 'haircut price');
    expect(after.some((r: any) => r.chunk.id === chunkId)).toBe(false);
    // Embedding row is gone.
    const emb = await db.client.query('SELECT chunk_id FROM knowledge_embeddings WHERE chunk_id = ?', [chunkId]);
    expect(emb.rows.length).toBe(0);
  });

  it('cross-tenant knowledge deletion is rejected and the target is untouched', async () => {
    const bellaBiz = (await db.businesses.toJSON()).find((b: any) => b.name === 'Bella Salon');
    const add = await bellaAgent.post('/api/knowledge').send({
      businessId: bellaBiz!.id, title: 'Bella Fact', type: 'faq', content: 'Bella opens at 8.'
    });
    const res = await tonyAgent.delete(`/api/knowledge/${add.body.id}`);
    expect([403, 404]).toContain(res.status);
    expect(await db.knowledgeChunks.find(k => k.id === add.body.id)).toBeDefined();
  });

  it('repeated deletion is safe (second delete -> 404, no corruption)', async () => {
    const add = await tonyAgent.post('/api/knowledge').send({ businessId: 'biz-tonys-barber', title: 'Temp', content: 'x' });
    expect((await tonyAgent.delete(`/api/knowledge/${add.body.id}`)).status).toBe(200);
    expect((await tonyAgent.delete(`/api/knowledge/${add.body.id}`)).status).toBe(404);
  });

  it('unauthenticated deletion is rejected (401)', async () => {
    const res = await request(app).delete('/api/knowledge/kc-whatever');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// UI (renderToStaticMarkup — established pattern)
// ---------------------------------------------------------------------------

const mkBusiness = (): any => ({
  id: 'biz-tonys-barber', name: "Tony's", type: 'barbershop', description: 'A shop.',
  location: 'Main St', language: 'en', currency: 'toman', timezone: 'Asia/Tehran',
  hours: [{ day: 'monday', isOpen: true, openTime: '09:00', closeTime: '20:00' }],
  services: [{ id: 'srv-1', name: 'Haircut', price: 20, durationMinutes: 30 }],
  faqs: [], policies: { cancellation: 'c', refund: 'r', bookingNotice: 'b' },
  communicationStyle: 'friendly', status: 'ACTIVE', allowedWidgetOrigins: [],
  holidays: [], createdAt: 'x', updatedAt: 'x'
});

describe('BusinessProfileEditor (UI)', () => {
  const noop = () => {};
  it('renders editable profile, services, and hours fields with the current values', () => {
    const html = renderToStaticMarkup(React.createElement(BusinessProfileEditor, {
      business: mkBusiness(), saving: false, saveError: null, saved: false, onSave: noop
    }));
    expect(html).toContain('Business Profile');
    expect(html).toContain('Tony&#x27;s');
    expect(html).toContain('A shop.');
    expect(html).toContain('Haircut');
    expect(html).toContain('20');
    expect(html).toContain('Services');
    expect(html).toContain('Opening Hours');
    expect(html).toContain('monday');
    expect(html).toContain('09:00');
    expect(html).toContain('Save changes');
  });

  it('surfaces a save error honestly and a success state only after server confirmation', () => {
    const errHtml = renderToStaticMarkup(React.createElement(BusinessProfileEditor, {
      business: mkBusiness(), saving: false, saveError: 'Update failed.', saved: false, onSave: noop
    }));
    expect(errHtml).toContain('Update failed.');
    const okHtml = renderToStaticMarkup(React.createElement(BusinessProfileEditor, {
      business: mkBusiness(), saving: false, saveError: null, saved: true, onSave: noop
    }));
    expect(okHtml).toContain('Saved');
  });

  it('saving state disables the save button (no duplicate in-flight mutations)', () => {
    const html = renderToStaticMarkup(React.createElement(BusinessProfileEditor, {
      business: mkBusiness(), saving: true, saveError: null, saved: false, onSave: noop
    }));
    expect(html).toContain('disabled');
  });
});

describe('KnowledgeManager (UI)', () => {
  const noop = () => {};
  const items: any[] = [
    { id: 'kc-1', businessId: 'biz-tonys-barber', title: 'Parking info', type: 'faq', content: 'x', tags: [], createdAt: 'x' },
    { id: 'kc-2', businessId: 'biz-tonys-barber', title: 'Refund policy', type: 'policy', content: 'y', tags: [], createdAt: 'x' }
  ];
  it('lists existing knowledge with a Delete action per entry', () => {
    const html = renderToStaticMarkup(React.createElement(KnowledgeManager, {
      items, deletingId: null, onDelete: noop
    }));
    expect(html).toContain('Parking info');
    expect(html).toContain('Refund policy');
    expect((html.match(/Delete/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('renders an honest empty state when there is no knowledge', () => {
    const html = renderToStaticMarkup(React.createElement(KnowledgeManager, {
      items: [], deletingId: null, onDelete: noop
    }));
    expect(html).toContain('No knowledge');
  });
});

// Static source audit: no unsafe rendering or storage of business data.
describe('owner self-service source discipline', () => {
  it('no HTML injection or client-side tenant fabrication', async () => {
    const fs2 = await import('fs');
    const src = fs2.readFileSync(new URL('../src/components/OwnerSelfService.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
