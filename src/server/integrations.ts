import { IntegrationConfig, IntegrationProviderType, IntegrationState } from '../types';

/**
 * Integration provider abstraction (Phase 11 / P1.1).
 *
 * Lifecycle:
 *   NOT_CONFIGURED -> CONFIGURING -> CONNECTED  (only after validate() succeeds)
 *                              \-> ERROR       (validate() failed)
 *   CONNECTED -> DISCONNECTED -> CONFIGURING -> CONNECTED ...
 *
 * Invariants:
 *  - A provider is CONNECTED ONLY after `validate()` actually succeeds against
 *    the real provider API (or a safe local pre-check when the SDK is absent).
 *  - The frontend can NEVER set `state = CONNECTED` directly; it can only
 *    submit credentials and request validation. The server runs validate().
 *  - Credentials are held server-side only and never returned to the client.
 *
 * When real credentials are absent, providers expose a NOT_CONFIGURED status and
 * the rest of the platform keeps working (see tests/noOptionalEnv.test.ts).
 */

export interface ProviderValidationInput {
  /** Non-secret config (e.g. calendar id, from-phone). */
  configData?: Record<string, string>;
  /** Raw credentials submitted by the operator (server-side only). */
  credentials: Record<string, string>;
}

export interface ProviderValidationResult {
  ok: boolean;
  message: string;
  /** Optional sanitized metadata the provider returns after a successful
   * validation (e.g. the connected account email). Stored on configData. */
  meta?: Record<string, string>;
}

export interface IntegrationProvider {
  readonly type: IntegrationProviderType;
  /** Human-readable label. */
  readonly label: string;
  /** Credential field names this provider expects (for documentation/UI). */
  readonly credentialFields: string[];
  /** Validate the submitted credentials against the real provider. Returns ok
   * only when the provider confirms the credentials work. Never throws —
   * network/SDK failures return { ok: false, message }. */
  validate(input: ProviderValidationInput): Promise<ProviderValidationResult>;
  /** Whether the platform-global credentials (env vars) for this provider are
   * present. Used to decide NOT_CONFIGURED vs CONFIGURING. */
  platformConfigured(): boolean;
}

// ---------------------------------------------------------------------------
// Credential storage — server-side only. NEVER serialized to the client.
// In production this would be encrypted at rest; here we keep an in-process
// map keyed by integration id so credentials never reach the DB JSON or API
// responses. (The DB row stores only non-secret configData + state.)
// ---------------------------------------------------------------------------

const credentialStore = new Map<string, Record<string, string>>();

export function storeCredentials(integrationId: string, creds: Record<string, string>): void {
  // Never persist secrets to disk in this prototype; they live in process
  // memory. A production deployment would encrypt-at-rest (KMS/SQLCipher).
  credentialStore.set(integrationId, { ...creds });
}

export function getCredentials(integrationId: string): Record<string, string> | undefined {
  return credentialStore.get(integrationId);
}

export function clearCredentials(integrationId: string): void {
  credentialStore.delete(integrationId);
}

