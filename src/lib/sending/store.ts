import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceForWorkspace, unscopedServiceClient } from '@/lib/db/service';
import { EMPTY_AUDIENCE } from '@/lib/eligibility';
import { backgroundSenderRepository } from '@/lib/sender/repository';
import type { CampaignRecord, ListSummary } from '@/lib/campaigns/ports';
import type { CampaignContext, CampaignRef, ClaimedJob, SendingStore } from './ports';

/**
 * The production sending store.
 *
 * A thin adapter: each method is one `sending_*` function call (migration 0010)
 * or one scoped read. No decision is made here — the functions re-check every
 * precondition — so this file has nothing to get wrong except argument names,
 * and the test suite's store calls the same functions with the same names.
 *
 * ── Why the unscoped client ────────────────────────────────────────────────
 *
 * The worker's sweeps span workspaces by nature ("which campaigns are due?"),
 * which is exactly the case `unscopedServiceClient` exists for. Every function
 * called through it either takes the workspace as an argument and filters on
 * it, or is a sweep whose rows carry their workspace back. Per-workspace
 * *reads* still go through `serviceForWorkspace`, which cannot build a query
 * without its tenant filter.
 */

const CAMPAIGN_COLUMNS =
  'id, workspace_id, name, status, template_id, sender_identity_id, list_id, ' +
  'template_snapshot, scheduled_at, launched_at, completed_at, requires_unsubscribe, ' +
  'max_rate_override, pause_reason, launched_by, execution_mode, n_total, n_sent, n_delivered, ' +
  'n_bounced, n_complained, n_failed, n_unsubscribed, n_suppressed, created_at, updated_at';

type Row = Record<string, unknown>;

function rows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : data === null || data === undefined ? [] : [data as Row];
}

