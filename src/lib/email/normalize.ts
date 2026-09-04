/**
 * The canonical email normalization and validation module.
 *
 * Every entry point that accepts an email address must go through here:
 * contact create/update, manual suppression, the eligibility authority, and —
 * when they arrive — the import engine, unsubscribe handling and provider event
 * processing. One function, applied at every boundary, is more robust than
 * pushing case handling into a functional index and hoping every query
 * remembers to match it (ARCHITECTURE §21.4).
 *
 * Deliberately NOT a runtime dependency on anything: no network, no DNS, no MX
 * lookup. Validation here is structural only.
 */

export type NormalizeFailure =
  | 'empty'
  | 'too_long'
  | 'local_too_long'
  | 'control_characters'
  | 'missing_at'
  | 'empty_local'
  | 'empty_domain'
  | 'invalid_local'
  | 'invalid_domain'
  | 'whitespace';

export type NormalizeResult =
  | { ok: true; normalized: string; raw: string; local: string; domain: string }
  | { ok: false; reason: NormalizeFailure };

/** RFC 5321 octet limits. */
const MAX_TOTAL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const MAX_DOMAIN_LABEL = 63;

/**
 * Zero-width and bidirectional formatting characters, stripped before parsing.
 *
 * The bidi ranges matter as much as the zero-width ones: U+202A-U+202E and
 * U+2066-U+2069 can reverse rendering direction, so an address can be made to
 * *display* as a different domain than the one it actually contains.
 */
const INVISIBLE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]', 'g');

/** C0 and C1 control ranges, plus DEL. Never legitimate in an address. */
const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]');

/** Any Unicode whitespace surviving the trim — an address contains none. */
const INNER_WHITESPACE = /\s/;

/**
 * Options that exist only to be explicitly off.
 *
 * Gmail dot-folding and plus-address stripping are provider-specific
 * behaviours. Applying them universally merges genuinely distinct addresses at
 * every other provider — `a.b@company.com` and `ab@company.com` are two
 * different people almost everywhere. They stay disabled; the flags exist so the
 * decision is visible and testable rather than an unstated omission.
 */
export interface NormalizeOptions {
  /** Default false. Enabling this merges distinct addresses at most providers. */
  stripGmailDots?: boolean;
  /** Default false. Enabling this discards deliberate sub-addressing. */
  stripPlusAddressing?: boolean;
}

const DEFAULTS: Required<NormalizeOptions> = {
  stripGmailDots: false,
  stripPlusAddressing: false,
};

function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.includes('..')) return false;

  const labels = domain.split('.');
  // A bare hostname with no dot is not deliverable in practice.
  if (labels.length < 2) return false;

  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_DOMAIN_LABEL) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
  }

  const tld = labels[labels.length - 1];
  if (tld === undefined || tld.length < 2 || !/^[a-z]+$/.test(tld)) return false;

  return true;
}

function isValidLocal(local: string): boolean {
  if (local.length === 0 || local.length > MAX_LOCAL_LENGTH) return false;
  if (local.startsWith('.') || local.endsWith('.')) return false;
  if (local.includes('..')) return false;
  // The RFC 5322 dot-atom set. Quoted local parts are legal and essentially
  // never used; rejecting them is the safer default for a bulk sender.
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local);
}

/**
 * Normalizes and validates an address.
 *
 * Deterministic: the same input always yields the same output, and
 * `normalizeEmail(normalizeEmail(x).normalized)` is a fixed point.
 */
export function normalizeEmail(input: unknown, options: NormalizeOptions = {}): NormalizeResult {
  const opts = { ...DEFAULTS, ...options };

  if (typeof input !== 'string') return { ok: false, reason: 'empty' };

  // NFKC first: it folds compatibility forms (fullwidth Latin, ligatures) into
  // their canonical equivalents, so visually identical addresses normalize
  // identically instead of becoming two contacts.
  const cleaned = input.normalize('NFKC').replace(INVISIBLE, '').trim();

  if (cleaned.length === 0) return { ok: false, reason: 'empty' };
  if (CONTROL.test(cleaned)) return { ok: false, reason: 'control_characters' };
  if (INNER_WHITESPACE.test(cleaned)) return { ok: false, reason: 'whitespace' };
  if (cleaned.length > MAX_TOTAL_LENGTH) return { ok: false, reason: 'too_long' };

  // Last '@' wins: the domain cannot contain one, so this is unambiguous.
  const at = cleaned.lastIndexOf('@');
  if (at === -1) return { ok: false, reason: 'missing_at' };
  if (at === 0) return { ok: false, reason: 'empty_local' };
  if (at === cleaned.length - 1) return { ok: false, reason: 'empty_domain' };

  const rawLocal = cleaned.slice(0, at);
  const domain = cleaned.slice(at + 1).toLowerCase();

  // The local part is case-sensitive per RFC 5321 but treated case-insensitively
  // by every provider in practice. Lowercasing prevents the same person being
  // stored twice as Bob@ and bob@; email_raw preserves what was supplied.
  let local = rawLocal.toLowerCase();

  if (local.length > MAX_LOCAL_LENGTH) return { ok: false, reason: 'local_too_long' };

  if (opts.stripPlusAddressing) {
    const plus = local.indexOf('+');
    if (plus > 0) local = local.slice(0, plus);
  }
  if (opts.stripGmailDots) {
    local = local.replaceAll('.', '');
  }

  if (!isValidLocal(local)) return { ok: false, reason: 'invalid_local' };
  if (!isValidDomain(domain)) return { ok: false, reason: 'invalid_domain' };

  const normalized = `${local}@${domain}`;
  if (normalized.length > MAX_TOTAL_LENGTH) return { ok: false, reason: 'too_long' };

  return { ok: true, normalized, raw: cleaned, local, domain };
}

/** Convenience for callers that only need the canonical form or nothing. */
export function normalizeEmailOrNull(input: unknown): string | null {
  const result = normalizeEmail(input);
  return result.ok ? result.normalized : null;
}

/** Human-readable, user-safe explanations. Never leaks the offending value. */
export const NORMALIZE_FAILURE_MESSAGE: Record<NormalizeFailure, string> = {
  empty: 'Enter an email address.',
  too_long: 'That email address is too long.',
  local_too_long: 'The part before the @ is too long.',
  control_characters: 'That email address contains characters that are not allowed.',
  whitespace: 'An email address cannot contain spaces.',
  missing_at: 'An email address needs an @ sign.',
  empty_local: 'Add the part before the @ sign.',
  empty_domain: 'Add the domain after the @ sign.',
  invalid_local: 'The part before the @ contains characters that are not allowed.',
  invalid_domain: 'That domain does not look valid.',
};
