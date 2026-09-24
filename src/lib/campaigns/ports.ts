/**
 * Data access for campaigns.
 *
 * Same pattern, same reason, as `lib/sender/ports.ts` and
 * `lib/templates/ports.ts`. Two things about this port are specific to campaigns
 * and worth reading:
 *
 *   1. `transition` is a *conditional* update, not a write. It takes the states
 *      the caller believes the campaign is in and applies the change only if it
 *      still is — a compare-and-set. Two people clicking Schedule at once
 *      therefore produce one schedule and one "no longer in that state", rather
 *      than two writes racing over the same row. The database's own transition
 *      trigger is the second layer behind it.
 *
 *   2. There is no method that writes `status` freely, and none that writes
 *      `template_snapshot` outside `transition`. A repository cannot offer a
 *      capability the service is not allowed to use.
 *
 * Deliberately free of `server-only`: types only, and the test suite implements
 * them against a real migrated database.
 */

import type { AudienceCounts } from '@/lib/eligibility';
import type { Cursor, Page, PageDirection } from '@/lib/pagination';
import type { CampaignStatus } from './status';

export interface CampaignRecord {
  id: string;
  workspace_id: string;
  name: string;
  status: CampaignStatus;
  template_id: string | null;
  sender_identity_id: string | null;
  list_id: string | null;
  template_snapshot: unknown;
  scheduled_at: string | null;
  launched_at: string | null;
  completed_at: string | null;
  requires_unsubscribe: boolean;
  max_rate_override: number | null;
  pause_reason: string | null;
  launched_by: string | null;
  /** Stamped at launch, once. Null until then (migration 0010). */
  execution_mode: 'dry_run' | 'live' | null;
  n_total: number;
  n_sent: number;
  n_delivered: number;
  n_bounced: number;
  n_complained: number;
  n_failed: number;
  n_unsubscribed: number;
  n_suppressed: number;
  created_at: string;
  updated_at: string | null;
}

/** The fields a person edits. Every one is inside the authenticated UPDATE grant. */
export interface CampaignDraftPatch {
  name?: string;
  templateId?: string | null;
  senderIdentityId?: string | null;
  listId?: string | null;
  /** ISO instant, already converted from wall-clock time (`./schedule.ts`). */
  scheduledAt?: string | null;
  requiresUnsubscribe?: boolean;
}

/** What a transition may write alongside the status change. */
export interface TransitionPatch {
  templateSnapshot?: unknown;
  scheduledAt?: string | null;
}

export interface CampaignListOptions {
  limit?: number | undefined;
  cursor?: Cursor | undefined;
  direction?: PageDirection | undefined;
  status?: CampaignStatus | undefined;
}

/** A contact list, as the audience step and the preflight see it. */
export interface ListSummary {
  id: string;
  name: string;
  contact_count: number;
}

export interface CampaignRepository {
  readonly workspaceId: string;

  /**
   * The workspace's display timezone. Every wall-clock schedule is interpreted
   * in it, so it belongs beside the campaign rather than in a settings module
   * the scheduling path would have to reach for separately.
   */
  timeZone(): Promise<string>;

  /** One list, or null when it is not this workspace's. */
  getList(listId: string): Promise<ListSummary | null>;
  /** Lists a campaign may target, with their trigger-maintained counter. No scan. */
  listLists(limit?: number): Promise<ListSummary[]>;

  list(options?: CampaignListOptions): Promise<Page<CampaignRecord>>;
  get(campaignId: string): Promise<CampaignRecord | null>;

  insert(input: { name: string; requiresUnsubscribe: boolean }): Promise<CampaignRecord>;

  /**
   * Applies an edit. Null when the campaign does not exist in this workspace, or
   * is no longer editable — the RLS policy and this method carry the same
   * predicate, so the answer is the same from either direction.
   */
  updateDraft(campaignId: string, patch: CampaignDraftPatch): Promise<CampaignRecord | null>;

  /**
   * Compare-and-set on `status`.
   *
   * Returns null when the campaign was not in one of `from` — which is a
   * conflict, not an error: someone else moved it.
   */
  transition(
    campaignId: string,
    from: readonly CampaignStatus[],
    to: CampaignStatus,
    patch?: TransitionPatch,
  ): Promise<CampaignRecord | null>;

  /** Only a draft or a cancelled campaign; the RLS policy says the same. */
  remove(campaignId: string): Promise<boolean>;

  /**
   * Counts a list's audience without loading it.
   *
   * Backed by `public.campaign_audience_counts`, which classifies each member
   * with the SQL form of the eligibility rule and is bounded by a LIMIT so a
   * pathological list cannot turn a page render into a table scan.
   */
  audienceCounts(listId: string): Promise<AudienceCounts>;

  /**
   * A bounded sample of the audience, for the preview's "real contact" mode and
   * for the cross-check in tests. Never the whole list.
   */
  audienceSample(listId: string, limit: number): Promise<AudienceMember[]>;
}

/** One member of an audience, as the preview and the eligibility cross-check see them. */
export interface AudienceMember {
  id: string;
  email_normalized: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  custom: Record<string, unknown>;
  status: string;
}
