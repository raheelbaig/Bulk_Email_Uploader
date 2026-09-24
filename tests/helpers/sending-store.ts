import type { TestDb } from './db';
import { testSenderRepository } from './sender';
import type { CampaignRecord, ListSummary } from '@/lib/campaigns/ports';
import { EMPTY_AUDIENCE } from '@/lib/eligibility';
import type { CampaignContext, ClaimedJob, SendingStore } from '@/lib/sending/ports';

/**
 * The sending store, over a real migrated database.
 *
 * Each method calls the same `sending_*` SQL function, with the same arguments,
 * as the production store (`src/lib/sending/store.ts`). All of the correctness
 * lives in those functions, so the worker tests exercise the real thing; only
 * the transport (PostgREST vs. a direct query) differs.
 *
 * Calls run as `service_role` — the worker's role — so a function that needs a
 * privilege the worker does not have fails here exactly as it would in
 * production.
 */

const CAMPAIGN_COLUMNS =
  'id, workspace_id, name, status::text as status, template_id, sender_identity_id, list_id, ' +
  'template_snapshot, scheduled_at, launched_at, completed_at, requires_unsubscribe, ' +
  'max_rate_override, pause_reason, launched_by, execution_mode, n_total, n_sent, n_delivered, ' +
  'n_bounced, n_complained, n_failed, n_unsubscribed, n_suppressed, created_at, updated_at';

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function testSendingStore(db: TestDb): SendingStore {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    db.asServiceRole(async (as) => (await as.raw<T>(sql, params)).rows);

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> =>
    (await q<T>(sql, params))[0];

  return {
    async reapClaimed(timeoutMinutes) {
      return Number((await one<{ n: number }>(`select sending_reap_claimed($1) as n`, [timeoutMinutes]))?.n ?? 0);
    },

    async reconcileAttempts(graceMinutes, policy) {
      const rows = await q<{ workspace_id: string; uncertain: number; redispatched: number }>(
        `select * from sending_reconcile_attempts($1, $2)`,
        [graceMinutes, policy],
      );
      return rows.map((row) => ({
        workspaceId: row.workspace_id,
        uncertain: Number(row.uncertain),
        redispatched: Number(row.redispatched),
      }));
    },

    async holdMissedCampaigns(graceMinutes) {
      const rows = await q<{ workspace_id: string; campaign_id: string; scheduled_at: unknown }>(
        `select * from sending_hold_missed_campaigns($1)`,
        [graceMinutes],
      );
      return rows.map((row) => ({
        workspaceId: row.workspace_id,
        campaignId: row.campaign_id,
        scheduledAt: iso(row.scheduled_at) ?? '',
      }));
    },

    async dueCampaigns(graceMinutes, limit) {
      const rows = await q<{ workspace_id: string; campaign_id: string }>(
        `select * from sending_due_campaigns($1, $2)`,
        [graceMinutes, limit],
      );
      return rows.map((row) => ({ workspaceId: row.workspace_id, campaignId: row.campaign_id }));
    },

    async activeCampaigns(limit) {
      const rows = await q<{ workspace_id: string; campaign_id: string; status: string }>(
        `select * from sending_active_campaigns($1)`,
        [limit],
      );
      return rows.map((row) => ({
        workspaceId: row.workspace_id,
        campaignId: row.campaign_id,
        status: row.status === 'queued' ? ('queued' as const) : ('sending' as const),
      }));
    },

    async loadCampaignContext({ workspaceId, campaignId }): Promise<CampaignContext | null> {
      const row = await one<Record<string, unknown>>(
        `select ${CAMPAIGN_COLUMNS} from campaigns where workspace_id = $1 and id = $2`,
        [workspaceId, campaignId],
      );
      if (row === undefined) return null;
      const campaign = {
        ...(row as unknown as CampaignRecord),
        scheduled_at: iso(row['scheduled_at']),
        launched_at: iso(row['launched_at']),
        completed_at: iso(row['completed_at']),
        created_at: iso(row['created_at']) ?? '',
        updated_at: iso(row['updated_at']),
      };

      let list: ListSummary | null = null;
      let audience = EMPTY_AUDIENCE;
      if (campaign.list_id !== null) {
        list =
          (await one<ListSummary>(
            `select id, name, contact_count from contact_lists where workspace_id = $1 and id = $2`,
            [workspaceId, campaign.list_id],
          )) ?? null;
        const counts = await one<{ total: string; eligible: string; suppressed: string; inactive: string; capped: boolean }>(
          `select * from campaign_audience_counts($1, $2)`,
          [workspaceId, campaign.list_id],
        );
        if (counts !== undefined) {
          audience = {
            total: Number(counts.total),
            eligible: Number(counts.eligible),
            suppressed: Number(counts.suppressed),
            inactive: Number(counts.inactive),
            capped: counts.capped === true,
          };
        }
      }

      const senders = testSenderRepository(db, workspaceId);
      const senderIdentity =
        campaign.sender_identity_id === null ? null : await senders.getIdentity(campaign.sender_identity_id);
      const senderDomain = senderIdentity === null ? null : await senders.getDomain(senderIdentity.domain_id);

      return { campaign, list, audience, senderIdentity, senderDomain };
    },

    async promoteCampaign({ workspaceId, campaignId }, mode) {
      return (
        (await one<{ ok: boolean }>(`select sending_promote_campaign($1, $2, $3) as ok`, [workspaceId, campaignId, mode]))
          ?.ok === true
      );
    },

    async pauseCampaign({ workspaceId, campaignId }, from, reason) {
      return (
        (
          await one<{ ok: boolean }>(`select sending_pause_campaign($1, $2, $3::text[], $4) as ok`, [
            workspaceId,
            campaignId,
            [...from],
            reason,
          ])
        )?.ok === true
      );
    },

    async materializeCampaign({ workspaceId, campaignId }) {
      const n = (await one<{ n: number | null }>(`select sending_materialize_campaign($1, $2) as n`, [workspaceId, campaignId]))?.n;
      return n === null || n === undefined ? null : Number(n);
    },

    async reserveBudget(workspaceId, perMinute, requested) {
      return Number(
        (await one<{ n: number }>(`select sending_reserve_budget($1, $2, $3) as n`, [workspaceId, perMinute, requested]))?.n ?? 0,
      );
    },

    async claimJobs({ workspaceId, campaignId }, limit): Promise<ClaimedJob[]> {
      const rows = await q<{ id: string; contact_id: string | null; to_email: string; merge_data: unknown; attempts: number }>(
        `select * from sending_claim_jobs($1, $2, $3)`,
        [workspaceId, campaignId, limit],
      );
      return rows.map((row) => ({
        id: row.id,
        contactId: row.contact_id,
        toEmail: row.to_email,
        mergeData: row.merge_data,
        attempts: Number(row.attempts),
      }));
    },

    async releaseJob(workspaceId, jobId, outcome, code) {
      return (
        (await one<{ ok: boolean }>(`select sending_release_job($1, $2, $3, $4) as ok`, [workspaceId, jobId, outcome, code]))
          ?.ok === true
      );
    },

    async beginAttempt(workspaceId, jobId, mode) {
      const row = await one<{ attempt_id: string; attempt_no: number }>(
        `select * from sending_begin_attempt($1, $2, $3)`,
        [workspaceId, jobId, mode],
      );
      return row === undefined ? null : { attemptId: row.attempt_id, attemptNo: Number(row.attempt_no) };
    },

    async recordAccepted(workspaceId, attemptId, providerMessageId) {
      return (
        (
          await one<{ ok: boolean }>(`select sending_record_accepted($1, $2, $3) as ok`, [
            workspaceId,
            attemptId,
            providerMessageId,
          ])
        )?.ok === true
      );
    },

    async recordRejected(workspaceId, attemptId, failure, code, retryAt) {
      const next = (
        await one<{ next: string | null }>(`select sending_record_rejected($1, $2, $3, $4, $5::timestamptz) as next`, [
          workspaceId,
          attemptId,
          failure,
          code,
          retryAt === null ? null : retryAt.toISOString(),
        ])
      )?.next;
      return next === 'pending' || next === 'failed' ? next : null;
    },

    async pauseWorkspace(workspaceId, reason) {
      return Number((await one<{ n: number }>(`select sending_pause_workspace($1, $2) as n`, [workspaceId, reason]))?.n ?? 0);
    },

    async finishCampaign({ workspaceId, campaignId }) {
      const status = (await one<{ s: string | null }>(`select sending_finish_campaign($1, $2) as s`, [workspaceId, campaignId]))?.s;
      return status === 'completed' || status === 'failed' ? status : null;
    },
  };
}
