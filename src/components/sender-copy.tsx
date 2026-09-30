import Link from 'next/link';
import type { SenderBlocker, SenderWarning } from '@/lib/sender/readiness';
import type { DomainReadiness, VerificationStatus } from '@/lib/sender/status';
import { cn } from '@/lib/utils';

/** Domain readiness in plain words. Tones stay with `READINESS_TONE`. */
export const DOMAIN_READINESS_LABEL: Record<DomainReadiness, string> = {
  NOT_CONFIGURED: 'Not set up',
  PENDING: 'Waiting for DNS records',
  ATTENTION: 'Verified · improvement suggested',
  VERIFIED: 'Verified',
  FAILED: 'Verification failed',
};

/**
 * Why a sender address can't be used yet, for the person choosing one.
 * `lib/sender/readiness#BLOCKER_MESSAGE` keeps the technical wording.
 */
export const SENDER_BLOCKER_COPY: Record<SenderBlocker, string> = {
  sender_identity_missing: 'This sender address no longer exists.',
  sender_domain_missing: 'Its domain is no longer set up.',
  identity_domain_mismatch: 'Its domain is no longer set up.',
  domain_never_checked: 'Its domain hasn’t been verified yet.',
  dkim_not_verified: 'Some DNS records for its domain haven’t been confirmed yet.',
  spf_not_verified: 'Some DNS records for its domain haven’t been confirmed yet.',
  mail_from_not_verified: 'Some DNS records for its domain haven’t been confirmed yet.',
  identity_not_marked_verified: 'It hasn’t been confirmed yet — checking its domain again usually fixes this.',
};

/** Advice for an address that can send; `WARNING_MESSAGE` keeps the technical wording. */
export const SENDER_WARNING_COPY: Record<SenderWarning, string> = {
  dmarc_not_enforcing:
    'Ready to send. Its domain’s DMARC record is in “monitor only” mode — fine to start with, and it can be made stricter later.',
  dmarc_invalid: 'Ready to send. Its domain’s DMARC record has a mistake — check it on the domain’s page.',
  verification_stale: 'Its domain hasn’t been checked recently. Open the domain and use “Check again”.',
};

/**
 * What each DNS check is for. The technical name stays visible next to it, but
 * is never the only explanation.
 */
export const CHECK_EXPLANATION: Record<'SPF' | 'DKIM' | 'DMARC' | 'MAIL FROM', string> = {
  SPF: 'Helps receiving email providers recognize that your domain is allowed to send email.',
  DKIM: 'A digital signature that proves your emails really come from your domain and weren’t changed on the way.',
  DMARC: 'Tells inboxes what to do with emails that pretend to be from your domain. Recommended, not required.',
  'MAIL FROM':
    'Uses your own domain behind the scenes for returned (bounced) emails, so your emails line up with your domain and pass spam checks.',
};

/** A domain's state in one plain sentence. `lib/sender/status#readinessSummary` keeps the technical one. */
export function domainSummary(readiness: DomainReadiness, dmarcStatus: VerificationStatus): string {
  switch (readiness) {
    case 'NOT_CONFIGURED':
      return 'This domain hasn’t been set up for sending yet.';
    case 'PENDING':
      return 'Waiting for your DNS records to be added and picked up. This usually takes under an hour, but can take up to 72 hours.';
    case 'ATTENTION':
      return dmarcStatus === 'failed'
        ? 'Ready to send. One recommended record (DMARC) has a mistake — see below.'
        : dmarcStatus === 'not_configured'
          ? 'Ready to send. Adding the recommended DMARC record would protect your domain from being impersonated.'
          : 'Ready to send. Your DMARC record is in “monitor only” mode, which is a fine place to start.';
    case 'VERIFIED':
      return 'Fully verified and ready to send.';
    case 'FAILED':
      return 'Verification didn’t pass. Check the DNS records below, then check again.';
  }
}

/** DMARC advice without policy syntax. */
export function dmarcAdvice(dmarcStatus: VerificationStatus): string | null {
  switch (dmarcStatus) {
    case 'not_configured':
      return 'Recommended: add the DMARC record below. It protects your domain from people sending email that pretends to be from you.';
    case 'failed':
      return 'Your DMARC record couldn’t be read — there may be a typo, or more than one DMARC record. Compare it with the record below.';
    case 'pending':
      return 'Your DMARC record is in “monitor only” mode: inboxes report problems but don’t block anything. That’s the safe way to start. Once your emails are sending well, it can be made stricter.';
    default:
      return null;
  }
}

/**
 * The last verification problem, in plain words. The provider's own message
 * is kept for owners and admins under "Technical details".
 */
export function friendlyCheckError(raw: string): string {
  if (/not registered/i.test(raw)) {
    return 'Your domain hasn’t been set up with the email service yet. This usually sorts itself out — use “Check again” in a few minutes.';
  }
  if (/could not be reached|timed? ?out|network/i.test(raw)) {
    return 'We couldn’t reach the email service to check your domain. This is usually temporary — try “Check again” shortly.';
  }
  return 'The last check didn’t complete. Try “Check again” in a few minutes.';
}

/** Explains the one DNS-provider quirk that trips most people up. */
export function DnsHostTip({ domain, exampleHost }: { domain: string; exampleHost?: string }) {
  const suffix = `.${domain}`;
  const full = exampleHost ?? `example._domainkey${suffix}`;
  const short = full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
  return (
    <div className="rounded-lg border bg-(--color-surface-subtle) px-4 py-3 text-sm">
      <p className="font-medium">Tip: check how your DNS provider wants the “Host”</p>
      <p className="mt-0.5 text-(--color-muted-foreground)">
        Some DNS providers add your domain to the end of the Host (also called “Name”) automatically. If yours does,
        enter only the first part — for example <code className="font-mono text-xs break-all">{short}</code> instead
        of <code className="font-mono text-xs break-all">{full}</code>. Otherwise the record ends up with your domain in
        it twice and the check won’t pass.
      </p>
    </div>
  );
}

/** Sub-navigation shared by the two Senders pages. */
export function SendersTabs({ active }: { active: 'domains' | 'addresses' }) {
  const tabs = [
    { key: 'domains', href: '/senders', label: 'Domains' },
    { key: 'addresses', href: '/senders/identities', label: 'Sender addresses' },
  ] as const;
  return (
    <nav aria-label="Senders" className="-mb-px flex gap-1 border-b">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={active === tab.key ? 'page' : undefined}
          className={cn(
            'rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)',
            active === tab.key
              ? 'border-(--color-primary) text-(--color-foreground)'
              : 'border-transparent text-(--color-muted-foreground) hover:text-(--color-foreground)',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