export function sendingStore(): SendingStore {
  const db: SupabaseClient = unscopedServiceClient('sending worker: cross-workspace sweeps and sending_* functions');

  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await db.rpc(fn, args);
    if (error !== null) throw new Error(`${fn} failed: ${error.message}`);
    return data;
  };

  const ref = (row: Row): CampaignRef => ({
    workspaceId: String(row['workspace_id']),
    campaignId: String(row['campaign_id']),
  });

  return {
    async reapClaimed(timeoutMinutes) {
      return Number(await call('sending_reap_claimed', { p_timeout_minutes: timeoutMinutes }));
    },

    async reconcileAttempts(graceMinutes, policy) {
      const data = await call('sending_reconcile_attempts', {
        p_grace_minutes: graceMinutes,
        p_policy: policy,
      });
      return rows(data).map((row) => ({
        workspaceId: String(row['workspace_id']),
        uncertain: Number(row['uncertain'] ?? 0),
        redispatched: Number(row['redispatched'] ?? 0),
      }));
    },

    async holdMissedCampaigns(graceMinutes) {
      const data = await call('sending_hold_missed_campaigns', { p_grace_minutes: graceMinutes });
      return rows(data).map((row) => ({ ...ref(row), scheduledAt: String(row['scheduled_at']) }));
    },

    async dueCampaigns(graceMinutes, limit) {
      const data = await call('sending_due_campaigns', { p_grace_minutes: graceMinutes, p_limit: limit });
      return rows(data).map(ref);
    },

    async activeCampaigns(limit) {
      const data = await call('sending_active_campaigns', { p_limit: limit });
      return rows(data).map((row) => ({
        ...ref(row),
        status: row['status'] === 'queued' ? ('queued' as const) : ('sending' as const),
      }));
    },

    async loadCampaignContext({ workspaceId, campaignId }): Promise<CampaignContext | null> {
      const scoped = serviceForWorkspace(workspaceId);

      const { data: campaignRow, error } = await scoped
        .select('campaigns', CAMPAIGN_COLUMNS)
        .eq('id', campaignId)
        .maybeSingle();
      if (error !== null) throw new Error(`campaign read failed: ${error.message}`);
      if (campaignRow === null) return null;
      const campaign = campaignRow as unknown as CampaignRecord;

      let list: ListSummary | null = null;
      let audience = EMPTY_AUDIENCE;
      if (campaign.list_id !== null) {
        const listRead = await scoped
          .select('contact_lists', 'id, name, contact_count')
          .eq('id', campaign.list_id)
          .maybeSingle();
        if (listRead.error !== null) throw new Error(`list read failed: ${listRead.error.message}`);
        list = listRead.data as unknown as ListSummary | null;

        if (list !== null) {
          const counts = await scoped.rpc('campaign_audience_counts', {
            p_workspace_id: workspaceId,
            p_list_id: campaign.list_id,
          });
          if (counts.error !== null) throw new Error(`audience count failed: ${counts.error.message}`);
          const row = rows(counts.data)[0];
          if (row !== undefined) {
            audience = {
              total: Number(row['total']),
              eligible: Number(row['eligible']),
              suppressed: Number(row['suppressed']),
              inactive: Number(row['inactive']),
              capped: row['capped'] === true,
            };
          }
        }
      }

      const senders = await backgroundSenderRepository(workspaceId);
      const senderIdentity =
        campaign.sender_identity_id === null ? null : await senders.getIdentity(campaign.sender_identity_id);
      const senderDomain = senderIdentity === null ? null : await senders.getDomain(senderIdentity.domain_id);

      return { campaign, list, audience, senderIdentity, senderDomain };
    },

    async promoteCampaign({ workspaceId, campaignId }, mode) {
      return (
        (await call('sending_promote_campaign', {
          p_workspace_id: workspaceId,
          p_campaign_id: campaignId,
          p_mode: mode,
        })) === true
      );
    },

    async pauseCampaign({ workspaceId, campaignId }, from, reason) {
      return (
        (await call('sending_pause_campaign', {
          p_workspace_id: workspaceId,
          p_campaign_id: campaignId,
          p_from: [...from],
          p_reason: reason,
        })) === true
      );
    },

    async materializeCampaign({ workspaceId, campaignId }) {
      const data = await call('sending_materialize_campaign', {
        p_workspace_id: workspaceId,
        p_campaign_id: campaignId,
      });
      return data === null ? null : Number(data);
    },

    async reserveBudget(workspaceId, perMinute, requested) {
      return Number(
        await call('sending_reserve_budget', {
          p_workspace_id: workspaceId,
          p_per_minute: perMinute,
          p_requested: requested,
        }),
      );
    },

    async claimJobs({ workspaceId, campaignId }, limit): Promise<ClaimedJob[]> {
      const data = await call('sending_claim_jobs', {
        p_workspace_id: workspaceId,
        p_campaign_id: campaignId,
        p_limit: limit,
      });
      return rows(data).map((row) => ({
        id: String(row['id']),
        contactId: row['contact_id'] === null ? null : String(row['contact_id']),
        toEmail: String(row['to_email']),
        mergeData: row['merge_data'],
        attempts: Number(row['attempts']),
      }));
    },

    async releaseJob(workspaceId, jobId, outcome, code) {
      return (
        (await call('sending_release_job', {
          p_workspace_id: workspaceId,
          p_job_id: jobId,
          p_outcome: outcome,
          p_code: code,
        })) === true
      );
    },

    async beginAttempt(workspaceId, jobId, mode) {
      const row = rows(
        await call('sending_begin_attempt', { p_workspace_id: workspaceId, p_job_id: jobId, p_mode: mode }),
      )[0];
      return row === undefined
        ? null
        : { attemptId: String(row['attempt_id']), attemptNo: Number(row['attempt_no']) };
    },

    async recordAccepted(workspaceId, attemptId, providerMessageId) {
      return (
        (await call('sending_record_accepted', {
          p_workspace_id: workspaceId,
          p_attempt_id: attemptId,
          p_message_id: providerMessageId,
        })) === true
      );
    },

    async recordRejected(workspaceId, attemptId, failure, code, retryAt) {
      const data = await call('sending_record_rejected', {
        p_workspace_id: workspaceId,
        p_attempt_id: attemptId,
        p_class: failure,
        p_code: code,
        p_retry_at: retryAt === null ? null : retryAt.toISOString(),
      });
      return data === 'pending' || data === 'failed' ? data : null;
    },

    async pauseWorkspace(workspaceId, reason) {
      return Number(await call('sending_pause_workspace', { p_workspace_id: workspaceId, p_reason: reason }));
    },

    async finishCampaign({ workspaceId, campaignId }) {
      const data = await call('sending_finish_campaign', {
        p_workspace_id: workspaceId,
        p_campaign_id: campaignId,
      });
      return data === 'completed' || data === 'failed' ? data : null;
    },
  };
}
