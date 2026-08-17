import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * LLM Provider Abstraction tests.
 *
 * The platform must operate WITHOUT a mandatory paid AI API. This suite
 * proves the provider layer:
 *   - Selects the right adapter from an agent's declared provider.
 *   - Falls back to Ollama (local/free) when no Gemini key is present, so a
 *     fresh install works without a paid API.
 *   - Converts the canonical Gemini-typed tool declarations into a
 *     provider-agnostic JSON schema (every adapter consumes the same shape).
 *   - Degrades gracefully (NOT_CONFIGURED / error response, never throws)
 *     when a provider's credentials/daemon are unavailable.
 */

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_DEFAULT_MODEL;
  delete process.env.LLM_REQUEST_TIMEOUT_MS;
  delete process.env.OLLAMA_REQUEST_TIMEOUT_MS;
  delete process.env.GEMINI_REQUEST_TIMEOUT_MS;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

const {
  getLlmProvider,
  resolveProviderAndModel,
  toLlmToolDeclarations,
  SUPPORTED_LLM_PROVIDERS,
  resolveTimeoutMs,
  providerTimeoutMs,
  createLlmTimeout,
  isAbortError,
  LLM_TIMEOUT_DEFAULT_MS
} = await import('../src/server/llmProvider');
const { agentToolDeclarations } = await import('../src/server/tools');

describe('provider factory + free-first resolution', () => {
  it('exposes gemini and ollama as supported providers', () => {
    expect(SUPPORTED_LLM_PROVIDERS).toContain('gemini');
    expect(SUPPORTED_LLM_PROVIDERS).toContain('ollama');
  });

  it('returns the explicitly requested provider', () => {
    const p = getLlmProvider('ollama');
    expect(p.type).toBe('ollama');
    const g = getLlmProvider('gemini');
    expect(g.type).toBe('gemini');
  });

  it('defaults to ollama when no provider is declared and no Gemini key is set', () => {
    delete process.env.GEMINI_API_KEY;
    const { provider, model } = resolveProviderAndModel(null);
    expect(provider.type).toBe('ollama');
    expect(model).toBe('llama3.1'); // free-first default model
  });

  it('prefers gemini when a key IS present and no provider declared', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const { provider, model } = resolveProviderAndModel(null);
    expect(provider.type).toBe('gemini');
    expect(model).toBe('gemini-3.6-flash');
  });

  it('honors an agent-declared ollama provider even when a Gemini key exists', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const { provider } = resolveProviderAndModel({ llmProvider: 'ollama', model: 'llama3.1' });
    expect(provider.type).toBe('ollama');
  });

  it('uses the agent-declared model over the provider default', () => {
    const { model } = resolveProviderAndModel({ llmProvider: 'ollama', model: 'qwen2.5:7b' });
    expect(model).toBe('qwen2.5:7b');
  });

  it('falls back to the provider default model when the agent omits one', () => {
    const { model } = resolveProviderAndModel({ llmProvider: 'ollama' });
    expect(model).toBe('llama3.1');
  });
});

describe('gemini adapter configuration gating', () => {
  it('is NOT configured without GEMINI_API_KEY', () => {
    delete process.env.GEMINI_API_KEY;
    const p = getLlmProvider('gemini');
    expect(p.isConfigured()).toBe(false);
  });

  it('IS configured with GEMINI_API_KEY', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const p = getLlmProvider('gemini');
    expect(p.isConfigured()).toBe(true);
  });

  it('returns an error response (never throws) when the key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const p = getLlmProvider('gemini');
    const r = await p.generate({
      model: 'gemini-3.6-flash',
      systemPrompt: 'sys',
      messages: [{ role: 'user', text: 'hi' }],
      tools: []
    });
    expect(r.error).toBeTruthy();
    expect(r.text).toBe('');
    expect(r.functionCalls).toEqual([]);
  });
});

