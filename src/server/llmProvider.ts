/**
 * LLM Provider Abstraction (free-first AI layer).
 *
 * The platform must operate WITHOUT a mandatory paid AI API. This module is
 * the single seam between the agent runtime and any underlying model backend.
 * Adapters implement the `LlmProvider` interface; the runtime never imports a
 * vendor SDK directly.
 *
 * Providers:
 *   - `gemini`  — Google Gemini via @google/genai (optional; requires key).
 *   - `ollama`  — local/open-source models via Ollama's OpenAI-compatible
 *                 `/api/chat` endpoint (no API key; runs on localhost).
 *
 * Invariants:
 *   - A missing optional credential leaves the provider NOT_CONFIGURED; the
 *     runtime degrades to a graceful human-handoff reply and NEVER crashes.
 *   - The provider converts the platform's canonical tool declarations (the
 *     Gemini-typed `FunctionDeclaration[]` in tools.ts) into its own native
 *     tool-calling schema. The runtime hands the SAME declarations to every
 *     provider, so tool behavior is uniform.
 *   - All providers return a normalized `LlmResponse` (text + functionCalls +
 *     usage), so the runtime's tool loop is provider-agnostic.
 */

import { Type, FunctionDeclaration } from '@google/genai';
import { safeError } from './logSanitizer';

// ---------------------------------------------------------------------------
// Request timeout (P1 reliability). Every outbound LLM network call is bounded
// so a hung/slow provider daemon can never hold an Express request open
// indefinitely (connection + memory exhaustion under load). A timeout aborts
// the request cleanly and the adapter returns its NORMALIZED error response —
// the runtime then degrades to a graceful human-handoff reply exactly as it
// does for an unreachable daemon. A timeout NEVER fabricates an answer and
// NEVER throws an uncaught AbortError into the runtime.
//
// Config: `LLM_REQUEST_TIMEOUT_MS` (milliseconds). A safe production default
// of 60s is used when unset. Invalid/negative values fall back to the default
// so protection can never be silently disabled by a misconfigured env var.
// Per-provider overrides: `OLLAMA_REQUEST_TIMEOUT_MS`, `GEMINI_REQUEST_TIMEOUT_MS`.
// ---------------------------------------------------------------------------

const DEFAULT_LLM_TIMEOUT_MS = 60_000;

function resolveTimeoutMs(envVar: string, defaultMs = DEFAULT_LLM_TIMEOUT_MS): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultMs; // never disable protection
  return Math.floor(n);
}

/** Per-provider timeout for an adapter (honors override then global then default). */
function providerTimeoutMs(globalVar: string, overrideVar: string): number {
  return resolveTimeoutMs(overrideVar, resolveTimeoutMs(globalVar));
}

/** Create an AbortController that fires after `ms` and a disposer to clear it.
 *  Exposed as a helper so tests can assert the controller + signal shape. */
export function createLlmTimeout(ms: number): { signal: AbortSignal; dispose: () => void; ms: number } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`LLM request timed out after ${ms}ms`)), ms);
  // unref so the timer never keeps the event loop alive on its own.
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return {
    signal: controller.signal,
    ms,
    dispose: () => clearTimeout(timer)
  };
}

/** Read whether a caught error was caused by our timeout abort. */
function isAbortError(err: any, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = err?.name;
  return name === 'AbortError' || name === 'DOMException';
}

export const LLM_TIMEOUT_DEFAULT_MS = DEFAULT_LLM_TIMEOUT_MS;
export { resolveTimeoutMs, providerTimeoutMs, isAbortError };

// ---------------------------------------------------------------------------
// Provider-agnostic types
// ---------------------------------------------------------------------------

export type LlmProviderType = 'gemini' | 'ollama';

export interface LlmMessagePart {
  text?: string;
}

export interface LlmFunctionCall {
  name: string;
  args: Record<string, any>;
}

export interface LlmFunctionResponse {
  name: string;
  response: Record<string, any>;
}

export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  /** Text parts (user/assistant turns). */
  text?: string;
  /** Assistant-requested tool calls (model turn). */
  toolCalls?: LlmFunctionCall[];
  /** Tool-result turns fed back to the model. */
  toolResults?: LlmFunctionResponse[];
}

