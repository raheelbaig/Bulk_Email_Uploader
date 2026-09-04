/**
 * Log redaction.
 *
 * An allowlist would be safer still, but it makes logs useless in practice
 * because useful context is open-ended. This is a denylist applied by key name
 * at every depth, plus value-shaped detection for the credential formats this
 * system actually handles.
 *
 * The blueprint's rule (§24.4): never log passwords, tokens, session cookies,
 * AWS keys, unsubscribe tokens, full recipient lists, or raw template HTML.
 */

const SENSITIVE_KEY = new RegExp(
  [
    'password',
    'passwd',
    'secret',
    'token',
    'jwt',
    'authorization',
    'auth',
    'cookie',
    'session',
    'credential',
    'api[-_]?key',
    'access[-_]?key',
    'private[-_]?key',
    'signature',
    'hmac',
    'service[-_]?role',
    'anon[-_]?key',
  ].join('|'),
  'i',
);

/** Value shapes that are credentials regardless of the key they arrive under. */
const SENSITIVE_VALUE: RegExp[] = [
  /^eyJ[A-Za-z0-9_-]{10,}\./, // JWT
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS temporary access key id
  /^sb(p|s)_[A-Za-z0-9]{20,}$/, // Supabase publishable / secret key
];

export const REDACTED = '[redacted]';

const MAX_DEPTH = 6;
const MAX_ARRAY = 20;
const MAX_STRING = 2_000;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]';

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.some((re) => re.test(value))) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, depth + 1),
      ...(value.stack !== undefined ? { stack: value.stack.split('\n').slice(0, 12).join('\n') } : {}),
    };
  }

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…${value.length - MAX_ARRAY} more`] : head;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1);
    }
    return out;
  }

  // functions, symbols
  return `[${typeof value}]`;
}