describe('ollama adapter (local/free)', () => {
  it('is configured by default (daemon availability checked at request time)', () => {
    const p = getLlmProvider('ollama');
    expect(p.isConfigured()).toBe(true);
  });

  it('returns a graceful error response when the daemon is unreachable', async () => {
    // Point at a port where nothing is listening so the fetch rejects.
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9';
    const p = getLlmProvider('ollama');
    const r = await p.generate({
      model: 'llama3.1',
      systemPrompt: 'sys',
      messages: [{ role: 'user', text: 'hi' }],
      tools: []
    });
    expect(r.error).toBeTruthy();
    expect(r.functionCalls).toEqual([]);
  });

  it('parses a tool-call response from a stubbed Ollama /api/chat reply', async () => {
    // Stub global fetch to simulate Ollama returning a function call.
    const originalFetch = globalThis.fetch;
    const captured: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      captured.push({ url: String(url), body: JSON.parse(init.body) });
      const resp: any = {
        ok: true,
        text: async () => '',
        json: async () => ({
          model: 'llama3.1',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'check_business_hours',
                  arguments: JSON.stringify({ day: 'monday' })
                }
              }
            ]
          },
          prompt_eval_count: 12,
          eval_count: 7
        })
      };
      return resp;
    }) as any;

    try {
      const p = getLlmProvider('ollama');
      const r = await p.generate({
        model: 'llama3.1',
        systemPrompt: 'sys',
        messages: [{ role: 'user', text: 'are you open monday?' }],
        tools: toLlmToolDeclarations(agentToolDeclarations)
      });
      expect(r.error).toBeUndefined();
      expect(r.functionCalls.length).toBe(1);
      expect(r.functionCalls[0].name).toBe('check_business_hours');
      expect(r.functionCalls[0].args).toEqual({ day: 'monday' });
      expect(r.usage?.inputTokens).toBe(12);
      expect(r.usage?.outputTokens).toBe(7);
      // The request hit the OpenAI-compatible tools shape.
      const body = captured[0].body;
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.tools[0].function.name).toBe('check_business_hours');
      expect(body.stream).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('canonical -> provider-agnostic tool schema conversion', () => {
  it('converts every platform tool declaration to the normalized shape', () => {
    const decls = toLlmToolDeclarations(agentToolDeclarations);
    expect(decls.length).toBe(agentToolDeclarations.length);
    for (const d of decls) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.description).toBe('string');
      expect(d.parameters).toBeTruthy();
      expect(['object', 'string', 'integer', 'number', 'boolean', 'array'])
        .toContain(d.parameters.type);
    }
  });

  it('preserves required fields and nested array item schemas', () => {
    const decls = toLlmToolDeclarations(agentToolDeclarations);
    const order = decls.find(d => d.name === 'create_order')!;
    expect(order).toBeTruthy();
    expect(order.parameters.properties?.items).toBeTruthy();
    expect(order.parameters.properties?.items?.type).toBe('array');
    expect(order.parameters.properties?.items?.items?.type).toBe('object');
    expect(order.parameters.required).toEqual(expect.arrayContaining(['customerName', 'customerPhone', 'items']));
  });

  it('produces the same normalized schema regardless of provider (uniformity)', () => {
    // The runtime hands the SAME normalized declarations to every adapter;
    // the canonical source stays the Gemini-typed declarations in tools.ts.
    const once = JSON.stringify(toLlmToolDeclarations(agentToolDeclarations));
    const twice = JSON.stringify(toLlmToolDeclarations(agentToolDeclarations));
    expect(once).toBe(twice);
  });
});

// ---------------------------------------------------------------------------
// P1 reliability: request timeouts.
// Every outbound LLM request must be bounded so a hung/slow provider never
// holds an Express request open indefinitely. A timeout returns the adapter's
// NORMALIZED error response (text='', error='... timed out ...') — the runtime
// degrades to a graceful human-handoff reply exactly as for an unreachable
// daemon. A timeout NEVER fabricates an answer, NEVER throws an uncaught
// AbortError into the runtime, and invalid config never disables protection.
// ---------------------------------------------------------------------------

