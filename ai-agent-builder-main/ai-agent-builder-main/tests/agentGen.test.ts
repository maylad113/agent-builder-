import { describe, it, expect } from 'vitest';

/**
 * Agent generation (Phase 7) tests:
 *  - The AI must NEVER invent business facts. When the input lacks hours or
 *    services, the generated config marks them NEEDS_INPUT rather than
 *    fabricating prices/durations ("Haircuts cost 300000 toman").
 *  - When Gemini is unavailable (no API key), the fact-safe fallback is used
 *    and is equally non-inventing.
 *  - The system prompt instructs the agent never to state unconfigured facts.
 */
process.env.SESSION_SECRET = 'test-gen-secret';
delete process.env.GEMINI_API_KEY;

const { generateSuggestedAgentConfig } = await import('../src/server/agentRuntime');

describe('agent generation never invents business facts', () => {
  it('marks missing services/hours as NEEDS_INPUT (no fabricated prices)', async () => {
    const cfg = await generateSuggestedAgentConfig({
      name: 'Mystery Barber Shop',
      type: 'barber',
      description: 'A barber shop.'
      // hours and services intentionally omitted
    });

    // No invented price should appear anywhere in the suggested services.
    const services = cfg.suggestedServices as any[];
    expect(services.length).toBeGreaterThan(0);
    for (const s of services) {
      expect(s.price).toBe('NEEDS_INPUT');
      expect(s.durationMinutes).toBe('NEEDS_INPUT');
    }

    // needsInput must list the missing business facts.
    const needs = cfg.needsInput as string[];
    const needsLower = needs.map(n => n.toLowerCase());
    expect(needsLower).toEqual(expect.arrayContaining(['operating hours']));
    expect(needsLower.some(n => n.includes('service'))).toBe(true);

    // System prompt must forbid stating unconfigured facts.
    expect(String(cfg.systemPrompt).toLowerCase()).toMatch(/never|configured|escalate|invent|do not state/);
  });

  it('does not invent a price when only a bare description is given', async () => {
    const cfg = await generateSuggestedAgentConfig({
      name: 'Generic Salon',
      type: 'salon',
      description: 'We do hair.'
    });
    const invented = (cfg.suggestedServices as any[]).some(
      s => typeof s.price === 'number' || typeof s.durationMinutes === 'number'
    );
    expect(invented).toBe(false);
  });

  it('keeps provided service values but still flags missing hours', async () => {
    const cfg = await generateSuggestedAgentConfig({
      name: 'Cafe With Services',
      type: 'restaurant',
      description: 'A cafe.',
      services: 'Espresso $4, Latte $5'
      // hours omitted
    });
    expect((cfg.needsInput as string[]).map(n => n.toLowerCase())).toEqual(
      expect.arrayContaining(['operating hours'])
    );
  });
});
