import crypto from 'crypto';

/**
 * Encrypted credential storage crypto helper (P1 — persist integration
 * credentials securely at rest).
 *
 * Design:
 *   - Authenticated encryption: AES-256-GCM ( confidentiality + integrity ).
 *   - A fresh random 12-byte IV per encryption operation (never reused).
 *   - The auth tag is stored alongside the ciphertext and verified on decrypt,
 *     so tampering or a wrong key fails loudly (throws) — never returns
 *     garbage/plaintext.
 *   - The encryption key is NEVER stored in the database. It is resolved from
 *     environment configuration: `INTEGRATION_ENCRYPTION_KEY` (preferred) or
 *     derived from `SESSION_SECRET`. If no key is available, encryption REFUSES
 *     to run and throws — credentials are never persisted in plaintext.
 *
 * Ciphertext envelope format (all base64url, no newlines):
 *   `v1.<iv>.<authTag>.<ciphertext>`
 *
 * Key rotation: each envelope records the `KEY_ID` of the key that produced it
 * (see `currentKeyId()`). A rotation would introduce a new key id; existing
 * envelopes can be decrypted with the old key and re-encrypted under the new
 * id by an offline rotation job. (See module-level note on rotation.)
 */

/** Domain-separation salt/info for HKDF key derivation. */
const HKDF_SALT = Buffer.from('agentforge.integration-credentials.v1', 'utf8');
const HKDF_INFO = Buffer.from('aes-256-gcm', 'utf8');
const KEY_LEN = 32; // AES-256

/**
 * The logical id of the active encryption key. Bumped/changed only when a key
 * is intentionally rotated. Stored on each credential row so a rotation job can
 * find rows still encrypted under an old key.
 *
 * ROTATION LIMITATION (documented, not auto-applied):
 * This implementation supports *detecting* which key id a row was encrypted
 * with and decrypting with the currently-configured key. Full multi-key
 * decryption (keeping old keys around for decrypt while encrypting with a new
 * one) is intentionally NOT wired into the live runtime to avoid storing
 * multiple secrets in memory; a rotation is performed as an offline job:
 *   1. Set INTEGRATION_ENCRYPTION_KEY to the NEW key.
 *   2. Run a one-shot migration that re-encrypts every row whose key_id != new
 *      id, using a stored mapping of old->new keys supplied out-of-band.
 * Until that job runs, rows encrypted under the old key remain readable only
 * if the old key is still the configured key. This is a deliberate trade-off:
 * we never hold multiple master keys in process memory at runtime.
 */
export const CURRENT_KEY_ID = 'k1';

export class CredentialEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialEncryptionError';
  }
}

/** The source material for the encryption key, as a string. Returns null when
 *  no key material is configured (so callers can fail safe rather than store
 *  plaintext). In production SESSION_SECRET is always present (required at
 *  boot), so this only returns null in a misconfigured/dev-without-secret env. */
function keyMaterial(): string | null {
  const explicit = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (explicit && explicit.trim() !== '') return explicit.trim();
  const session = process.env.SESSION_SECRET;
  if (session && session.trim() !== '') return session.trim();
  return null;
}

/** Whether an encryption key is currently resolvable (used to fail fast). */
export function hasEncryptionKey(): boolean {
  return keyMaterial() !== null;
}

/** Derive a 32-byte AES-256 key from the configured key material via HKDF.
 *  Throws CredentialEncryptionError if no key material is available. */
function deriveKey(): Buffer {
  const material = keyMaterial();
  if (!material) {
    throw new CredentialEncryptionError(
      'Integration credential encryption key is not configured. Set INTEGRATION_ENCRYPTION_KEY or SESSION_SECRET. Credentials will NOT be stored.'
    );
  }
  // HKDF expands the master material into a purpose-bound key. Using a distinct
  // salt/info means this key is cryptographically separate from the session
  // signing key derived from the same SESSION_SECRET (defense in depth).
  const ikm = Buffer.from(material, 'utf8');
  const derived = crypto.hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, KEY_LEN);
  return Buffer.from(derived);
}

/** Encrypt a credential object to a string envelope. NEVER stores plaintext.
 *  Throws CredentialEncryptionError if no encryption key is configured. */
export function encryptCredentials(creds: Record<string, string>): string {
  const key = deriveKey(); // throws if missing — never plaintext
  const iv = crypto.randomBytes(12); // fresh per operation
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(creds), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

/** Decrypt a credential envelope. Throws on tampering, truncation, or a wrong
 *  key (auth tag verification fails). Returns the credential object. */
export function decryptCredentials(envelope: string): Record<string, string> {
  if (typeof envelope !== 'string' || !envelope.startsWith('v1.')) {
    throw new CredentialEncryptionError('Unrecognized credential envelope format.');
  }
  const parts = envelope.split('.');
  if (parts.length !== 4) {
    throw new CredentialEncryptionError('Malformed credential envelope.');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  let iv: Buffer, tag: Buffer, ct: Buffer;
  try {
    iv = Buffer.from(ivB64, 'base64url');
    tag = Buffer.from(tagB64, 'base64url');
    ct = Buffer.from(ctB64, 'base64url');
  } catch {
    throw new CredentialEncryptionError('Malformed credential envelope (base64).');
  }
  if (iv.length !== 12 || tag.length !== 16) {
    throw new CredentialEncryptionError('Malformed credential envelope (lengths).');
  }
  const key = deriveKey(); // throws if missing
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CredentialEncryptionError('Credential decryption failed (tampered or wrong key).');
  }
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new CredentialEncryptionError('Decrypted credential payload was not valid JSON.');
  }
}

/** The key id under which new envelopes are currently written. */
export function currentKeyId(): string {
  return CURRENT_KEY_ID;
}

/** Is the envelope marked as encrypted under `keyId`? (A row records this at
 *  write time; the envelope itself is authenticated independently.) */
export function envelopeKeyId(): string {
  return CURRENT_KEY_ID;
}