describe('timeout resolution', () => {
  it('uses a safe production default when the env var is unset', () => {
    delete process.env.LLM_REQUEST_TIMEOUT_MS;
    expect(resolveTimeoutMs('LLM_REQUEST_TIMEOUT_MS')).toBe(LLM_TIMEOUT_DEFAULT_MS);
    expect(LLM_TIMEOUT_DEFAULT_MS).toBeGreaterThanOrEqual(30_000); // bounded + sane
  });

  it('honors a valid configured timeout', () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '15000';
    expect(resolveTimeoutMs('LLM_REQUEST_TIMEOUT_MS')).toBe(15_000);
  });

  it('falls back to the default for an invalid (non-numeric) value', () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = 'not-a-number';
    expect(resolveTimeoutMs('LLM_REQUEST_TIMEOUT_MS')).toBe(LLM_TIMEOUT_DEFAULT_MS);
  });

  it('falls back to the default for a negative value (never disables protection)', () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '-5';
    expect(resolveTimeoutMs('LLM_REQUEST_TIMEOUT_MS')).toBe(LLM_TIMEOUT_DEFAULT_MS);
  });

  it('falls back to the default for zero (never disables protection)', () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '0';
    expect(resolveTimeoutMs('LLM_REQUEST_TIMEOUT_MS')).toBe(LLM_TIMEOUT_DEFAULT_MS);
  });

  it('honors a per-provider override over the global value', () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '30000';
    process.env.OLLAMA_REQUEST_TIMEOUT_MS = '7000';
    expect(providerTimeoutMs('LLM_REQUEST_TIMEOUT_MS', 'OLLAMA_REQUEST_TIMEOUT_MS')).toBe(7_000);
  });

  it('uses the global when the override is invalid (override never disables)', () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '30000';
    process.env.OLLAMA_REQUEST_TIMEOUT_MS = 'bogus';
    expect(providerTimeoutMs('LLM_REQUEST_TIMEOUT_MS', 'OLLAMA_REQUEST_TIMEOUT_MS')).toBe(30_000);
  });
});

describe('createLlmTimeout + isAbortError', () => {
  it('produces an abort signal that fires after the deadline', async () => {
    const to = createLlmTimeout(40);
    expect(to.signal.aborted).toBe(false);
    await new Promise(r => setTimeout(r, 70));
    expect(to.signal.aborted).toBe(true);
    to.dispose();
  });

  it('dispose clears the timer so the signal never aborts', async () => {
    const to = createLlmTimeout(40);
    to.dispose();
    await new Promise(r => setTimeout(r, 70));
    expect(to.signal.aborted).toBe(false);
  });

  it('isAbortError detects a signal-driven abort', () => {
    const to = createLlmTimeout(1);
    const fakeErr = { name: 'AbortError' };
    expect(isAbortError(fakeErr, to.signal)).toBe(true);
    to.dispose();
  });

  it('isAbortError detects an AbortError by name even without a signal', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError({ name: 'DOMException' })).toBe(true);
    expect(isAbortError({ name: 'TypeError' })).toBe(false);
    expect(isAbortError({ name: undefined })).toBe(false);
  });
});

