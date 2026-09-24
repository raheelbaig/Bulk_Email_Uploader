/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CAMPAIGN STATE MACHINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file is the TypeScript mirror of `app.campaign_transition_allowed` in
 * migration 0009. The database is the authority — the trigger there rejects a
 * forbidden transition for every role, including the service role, whatever this
 * file says — and `tests/campaign-state.test.ts` asserts the two agree
 * transition for transition, so a change to one without the other fails the
 * build.
 *
 * ── The machine, as of P5 ──────────────────────────────────────────────
 *
 *      draft ──preflight──▶ validating ──passes──▶ scheduled
 *        ▲                      │                      │ time arrives, preflight re-runs (worker)
 *        └───────fails──────────┘                      ▼
 *        ▲                                  queued ──jobs created──▶ sending ──▶ completed | failed
 *        │                                                            │  ▲
 *        │                                                pause/halt  ▼  │ resume (preflight re-runs)
 *        └──── unschedule (never launched only) ◀──────────────────  paused
 *
 *   Every non-terminal state may also be cancelled. A scheduled campaign whose
 *   time was missed by more than the grace window goes to `paused`, never to
 *   `queued` (ADR-0002 §5.1).
 *
 * The worker performs the `scheduled → queued → sending → completed|failed`
 * steps. People perform pause, resume, unschedule and cancel. Two transitions
 * depend on whether the campaign ever launched, which a status pair cannot
 * express, so the database trigger checks them: `paused → draft` only for a
 * campaign that never launched, `paused → sending` only for one that did.
 *
 * Deliberately free of `server-only`: the UI renders these labels, and a client
 * that believed in a transition the server refuses would show buttons that
 * cannot work.
 */

export const CAMPAIGN_STATUSES = [
  'draft',
  'validating',
  'scheduled',
  'queued',
  'sending',
  'paused',
  'completed',
  'cancelled',
  'failed',
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * Every transition this deployment can perform. Exhaustive by construction: a
 * status missing from the map has no outbound transition.
 */
export const TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ['validating', 'cancelled'],
  validating: ['scheduled', 'draft', 'cancelled'],
  scheduled: ['draft', 'cancelled', 'queued', 'paused'],
  queued: ['sending', 'failed', 'cancelled'],
  sending: ['completed', 'failed', 'paused', 'cancelled'],
  paused: ['sending', 'draft', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
};

/** No transition leaves these. Re-sending means a new campaign and a new audit trail. */
export const TERMINAL_STATUSES: readonly CampaignStatus[] = ['completed', 'cancelled', 'failed'];

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses whose content a person may still edit. Mirrors the RLS UPDATE policy. */
export const EDITABLE_STATUSES: readonly CampaignStatus[] = ['draft', 'validating'];

export function isEditable(status: CampaignStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

export function isCampaignStatus(value: unknown): value is CampaignStatus {
  return typeof value === 'string' && (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: 'Draft',
  validating: 'Checking',
  scheduled: 'Scheduled',
  queued: 'Queued',
  sending: 'Sending',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const STATUS_TONE: Record<CampaignStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  draft: 'neutral',
  validating: 'warning',
  scheduled: 'positive',
  queued: 'warning',
  sending: 'warning',
  paused: 'warning',
  completed: 'positive',
  cancelled: 'neutral',
  failed: 'danger',
};

/** Human-readable pause reasons. Unknown reasons fall back to the raw code. */
export const PAUSE_REASON_LABEL: Record<string, string> = {
  missed_schedule:
    'The scheduled time passed while the service was unavailable. It has not been sent. Review it and schedule it again when ready.',
  paused_by_user: 'Paused by a member of this workspace.',
  provider_halt: 'Amazon SES refused to send for this account. Sending stopped automatically; check the account before resuming.',
  sender_not_ready: 'The sender address stopped passing verification. Sending stopped automatically.',
  unsubscribe_unavailable: 'Unsubscribe links could not be signed. Sending stopped automatically.',
};

export function pauseReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason.startsWith('preflight_failed')) {
    return 'The final check before sending failed, so the campaign did not start. Unschedule it, fix the problem, and schedule it again.';
  }
  return PAUSE_REASON_LABEL[reason] ?? reason;
}