export interface LlmToolParam {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: LlmToolSchema;
  properties?: Record<string, LlmToolSchema>;
  required?: string[];
}

export interface LlmToolSchema {
  type: LlmToolParam['type'];
  description?: string;
  enum?: string[];
  items?: LlmToolSchema;
  properties?: Record<string, LlmToolSchema>;
  required?: string[];
}

export interface LlmToolDeclaration {
  name: string;
  description: string;
  parameters: LlmToolSchema;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  /** Final text reply (empty when the model only emitted tool calls). */
  text: string;
  /** Tool calls requested by the model (empty when none). */
  functionCalls: LlmFunctionCall[];
  /** Token usage from the provider, when reported. */
  usage?: LlmUsage;
  /** Raw model identifier the provider actually used. */
  model: string;
}

export interface LlmGenerateOptions {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmToolDeclaration[];
  temperature?: number;
}

export interface LlmProvider {
  readonly type: LlmProviderType;
  /** Human-readable label. */
  readonly label: string;
  /** Whether the provider is usable right now (credentials/endpoint present). */
  isConfigured(): boolean;
  /** Generate a completion (with optional tool calling). Never throws —
   *  network/SDK failures return a response with text='' and an `error`. */
  generate(options: LlmGenerateOptions): Promise<LlmResponse & { error?: string }>;
  /** Default model id for this provider when the agent omits one. */
  defaultModel(): string;
}

// ---------------------------------------------------------------------------
// Canonical -> provider-agnostic tool-schema conversion.
// The platform keeps Gemini-typed declarations as the single source of truth
// (see tools.ts). Every provider converts them to its native schema here.
// ---------------------------------------------------------------------------

function geminiTypeToLlm(t: Type | string | undefined): LlmToolParam['type'] {
  switch (t) {
    case Type.STRING:
    case 'STRING':
      return 'string';
    case Type.INTEGER:
    case 'INTEGER':
      return 'integer';
    case Type.NUMBER:
    case 'NUMBER':
      return 'number';
    case Type.BOOLEAN:
    case 'BOOLEAN':
      return 'boolean';
    case Type.ARRAY:
    case 'ARRAY':
      return 'array';
    case Type.OBJECT:
    case 'OBJECT':
    case undefined:
    default:
      return 'object';
  }
}

function convertSchema(node: any): LlmToolSchema {
  if (!node || typeof node !== 'object') {
    return { type: 'object' };
  }
  const type = geminiTypeToLlm(node.type);
  const out: LlmToolSchema = { type };
  if (node.description) out.description = node.description;
  if (Array.isArray(node.enum)) out.enum = node.enum;
  if (node.items) out.items = convertSchema(node.items);
  if (node.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) {
      out.properties[k] = convertSchema(v);
    }
  }
  if (Array.isArray(node.required) && node.required.length) {
    out.required = node.required;
  }
  return out;
}

/** Convert the platform's canonical Gemini FunctionDeclarations to the
 *  provider-agnostic shape every adapter consumes. */
export function toLlmToolDeclarations(decls: FunctionDeclaration[]): LlmToolDeclaration[] {
  return decls.map(d => ({
    name: d.name,
    description: d.description || '',
    parameters: convertSchema(d.parameters) || { type: 'object' }
  }));
}

// ---------------------------------------------------------------------------
// Gemini adapter (wraps @google/genai — optional, key-gated)
// ---------------------------------------------------------------------------

import { GoogleGenAI, Part } from '@google/genai';

let geminiClient: GoogleGenAI | null = null;
function gemini(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });
  }
  return geminiClient;
}

