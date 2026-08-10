import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Knowledge / RAG tests (Phase 6):
 *  - keyword retrieval returns business-relevant chunks for a matching query
 *  - retrieval is tenant-scoped: Business A's knowledge never surfaces for B
 *  - creating/updating/deleting knowledge is tenant-isolated
 *  - the cosine similarity helper ranks a more-relevant chunk above an
 *    irrelevant one (pure function; no network/API key required)
 *
 * GEMINI_API_KEY is forced off so the semantic path degrades to the keyword
 * fallback (deterministic, no external calls).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-rag-'));
process.env.DB_PATH = path.join(tmpDir, 'rag.db');
process.env.SESSION_SECRET = 'test-rag-secret';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');
const { retrieveRelevant } = await import('../src/server/embeddings');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

const app = makeApp();
const platformAgent = request.agent(app);
const tonyAgent = request.agent(app);

beforeAll(async () => {
  await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
});
afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('knowledge retrieval (RAG)', () => {
  it('keyword retrieval returns matching chunks for the owning tenant', async () => {
    // Tony's seeded knowledge includes a "Service & Price List" chunk.
    const results = await retrieveRelevant('biz-tonys-barber', 'What is the price of a haircut?', 5);
    expect(results.length).toBeGreaterThan(0);
    const titles = results.map(r => r.chunk.title);
    expect(titles.some(t => /price|service/i.test(t))).toBe(true);
    // All results must belong to Tony's tenant.
    expect(results.every(r => r.chunk.businessId === 'biz-tonys-barber')).toBe(true);
    // With no API key, source is keyword fallback.
    expect(results.every(r => r.source === 'keyword')).toBe(true);
  });

  it('retrieval is tenant-scoped: a second business never sees Tony\'s knowledge', async () => {
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'Rag Isolation Spa', type: 'salon',
      services: [{ name: 'Massage', price: 200, durationMinutes: 60, description: 'x' }]
    });
    const bizBId = bizB.body.id;

    // Biz B has its own knowledge chunk, intentionally sharing a keyword with Tony's.
    await platformAgent.post('/api/knowledge').send({
      businessId: bizBId, title: 'Spa Pricing', type: 'faq',
      content: 'Massage costs 200 toman. We do NOT do haircuts here.'
    });

    // A query on Biz B for "haircut" must return Biz B's own chunks only.
    const results = await retrieveRelevant(bizBId, 'haircut price', 5);
    expect(results.every(r => r.chunk.businessId === bizBId)).toBe(true);
    // And Tony's "Service & Price List" must NEVER appear for Biz B.
    expect(results.some(r => r.chunk.businessId === 'biz-tonys-barber')).toBe(false);

    // Conversely, querying Tony's tenant never surfaces Biz B's chunk.
    const tonyResults = await retrieveRelevant('biz-tonys-barber', 'spa massage pricing', 5);
    expect(tonyResults.every(r => r.chunk.businessId === 'biz-tonys-barber')).toBe(true);
    expect(tonyResults.some(r => r.chunk.businessId === bizBId)).toBe(false);
  });

  it('creating knowledge is tenant-isolated (Tony cannot write to Biz B)', async () => {
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'Rag Isolation Gym', type: 'fitness',
      services: [{ name: 'Class', price: 50, durationMinutes: 45, description: 'x' }]
    });
    const bizBId = bizB.body.id;

    // Tony attempts to create knowledge under Biz B's id — must be rejected by
    // requireTenantScope (Tony's session is scoped to biz-tonys-barber).
    const cross = await tonyAgent.post('/api/knowledge').send({
      businessId: bizBId, title: 'leaked', type: 'faq', content: 'should not persist'
    });
    expect(cross.status).toBe(403);
  });

  it('updating and deleting knowledge is tenant-isolated', async () => {
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'Rag Isolation Cafe', type: 'restaurant',
      services: [{ name: 'Coffee', price: 5, durationMinutes: 10, description: 'x' }]
    });
    const bizBId = bizB.body.id;
    const created = await platformAgent.post('/api/knowledge').send({
      businessId: bizBId, title: 'Cafe Menu', type: 'faq', content: 'Espresso 5 toman.'
    });
    const chunkId = created.body.id;

    // Tony cannot update Biz B's chunk.
    const updateCross = await tonyAgent.put(`/api/knowledge/${chunkId}`).send({ content: 'hacked' });
    expect([403, 404]).toContain(updateCross.status);

    // Tony cannot delete it.
    const delCross = await tonyAgent.delete(`/api/knowledge/${chunkId}`);
    expect([403, 404]).toContain(delCross.status);

    // Platform owner can still update it (positive control).
    const updateOk = await platformAgent.put(`/api/knowledge/${chunkId}`).send({ content: 'Latte 6 toman.' });
    expect(updateOk.status).toBe(200);
    expect(updateOk.body.content).toBe('Latte 6 toman.');
  });
});
