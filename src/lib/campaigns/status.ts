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
 * ── Why the vocabulary is larger than the machine ────────────────────────
 *
 * `CAMPAIGN_STATUSES` carries the full P5 set, because the enum in the database
 * does: fixing an enum now costs nothing, and migrating one under live data
 * costs a maintenance window. `TRANSITIONS` carries only what P4 can honestly
 * perform. The gap between the two is the "no sending" guarantee expressed as a
 * state machine:
 *
 *      draft ──preflight──▶ validating ──passes──▶ scheduled
 *        ▲                      │                      │
 *        └───────fails──────────┘                      │
 *        └────────────────unschedule───────────────────┘
 *
 *   ... and nothing leaves `scheduled` except back to `draft` or to `cancelled`.
 *   `queued`, `sending`, `paused`, `completed` and `failed` have no inbound
 *   transition at all, so no campaign can hold one.
 *
 * A scheduled campaign whose time arrives therefore does nothing. There is no
 * promotion sweep, no `pg_cron` job, and no code path that could start one —
 * ARCHITECTURE §12's scheduler is P5's, and it will arrive as a migration that
 * edits the SQL function above, which is a reviewable event.
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
  scheduled: ['draft', 'cancelled'],
  // P5 territory. Unreachable, and therefore with nowhere to go.
  queued: [],
  sending: [],
  paused: [],
  completed: [],
  cancelled: [],
  failed: [],
};

/**
 * Statuses that no transition leads to.
 *
 * Asserted by tests/no-sending.test.ts, which is the point: if a future edit
 * gives any of these an inbound edge, the "no sending" suite fails rather than
 * the change passing review unremarked.
 */
export const UNREACHABLE_STATUSES: readonly CampaignStatus[] = CAMPAIGN_STATUSES.filter(
  (status) =>
    status !== 'draft' && !Object.values(TRANSITIONS).some((targets) => targets.includes(status)),
);

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

/**
 * What a scheduled campaign will do when its time arrives, said plainly.
 *
 * Shown wherever a schedule is displayed. A person who schedules something and
 * is not told it will not send would reasonably assume it did.
 */
export const SCHEDULED_INERT_NOTICE =
  'Scheduling saves the campaign and freezes its content. This deployment cannot send email yet, so nothing will be delivered when the scheduled time arrives.';