class GeminiLlmProvider implements LlmProvider {
  readonly type = 'gemini' as const;
  readonly label = 'Google Gemini';
  isConfigured(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }
  defaultModel(): string {
    return 'gemini-3.6-flash';
  }
  async generate(opts: LlmGenerateOptions): Promise<LlmResponse & { error?: string }> {
    const ai = gemini();
    if (!ai) {
      return { text: '', functionCalls: [], model: opts.model, error: 'GEMINI_API_KEY missing' };
    }
    const model = opts.model || this.defaultModel();

    // Convert normalized messages back to Gemini `contents` (model turn with
    // function calls + user/tool turn with function responses).
    const contents: Array<{ role: string; parts: Part[] }> = [];
    for (const m of opts.messages) {
      if (m.role === 'user') {
        const parts: Part[] = [];
        if (m.text != null) parts.push({ text: m.text });
        if (m.toolResults && m.toolResults.length) {
          for (const tr of m.toolResults) {
            parts.push({ functionResponse: { name: tr.name, response: tr.response } });
          }
        }
        if (parts.length) contents.push({ role: 'user', parts });
      } else {
        // assistant / tool (model) turn
        const parts: Part[] = [];
        if (m.text != null) parts.push({ text: m.text });
        if (m.toolCalls && m.toolCalls.length) {
          for (const tc of m.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.args } });
          }
        }
        if (parts.length) contents.push({ role: 'model', parts });
      }
    }

    try {
      const timeoutMs = providerTimeoutMs('LLM_REQUEST_TIMEOUT_MS', 'GEMINI_REQUEST_TIMEOUT_MS');
      const to = createLlmTimeout(timeoutMs);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: contents as any,
          config: {
            systemInstruction: opts.systemPrompt,
            temperature: opts.temperature,
            abortSignal: to.signal,
            httpOptions: { timeout: timeoutMs },
            tools: opts.tools.length > 0
              ? [{ functionDeclarations: opts.tools as unknown as FunctionDeclaration[] }]
              : undefined
          }
        });

        const text = response.text || '';
        const functionCalls: LlmFunctionCall[] = (response.functionCalls || []).map(fc => ({
          name: fc.name,
          args: (fc.args as Record<string, any>) || {}
        }));
        const um = response.usageMetadata;
        const usage: LlmUsage | undefined = um
          ? {
            inputTokens: um.promptTokenCount ?? 0,
            outputTokens: um.candidatesTokenCount ?? 0
          }
          : undefined;
        return { text, functionCalls, usage, model };
      } finally {
        to.dispose();
      }
    } catch (err: any) {
      const isTimeout = isAbortError(err);
      safeError('[llm/gemini] generate failed:', err?.message || err);
      return { text: '', functionCalls: [], model, error: isTimeout
        ? `Gemini request timed out after ${providerTimeoutMs('LLM_REQUEST_TIMEOUT_MS', 'GEMINI_REQUEST_TIMEOUT_MS')}ms`
        : (err?.message || 'Gemini generate failed') };
    }
  }
}

// ---------------------------------------------------------------------------
// Ollama adapter — local/open-source models, OpenAI-compatible /api/chat.
// No API key. Requires OLLAMA_BASE_URL (default http://localhost:11434) and a
// model pull (e.g. `ollama pull llama3.1`). When the server is unreachable,
// generate() returns an error response and the runtime degrades gracefully.
// ---------------------------------------------------------------------------

class OllamaLlmProvider implements LlmProvider {
  readonly type = 'ollama' as const;
  readonly label = 'Ollama (local/open-source)';
  private base(): string {
    const url = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    return url.replace(/\/+$/, '');
  }
  isConfigured(): boolean {
    // Ollama is "configured" when an explicit base URL or model is set; in
    // practice availability is confirmed at request time (the daemon may be
    // down). We treat an unset URL as configured-default so a local install
    // works out of the box, but generate() reports the real reachability.
    return true;
  }
  defaultModel(): string {
    return process.env.OLLAMA_DEFAULT_MODEL || 'llama3.1';
  }

  private toOpenAiTools(tools: LlmToolDeclaration[]): any[] {
    return tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmResponse & { error?: string }> {
    const model = opts.model || this.defaultModel();
    const messages: any[] = [{ role: 'system', content: opts.systemPrompt }];
    for (const m of opts.messages) {
      if (m.role === 'user') {
        if (m.toolResults && m.toolResults.length) {
          for (const tr of m.toolResults) {
            messages.push({
              role: 'tool',
              name: tr.name,
              content: JSON.stringify(tr.response)
            });
          }
        }
        if (m.text != null) messages.push({ role: 'user', content: m.text });
      } else {
        const assistant: any = { role: 'assistant' };
        if (m.text != null) assistant.content = m.text;
        if (m.toolCalls && m.toolCalls.length) {
          assistant.tool_calls = m.toolCalls.map((tc, i) => ({
            id: `call_${i}`,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) }
          }));
        }
        messages.push(assistant);
      }
    }

