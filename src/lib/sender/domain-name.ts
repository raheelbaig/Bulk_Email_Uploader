/**
 * Sender-domain name normalization and validation.
 *
 * This is the boundary where an untrusted string becomes a value the rest of P3
 * is willing to put into a DNS query, an SES API path and a database row. Every
 * one of those three is a place where a permissive parse becomes a security
 * problem, so the rule here is the opposite of a URL parser's: reject anything
 * that is not already exactly a hostname, rather than extracting a hostname from
 * whatever was supplied.
 *
 * Deliberately free of dependencies and side effects — no network, no DNS, no
 * `new URL()`. `new URL('http://' + input)` would happily accept
 * `user:pass@evil.test:8080/path` and hand back `evil.test`, which is precisely
 * the class of input this module exists to refuse rather than silently repair.
 */

export type DomainFailure =
  | 'empty'
  | 'too_long'
  | 'contains_whitespace'
  | 'control_characters'
  | 'contains_scheme'
  | 'contains_path'
  | 'contains_credentials'
  | 'contains_port'
  | 'not_ascii'
  | 'ip_address'
  | 'single_label'
  | 'invalid_label'
  | 'invalid_tld'
  | 'reserved_tld';

export type DomainResult =
  | { ok: true; domain: string }
  | { ok: false; reason: DomainFailure };

/** RFC 1035 limits. */
const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * Zero-width and bidirectional formatting characters.
 *
 * Stripped rather than merely rejected for the same reason as in
 * `lib/email/normalize.ts`: a bidi override can make a domain *render* as one
 * name while containing another, which is the whole mechanism of a homograph
 * attack on a copy-pasted value.
 */
const INVISIBLE = new RegExp(
  '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  'g',
);

const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]');

/**
 * TLDs that are reserved, private-use, or resolve only inside a local network.
 *
 * None of them can hold a publicly verifiable DKIM record, so a domain under one
 * can never become a usable sender — accepting it would mean provisioning an SES
 * identity that is guaranteed to stay pending forever. `.arpa` is included
 * because it is infrastructure, not a mailable namespace.
 */
const RESERVED_TLDS = new Set([
  'localhost',
  'local',
  'localdomain',
  'test',
  'invalid',
  'example',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'arpa',
  'onion',
]);

/** Dotted-quad, with or without a partial form. */
function looksLikeIPv4(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){0,3}$/.test(value);
}

function looksLikeIPv6(value: string): boolean {
  // Bracketed literal, or anything containing a colon — colons are separately
  // rejected as a port, so this catches the bare form for a clearer reason.
  return value.startsWith('[') || value.endsWith(']');
}

/**
 * Normalizes and validates a sending domain.
 *
 * The output is the exact form stored in `sender_domains.domain` and used to
 * build every DNS name and SES identity: lowercase, ASCII, no trailing dot, at
 * least two labels.
 */
