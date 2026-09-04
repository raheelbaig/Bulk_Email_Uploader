/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SENDER READINESS AUTHORITY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module is the single source of truth for whether a workspace may send
 * *as* a given address. Nothing else in the codebase may read `dkim_status`,
 * `spf_status`, `mail_from_status` or `verified_at` to make that decision.
 *
 * ── Who must call this ────────────────────────────────────────────────────
 *
 *   P4  campaign preflight   — before a campaign may leave `draft`
 *   P4  campaign creation    — when a sender identity is chosen
 *   P5  the send path        — immediately before a message is handed to the
 *                              provider, because a domain can lose verification
 *                              between launch and delivery
 *   P5  test sends           — no bypass flag exists, deliberately
 *
 * The failure this prevents is the same one §1.3 of the blueprint describes for
 * suppression: a second code path that reimplements the check slightly
 * differently, and a campaign that goes out from a domain whose DKIM lapsed
 * three weeks ago. Adding a new caller means calling this function, not writing
 * another one.
 *
 * ── Why the decision is pure ──────────────────────────────────────────────
 *
 * `evaluateSenderReadiness` takes records and returns a verdict. It performs no
 * I/O, so the request path, a future worker under the service role, and the test
 * suite all reach the identical conclusion from the identical inputs — the only
 * thing that varies is how the two rows were fetched.
 *
 * Deliberately free of `server-only`: the pure half must be importable anywhere.
 */

import {
  domainReadiness,
  isDmarcEnforcing,
  isDomainUsable,
  type DomainReadiness,
} from './status';
import type { SenderDomainRecord, SenderIdentityRecord } from './ports';

/** Reasons a sender is not usable. Each blocks sending on its own. */
export type SenderBlocker =
  | 'sender_identity_missing'
  | 'sender_domain_missing'
  | 'identity_domain_mismatch'
  | 'domain_never_checked'
  | 'dkim_not_verified'
  | 'spf_not_verified'
  | 'mail_from_not_verified'
  | 'identity_not_marked_verified';

/** Conditions worth surfacing that do not block sending. */
export type SenderWarning = 'dmarc_not_enforcing' | 'dmarc_invalid' | 'verification_stale';

export interface SenderReadiness {
  ready: boolean;
  /** Empty when ready. Ordered most-actionable first. */
  blockers: SenderBlocker[];
  warnings: SenderWarning[];
  /** The domain's derived status, or null when there is no domain to judge. */
  domainReadiness: DomainReadiness | null;
}

/**
 * A check older than this is reported as stale.
 *
 * A warning rather than a blocker: DNS and provider state rarely change without
 * a person changing them, and refusing to send because a background sweep is
 * late would convert a monitoring gap into an outage. The scheduled re-check
 * interval in ARCHITECTURE §12.4 is six hours, so a day is four missed sweeps.
 */
export const STALE_CHECK_HOURS = 24;

export interface ReadinessInput {
  identity: SenderIdentityRecord | null;
  domain: SenderDomainRecord | null;
  /** Injectable so staleness is testable without waiting a day. */
  now?: Date;
}

export function evaluateSenderReadiness(input: ReadinessInput): SenderReadiness {
  const { identity, domain } = input;
  const now = input.now ?? new Date();

  if (identity === null) {
    return {
      ready: false,
      blockers: ['sender_identity_missing'],
      warnings: [],
      domainReadiness: null,
    };
  }
  if (domain === null) {
    return {
      ready: false,
      blockers: ['sender_domain_missing'],
      warnings: [],
      domainReadiness: null,
    };
  }

  const blockers: SenderBlocker[] = [];

  // Belt and braces. The composite foreign key in migration 0008 makes all three
  // of these impossible to store, so reaching one means either the schema
  // changed or these records were assembled by hand. Either way, refuse.
  if (
    identity.domain_id !== domain.id ||
    identity.workspace_id !== domain.workspace_id ||
    identity.from_domain !== domain.domain
  ) {
    blockers.push('identity_domain_mismatch');
  }

  const state = {
    spfStatus: domain.spf_status,
    dkimStatus: domain.dkim_status,
    dmarcStatus: domain.dmarc_status,
    mailFromStatus: domain.mail_from_status,
    dmarcPolicy: domain.dmarc_policy,
    lastCheckedAt: domain.last_checked_at,
  };

  if (domain.last_checked_at === null) blockers.push('domain_never_checked');
  if (domain.dkim_status !== 'verified') blockers.push('dkim_not_verified');
  if (domain.spf_status !== 'verified') blockers.push('spf_not_verified');
  if (domain.mail_from_status !== 'verified') blockers.push('mail_from_not_verified');

  // The stamp is written by the verifier from `isDomainUsable`. If it disagrees
  // with the domain's own columns, something wrote one without the other, and
  // the safe reading of a disagreement is "not ready".
  if (identity.verified_at === null && isDomainUsable(state)) {
    blockers.push('identity_not_marked_verified');
  }

  const warnings: SenderWarning[] = [];
  if (domain.dmarc_status === 'failed') warnings.push('dmarc_invalid');
  else if (!isDmarcEnforcing(state)) warnings.push('dmarc_not_enforcing');

  if (domain.last_checked_at !== null) {
    const age = now.getTime() - new Date(domain.last_checked_at).getTime();
    if (age > STALE_CHECK_HOURS * 3_600_000) warnings.push('verification_stale');
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    domainReadiness: domainReadiness(state),
  };
}

/** User-safe explanations, one per blocker. */
export const BLOCKER_MESSAGE: Record<SenderBlocker, string> = {
  sender_identity_missing: 'That sender address does not exist in this workspace.',
  sender_domain_missing: 'The sending domain for that address no longer exists.',
  identity_domain_mismatch: 'That sender address does not belong to its sending domain.',
  domain_never_checked: 'The sending domain has not been verified yet.',
  dkim_not_verified: 'DKIM is not verified for the sending domain.',
  spf_not_verified: 'SPF is not verified for the sending domain.',
  mail_from_not_verified: 'The custom MAIL FROM domain is not verified.',
  identity_not_marked_verified:
    'This sender address has not been marked verified. Re-run verification for its domain.',
};

export const WARNING_MESSAGE: Record<SenderWarning, string> = {
  dmarc_not_enforcing:
    'DMARC is not enforcing for this domain. Mail will send, but the domain is not protected from spoofing.',
  dmarc_invalid: 'The DMARC record for this domain is not valid.',
  verification_stale:
    'This domain has not been re-checked recently. Its DNS may have changed since the last check.',
};
