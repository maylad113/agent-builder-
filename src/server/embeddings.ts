import { resolveEmbeddingProvider, embeddingProviderAvailable } from './llmProvider';
import { KnowledgeChunk } from '../types';

/**
 * Semantic retrieval (RAG) over business knowledge.
 *
 * Storage: SQLite with vectors persisted as JSON float arrays in
 * `knowledge_embeddings`. Cosine similarity is computed in-process.
 * (The project standardizes on better-sqlite3 for synchronous transactions;
 * pgvector is the documented upgrade path — see AGENTS.md.)
 *
 * Embeddings: provider-agnostic (see src/server/llmProvider.ts).
 *  - FREE-FIRST: defaults to a local Ollama embedding model
 *    (`nomic-embed-text`) when no paid Gemini key is set, so RAG works
 *    without a paid API. Gemini `text-embedding-004` (256-dim) is used when
 *    `GEMINI_API_KEY` is present.
 *  - Each stored vector records the model that produced it. Retrieval only
 *    compares vectors from the SAME model as the query embedding, so a
 *    provider/model change never produces meaningless cross-model cosine
 *    scores (no fabricated relevance).
 *  - Re-indexed when a chunk's content changes (content hash guard).
 *  - Tenant-scoped: every embedding carries a businessId and search is
 *    restricted to the caller's tenant.
 *  - Graceful fallback: when no provider is available/reachable, semantic
 *    search degrades to the keyword method so the app never fails to start or
 *    answer. Embeddings/results are never fabricated.
 */

// Resolve the db lazily to avoid a circular import (db.ts imports this module
// for initEmbeddingsTable; this module imports db.ts for chunk access).
async function getDb() {
  const { db } = await import('./db');
  return db;
}