    const body: any = {
      model,
      messages,
      stream: false,
      options: { temperature: opts.temperature ?? 0.2 }
    };
    if (opts.tools.length > 0) body.tools = this.toOpenAiTools(opts.tools);

    const timeoutMs = providerTimeoutMs('LLM_REQUEST_TIMEOUT_MS', 'OLLAMA_REQUEST_TIMEOUT_MS');
    const to = createLlmTimeout(timeoutMs);
    try {
      const res = await fetch(`${this.base()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: to.signal
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { text: '', functionCalls: [], model, error: `Ollama HTTP ${res.status}: ${detail.slice(0, 200)}` };
      }
      const data: any = await res.json();
      const msg = data.message || {};
      const text: string = msg.content || '';
      const functionCalls: LlmFunctionCall[] = [];
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc?.function?.name;
          if (!name) continue;
          let args: Record<string, any> = {};
          const raw = tc?.function?.arguments;
          if (typeof raw === 'string') {
            try { args = JSON.parse(raw); } catch { args = {}; }
          } else if (raw && typeof raw === 'object') {
            args = raw;
          }
          functionCalls.push({ name, args });
        }
      }
      const usage: LlmUsage | undefined = data.eval_count != null || data.prompt_eval_count != null
        ? { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 }
        : undefined;
      return { text, functionCalls, usage, model };
    } catch (err: any) {
      const isTimeout = isAbortError(err, to.signal);
      safeError('[llm/ollama] generate failed:', err?.message || err);
      return {
        text: '',
        functionCalls: [],
        model,
        error: isTimeout
          ? `Ollama request timed out after ${timeoutMs}ms`
          : (err?.message || 'Ollama unreachable (is the daemon running?)')
      };
    } finally {
      to.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// Registry + factory
// ---------------------------------------------------------------------------

const PROVIDERS: Record<LlmProviderType, () => LlmProvider> = {
  gemini: () => new GeminiLlmProvider(),
  ollama: () => new OllamaLlmProvider()
};

export const SUPPORTED_LLM_PROVIDERS: LlmProviderType[] = ['gemini', 'ollama'];

export function getLlmProvider(type?: LlmProviderType): LlmProvider {
  const t = type && PROVIDERS[type] ? type : 'gemini';
  return PROVIDERS[t]();
}

/** Resolve the effective provider + model for an agent (or version), applying
 *  safe defaults. Used by the runtime so a published version with no provider
 *  field still resolves deterministically. Free-first: when no provider is
 *  declared, prefer a configured Gemini key, otherwise fall back to local
 *  Ollama so the platform works without a paid API. */
export function resolveProviderAndModel(
  agent: { llmProvider?: LlmProviderType; model?: string } | null | undefined
): { provider: LlmProvider; model: string } {
  let type = agent?.llmProvider;
  if (!type || !PROVIDERS[type]) {
    type = process.env.GEMINI_API_KEY ? 'gemini' : 'ollama';
  }
  const provider = PROVIDERS[type]();
  const model = (agent?.model && agent.model.trim()) || provider.defaultModel();
  return { provider, model };
}

// ---------------------------------------------------------------------------
// Embedding provider abstraction (free-first RAG).
//
// Mirror of the chat provider seam, but for the embedding pipeline used by
// embeddings.ts. Each adapter embeds text into a vector and reports the model
// it used. The caller stores that model alongside the vector so retrieval
// never compares vectors from two different models (which would silently
// produce meaningless cosine scores).
//
//   - `gemini`  — text-embedding-004 (256-dim), optional, key-gated.
//   - `ollama`  — local/open-source embedding model (default
//                 nomic-embed-text, 768-dim) via POST /api/embeddings. No key.
//
// A missing/unreachable provider returns null — the caller falls back to the
// keyword retrieval path. Embeddings are never fabricated.
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  readonly type: 'gemini' | 'ollama';
  /** Whether the provider is usable right now (credentials/endpoint present). */
  isConfigured(): boolean;
  /** Embed `text`, returning {vector, model} or null on failure/no config.
   *  Never throws. */
  embed(text: string): Promise<{ vector: number[]; model: string } | null>;
  /** Default embedding model id for this provider. */
  defaultModel(): string;
}

class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly type = 'gemini' as const;
  private readonly model = 'text-embedding-004';
  private readonly dim = 256;
  isConfigured(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }
  defaultModel(): string {
    return this.model;
  }
  async embed(text: string): Promise<{ vector: number[]; model: string } | null> {
    if (!process.env.GEMINI_API_KEY) return null;
    try {
      const ai = gemini();
      if (!ai) return null;
      const timeoutMs = providerTimeoutMs('LLM_REQUEST_TIMEOUT_MS', 'GEMINI_REQUEST_TIMEOUT_MS');
      const to = createLlmTimeout(timeoutMs);
      try {
        const res = await ai.models.embedContent({
          model: this.model,
          contents: text.slice(0, 8000),
          config: { outputDimensionality: this.dim, abortSignal: to.signal, httpOptions: { timeout: timeoutMs } }
        });
        const vec = res.embeddings?.[0]?.values;
        return vec && vec.length ? { vector: vec, model: `gemini:${this.model}` } : null;
      } finally {
        to.dispose();
      }
    } catch {
      return null;
    }
  }
}

class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly type = 'ollama' as const;
  private base(): string {
    const url = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    return url.replace(/\/+$/, '');
  }
  isConfigured(): boolean {
    // Availability is confirmed at request time (the daemon may be down).
    return true;
  }
  defaultModel(): string {
    return process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
  }
  async embed(text: string): Promise<{ vector: number[]; model: string } | null> {
    const model = this.defaultModel();
    const timeoutMs = providerTimeoutMs('LLM_REQUEST_TIMEOUT_MS', 'OLLAMA_REQUEST_TIMEOUT_MS');
    const to = createLlmTimeout(timeoutMs);
    try {
      const res = await fetch(`${this.base()}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text.slice(0, 8000) }),
        signal: to.signal
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const vec: unknown = data?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) return null;
      return { vector: vec as number[], model: `ollama:${model}` };
    } catch {
      // Daemon unreachable / timeout / network error — caller falls back to keywords.
      return null;
    } finally {
      to.dispose();
    }
  }
}

