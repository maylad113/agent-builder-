import { GoogleGenAI } from '@google/genai';
import { KnowledgeChunk } from '../types';

/**
 * Semantic retrieval (RAG) over business knowledge.
 *
 * Storage: SQLite with vectors persisted as JSON float arrays in
 * `knowledge_embeddings`. Cosine similarity is computed in-process.
 * (The project standardizes on better-sqlite3 for synchronous transactions;
 * pgvector is the documented upgrade path — see AGENTS.md.)
 *
 * Embeddings: Gemini `text-embedding-004` with outputDimensionality=256.
 *  - Re-indexed when a chunk's content changes (content hash guard).
 *  - Tenant-scoped: every embedding carries a businessId and search is
 *    restricted to the caller's tenant.
 *  - Graceful fallback: when GEMINI_API_KEY is absent, semantic search
 *    degrades to the keyword method so the app never fails to start or answer.
 */

const EMBED_MODEL = 'text-embedding-004';
const DIM = 256;

// Resolve the db lazily to avoid a circular import (db.ts imports this module
// for initEmbeddingsTable; this module imports db.ts for chunk access).
async function getDb() {
  const { db } = await import('./db');
  return db;
}

let aiClient: GoogleGenAI | null = null;
function client(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return aiClient;
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

/** Embed a single string, returning a vector or null on failure/no key. */
export async function embed(text: string): Promise<number[] | null> {
  const ai = client();
  if (!ai) return null;
  const trimmed = text.slice(0, 8000);
  try {
    const res = await ai.models.embedContent({
      model: EMBED_MODEL,
      contents: trimmed,
      config: { outputDimensionality: DIM }
    });
    const vec = res.embeddings?.[0]?.values;
    return vec && vec.length ? vec : null;
  } catch {
    return null;
  }
}

export interface StoredEmbedding {
  chunkId: string;
  businessId: string;
  vector: number[];
  hash: string;
}

function loadRow(r: any): StoredEmbedding | null {
  if (!r) return null;
  let vec: number[];
  try { vec = JSON.parse(r.vector); } catch { return null; }
  return { chunkId: r.chunk_id, businessId: r.business_id, vector: vec, hash: r.hash };
}

async function allEmbeddings(): Promise<StoredEmbedding[]> {
  const db = await getDb();
  const rows = db.sqlite.prepare('SELECT chunk_id, business_id, vector, hash FROM knowledge_embeddings').all() as any[];
  const out: StoredEmbedding[] = [];
  for (const r of rows) {
    const e = loadRow(r);
    if (e) out.push(e);
  }
  return out;
}

/** Index (or re-index) a chunk. Idempotent; only re-embeds when content changed. */
export async function indexChunk(chunk: KnowledgeChunk): Promise<void> {
  const db = await getDb();
  const hash = contentHash(chunk.title + '\n' + chunk.content);
  const existing = db.sqlite.prepare('SELECT hash FROM knowledge_embeddings WHERE chunk_id = ?').get(chunk.id) as { hash: string } | undefined;
  if (existing && existing.hash === hash) return; // unchanged

  const vec = await embed(`${chunk.title}\n${chunk.content}`);
  if (!vec) return; // no key or failure — keyword fallback still works

  db.sqlite.prepare(
    `INSERT INTO knowledge_embeddings (chunk_id, business_id, vector, hash, updated_at)
     VALUES (@chunk_id, @business_id, @vector, @hash, @updated_at)
     ON CONFLICT(chunk_id) DO UPDATE SET vector=excluded.vector, hash=excluded.hash, updated_at=excluded.updated_at`
  ).run({
    chunk_id: chunk.id,
    business_id: chunk.businessId,
    vector: JSON.stringify(vec),
    hash,
    updated_at: new Date().toISOString()
  });
}

/** Remove embedding(s) for a chunk (call on delete). */
export async function removeEmbedding(chunkId: string): Promise<void> {
  const db = await getDb();
  db.sqlite.prepare('DELETE FROM knowledge_embeddings WHERE chunk_id = ?').run(chunkId);
}

export interface RetrievalResult {
  chunk: KnowledgeChunk;
  score: number;
  source: 'semantic' | 'keyword';
}

/**
 * Semantic search for the top-K chunks relevant to `query`, scoped to the
 * tenant. Falls back to keyword matching when embeddings are unavailable
 * (no API key / nothing indexed yet).
 */
export async function retrieveRelevant(
  businessId: string,
  query: string,
  topK = 4
): Promise<RetrievalResult[]> {
  const db = await getDb();
  const chunks = db.knowledgeChunks.filter(k => k.businessId === businessId);
  if (chunks.length === 0) return [];

  const stored = (await allEmbeddings()).filter(e => e.businessId === businessId);
  // If we have embeddings for at least half the chunks AND an API key, do
  // semantic search; otherwise degrade to keyword so partial indexes don't
  // silently miss chunks.
  const useSemantic = !!process.env.GEMINI_API_KEY && stored.length >= Math.ceil(chunks.length / 2);

  if (useSemantic) {
    const qVec = await embed(query);
    if (qVec) {
      const scored = stored
        .map(e => ({ chunk: chunks.find(c => c.id === e.chunkId), score: cosine(qVec, e.vector) }))
        .filter((s): s is { chunk: KnowledgeChunk; score: number } => !!s.chunk)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      if (scored.length) return scored.map(s => ({ chunk: s.chunk, score: s.score, source: 'semantic' as const }));
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

/** Create the embeddings table on the given sqlite handle. Called by db.ts
 *  right after migrations run (avoids importing db back into this module). */
export function initEmbeddingsTable(sqlite: { exec: (sql: string) => void }): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
       chunk_id    TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
       business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
       vector      TEXT NOT NULL,
       hash        TEXT NOT NULL,
       updated_at  TEXT NOT NULL
     )`
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_kb_embeddings_business ON knowledge_embeddings(business_id)');
}

