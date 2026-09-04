/**
 * DMARC discovery and parsing.
 *
 * Pure, for the same reason as SPF: every interesting case is hostile input from
 * a zone we do not control.
 *
 * ── What a DMARC record does and does not prove ───────────────────────────
 *
 * A published record proves a policy exists. It does not prove the domain's mail
 * is *aligned* — alignment depends on the envelope domain SES uses, which is why
 * this system configures a custom MAIL FROM and reports MAIL FROM verification
 * separately. `p=none` in particular asks receivers to do nothing at all; a
 * domain with `p=none` is monitored, not protected. This module therefore
 * reports the policy value rather than collapsing "has a record" into "verified"
 * — the readiness rules in `../status.ts` decide what that is worth.
 */

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

export type DmarcVerdict =
  | 'missing'
  | 'multiple_records'
  | 'malformed'
  | 'monitoring_only'
  | 'enforcing'
  | 'lookup_failed';

export interface DmarcEvaluation {
  verdict: DmarcVerdict;
  policy: DmarcPolicy | null;
  /** Subdomain policy when the record sets one; otherwise null. */
  subdomainPolicy: DmarcPolicy | null;
  /** `pct` when present. A record with pct<100 enforces on a sample only. */
  percent: number | null;
  /** True when an aggregate-report destination is configured. */
  hasAggregateReporting: boolean;
  record: string | null;
}

function isPolicy(value: string): value is DmarcPolicy {
  return value === 'none' || value === 'quarantine' || value === 'reject';
}

function joinChunks(chunks: readonly string[]): string {
  return chunks.join('');
}

/** Records that declare themselves DMARC. The version tag must come first. */
export function selectDmarcRecords(txt: readonly (readonly string[])[]): string[] {
  return txt.map(joinChunks).filter((record) => /^\s*v\s*=\s*dmarc1\s*(;|$)/i.test(record));
}

/**
 * Parses the tag-value list.
 *
 * Tags are case-insensitive, separated by semicolons, and may carry surrounding
 * whitespace. A repeated tag takes its first value, matching how receivers
 * behave, so a record cannot smuggle a second `p=` past the check.
 */
function parseTags(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    if (key.length === 0 || tags.has(key)) continue;
    tags.set(key, value);
  }
  return tags;
}

export function evaluateDmarc(txt: readonly (readonly string[])[] | null): DmarcEvaluation {
  const empty: Omit<DmarcEvaluation, 'verdict'> = {
    policy: null,
    subdomainPolicy: null,
    percent: null,
    hasAggregateReporting: false,
    record: null,
  };

  if (txt === null) return { verdict: 'lookup_failed', ...empty };

  const records = selectDmarcRecords(txt);
  if (records.length === 0) return { verdict: 'missing', ...empty };
  if (records.length > 1) {
    // RFC 7489 §6.6.3: a domain publishing several DMARC records has no usable
    // policy — receivers discard all of them.
    return { verdict: 'multiple_records', ...empty, record: records[0] ?? null };
  }

  const record = records[0] ?? '';
  const tags = parseTags(record);

  const rawPolicy = (tags.get('p') ?? '').toLowerCase();
  if (rawPolicy.length === 0 || !isPolicy(rawPolicy)) {
    // `p` is mandatory and its value is a closed set. Anything else is a record
    // a receiver cannot act on, which is not the same as no record at all.
    return { verdict: 'malformed', ...empty, record };
  }

  const rawSubdomain = (tags.get('sp') ?? '').toLowerCase();
  const subdomainPolicy = isPolicy(rawSubdomain) ? rawSubdomain : null;

  const rawPercent = tags.get('pct');
  const parsedPercent = rawPercent === undefined ? null : Number.parseInt(rawPercent, 10);
  const percent =
    parsedPercent === null || Number.isNaN(parsedPercent) || parsedPercent < 0 || parsedPercent > 100
      ? null
      : parsedPercent;

  const rua = tags.get('rua') ?? '';

  return {
    verdict: rawPolicy === 'none' ? 'monitoring_only' : 'enforcing',
    policy: rawPolicy,
    subdomainPolicy,
    percent,
    hasAggregateReporting: /mailto:[^\s,]+@[^\s,]+/i.test(rua),
    record,
  };
}

/** Remediation guidance, per verdict. */
export const DMARC_GUIDANCE: Record<DmarcVerdict, string> = {
  missing:
    'No DMARC record was found. Publish the recommended TXT record to tell receivers what to do with mail that fails authentication.',
  multiple_records:
    'This domain publishes more than one DMARC record, so receivers ignore all of them. Keep exactly one.',
  malformed:
    'The DMARC record is present but its policy tag is missing or not one of none, quarantine or reject.',
  monitoring_only:
    'DMARC policy is "none", which asks receivers to take no action. Once you are confident in your reports, move to quarantine and then reject.',
  enforcing: 'DMARC is published and enforcing.',
  lookup_failed: 'The DMARC record could not be read. This is usually temporary — check again shortly.',
};