const EMBEDDING_PROVIDERS: Record<'gemini' | 'ollama', () => EmbeddingProvider> = {
  gemini: () => new GeminiEmbeddingProvider(),
  ollama: () => new OllamaEmbeddingProvider()
};

/** Resolve the effective embedding provider (free-first).
 *  - `EMBEDDING_PROVIDER=gemini|ollama` forces a specific provider.
 *  - Otherwise: gemini when GEMINI_API_KEY is present, else the local/free
 *    Ollama embedding model. */
export function resolveEmbeddingProvider(): EmbeddingProvider {
  const forced = process.env.EMBEDDING_PROVIDER as 'gemini' | 'ollama' | undefined;
  if (forced && EMBEDDING_PROVIDERS[forced]) return EMBEDDING_PROVIDERS[forced]();
  if (process.env.GEMINI_API_KEY) return EMBEDDING_PROVIDERS.gemini();
  return EMBEDDING_PROVIDERS.ollama();
}

/** Whether any embedding provider is genuinely configured, i.e. background
 *  indexing is worth attempting. Used by db.ts startup to avoid hammering a
 *  dead daemon when no provider is intended. True when a Gemini key is present
 *  OR Ollama is explicitly enabled (base URL or model set, or provider forced
 *  to ollama). */
export function embeddingProviderAvailable(): boolean {
  if (process.env.GEMINI_API_KEY) return true;
  if (process.env.EMBEDDING_PROVIDER === 'ollama') return true;
  // An explicitly-configured Ollama endpoint/model signals intent to use the
  // local embedding path; a bare default (no env) does not, so a plain machine
  // without Ollama installed won't spam connection-refused on every startup.
  return !!process.env.OLLAMA_BASE_URL || !!process.env.OLLAMA_EMBEDDING_MODEL;
}
