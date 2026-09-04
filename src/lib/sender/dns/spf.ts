/**
 * SPF discovery and evaluation.
 *
 * Pure: it is handed the TXT records that were found and decides what they mean.
 * The decision is separate from the lookup for the same reason the eligibility
 * authority separates them — every hostile case (two records, a truncated
 * record, a record that merely contains the word "amazonses") is then a table
 * entry in a test rather than a live DNS zone someone has to publish.
 *
 * What is deliberately *not* done here: nothing is written to DNS, and no
 * record is inferred. A domain with no SPF record is reported as having none,
 * never as "probably fine".
 */

export type SpfVerdict =
  | 'missing'
  | 'multiple_records'
  | 'malformed'
  | 'authorized'
  | 'not_authorized'
  | 'lookup_failed';

export interface SpfEvaluation {
  verdict: SpfVerdict;
  /** The record that was evaluated, joined from its chunks. Null when absent. */
  record: string | null;
  /** The `include:` mechanism sought, e.g. `amazonses.com`. */
  expectedInclude: string;
  /** The qualifier on the `all` mechanism, when the record has one. */
  allQualifier: '+' | '-' | '~' | '?' | null;
}

/** SES's SPF include. Every region shares it. */
export const SES_SPF_INCLUDE = 'amazonses.com';

/**
 * Joins a TXT record's chunks.
 *
 * DNS splits a value longer than 255 bytes into several strings, and the value
 * is their concatenation with no separator. Joining with a space — an easy
 * mistake — turns `...include:amazon` + `ses.com...` into a record that no
 * longer contains the include, and the check would then report a correctly
 * configured domain as unauthorized.
 */
export function joinTxtChunks(chunks: readonly string[]): string {
  return chunks.join('');
}

/** True for a record that declares itself SPF. Case-insensitive per RFC 7208. */
function isSpfRecord(record: string): boolean {
  return /^v=spf1(\s|$)/i.test(record.trim());
}

/**
 * Selects the SPF record from a domain's TXT records.
 *
 * More than one is a permanent error under RFC 7208 §4.5, not a warning: a
 * receiver cannot choose between them, so the domain's SPF is broken even if one
 * of the two records is perfect. Reporting that plainly is the point.
 */
export function selectSpfRecords(txt: readonly (readonly string[])[]): string[] {
  return txt.map(joinTxtChunks).filter(isSpfRecord);
}

function readAllQualifier(record: string): '+' | '-' | '~' | '?' | null {
  const match = /(^|\s)([+\-~?]?)all(\s|$)/i.exec(record);
  if (match === null) return null;
  const qualifier = match[2];
  return qualifier === '-' || qualifier === '~' || qualifier === '?' ? qualifier : '+';
}

/**
 * Whether the record authorizes `expectedInclude`.
 *
 * Tokenised, not substring-matched. `include:amazonses.com.evil.example` and a
 * comment containing the word both contain the string; neither authorizes
 * anything, and a substring check would call both verified.
 */
function hasInclude(record: string, expectedInclude: string): boolean {
  const wanted = expectedInclude.toLowerCase();
  return record
    .trim()
    .split(/\s+/)
    .slice(1)
    .some((term) => {
      const withoutQualifier = term.replace(/^[+\-~?]/, '').toLowerCase();
      const separator = withoutQualifier.indexOf(':');
      if (separator === -1) return false;
      const mechanism = withoutQualifier.slice(0, separator);
      const value = withoutQualifier.slice(separator + 1).replace(/\.$/, '');
      return mechanism === 'include' && value === wanted;
    });
}

/**
 * Evaluates a domain's SPF for SES.
 *
 * `lookupFailed` is a distinct verdict rather than being folded into "missing".
 * A resolver timeout is not evidence that a record is absent, and treating it as
 * such would flip a verified domain to unverified on a transient network fault.
 */
export function evaluateSpf(args: {
  txt: readonly (readonly string[])[] | null;
  expectedInclude?: string;
}): SpfEvaluation {
  const expectedInclude = args.expectedInclude ?? SES_SPF_INCLUDE;

  if (args.txt === null) {
    return { verdict: 'lookup_failed', record: null, expectedInclude, allQualifier: null };
  }

  const records = selectSpfRecords(args.txt);

  if (records.length === 0) {
    return { verdict: 'missing', record: null, expectedInclude, allQualifier: null };
  }
  if (records.length > 1) {
    return {
      verdict: 'multiple_records',
      record: records[0] ?? null,
      expectedInclude,
      allQualifier: null,
    };
  }

  const record = records[0] ?? '';
  const allQualifier = readAllQualifier(record);

  // A record that is nothing but the version tag declares no policy at all.
  const terms = record.trim().split(/\s+/).slice(1);
  if (terms.length === 0) {
    return { verdict: 'malformed', record, expectedInclude, allQualifier };
  }

  // `+all` authorizes every host on the internet to send as this domain. It
  // makes the include irrelevant and the domain trivially spoofable, so it is
  // reported as malformed rather than quietly accepted as "authorized".
  if (allQualifier === '+') {
    return { verdict: 'malformed', record, expectedInclude, allQualifier };
  }

  return {
    verdict: hasInclude(record, expectedInclude) ? 'authorized' : 'not_authorized',
    record,
    expectedInclude,
    allQualifier,
  };
}

/** Guidance shown next to each verdict. Says what to do, not what we inspected. */
export const SPF_GUIDANCE: Record<SpfVerdict, string> = {
  missing: 'No SPF record was found. Publish the TXT record shown below.',
  multiple_records:
    'This domain publishes more than one SPF record. Receivers treat that as an error — merge them into a single record.',
  malformed:
    'The SPF record is present but does not restrict who may send. Replace it with the TXT record shown below.',
  authorized: 'SPF authorizes Amazon SES for this domain.',
  not_authorized:
    'An SPF record exists but does not include Amazon SES. Add include:amazonses.com to it.',
  lookup_failed: 'The SPF record could not be read. This is usually temporary — check again shortly.',
};
