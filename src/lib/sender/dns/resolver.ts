/**
 * The DNS port.
 *
 * P3 answers questions about a user-supplied domain by querying DNS and by
 * asking SES. It never makes an HTTP request to that domain, and there is no
 * function here that could: the port exposes three record types and nothing that
 * takes a URL.
 *
 * That restriction is the SSRF control. A verification system that fetched
 * `https://<user domain>/.well-known/...` would be an outbound request to an
 * address the user chooses — the textbook shape of the vulnerability. DNS
 * resolution has no such property: the query goes to the configured resolver,
 * and the response is data, never a destination.
 *
 * Deliberately free of `server-only`: this file declares types and one Node
 * implementation, and the test suite substitutes its own.
 */

export type DnsFailure = 'nxdomain' | 'no_data' | 'timeout' | 'refused' | 'error';

export type DnsAnswer<T> = { ok: true; records: T } | { ok: false; reason: DnsFailure };

export interface MxRecord {
  exchange: string;
  priority: number;
}

/**
 * A resolver, restricted to the three record types sender verification needs.
 *
 * TXT answers arrive as an array of records, each of which is an array of
 * strings — DNS splits a long TXT value into 255-byte chunks and a record's
 * value is their concatenation. Modelling that faithfully rather than flattening
 * it at the boundary matters: a joined-with-spaces SPF record is a different
 * record from the one the user published, and would be evaluated wrongly.
 */
export interface DnsResolver {
  resolveTxt(name: string): Promise<DnsAnswer<string[][]>>;
  resolveCname(name: string): Promise<DnsAnswer<string[]>>;
  resolveMx(name: string): Promise<DnsAnswer<MxRecord[]>>;
}

/** A DNS name this system is willing to look up. */
const QUERY_NAME = /^(?:[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?\.)+[a-z]{2,}$|^(?:_[a-z0-9-]+\.)+[a-z0-9-]+(?:\.[a-z]{2,})+$/;

/**
 * Validates a name before it reaches the resolver.
 *
 * Underscore labels are permitted because `_dmarc.` and `..._domainkey.` are
 * exactly the names being queried. Everything else is the hostname grammar, so a
 * name carrying a null byte, a space, or a second query smuggled behind a
 * newline never reaches the resolver in the first place.
 */
export function isQueryableName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  if (name !== name.toLowerCase()) return false;
  if (name.includes('..') || name.startsWith('.') || name.endsWith('.')) return false;
  if (name.split('.').some((label) => label.length === 0 || label.length > 63)) return false;
  return QUERY_NAME.test(name);
}

/** Maps Node's resolver error codes onto the port's vocabulary. */
export function classifyDnsError(code: unknown): DnsFailure {
  switch (code) {
    case 'ENOTFOUND':
    case 'ENODATA':
      return 'no_data';
    case 'NXDOMAIN':
      return 'nxdomain';
    case 'ETIMEOUT':
    case 'ETIMEDOUT':
      return 'timeout';
    case 'REFUSED':
    case 'ECONNREFUSED':
      return 'refused';
    default:
      return 'error';
  }
}

/**
 * Caps on what a response may contain.
 *
 * A domain's authoritative server is controlled by the person who typed the
 * domain, so its response is untrusted input with an attacker-chosen size. These
 * limits bound what is parsed and what could be stored.
 */
const MAX_RECORDS = 50;
const MAX_RECORD_LENGTH = 4_096;

/** Truncates a resolver answer to the caps above. Exported for the test resolver. */
export function clampTxt(records: string[][]): string[][] {
  return records
    .slice(0, MAX_RECORDS)
    .map((chunks) => chunks.slice(0, MAX_RECORDS).map((c) => c.slice(0, MAX_RECORD_LENGTH)));
}

/**
 * The Node resolver.
 *
 * Built lazily and per call site so a hung query cannot outlive the request. The
 * timeout is the resolver's own, not a race with a promise, so an abandoned
 * query is actually cancelled rather than merely ignored.
 */
export async function nodeDnsResolver(options: { timeoutMs?: number } = {}): Promise<DnsResolver> {
  const { Resolver } = await import('node:dns/promises');
  const resolver = new Resolver({ timeout: options.timeoutMs ?? 5_000, tries: 2 });

  async function query<T>(name: string, fn: () => Promise<T>): Promise<DnsAnswer<T>> {
    if (!isQueryableName(name)) return { ok: false, reason: 'error' };
    try {
      return { ok: true, records: await fn() };
    } catch (cause) {
      const code = (cause as { code?: unknown }).code;
      return { ok: false, reason: classifyDnsError(code) };
    }
  }

  return {
    async resolveTxt(name) {
      const answer = await query(name, () => resolver.resolveTxt(name));
      return answer.ok ? { ok: true, records: clampTxt(answer.records) } : answer;
    },
    async resolveCname(name) {
      const answer = await query(name, () => resolver.resolveCname(name));
      return answer.ok
        ? { ok: true, records: answer.records.slice(0, MAX_RECORDS).map((r) => r.toLowerCase()) }
        : answer;
    },
    async resolveMx(name) {
      const answer = await query(name, () => resolver.resolveMx(name));
      return answer.ok
        ? {
            ok: true,
            records: answer.records
              .slice(0, MAX_RECORDS)
              .map((r) => ({ exchange: r.exchange.toLowerCase(), priority: r.priority })),
          }
        : answer;
    },
  };
}
