/**
 * The sending engine's data access.
 *
 * Every mutating method is exactly one call to one `sending_*` function in
 * migration 0010, and every one of those functions re-checks the state it
 * expects. That is what lets the worker run over PostgREST — which cannot hold a
 * transaction across calls — without any step depending on the worker's view of
 * the world still being true.
 *
 * Two implementations: `./store.ts` for production (service role, over HTTP) and
 * the test suite's, which calls the same SQL functions against a real migrated
 * database. The logic that matters is in the SQL, so both exercise it.
 *
 * Deliberately free of `server-only`: types only.
 */

import type { AudienceCounts } from '@/lib/eligibility';
import type { CampaignRecord, ListSummary } from '@/lib/campaigns/ports';
import type { SenderDomainRecord, SenderIdentityRecord } from '@/lib/sender/ports';
import type { SendFailureClass } from './provider/types';

export interface CampaignRef {
  workspaceId: string;
  campaignId: string;
}

export type ExecutionMode = 'dry_run' | 'live';

/** Everything a launch decision or a send batch needs to know about a campaign. */
export interface CampaignContext {
  campaign: CampaignRecord;
  list: ListSummary | null;
  audience: AudienceCounts;
  senderIdentity: SenderIdentityRecord | null;
  senderDomain: SenderDomainRecord | null;
}

export interface ClaimedJob {
  id: string;
  contactId: string | null;
  toEmail: string;
  mergeData: unknown;
  /** The attempt number this claim represents. Also the attempt row's number. */
  attempts: number;
}

export type ReleaseOutcome = 'pending' | 'suppressed' | 'skipped' | 'failed';

export interface SendingStore {
  // ── Maintenance (ADR-0001 §3.3–3.4) ────────────────────────────────────
  reapClaimed(timeoutMinutes: number): Promise<number>;
  /** Per workspace, so each workspace's audit trail records its own. */
  reconcileAttempts(
    graceMinutes: number,
    policy: 'hold' | 'redispatch',
  ): Promise<Array<{ workspaceId: string; uncertain: number; redispatched: number }>>;

  // ── Promotion (ADR-0002 §5.1) ──────────────────────────────────────────
  holdMissedCampaigns(graceMinutes: number): Promise<Array<CampaignRef & { scheduledAt: string }>>;
  dueCampaigns(graceMinutes: number, limit: number): Promise<CampaignRef[]>;
  activeCampaigns(limit: number): Promise<Array<CampaignRef & { status: 'queued' | 'sending' }>>;
  loadCampaignContext(ref: CampaignRef): Promise<CampaignContext | null>;
  promoteCampaign(ref: CampaignRef, mode: ExecutionMode): Promise<boolean>;
  pauseCampaign(ref: CampaignRef, from: readonly string[], reason: string): Promise<boolean>;
  materializeCampaign(ref: CampaignRef): Promise<number | null>;

  // ── Sending ────────────────────────────────────────────────────────────
  reserveBudget(workspaceId: string, perMinute: number, requested: number): Promise<number>;
  claimJobs(ref: CampaignRef, limit: number): Promise<ClaimedJob[]>;
  releaseJob(workspaceId: string, jobId: string, outcome: ReleaseOutcome, code: string): Promise<boolean>;
  beginAttempt(
    workspaceId: string,
    jobId: string,
    mode: ExecutionMode,
  ): Promise<{ attemptId: string; attemptNo: number } | null>;
  recordAccepted(workspaceId: string, attemptId: string, providerMessageId: string): Promise<boolean>;
  recordRejected(
    workspaceId: string,
    attemptId: string,
    failure: SendFailureClass,
    code: string,
    retryAt: Date | null,
  ): Promise<'pending' | 'failed' | null>;

  // ── Outcomes ───────────────────────────────────────────────────────────
  pauseWorkspace(workspaceId: string, reason: string): Promise<number>;
  finishCampaign(ref: CampaignRef): Promise<'completed' | 'failed' | null>;
}
