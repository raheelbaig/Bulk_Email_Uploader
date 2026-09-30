import type { SuppressionReason } from '@/lib/suppression/service';

/** Why an address won't be emailed, in plain words. Display only. */
export const SUPPRESSION_REASON_LABEL: Record<SuppressionReason, string> = {
  unsubscribe: 'Unsubscribed',
  hard_bounce: 'Address bounced',
  complaint: 'Marked as spam',
  invalid: 'Invalid address',
  manually_blocked: 'Blocked by your team',
  provider_suppressed: 'Blocked by email provider',
};

export const SUPPRESSION_SOURCE_LABEL: Record<string, string> = {
  manual: 'Added by your team',
  import: 'From an import',
  unsubscribe_link: 'Unsubscribe link',
  provider: 'Email provider',
  ses_event: 'Email provider',
  system: 'Automatic',
};

export function suppressionSourceLabel(source: string): string {
  const known = SUPPRESSION_SOURCE_LABEL[source];
  if (known !== undefined) return known;
  const tidy = source.replace(/_/g, ' ');
  return tidy.charAt(0).toUpperCase() + tidy.slice(1);
}
