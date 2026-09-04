/**
 * The domain readiness rules.
 *
 * Pure and dependency-free, so the same function decides the badge on a page,
 * the answer the readiness authority gives, and the assertion a test makes. The
 * important property is that "usable" has exactly one definition — see
 * `./readiness.ts` for why that matters and who must call it.
 *
 * A status is *derived*, never stored and never accepted from a request. The
 * inputs are the four verification columns, each of which is written only by the
 * server after asking SES or DNS (migration 0008 gives `authenticated` no UPDATE
 * grant on `sender_domains` at all).
 */

export type VerificationStatus = 'pending' | 'verified' | 'failed' | 'not_configured';

export type DomainReadiness =
  /** Nothing has been provisioned yet. */
  | 'NOT_CONFIGURED'
  /** Provisioned, waiting on DNS or the provider. */
  | 'PENDING'
  /** Usable, but something deliverability-relevant is unresolved. */
  | 'ATTENTION'
  /** Fully verified, including an enforcing DMARC policy. */
  | 'VERIFIED'
  /** The provider or DNS reported a hard failure. */
  | 'FAILED';

export interface DomainVerificationState {
  spfStatus: VerificationStatus;
  dkimStatus: VerificationStatus;
  dmarcStatus: VerificationStatus;
  mailFromStatus: VerificationStatus;
  dmarcPolicy: string | null;
  lastCheckedAt: string | null;
}

/**
 * The checks that gate usability.
 *
 * DMARC is not among them, and that is a considered position rather than an
 * omission. DKIM, SPF and a verified MAIL FROM are what make a message
 * authenticate and align; DMARC is the domain owner's instruction to receivers
 * about what to do when it does not. A domain can send correctly with no DMARC
 * record, so blocking on it would refuse to send mail that would have been
 * delivered — while a domain that fails DKIM cannot authenticate at all.
 *
 * DMARC still moves a domain from VERIFIED to ATTENTION, with guidance, because
 * "will deliver" and "is properly protected" are different questions and the UI
 * should not pretend otherwise.
 */
export const REQUIRED_CHECKS = ['dkimStatus', 'spfStatus', 'mailFromStatus'] as const;

export type RequiredCheck = (typeof REQUIRED_CHECKS)[number];

/**
 * The single definition of "this domain may be used to send".
 *
 * Nothing else in the codebase may re-derive this from the individual columns.
 */
export function isDomainUsable(state: DomainVerificationState): boolean {
  return REQUIRED_CHECKS.every((check) => state[check] === 'verified');
}

/** True when DMARC is published and asking receivers to act. */
export function isDmarcEnforcing(state: DomainVerificationState): boolean {
  return state.dmarcStatus === 'verified' && state.dmarcPolicy !== null && state.dmarcPolicy !== 'none';
}

export function domainReadiness(state: DomainVerificationState): DomainReadiness {
  const required = REQUIRED_CHECKS.map((check) => state[check]);

  // A hard provider or DNS failure outranks everything: it needs attention that
  // waiting will not supply.
  if (required.includes('failed')) return 'FAILED';

  if (isDomainUsable(state)) {
    if (state.dmarcStatus === 'failed') return 'ATTENTION';
    return isDmarcEnforcing(state) ? 'VERIFIED' : 'ATTENTION';
  }

  // Never checked, and nothing provisioned.
  if (state.lastCheckedAt === null && required.every((status) => status !== 'verified')) {
    return 'NOT_CONFIGURED';
  }

  return 'PENDING';
}

export const READINESS_TONE: Record<DomainReadiness, 'neutral' | 'positive' | 'warning' | 'danger'> =
  {
    NOT_CONFIGURED: 'neutral',
    PENDING: 'warning',
    ATTENTION: 'warning',
    VERIFIED: 'positive',
    FAILED: 'danger',
  };

export const READINESS_LABEL: Record<DomainReadiness, string> = {
  NOT_CONFIGURED: 'Not configured',
  PENDING: 'Pending',
  ATTENTION: 'Attention',
  VERIFIED: 'Verified',
  FAILED: 'Failed',
};

/** One line explaining the derived status, shown under the badge. */
export function readinessSummary(state: DomainVerificationState): string {
  const readiness = domainReadiness(state);
  switch (readiness) {
    case 'NOT_CONFIGURED':
      return 'This domain has not been set up with the sending provider yet.';
    case 'PENDING':
      return 'Waiting for DNS changes to be published and picked up. This can take up to 72 hours.';
    case 'ATTENTION':
      if (state.dmarcStatus === 'failed') {
        return 'This domain can send, but its DMARC record is not valid. Review the DNS configuration below.';
      }
      if (state.dmarcStatus === 'not_configured') {
        return 'This domain can send, but has no DMARC record. Publishing one is strongly recommended.';
      }
      return 'This domain can send, but DMARC policy is currently "none". Review the recommended DNS configuration.';
    case 'VERIFIED':
      return 'This domain is fully verified and can be used to send.';
    case 'FAILED':
      return 'Verification failed. Check the DNS records below and try again.';
  }
}
