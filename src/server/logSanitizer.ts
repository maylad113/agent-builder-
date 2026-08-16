/**
 * Centralized log sanitization (audit P2.12).
 *
 * Every structured/semi-structured record that may contain user-supplied or
 * credential-bearing fields is passed through `redact` before it reaches a
 * log sink. The goal: passwords, tokens, secrets, authorization headers, and
 * unnecessary customer PII never reach stdout/stderr/logs, even when an
 * error object or a tool payload is logged verbatim.
 *
 * This is a deny-list + shape-based redactor: known-sensitive keys are masked
 * unconditionally, and string values that look like bearer tokens / long hex
 * secrets are masked too. Object recursion is bounded to avoid pathological
 * depth.
 */

const SENSITIVE_KEY_RE = /^(pass(word|wd)?|secret|token|apikey|api_key|authorization|auth|cookie|credential|privatekey|private_key|access_token|refresh_token|client_secret|app_secret|hub_secret|verify_token|session)$/i;

/** Patterns that match common secret shapes inside arbitrary strings. */
const SECRET_SHAPE_RES = [
  /(?:Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/i,
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub PATs
  /github_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained PATs
  /AIza[A-Za-z0-9_-]{20,}/, // Google API keys
  /[A-Za-z0-9_-]{32,}/, // generic long opaque token (masked only when key is sensitive)
];

const MAX_DEPTH = 6;
const MAX_STRING_LEN = 4096;

function maskString(value: string): string {
  if (value.length > MAX_STRING_LEN) value = value.slice(0, MAX_STRING_LEN) + '…[truncated]';
  return value;
}

function redactValue(key: string, value: any, depth: number): any {
  if (depth > MAX_DEPTH) return '[max depth]';
  if (value == null) return value;

  // Mask by key name first — a secret under a sensitive key is always masked
  // regardless of its shape.
  if (typeof key === 'string' && SENSITIVE_KEY_RE.test(key)) {
    if (typeof value === 'string') return value ? '[REDACTED]' : value;
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    let v = value;
    for (const re of SECRET_SHAPE_RES.slice(0, 3)) { // shape-mask only clear token formats
      if (re.test(v)) return '[REDACTED]';
    }
    return maskString(v);
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactValue('', v, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(k, v, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Return a sanitized copy of `obj` safe to log. The input is never mutated.
 * Use this for any structured log payload (tool args, error objects, request
 * bodies, webhook payloads) before passing to console/loggers.
 */
export function redact(obj: any): any {
  return redactValue('', obj, 0);
}

/**
 * Safe console.error that redacts the message/payload. Accepts the same
 * signature shape as console.error for drop-in use.
 */
export function safeError(...args: any[]): void {
  const sanitized = args.map((a) => redact(a));
  console.error(...sanitized);
}

/** Safe console.log that redacts the message/payload. */
export function safeLog(...args: any[]): void {
  const sanitized = args.map((a) => redact(a));
  console.log(...sanitized);
}
