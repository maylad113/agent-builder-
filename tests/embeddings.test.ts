import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Embedding provider abstraction + free-first RAG tests.
 *
 * The RAG pipeline must work WITHOUT a paid AI API. This suite proves:
 *   - The embedding provider seam resolves free-first (ollama when no Gemini key).
 *   - The Ollama adapter makes a REAL request to /api/embeddings (stubbed fetch)
 *     and returns {vector, model}; a down daemon returns null (no fabrication).
 *   - indexChunk stores the model that produced the vector.
 *   - retrieveRelevant only compares vectors from the SAME model as the query
 *     (a provider/model change never yields meaningless cross-model cosine).
 *   - With no provider available, retrieval degrades to the keyword fallback.
 *   - Tenant isolation holds: a tenant never retrieves another tenant's chunks.
 */

const ORIG_ENV = { ...process.env };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-embed-'));
process.env.DB_PATH = path.join(tmpDir, 'embed.db');
process.env.SESSION_SECRET = 'test-embed-secret';

// Env management for the provider-resolution unit tests only. The integration
// block below sets its own env in beforeAll and must not be reset mid-suite.
let unitEnvActive = false;
beforeEach(() => {
  if (!unitEnvActive) return;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_EMBEDDING_MODEL;
  delete process.env.EMBEDDING_PROVIDER;
});
afterEach(() => {
  if (!unitEnvActive) return;
  process.env = { ...ORIG_ENV };
});

const {
  resolveEmbeddingProvider,
  embeddingProviderAvailable
} = await import('../src/server/llmProvider');

describe('embedding provider resolution (free-first)', () => {
  beforeAll(() => { unitEnvActive = true; });
  it('defaults to ollama when no Gemini key is set', () => {
    delete process.env.GEMINI_API_KEY;
    const p = resolveEmbeddingProvider();
    expect(p.type).toBe('ollama');
    expect(p.defaultModel()).toBe('nomic-embed-text');
  });

  it('uses gemini when a key is present', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const p = resolveEmbeddingProvider();
    expect(p.type).toBe('gemini');
  });

  it('honors an explicit EMBEDDING_PROVIDER override', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.EMBEDDING_PROVIDER = 'ollama';
    expect(resolveEmbeddingProvider().type).toBe('ollama');
  });

  it('honors a configured Ollama embedding model', () => {
    process.env.OLLAMA_EMBEDDING_MODEL = 'bge-m3';
    const p = resolveEmbeddingProvider();
    expect(p.defaultModel()).toBe('bge-m3');
  });

  it('embeddingProviderAvailable is false on a plain machine (no key, no ollama config)', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_EMBEDDING_MODEL;
    delete process.env.EMBEDDING_PROVIDER;
    expect(embeddingProviderAvailable()).toBe(false);
  });

  it('embeddingProviderAvailable is true when ollama is explicitly configured', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    expect(embeddingProviderAvailable()).toBe(true);
  });
});