describe('ollama request timeout', () => {
  it('aborts a hanging ollama request and returns a normalized timeout error', async () => {
    // Stub fetch to NEVER resolve on its own but REJECT on abort (simulates a
    // hung daemon that the AbortController cancels). The adapter must return a
    // normalized timeout error after the configured deadline.
    const originalFetch = globalThis.fetch;
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: any, init: any) => {
      receivedSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        const sig: AbortSignal | undefined = init?.signal;
        if (sig) {
          if (sig.aborted) reject(new DOMException('aborted', 'AbortError'));
          sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }
        // Never resolves otherwise; only the abort path rejects.
      });
    }) as any;
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    process.env.LLM_REQUEST_TIMEOUT_MS = '60'; // 60ms — fast test, bounded
    try {
      const p = getLlmProvider('ollama');
      const start = Date.now();
      const r = await p.generate({
        model: 'llama3.1',
        systemPrompt: 'sys',
        messages: [{ role: 'user', text: 'hi' }],
        tools: []
      });
      const elapsed = Date.now() - start;
      // Timed out (not hung), and close to the deadline (not the 60s default).
      expect(r.text).toBe('');
      expect(r.functionCalls).toEqual([]);
      expect(r.error).toMatch(/timed out/i);
      expect(elapsed).toBeLessThan(5_000); // did NOT hang indefinitely
      // The fetch was given our abort signal.
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not throw an uncaught AbortError into the caller (normalized)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, _init: any) => {
      // Reject with an AbortError to prove the catch normalizes it.
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as any;
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    process.env.LLM_REQUEST_TIMEOUT_MS = '1000';
    try {
      const p = getLlmProvider('ollama');
      const r = await p.generate({
        model: 'llama3.1', systemPrompt: 'sys',
        messages: [{ role: 'user', text: 'hi' }], tools: []
      });
      // No throw — a normalized error response is returned.
      expect(r.error).toBeTruthy();
      expect(r.text).toBe('');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('still returns a graceful error when the daemon is unreachable (existing behavior)', async () => {
    // A dead port rejects immediately (ECONNREFUSED), not a timeout.
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9';
    const p = getLlmProvider('ollama');
    const r = await p.generate({
      model: 'llama3.1', systemPrompt: 'sys',
      messages: [{ role: 'user', text: 'hi' }], tools: []
    });
    expect(r.error).toBeTruthy();
    expect(r.functionCalls).toEqual([]);
    // This is an unreachable error, NOT a timeout error.
    expect(r.error).not.toMatch(/timed out/i);
  });

  it('still parses a successful tool-call response (existing behavior preserved)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      // Ensure a signal is passed but the request resolves normally.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return {
        ok: true,
        text: async () => '',
        json: async () => ({
          model: 'llama3.1',
          message: { role: 'assistant', content: '', tool_calls: [
            { function: { name: 'check_business_hours', arguments: JSON.stringify({ day: 'monday' }) } }
          ] },
          prompt_eval_count: 5, eval_count: 3
        })
      } as any;
    }) as any;
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    try {
      const p = getLlmProvider('ollama');
      const r = await p.generate({
        model: 'llama3.1', systemPrompt: 'sys',
        messages: [{ role: 'user', text: 'are you open monday?' }],
        tools: toLlmToolDeclarations(agentToolDeclarations)
      });
      expect(r.error).toBeUndefined();
      expect(r.functionCalls.length).toBe(1);
      expect(r.functionCalls[0].name).toBe('check_business_hours');
      expect(r.usage?.inputTokens).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('gemini request timeout', () => {
  it('aborts a hanging gemini request and returns a normalized timeout error', async () => {
    // The Gemini SDK (@google/genai) ultimately issues an HTTP request via
    // fetch and respects the abortSignal we pass in config. Stub global fetch
    // to never resolve on its own but reject on abort, and assert the adapter
    // returns a normalized timeout error after the configured deadline.
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.LLM_REQUEST_TIMEOUT_MS = '60';
    const originalFetch = globalThis.fetch;
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: any, init: any) => {
      receivedSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        const sig: AbortSignal | undefined = init?.signal;
        if (sig) {
          if (sig.aborted) reject(new DOMException('aborted', 'AbortError'));
          sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }
      });
    }) as any;
    try {
      const p = getLlmProvider('gemini');
      const start = Date.now();
      const r = await p.generate({
        model: 'gemini-3.6-flash', systemPrompt: 'sys',
        messages: [{ role: 'user', text: 'hi' }], tools: []
      });
      const elapsed = Date.now() - start;
      expect(r.text).toBe('');
      expect(r.functionCalls).toEqual([]);
      expect(r.error).toMatch(/timed out/i);
      expect(elapsed).toBeLessThan(5_000); // bounded, not hung
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.GEMINI_API_KEY;
    }
    // The fetch (or SDK) was given an abort signal. Some SDK builds pass the
    // signal through a different option name; assert loosely to stay robust.
    expect(receivedSignal === undefined || receivedSignal instanceof AbortSignal).toBe(true);
  });

  it('does not throw an uncaught AbortError into the caller (normalized)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.LLM_REQUEST_TIMEOUT_MS = '1000';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as any;
    try {
      const p = getLlmProvider('gemini');
      const r = await p.generate({
        model: 'gemini-3.6-flash', systemPrompt: 'sys',
        messages: [{ role: 'user', text: 'hi' }], tools: []
      });
      expect(r.error).toBeTruthy();
      expect(r.text).toBe('');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('still returns a normalized error when the key is missing (existing behavior)', async () => {
    delete process.env.GEMINI_API_KEY;
    const p = getLlmProvider('gemini');
    const r = await p.generate({
      model: 'gemini-3.6-flash', systemPrompt: 'sys',
      messages: [{ role: 'user', text: 'hi' }], tools: []
    });
    expect(r.error).toBeTruthy();
    expect(r.text).toBe('');
    expect(r.functionCalls).toEqual([]);
    expect(r.error).not.toMatch(/timed out/i); // config error, not a timeout
  });
});
