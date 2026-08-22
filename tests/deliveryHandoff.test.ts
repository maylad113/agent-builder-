import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

/**
 * Task 26 — operator delivery handoff in the PLATFORM_OWNER UI.
 *
 * The Deliveries panel must expose the EXISTING Task 23 provisioning API and
 * the EXISTING Task 19/24 onboarding artifact so the operator can complete
 * the customer handoff without curl. The UI never re-implements backend
 * logic: provisioning/idempotency/one-time-password semantics are server
 * decisions; the view only renders what the server returns.
 *
 * SECURITY (one-time password): the OTP is rendered ONLY when the server
 * returned it (initial 201). It must never be persisted to
 * localStorage/sessionStorage, never placed in URLs, never re-displayed on a
 * replay, and never faked when the server omits it.
 *
 * Test approach follows the project's established pattern
 * (controlCenter.test.ts): vitest node env — pure display-logic unit tests +
 * renderToStaticMarkup smoke tests of the presentational DeliveryHandoffPanel.
 */
import {
  PROVISION_ENDPOINT,
  ONBOARDING_ENDPOINT,
  canProvisionDelivery,
  isAlreadyProvisioned,
  provisionResultFromResponse,
  ONE_TIME_PASSWORD_NOTICE,
  embedSnippetOf,
  allowedOriginsOf
} from '../src/components/deliveryHandoffLogic';
import { DeliveryHandoffPanel } from '../src/components/DeliveryHandoffPanel';
import { Delivery, OnboardingArtifact } from '../src/types';

const mkDelivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: 'del-1', prospectId: 'pro-1', businessId: 'biz-1', agentId: 'agent-1',
  status: 'DELIVERED', deliveryMethod: 'manual',
  deliveryPayload: { note: 'ready', agentId: 'agent-1', businessId: 'biz-1' },
  deliveredAt: '2026-08-21T00:00:00.000Z',
  createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  ...over
});