export function normalizeDomainName(input: unknown): DomainResult {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };

  // NFKC folds compatibility forms (fullwidth Latin, for one) into their
  // canonical equivalents, so a visually identical domain normalises to the
  // same bytes instead of becoming a second, un-matchable row.
  const cleaned = input.normalize('NFKC').replace(INVISIBLE, '').trim();

  if (cleaned.length === 0) return { ok: false, reason: 'empty' };
  if (CONTROL.test(cleaned)) return { ok: false, reason: 'control_characters' };
  if (/\s/.test(cleaned)) return { ok: false, reason: 'contains_whitespace' };

  const lowered = cleaned.toLowerCase();

  // Checked in the order a person is most likely to have made the mistake, so
  // the message they get names the thing they actually typed.
  // The scheme pattern excludes a dot on purpose: `example.com:8080` would
  // otherwise look like the scheme `example.com`, and the user would be told to
  // remove a scheme they never typed.
  if (lowered.includes('://') || /^[a-z][a-z0-9+-]*:/.test(lowered)) {
    return { ok: false, reason: 'contains_scheme' };
  }
  if (lowered.includes('@')) return { ok: false, reason: 'contains_credentials' };
  if (/[/\\?#]/.test(lowered)) return { ok: false, reason: 'contains_path' };
  // Before the port check: an IPv6 literal is full of colons and deserves the
  // message that names the actual problem.
  if (looksLikeIPv6(lowered)) return { ok: false, reason: 'ip_address' };
  if (lowered.includes(':')) return { ok: false, reason: 'contains_port' };

  // A trailing dot is a valid absolute-form FQDN and means the same domain.
  // Accepted and dropped; a leading dot is simply malformed.
  const withoutRootDot = lowered.endsWith('.') ? lowered.slice(0, -1) : lowered;

  if (withoutRootDot.length === 0) return { ok: false, reason: 'empty' };
  if (withoutRootDot.length > MAX_DOMAIN_LENGTH) return { ok: false, reason: 'too_long' };

  // Non-ASCII is refused rather than converted. Converting would require an IDNA
  // implementation whose disagreement with the registrar's — over which
  // codepoints map to what — produces a domain that verifies here and fails
  // there. The user is told to supply the punycode form their registrar shows.
  if (!/^[\x20-\x7E]*$/.test(withoutRootDot)) return { ok: false, reason: 'not_ascii' };

  if (looksLikeIPv4(withoutRootDot)) return { ok: false, reason: 'ip_address' };

  const labels = withoutRootDot.split('.');
  if (labels.length < 2) return { ok: false, reason: 'single_label' };

  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      return { ok: false, reason: 'invalid_label' };
    }
    if (label.startsWith('-') || label.endsWith('-')) return { ok: false, reason: 'invalid_label' };
    if (!/^[a-z0-9-]+$/.test(label)) return { ok: false, reason: 'invalid_label' };
  }

  const tld = labels[labels.length - 1] ?? '';
  // Punycode TLDs are legitimate; anything else must be alphabetic. A numeric
  // TLD is not delegable and is usually a mistyped IP address.
  if (!/^[a-z]{2,}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) {
    return { ok: false, reason: 'invalid_tld' };
  }
  if (RESERVED_TLDS.has(tld)) return { ok: false, reason: 'reserved_tld' };

  return { ok: true, domain: withoutRootDot };
}

/** User-safe explanations. Never echoes the offending value back. */
export const DOMAIN_FAILURE_MESSAGE: Record<DomainFailure, string> = {
  empty: 'Enter a domain, for example example.com.',
  too_long: 'That domain is too long.',
  contains_whitespace: 'A domain cannot contain spaces.',
  control_characters: 'That domain contains characters that are not allowed.',
  contains_scheme: 'Enter the domain only, without https:// in front of it.',
  contains_path: 'Enter the domain only, without a path or slash.',
  contains_credentials: 'Enter the domain only, without an @ sign or an email address.',
  contains_port: 'Enter the domain only, without a port number.',
  not_ascii: 'Enter the punycode form of the domain, which starts with xn--. Your registrar shows it.',
  ip_address: 'Enter a domain name, not an IP address.',
  single_label: 'Enter a full domain, for example example.com.',
  invalid_label: 'That does not look like a valid domain.',
  invalid_tld: 'That domain ends in something that is not a valid top-level domain.',
  reserved_tld: 'That domain cannot be verified publicly, so it cannot be used to send email.',
};

/**
 * The custom MAIL FROM subdomain for a sending domain.
 *
 * Deterministic and derived, never user-supplied: the value ends up in an SES
 * API call that causes SES to expect DNS records under it, so letting a request
 * choose it would let a caller point one workspace's MAIL FROM at another
 * workspace's domain. `bounce.` is conventional and describes what the subdomain
 * actually receives.
 *
 * Returns null when prefixing would exceed the length limit, or when the domain
 * is already a `bounce.` subdomain — nesting `bounce.bounce.example.com` is a
 * configuration nobody intends.
 */
export function mailFromDomainFor(domain: string): string | null {
  if (domain.startsWith('bounce.')) return null;
  const candidate = `bounce.${domain}`;
  const result = normalizeDomainName(candidate);
  return result.ok ? result.domain : null;
}

/** The DNS name carrying a domain's DMARC policy. */
export function dmarcRecordName(domain: string): string {
  return `_dmarc.${domain}`;
}

/** True when `candidate` is exactly `domain` or a subdomain of it. */
export function isSameOrSubdomain(candidate: string, domain: string): boolean {
  return candidate === domain || candidate.endsWith(`.${domain}`);
}