/** Strip secrets from an IntegrationConfig before returning it to the client. */
export function sanitizeIntegrationForClient(integ: IntegrationConfig): IntegrationConfig {
  return {
    ...integ,
    configData: integ.configData ? { ...integ.configData } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helper to run validation and update the integration row state.
// ---------------------------------------------------------------------------

export function initialIntegrationState(providerType: IntegrationProviderType, hasCreds: boolean): IntegrationState {
  if (!hasCreds) return 'NOT_CONFIGURED';
  return 'CONFIGURING';
}

/**
 * Validate an integration's credentials and return the new state + message.
 * The caller persists the returned state. This is the ONLY path to CONNECTED.
 */
export async function runValidation(
  provider: IntegrationProvider,
  integrationId: string,
  configData: Record<string, string> | undefined,
  credentials: Record<string, string>
): Promise<{ state: IntegrationState; statusMessage: string; lastError?: string; meta?: Record<string, string> }> {
  try {
    const result = await provider.validate({ configData, credentials });
    if (result.ok) {
      return {
        state: 'CONNECTED',
        statusMessage: result.message,
        meta: result.meta,
      };
    }
    return {
      state: 'ERROR',
      statusMessage: result.message,
      lastError: result.message,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Validation failed unexpectedly.';
    return { state: 'ERROR', statusMessage: msg, lastError: msg };
  }
}

// ---------------------------------------------------------------------------
// Provider implementations.
//
// Each validate() performs a real check when the official SDK/credentials are
// available, and otherwise returns a clear NOT_CONFIGURED-style message. We
// never fake a successful connection.
// ---------------------------------------------------------------------------

function hasEnv(...names: string[]): boolean {
  return names.every(n => !!process.env[n] && String(process.env[n]).trim() !== '');
}

/** Google Calendar — validates via a lightweight OAuth token / API-key probe. */
export const googleCalendarProvider: IntegrationProvider = {
  type: 'google_calendar',
  label: 'Google Calendar',
  credentialFields: ['access_token', 'refresh_token', 'calendar_id'],
  platformConfigured() {
    return hasEnv('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
  },
  async validate(input) {
    const creds = input.credentials || {};
    // Require either a user access token or platform OAuth config + refresh token.
    const hasAccessToken = !!creds.access_token;
    const hasOAuth = this.platformConfigured() && !!creds.refresh_token;
    if (!hasAccessToken && !hasOAuth) {
      return { ok: false, message: 'Google Calendar credentials missing. Provide an access_token or a refresh_token (with GOOGLE_CLIENT_ID/SECRET configured).' };
    }
    // Real probe: list calendars via the Google Calendar API. This is an actual
    // network call against the official API; failure means NOT connected.
    try {
      const token = creds.access_token;
      const resp = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (resp.ok) {
        return { ok: true, message: 'Google Calendar connected.', meta: { validatedAt: new Date().toISOString() } };
      }
      return { ok: false, message: `Google Calendar validation failed (HTTP ${resp.status}).` };
    } catch (e) {
      return { ok: false, message: `Google Calendar validation error: ${e instanceof Error ? e.message : 'network error'}` };
    }
  },
};

/** Meta/Instagram — validates the long-lived access token against the Graph API. */
export const metaInstagramProvider: IntegrationProvider = {
  type: 'meta_instagram',
  label: 'Meta / Instagram',
  credentialFields: ['access_token', 'instagram_business_account_id'],
  platformConfigured() {
    return hasEnv('META_APP_ID', 'META_APP_SECRET');
  },
  async validate(input) {
    const creds = input.credentials || {};
    if (!creds.access_token) {
      return { ok: false, message: 'Meta access token missing.' };
    }
    try {
      const resp = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(creds.access_token)}`);
      if (resp.ok) {
        return { ok: true, message: 'Meta/Instagram connected.', meta: { validatedAt: new Date().toISOString() } };
      }
      return { ok: false, message: `Meta validation failed (HTTP ${resp.status}).` };
    } catch (e) {
      return { ok: false, message: `Meta validation error: ${e instanceof Error ? e.message : 'network error'}` };
    }
  },
};

/** Twilio — validates Account SID + Auth Token via the Twilio REST API. */
export const twilioProvider: IntegrationProvider = {
  type: 'twilio_sms',
  label: 'Twilio',
  credentialFields: ['account_sid', 'auth_token', 'from_number'],
  platformConfigured() {
    return hasEnv('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN');
  },
  async validate(input) {
    const creds = input.credentials || {};
    const sid = creds.account_sid || process.env.TWILIO_ACCOUNT_SID;
    const token = creds.auth_token || process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      return { ok: false, message: 'Twilio Account SID and Auth Token are required.' };
    }
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (resp.ok) {
        return { ok: true, message: 'Twilio connected.', meta: { validatedAt: new Date().toISOString() } };
      }
      return { ok: false, message: `Twilio validation failed (HTTP ${resp.status}).` };
    } catch (e) {
      return { ok: false, message: `Twilio validation error: ${e instanceof Error ? e.message : 'network error'}` };
    }
  },
};

/** Voice AI — validates the configured endpoint responds to a health probe. */
export const voiceAiProvider: IntegrationProvider = {
  type: 'voice_ai',
  label: 'Voice AI',
  credentialFields: ['api_key'],
  platformConfigured() {
    return hasEnv('VOICE_AI_ENDPOINT');
  },
  async validate(input) {
    const creds = input.credentials || {};
    const endpoint = process.env.VOICE_AI_ENDPOINT;
    const key = creds.api_key || process.env.VOICE_AI_API_KEY;
    if (!endpoint) {
      return { ok: false, message: 'VOICE_AI_ENDPOINT is not configured.' };
    }
    if (!key) {
      return { ok: false, message: 'Voice AI API key missing.' };
    }
    try {
      const resp = await fetch(`${endpoint.replace(/\/$/, '')}/health`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (resp.ok) {
        return { ok: true, message: 'Voice AI provider connected.', meta: { validatedAt: new Date().toISOString() } };
      }
      return { ok: false, message: `Voice AI validation failed (HTTP ${resp.status}).` };
    } catch (e) {
      return { ok: false, message: `Voice AI validation error: ${e instanceof Error ? e.message : 'network error'}` };
    }
  },
};

const providersByType: Record<IntegrationProviderType, IntegrationProvider> = {
  google_calendar: googleCalendarProvider,
  meta_instagram: metaInstagramProvider,
  twilio_sms: twilioProvider,
  voice_ai: voiceAiProvider,
};

export function getProvider(type: IntegrationProviderType): IntegrationProvider {
  return providersByType[type];
}