function contentHash(s: string): string {
  // FNV-1a — fast, dependency-free, good enough for change detection.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embed a single string via the resolved provider, returning the vector and
 *  the model that produced it (or null when no provider is available/reachable).
 *  The model is stored alongside the vector so retrieval can avoid cross-model
 *  comparisons. Never throws. */
export async function embed(text: string): Promise<{ vector: number[]; model: string } | null> {
  if (!embeddingProviderAvailable()) return null;
  const provider = resolveEmbeddingProvider();
  return provider.embed(text);
}

export interface StoredEmbedding {
  chunkId: string;
  businessId: string;
  vector: number[];
  hash: string;
  /** Model that produced `vector` (e.g. "gemini:text-embedding-004",
   *  "ollama:nomic-embed-text"). Used to avoid cross-model cosine. */
  model: string;
}

async function loadRow(r: any): Promise<StoredEmbedding | null> {
  // r.vector is TEXT (JSON string) on SQLite or JSONB (already-parsed array)
  // on PostgreSQL. Normalize to number[].
  let vec: number[];
  if (typeof r.vector === 'string') {
    try { vec = JSON.parse(r.vector); } catch { return null; }
  } else if (Array.isArray(r.vector)) {
    vec = r.vector;
  } else {
    return null;
  }
  return {
    chunkId: r.chunk_id,
    businessId: r.business_id,
    vector: vec,
    hash: r.hash,
    // Pre-existing rows (created before the model column existed) default to
    // the legacy Gemini model so they remain comparable to new Gemini vectors.
    model: r.model || 'gemini:text-embedding-004'
  };
}

async function allEmbeddings(): Promise<StoredEmbedding[]> {
  const db = await getDb();
  const res = await db.client.query('SELECT chunk_id, business_id, vector, hash, model FROM knowledge_embeddings');
  const out: StoredEmbedding[] = [];
  for (const r of res.rows) {
    const e = await loadRow(r);
    if (e) out.push(e);
  }
  return out;
}

/** Index (or re-index) a chunk. Idempotent; only re-embeds when content
 *  changed. Records the embedding model so retrieval can match on it. */
export async function indexChunk(chunk: KnowledgeChunk): Promise<void> {
  const db = await getDb();
  const hash = contentHash(chunk.title + '\n' + chunk.content);
  const existingRes = await db.client.query('SELECT hash, model FROM knowledge_embeddings WHERE chunk_id = ?', [chunk.id]);
  const existing = existingRes.rows[0] as { hash: string; model?: string } | undefined;
  if (existing && existing.hash === hash) return; // unchanged

  const result = await embed(`${chunk.title}\n${chunk.content}`);
  if (!result) return; // no provider / failure — keyword fallback still works

  await db.client.query(
    `INSERT INTO knowledge_embeddings (chunk_id, business_id, vector, hash, model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chunk_id) DO UPDATE SET vector=excluded.vector, hash=excluded.hash, model=excluded.model, updated_at=excluded.updated_at`,
    [chunk.id, chunk.businessId, JSON.stringify(result.vector), hash, result.model, new Date().toISOString()]
  );
}

/** Remove embedding(s) for a chunk (call on delete). */
export async function removeEmbedding(chunkId: string): Promise<void> {
  const db = await getDb();
  await db.client.query('DELETE FROM knowledge_embeddings WHERE chunk_id = ?', [chunkId]);
}

export interface RetrievalResult {
  chunk: KnowledgeChunk;
  score: number;
  source: 'semantic' | 'keyword';
}

/**
 * Semantic search for the top-K chunks relevant to `query`, scoped to the
 * tenant. Falls back to keyword matching when embeddings are unavailable
 * (no provider / nothing indexed yet) OR when the stored vectors were
 * produced by a different model than the current query embedding (so a
 * provider/model change never yields meaningless cross-model cosine scores).
 */
export async function retrieveRelevant(
  businessId: string,
  query: string,
  topK = 4
): Promise<RetrievalResult[]> {
  const db = await getDb();
  const chunks = await db.knowledgeChunks.filterWhere('business_id = ?', [businessId]);
  if (chunks.length === 0) return [];

  const stored = (await allEmbeddings()).filter(e => e.businessId === businessId);
  // Only attempt semantic search when a provider is configured AND we have
  // embeddings for at least half the chunks. Partial indexes would otherwise
  // silently miss un-indexed chunks.
  const useSemantic = embeddingProviderAvailable() && stored.length >= Math.ceil(chunks.length / 2);

  if (useSemantic) {
    const qResult = await embed(query);
    if (qResult) {
      // Only compare vectors produced by the SAME model as the query. Vectors
      // from a previous provider/model are skipped (not silently scored).
      const compatible = stored.filter(e => e.model === qResult.model);
      if (compatible.length >= Math.ceil(chunks.length / 2)) {
        const scored = compatible
          .map(e => ({ chunk: chunks.find(c => c.id === e.chunkId), score: cosine(qResult.vector, e.vector) }))
          .filter((s): s is { chunk: KnowledgeChunk; score: number } => !!s.chunk)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        if (scored.length) {
          return scored.map(s => ({ chunk: s.chunk, score: s.score, source: 'semantic' as const }));
        }
      }
      // Compatible vectors insufficient — fall through to keyword rather than
      // returning a partial/skewed semantic result.
    }
  }

  // Keyword fallback (tenant-scoped).
  const qLower = query.toLowerCase();
  const matched = chunks.filter(c => {
    return c.title.toLowerCase().includes(qLower)
      || c.tags.some(t => qLower.includes(t.toLowerCase()))
      || c.content.toLowerCase().split(' ').some(word => word.length > 3 && qLower.includes(word));
  });
  const selected = matched.length > 0 ? matched : chunks.slice(0, 3);
  return selected.slice(0, topK).map(c => ({ chunk: c, score: 0, source: 'keyword' as const }));
}

/** Create the embeddings table if it doesn't exist. Called by db.ts right
 *  after migrations run (avoids importing db back into this module). On
 *  PostgreSQL the migrations already create this table; the IF NOT EXISTS
 *  makes this idempotent for both drivers. Also self-heals the `model` column
 *  onto pre-existing tables (created before the provider abstraction) so
 *  retrieval can match vectors by model without a separate migration. */
export async function initEmbeddingsTable(client: { execMany: (sql: string) => Promise<void>; query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>; dialect: 'sqlite' | 'postgres' }): Promise<void> {
  // The vector column is TEXT on SQLite (JSON string) and JSONB on PostgreSQL
  // (already declared in migrations/pg/001). This CREATE TABLE IF NOT EXISTS
  // is harmless when the table already exists.
  await client.execMany(
    `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
       chunk_id    TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
       business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
       vector       ${client.dialect === 'postgres' ? 'JSONB' : 'TEXT'} NOT NULL,
       hash        TEXT NOT NULL,
       model       TEXT NOT NULL DEFAULT 'gemini:text-embedding-004',
       updated_at  TEXT NOT NULL
     )`
  );
  await client.execMany('CREATE INDEX IF NOT EXISTS idx_kb_embeddings_business ON knowledge_embeddings(business_id)');

  // Self-heal: add the `model` column to tables created by older versions of
  // this module (CREATE TABLE IF NOT EXISTS won't add a column to an existing
  // table). Idempotent across restarts.
  try {
    if (client.dialect === 'postgres') {
      await client.execMany(`ALTER TABLE knowledge_embeddings ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'gemini:text-embedding-004'`);
    } else {
      // SQLite has no ADD COLUMN IF NOT EXISTS; check the schema first.
      const cols = await client.query(`PRAGMA table_info(knowledge_embeddings)`);
      const hasModel = cols.rows.some((c: any) => c.name === 'model');
      if (!hasModel) {
        await client.execMany(`ALTER TABLE knowledge_embeddings ADD COLUMN model TEXT NOT NULL DEFAULT 'gemini:text-embedding-004'`);
      }
    }
  } catch {
    // Non-fatal: a concurrent add or unexpected state shouldn't break startup.
  }
}

