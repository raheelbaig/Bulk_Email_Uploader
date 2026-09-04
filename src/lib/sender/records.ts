/**
 * The DNS records a workspace must publish.
 *
 * One module knows SES's record formats, so the setup page, the verifier and any
 * future documentation cannot drift apart. Pure — it derives records from stored
 * state and never queries anything.
 *
 * These are *instructions*. Nothing in this system writes DNS: we tell the user
 * what to publish and then check whether they did.
 */

import { SES_SPF_INCLUDE } from './dns/spf';

export type DnsRecordType = 'CNAME' | 'TXT' | 'MX';

export type RecordPurpose = 'dkim' | 'mail_from_mx' | 'mail_from_spf' | 'dmarc';

export interface RequiredDnsRecord {
  purpose: RecordPurpose;
  type: DnsRecordType;
  /** The fully-qualified name. Registrars usually want the part before the domain. */
  host: string;
  value: string;
  /** MX only. */
  priority?: number;
  /**
   * False for records that improve deliverability but are not part of the
   * verification gate — currently DMARC, which is assessed and reported but
   * never fabricated on the user's behalf.
   */
  required: boolean;
  label: string;
}

/** The DKIM CNAME for one SES selector token. */
function dkimRecord(domain: string, token: string, index: number): RequiredDnsRecord {
  return {
    purpose: 'dkim',
    type: 'CNAME',
    host: `${token}._domainkey.${domain}`,
    value: `${token}.dkim.amazonses.com`,
    required: true,
    label: `DKIM record ${index + 1}`,
  };
}

/** The recommended starting DMARC policy. */
export const RECOMMENDED_DMARC_VALUE = 'v=DMARC1; p=none;';

/** The SPF value SES requires on a custom MAIL FROM domain. */
export const MAIL_FROM_SPF_VALUE = `v=spf1 include:${SES_SPF_INCLUDE} ~all`;

/**
 * Every record for a domain, in the order the setup page shows them.
 *
 * DKIM records are absent until SES has issued the tokens — showing placeholder
 * hosts would invite someone to publish records that authenticate nothing.
 */
export function requiredDnsRecords(input: {
  domain: string;
  dkimTokens: readonly string[] | null;
  mailFromDomain: string | null;
  region: string;
}): RequiredDnsRecord[] {
  const records: RequiredDnsRecord[] = [];

  for (const [index, token] of (input.dkimTokens ?? []).entries()) {
    records.push(dkimRecord(input.domain, token, index));
  }

  if (input.mailFromDomain !== null) {
    records.push({
      purpose: 'mail_from_mx',
      type: 'MX',
      host: input.mailFromDomain,
      // Region-specific: SES bounces are returned to the endpoint in the region
      // the identity lives in.
      value: `feedback-smtp.${input.region}.amazonses.com`,
      priority: 10,
      required: true,
      label: 'MAIL FROM (MX)',
    });
    records.push({
      purpose: 'mail_from_spf',
      type: 'TXT',
      host: input.mailFromDomain,
      value: MAIL_FROM_SPF_VALUE,
      required: true,
      label: 'MAIL FROM (SPF)',
    });
  }

  records.push({
    purpose: 'dmarc',
    type: 'TXT',
    host: `_dmarc.${input.domain}`,
    value: RECOMMENDED_DMARC_VALUE,
    required: false,
    label: 'DMARC (recommended)',
  });

  return records;
}