const mkArtifact = (): OnboardingArtifact => ({
  deliveryId: 'del-1', deliveryStatus: 'DELIVERED', deliveryMethod: 'manual',
  deliveredAt: '2026-08-21T00:00:00.000Z',
  business: { id: 'biz-1', name: 'Smoke Cuts' },
  agent: { id: 'agent-1', name: 'Front Desk AI', status: 'ACTIVE', capabilities: ['Answer FAQs'] },
  channels: [
    {
      type: 'web_chat', status: 'connected', note: 'Website chat widget is available.',
      embedSnippet: '<script src="https://platform.example/widget.js" data-business-id="biz-1"></script>',
      allowedOrigins: ['https://smokecuts.example']
    },
    { type: 'instagram', status: 'not_configured', note: 'Not configured — no action has been taken on this channel.' }
  ],
  instructions: [
    'Your AI agent "Front Desk AI" is live and ready to serve customers.',
    'The widget is allow-listed for these website origins: https://smokecuts.example. Embed it only on those sites.'
  ]
});

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe('deliveryHandoffLogic', () => {
  it('uses the EXISTING backend endpoints (no second implementation)', () => {
    expect(PROVISION_ENDPOINT('del-9')).toBe('/api/orchestration/deliveries/del-9/provision-owner-account');
    expect(ONBOARDING_ENDPOINT('del-9')).toBe('/api/orchestration/deliveries/del-9/onboarding');
  });

  it('provisioning display hint: DELIVERED/ACCEPTED only (server remains authoritative)', () => {
    expect(canProvisionDelivery(mkDelivery({ status: 'DELIVERED' }))).toBe(true);
    expect(canProvisionDelivery(mkDelivery({ status: 'ACCEPTED' }))).toBe(true);
    expect(canProvisionDelivery(mkDelivery({ status: 'PENDING' as any }))).toBe(false);
  });

  it('detects an already-provisioned delivery from the server payload', () => {
    expect(isAlreadyProvisioned(mkDelivery())).toBe(false);
    expect(isAlreadyProvisioned(mkDelivery({ deliveryPayload: { ownerAccountUserId: 'usr-1' } }))).toBe(true);
  });

  it('maps the initial 201 to a one-time password display', () => {
    const r = provisionResultFromResponse(201, {
      user: { id: 'usr-1', email: 'owner@shop.example', role: 'BUSINESS_OWNER', businessId: 'biz-1' },
      temporaryPassword: 'one-time-secret'
    });
    expect(r.temporaryPassword).toBe('one-time-secret');
    expect(r.alreadyProvisioned).toBe(false);
  });

  it('a replay (200) NEVER surfaces a password — even if a hostile body tries to include one', () => {
    const r = provisionResultFromResponse(200, {
      user: { id: 'usr-1', email: 'owner@shop.example' },
      temporaryPassword: 'should-be-ignored'
    });
    expect(r.temporaryPassword).toBeUndefined();
    expect(r.alreadyProvisioned).toBe(true);
  });

  it('a 201 without a password field also never fabricates one', () => {
    const r = provisionResultFromResponse(201, { user: { id: 'usr-1' } });
    expect(r.temporaryPassword).toBeUndefined();
  });

  it('extracts the embed snippet and origins from the existing artifact shape', () => {
    const art = mkArtifact();
    expect(embedSnippetOf(art)).toBe('<script src="https://platform.example/widget.js" data-business-id="biz-1"></script>');
    expect(allowedOriginsOf(art)).toEqual(['https://smokecuts.example']);
    const noWeb: OnboardingArtifact = { ...art, channels: [{ type: 'instagram', status: 'not_configured' }] };
    expect(embedSnippetOf(noWeb)).toBeUndefined();
    expect(allowedOriginsOf(noWeb)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Presentational panel (renderToStaticMarkup)
// ---------------------------------------------------------------------------

describe('DeliveryHandoffPanel', () => {
  const noop = () => {};

  it('renders provisioning controls (email + name + action) for an eligible, un-provisioned delivery', () => {
    const html = renderToStaticMarkup(React.createElement(DeliveryHandoffPanel, {
      delivery: mkDelivery(),
      provisionState: { status: 'idle' },
      onProvision: noop,
      onProvisionClose: noop,
      onboarding: null,
      onboardingOpen: false,
      onOnboardingToggle: noop,
      onOnboardingClose: noop
    }));
    expect(html).toContain('provision-owner-account');
    expect(html).toContain('Owner email');
    expect(html).toContain('Owner name');
    expect(html).toContain('Provision owner account');
    expect(html).not.toContain('temporaryPassword');
  });

  it('initial provisioning state displays the one-time password EXACTLY as returned, with the once-only warning and a copy action', () => {
    const html = renderToStaticMarkup(React.createElement(DeliveryHandoffPanel, {
      delivery: mkDelivery(),
      provisionState: { status: 'provisioned', result: { temporaryPassword: 'otp-abc-123', alreadyProvisioned: false, user: { id: 'usr-1', email: 'owner@shop.example' } } },
      onProvision: noop,
      onProvisionClose: noop,
      onboarding: null,
      onboardingOpen: false,
      onOnboardingToggle: noop,
      onOnboardingClose: noop
    }));
    expect(html).toContain('otp-abc-123');
    expect(html).toContain(ONE_TIME_PASSWORD_NOTICE);
    expect(html).toContain('Copy');
    expect(html).toContain('owner@shop.example');
  });

  it('replay state shows the existing account and NO password, and does not offer provisioning again', () => {
    const html = renderToStaticMarkup(React.createElement(DeliveryHandoffPanel, {
      delivery: mkDelivery({ deliveryPayload: { ownerAccountUserId: 'usr-1' } }),
      provisionState: { status: 'provisioned', result: { alreadyProvisioned: true, user: { id: 'usr-1', email: 'owner@shop.example' } } },
      onProvision: noop,
      onProvisionClose: noop,
      onboarding: null,
      onboardingOpen: false,
      onOnboardingToggle: noop,
      onOnboardingClose: noop
    }));
    expect(html).toContain('already provisioned');
    expect(html).toContain('owner@shop.example');
    expect(html).not.toContain('temporaryPassword');
    expect(html).not.toContain('Provision owner account');
  });

  it('already-provisioned delivery (from server payload) does not render the provision form', () => {
    const html = renderToStaticMarkup(React.createElement(DeliveryHandoffPanel, {
      delivery: mkDelivery({ deliveryPayload: { ownerAccountUserId: 'usr-1' } }),
      provisionState: { status: 'idle' },
      onProvision: noop,
      onProvisionClose: noop,
      onboarding: null,
      onboardingOpen: false,
      onOnboardingToggle: noop,
      onOnboardingClose: noop
    }));
    expect(html).not.toContain('Provision owner account');
    expect(html).toContain('owner account');
  });

  it('renders the onboarding artifact: absolute embed snippet AS TEXT (never executed), origins, and instructions', () => {
    const art = mkArtifact();
    const html = renderToStaticMarkup(React.createElement(DeliveryHandoffPanel, {
      delivery: mkDelivery(),
      provisionState: { status: 'idle' },
      onProvision: noop,
      onProvisionClose: noop,
      onboarding: art,
      onboardingOpen: true,
      onOnboardingToggle: noop,
      onOnboardingClose: noop
    }));
    // The snippet must be escaped text inside a code block, not a live script.
    expect(html).not.toContain('<script src="https://platform.example/widget.js"');
    expect(html).toContain('&lt;script src=&quot;https://platform.example/widget.js&quot; data-business-id=&quot;biz-1&quot;&gt;&lt;/script&gt;');
    expect(html).toContain('https://smokecuts.example');
    expect(html).toContain('live and ready to serve customers');
    expect(html).toContain('Copy');
    expect(html).toContain('<code');
  });

  it('renders server errors safely as text', () => {
    const html = renderToStaticMarkup(React.createElement(DeliveryHandoffPanel, {
      delivery: mkDelivery(),
      provisionState: { status: 'error', error: 'An account with this email already exists.' },
      onProvision: noop,
      onProvisionClose: noop,
      onboarding: null,
      onboardingOpen: false,
      onOnboardingToggle: noop,
      onOnboardingClose: noop
    }));
    expect(html).toContain('An account with this email already exists.');
    expect(html).not.toContain('Provision owner account');
  });

  it('existing delivery row information still renders (status badge, ids)', () => {
    const html = renderToStaticMarkup(React.createElement(DeliveryHandoffPanel, {
      delivery: mkDelivery({ status: 'ACCEPTED' }),
      provisionState: { status: 'idle' },
      onProvision: noop,
      onProvisionClose: noop,
      onboarding: null,
      onboardingOpen: false,
      onOnboardingToggle: noop,
      onOnboardingClose: noop
    }));
    expect(html).toContain('ACCEPTED');
    expect(html).toContain('del-1');
  });
});

// ---------------------------------------------------------------------------
// One-time-password storage discipline (static source audit)
// ---------------------------------------------------------------------------

describe('OTP storage discipline', () => {
  it('the UI source never touches web storage or URLs with the password', async () => {
    const fs = await import('fs');
    const panel = fs.readFileSync(new URL('../src/components/DeliveryHandoffPanel.tsx', import.meta.url), 'utf8');
    const view = fs.readFileSync(new URL('../src/components/OrchestrationView.tsx', import.meta.url), 'utf8');
    for (const src of [panel, view]) {
      expect(src).not.toMatch(/localStorage|sessionStorage/);
      expect(src).not.toMatch(/location\.(href|assign|replace)/);
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});
