import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Agent versioning lifecycle tests (Phase 4):
 *  - creating an agent creates an initial DRAFT version
 *  - editing a DRAFT never changes the live (published) agent config
 *  - publishing promotes a draft to PUBLISHED, archives the prior published
 *  - only ONE published version exists at a time
 *  - rollback re-issues a previously-published config as the new published
 *  - cross-tenant access to another business's version endpoints is blocked
 *
 * Drives the real HTTP API + authenticated sessions (no mocks).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-ver-'));
process.env.DB_PATH = path.join(tmpDir, 'ver.db');
process.env.SESSION_SECRET = 'test-version-secret';
delete process.env.GEMINI_API_KEY;

const { router } = await import('../src/server/routes');
const { db } = await import('../src/server/db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

const app = makeApp();
const platformAgent = request.agent(app);
const tonyAgent = request.agent(app);

const tonyAgentId = 'agent-tonys-1';

beforeAll(async () => {
  await db.init();
  await platformAgent.post('/api/auth/login').send({ email: 'owner@agentfactory.io', password: 'Password123!' });
  const tonyLogin = await tonyAgent.post('/api/auth/login').send({ email: 'tony@tonysbarber.com', password: 'Password123!' });
  expect(tonyLogin.status).toBe(200);
});
afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('agent versioning lifecycle', () => {
  it('the seeded agent has exactly one PUBLISHED version', async () => {
    const res = await tonyAgent.get(`/api/agents/${tonyAgentId}/versions`);
    expect(res.status).toBe(200);
    const versions = res.body;
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const published = versions.filter((v: any) => v.status === 'PUBLISHED');
    expect(published).toHaveLength(1);
  });

  it('editing a draft does NOT change the live published config', async () => {
    const before = await tonyAgent.get(`/api/agents/${tonyAgentId}`);
    const livePromptBefore = before.body.systemPrompt;

    const draftRes = await tonyAgent.post(`/api/agents/${tonyAgentId}/versions`).send({ changeNote: 'test draft' });
    expect(draftRes.status).toBe(201);
    const draftId = draftRes.body.id;
    expect(draftRes.body.status).toBe('DRAFT');

    const edited = await tonyAgent.put(`/api/agents/${tonyAgentId}/versions/${draftId}`).send({
      systemPrompt: 'DRAFT-ONLY PROMPT - should never be live'
    });
    expect(edited.status).toBe(200);
    expect(edited.body.systemPrompt).toBe('DRAFT-ONLY PROMPT - should never be live');

    const after = await tonyAgent.get(`/api/agents/${tonyAgentId}`);
    expect(after.body.systemPrompt).toBe(livePromptBefore);
    expect(after.body.systemPrompt).not.toContain('DRAFT-ONLY');

    const pubRes = await tonyAgent.get(`/api/agents/${tonyAgentId}/versions/published`);
    expect(pubRes.body.systemPrompt).toBe(livePromptBefore);
  });

  it('publishing promotes the draft and archives the prior published version', async () => {
    const versionsBefore = await tonyAgent.get(`/api/agents/${tonyAgentId}/versions`);
    const publishedBefore = versionsBefore.body.find((v: any) => v.status === 'PUBLISHED');
    const draft = versionsBefore.body.find((v: any) => v.status === 'DRAFT');
    expect(draft).toBeTruthy();

    const pubRes = await tonyAgent.post(`/api/agents/${tonyAgentId}/versions/${draft.id}/publish`);
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.status).toBe('PUBLISHED');

    const versionsAfter = await tonyAgent.get(`/api/agents/${tonyAgentId}/versions`);
    const publishedNow = versionsAfter.body.filter((v: any) => v.status === 'PUBLISHED');
    expect(publishedNow).toHaveLength(1);
    expect(publishedNow[0].id).toBe(draft.id);
    const archived = versionsAfter.body.find((v: any) => v.id === publishedBefore.id);
    expect(archived.status).toBe('ARCHIVED');

    const agent = await tonyAgent.get(`/api/agents/${tonyAgentId}`);
    expect(agent.body.systemPrompt).toContain('DRAFT-ONLY');
    expect(agent.body.version).toBe(draft.versionNumber);
  });

  it('cannot edit a PUBLISHED or ARCHIVED version directly', async () => {
    const versions = await tonyAgent.get(`/api/agents/${tonyAgentId}/versions`);
    const pub = versions.body.find((v: any) => v.status === 'PUBLISHED');
    const arch = versions.body.find((v: any) => v.status === 'ARCHIVED');

    const editPub = await tonyAgent.put(`/api/agents/${tonyAgentId}/versions/${pub.id}`).send({ systemPrompt: 'hack' });
    expect(editPub.status).toBe(400);
    const editArch = await tonyAgent.put(`/api/agents/${tonyAgentId}/versions/${arch.id}`).send({ systemPrompt: 'hack' });
    expect(editArch.status).toBe(400);
  });

  it('rollback restores a previous version as the new published config', async () => {
    const versions = await tonyAgent.get(`/api/agents/${tonyAgentId}/versions`);
    const archivedOriginal = versions.body.find((v: any) => v.status === 'ARCHIVED');
    const originalPrompt = archivedOriginal.systemPrompt;

    const rollback = await tonyAgent.post(`/api/agents/${tonyAgentId}/versions/${archivedOriginal.id}/rollback`);
    expect(rollback.status).toBe(200);
    expect(rollback.body.status).toBe('PUBLISHED');

    const agent = await tonyAgent.get(`/api/agents/${tonyAgentId}`);
    expect(agent.body.systemPrompt).toBe(originalPrompt);
  });

  it('cross-tenant access to another business\'s version endpoints is blocked', async () => {
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'Version Isolation Co', type: 'retail', services: [{ name: 'Consult', price: 100, durationMinutes: 30, description: 'x' }]
    });
    const agentB = await platformAgent.post('/api/agents').send({
      businessId: bizB.body.id, name: 'Agent B'
    });

    const cross = await tonyAgent.get(`/api/agents/${agentB.body.id}/versions`);
    expect([403, 404]).toContain(cross.status);

    const crossPub = await tonyAgent.post(`/api/agents/${agentB.body.id}/versions/anything/publish`);
    expect([403, 404]).toContain(crossPub.status);
  });

  // IDOR regression (audit P0): the version mutation routes authorize the
  // parent :id (agent) via requireResourceAccess, but the :versionId was NOT
  // verified to belong to that agent. A tenant authorized for agent A could
  // supply A's id in the path and B's version id in :versionId, and the
  // mutation would act on B's version (publish/rollback/archive/edit B's config
  // across the tenant boundary). Each mutation must now reject a foreign
  // version id with 400/404 and leave B's version untouched.
  it('rejects a foreign version id on every version mutation (IDOR guard)', async () => {
    // Business B with its own agent + a DRAFT version to target.
    const bizB = await platformAgent.post('/api/businesses').send({
      name: 'IDOR Target Co', type: 'retail', services: [{ name: 'Consult', price: 100, durationMinutes: 30, description: 'x' }]
    });
    const agentB = await platformAgent.post('/api/agents').send({
      businessId: bizB.body.id, name: 'Agent B IDOR'
    });
    // Agent B's initial draft (Platform owner creates it so it belongs to B).
    const bVersions = await platformAgent.get(`/api/agents/${agentB.body.id}/versions`);
    const bDraft = bVersions.body.find((v: any) => v.status === 'DRAFT') || bVersions.body[0];
    expect(bDraft).toBeTruthy();
    const bDraftPromptBefore = bDraft.systemPrompt;

    // Tony is authorized for HIS agent (agent-tonys-1), but supplies B's version id.
    const tonyAgentIdLocal = tonyAgentId;

    // publish B's version via Tony's agent path -> must be rejected.
    const pub = await tonyAgent.post(`/api/agents/${tonyAgentIdLocal}/versions/${bDraft.id}/publish`);
    expect(pub.status).toBeGreaterThanOrEqual(400);
    expect(pub.status).toBeLessThanOrEqual(404);

    // rollback to B's version via Tony's agent path -> rejected.
    const rb = await tonyAgent.post(`/api/agents/${tonyAgentIdLocal}/versions/${bDraft.id}/rollback`);
    expect(rb.status).toBeGreaterThanOrEqual(400);
    expect(rb.status).toBeLessThanOrEqual(404);

    // archive B's version via Tony's agent path -> rejected.
    const arch = await tonyAgent.post(`/api/agents/${tonyAgentIdLocal}/versions/${bDraft.id}/archive`);
    expect(arch.status).toBeGreaterThanOrEqual(400);
    expect(arch.status).toBeLessThanOrEqual(404);

    // move B's version to TESTING via Tony's agent path -> rejected.
    const test = await tonyAgent.post(`/api/agents/${tonyAgentIdLocal}/versions/${bDraft.id}/test`);
    expect(test.status).toBeGreaterThanOrEqual(400);
    expect(test.status).toBeLessThanOrEqual(404);

    // edit B's draft via Tony's agent path -> rejected.
    const edit = await tonyAgent.put(`/api/agents/${tonyAgentIdLocal}/versions/${bDraft.id}`).send({
      systemPrompt: 'INJECTED BY TONY'
    });
    expect(edit.status).toBeGreaterThanOrEqual(400);
    expect(edit.status).toBeLessThanOrEqual(404);

    // create-draft FROM B's version via Tony's agent path -> rejected.
    const draft = await tonyAgent.post(`/api/agents/${tonyAgentIdLocal}/versions`).send({
      fromVersionId: bDraft.id
    });
    expect(draft.status).toBeGreaterThanOrEqual(400);

    // evaluate B's version via Tony's agent path -> rejected (404).
    const evalRes = await tonyAgent.post(`/api/agents/${tonyAgentIdLocal}/versions/${bDraft.id}/evaluate`).send({
      scenarios: [{ id: 's1', name: 's1', userMessage: 'hi', dimension: 'helpfulness' }]
    });
    expect(evalRes.status).toBe(404);

    // Invariant: B's version is UNCHANGED (no cross-tenant write occurred).
    const bVersionsAfter = await platformAgent.get(`/api/agents/${agentB.body.id}/versions`);
    const bDraftAfter = bVersionsAfter.body.find((v: any) => v.id === bDraft.id);
    expect(bDraftAfter).toBeTruthy();
    expect(bDraftAfter.status).toBe(bDraft.status);
    expect(bDraftAfter.systemPrompt).toBe(bDraftPromptBefore);
    expect(bDraftAfter.systemPrompt).not.toBe('INJECTED BY TONY');
  });
});