describe('ollama embedding adapter — real /api/embeddings request', () => {
  it('POSTs {model, prompt} to /api/embeddings and returns {vector, model}', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    process.env.OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';
    const originalFetch = globalThis.fetch;
    let captured: { url: string; body: any } | null = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return {
        ok: true,
        text: async () => '',
        json: async () => ({ embedding: [0.1, 0.2, 0.3, 0.4] })
      } as any;
    }) as any;

    try {
      const p = resolveEmbeddingProvider();
      const res = await p.embed('hello world');
      expect(res).not.toBeNull();
      expect(res!.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(res!.model).toBe('ollama:nomic-embed-text');
      // Verify the REAL request shape Ollama expects.
      expect(captured!.url).toBe('http://localhost:11434/api/embeddings');
      expect(captured!.body.model).toBe('nomic-embed-text');
      expect(typeof captured!.body.prompt).toBe('string');
      expect(captured!.body.prompt).toBe('hello world');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null (never throws, never fabricates) when the daemon is down', async () => {
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9'; // nothing listening
    const p = resolveEmbeddingProvider();
    const res = await p.embed('hello');
    expect(res).toBeNull();
  });

  it('returns null on a non-OK HTTP response', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 400, text: async () => 'bad model' } as any)) as any;
    try {
      const p = resolveEmbeddingProvider();
      expect(await p.embed('hi')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null when the response has no embedding array', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ embedding: [] }) } as any)) as any;
    try {
      const p = resolveEmbeddingProvider();
      expect(await p.embed('hi')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('gemini embedding adapter gating', () => {
  it('is not configured without a key and returns null', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.EMBEDDING_PROVIDER = 'gemini';
    const p = resolveEmbeddingProvider();
    expect(p.isConfigured()).toBe(false);
    expect(await p.embed('hi')).toBeNull();
  });
});

// --- Integration: indexChunk + retrieveRelevant against the real DB ---

const { db } = await import('../src/server/db');
const { indexChunk, retrieveRelevant } = await import('../src/server/embeddings');

function makeChunk(businessId: string, id: string, title: string, content: string): any {
  return { id, businessId, title, type: 'faq', content, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

describe('free-first RAG integration (stubbed ollama embeddings)', () => {
  beforeAll(async () => {
    unitEnvActive = false;
    delete process.env.GEMINI_API_KEY;
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    process.env.OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';
    await db.init();
  });
  afterAll(async () => { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('indexes chunks via the ollama provider and stores the model', async () => {
    // Deterministic stub: map text -> a stable vector so cosine is meaningful.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const text: string = body.prompt || '';
      // Hash-ish vector: 4 dims derived from text length + char codes.
      const v = [
        text.length % 7,
        (text.charCodeAt(0) || 0) % 11,
        (text.charCodeAt(1) || 0) % 13,
        (text.includes('price') || text.includes('Price')) ? 9 : 1
      ];
      return { ok: true, json: async () => ({ embedding: v }) } as any;
    }) as any;

    try {
      const bizB = 'biz-embed-test';
      // Ensure the business exists (FK) by inserting directly via the client.
      await db.client.execMany(
        `INSERT OR IGNORE INTO businesses (id, name, type, description, language, currency, timezone, hours, services, policies, communication_style, status, allowed_widget_origins, created_at, updated_at)
         VALUES ('${bizB}', 'Embed Test', 'salon', 'x', 'en', 'usd', 'UTC', '[]', '[]', '{}', 'x', 'ACTIVE', '[]', '${new Date().toISOString()}', '${new Date().toISOString()}')`
      );
      const c1 = makeChunk(bizB, 'emb-1', 'Pricing', 'Haircut price is 30 dollars.');
      const c2 = makeChunk(bizB, 'emb-2', 'Hours', 'We are open 9 to 5 daily.');
      await db.knowledgeChunks.push(c1);
      await db.knowledgeChunks.push(c2);
      await indexChunk(c1);
      await indexChunk(c2);

      // Both stored embeddings must carry the ollama model tag.
      const rows = await db.client.query('SELECT chunk_id, model FROM knowledge_embeddings WHERE business_id = ?', [bizB]);
      expect(rows.rows.length).toBe(2);
      for (const r of rows.rows) {
        expect(r.model).toBe('ollama:nomic-embed-text');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retrieveRelevant performs semantic search scoped to the tenant', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const text: string = body.prompt || '';
      const v = [
        text.length % 7,
        (text.charCodeAt(0) || 0) % 11,
        (text.charCodeAt(1) || 0) % 13,
        (text.includes('price') || text.includes('Price')) ? 9 : 1
      ];
      return { ok: true, json: async () => ({ embedding: v }) } as any;
    }) as any;
    try {
      const results = await retrieveRelevant('biz-embed-test', 'What is the price?', 5);
      expect(results.length).toBeGreaterThan(0);
      // Semantic path used (provider available + model matches).
      expect(results.every(r => r.source === 'semantic')).toBe(true);
      // The "Pricing" chunk should rank first for a price query.
      expect(results[0].chunk.title).toBe('Pricing');
      // Tenant isolation: all results belong to the queried tenant.
      expect(results.every(r => r.chunk.businessId === 'biz-embed-test')).toBe(true);
    } finally {
      globalFetch(originalFetch);
    }
  });

  it('never retrieves another tenant\'s chunks (tenant isolation)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const text: string = body.prompt || '';
      const v = [text.length % 7, (text.charCodeAt(0) || 0) % 11, (text.charCodeAt(1) || 0) % 13, text.includes('price') ? 9 : 1];
      return { ok: true, json: async () => ({ embedding: v }) } as any;
    }) as any;
    try {
      const bizC = 'biz-embed-iso';
      await db.client.execMany(
        `INSERT OR IGNORE INTO businesses (id, name, type, description, language, currency, timezone, hours, services, policies, communication_style, status, allowed_widget_origins, created_at, updated_at)
         VALUES ('${bizC}', 'Iso Test', 'salon', 'x', 'en', 'usd', 'UTC', '[]', '[]', '{}', 'x', 'ACTIVE', '[]', '${new Date().toISOString()}', '${new Date().toISOString()}')`
      );
      const c = makeChunk(bizC, 'emb-iso-1', 'Secret Pricing', 'Confidential price list for bizC only.');
      await db.knowledgeChunks.push(c);
      await indexChunk(c);

      // Query biz-embed-test — must never surface bizC's chunk.
      const results = await retrieveRelevant('biz-embed-test', 'price', 5);
      expect(results.every(r => r.chunk.businessId === 'biz-embed-test')).toBe(true);
      expect(results.some(r => r.chunk.businessId === bizC)).toBe(false);
    } finally {
      globalFetch(originalFetch);
    }
  });

  it('falls back to keyword when the daemon is unreachable (no fabrication)', async () => {
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9'; // dead port
    const results = await retrieveRelevant('biz-embed-test', 'price', 5);
    // Keyword fallback still returns the pricing chunk via text matching.
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.source === 'keyword')).toBe(true);
  });

  it('does not compare vectors across models (cross-model safety)', async () => {
    // Simulate a model change: stored vectors are ollama:nomic-embed-text, but
    // force the query embedding to report a DIFFERENT model. Retrieval must
    // skip the incompatible stored vectors and fall back to keyword rather
    // than producing meaningless cosine scores.
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    process.env.OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';

    const originalFetch = globalThis.fetch;
    // Stub: indexChunk uses nomic-embed-text; the query embed also calls
    // /api/embeddings. To simulate a model mismatch, we flip the model env
    // AFTER indexing so the query embedding reports a different model tag.
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const text: string = body.prompt || '';
      const v = [text.length % 7, (text.charCodeAt(0) || 0) % 11, (text.charCodeAt(1) || 0) % 13, text.includes('price') ? 9 : 1];
      return { ok: true, json: async () => ({ embedding: v }) } as any;
    }) as any;

    try {
      // Re-index biz-embed-test with nomic-embed-text (already done above, but
      // ensure the model tag is set).
      const chunks = await db.knowledgeChunks.filterWhere('business_id = ?', ['biz-embed-test']);
      for (const c of chunks) await indexChunk(c);

      // Now switch the embedding model so the query vector reports a different
      // model tag than the stored vectors.
      process.env.OLLAMA_EMBEDDING_MODEL = 'bge-m3';
      const results = await retrieveRelevant('biz-embed-test', 'price', 5);
      // No semantic result: model mismatch -> keyword fallback.
      expect(results.every(r => r.source === 'keyword')).toBe(true);
    } finally {
      globalFetch(originalFetch);
      process.env.OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';
    }
  });
});

function globalFetch(original: typeof globalThis.fetch) {
  globalThis.fetch = original;
}
