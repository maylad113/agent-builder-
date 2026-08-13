import crypto from 'crypto';

/**
 * Password hashing with node:crypto scrypt — zero dependencies, never
 * reversible, never stored in plaintext.
 *
 * Storage format: `scrypt$N$r$p$saltHex$hashHex`
 * (all parameters stored alongside the hash so they can be tuned later
 * without breaking existing rows).
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr)
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * A lazily-computed scrypt hash used as a CONSTANT dummy for unknown-user login
 * attempts (audit P2.6). Running verifyPassword against this fixed hash keeps
 * the CPU cost of a "user not found" response identical to a wrong-password
 * response, so an attacker cannot enumerate accounts by timing. Computed once
 * (first unknown-user login pays the one-time scrypt cost) with the same
 * N/r/p as production hashes.
 */
let _dummyHash: string | null = null;
export function getDummyPasswordHash(): string {
  if (_dummyHash) return _dummyHash;
  _dummyHash = hashPassword('dummy-unknown-user-password');
  return _dummyHash;
}
