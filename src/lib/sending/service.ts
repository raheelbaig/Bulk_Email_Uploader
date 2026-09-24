import 'server-only';
import { requireWorkspace } from '@/lib/auth/workspace';
import { writeAuditLog } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { ConflictError, ForbiddenError, InternalError, ValidationError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { serviceForWorkspace } from '@/lib/db/service';
import { logger } from '@/lib/observability/logger';
import { sendingConfig } from './config';
import { evaluateLaunchPreflight } from './launch';
import { sendingStore } from './store';

/**
 * The person-facing side of the sending engine.
 *
 * Everything a member can *do* to a campaign in flight: see its progress, pause
 * it, resume it, and decide about messages whose outcome is unknown. Launching
 * is not here — a campaign launches when its scheduled time arrives, through the
 * worker, after preflight runs again.
 *
 * Authorization comes first in every function (`requireWorkspace`), and every
 * state change goes through a guarded SQL function or compare-and-set, so a
 * stale page cannot push a campaign somewhere it no longer may go.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const JOB_STATUS_ORDER = [
  'pending',
  'claimed',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'send_uncertain',
  'failed',
  'suppressed',
  'skipped',
  'cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUS_ORDER)[number];

export interface UncertainJob {
  id: string;
  toEmail: string;
  attempts: number;
  updatedAt: string | null;
}

export interface DeliverySummary {
  counts: Record<JobStatus, number>;
  total: number;
  uncertain: UncertainJob[];
}

const EMPTY_COUNTS = Object.fromEntries(JOB_STATUS_ORDER.map((status) => [status, 0])) as Record<
  JobStatus,
  number
>;

/** Read under the caller's own session, so RLS is the second layer. */
export async function getDeliverySummary(workspaceId: string, campaignId: string): Promise<DeliverySummary> {
  await requireWorkspace(workspaceId);
  if (!UUID.test(campaignId)) throw new ForbiddenError();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('campaign_delivery_counts', {
    p_workspace_id: workspaceId,
    p_campaign_id: campaignId,
  });
  if (error !== null) throw new InternalError(error);

  const counts = { ...EMPTY_COUNTS };
  let total = 0;
  for (const row of (data ?? []) as Array<{ status: string; n: number | string }>) {
    if ((JOB_STATUS_ORDER as readonly string[]).includes(row.status)) {
      counts[row.status as JobStatus] = Number(row.n);
      total += Number(row.n);
    }
  }

  let uncertain: UncertainJob[] = [];
  if (counts.send_uncertain > 0) {
    const read = await supabase
      .from('email_jobs')
      .select('id, to_email, attempts, updated_at')
      .eq('workspace_id', workspaceId)
      .eq('campaign_id', campaignId)
      .eq('status', 'send_uncertain')
      .order('updated_at', { ascending: true })
      .limit(50);
    if (read.error !== null) throw new InternalError(read.error);
    uncertain = ((read.data ?? []) as Array<{ id: string; to_email: string; attempts: number; updated_at: string | null }>).map(
      (row) => ({ id: row.id, toEmail: row.to_email, attempts: row.attempts, updatedAt: row.updated_at }),
    );
  }

  return { counts, total, uncertain };
}

/** Stopping is the safe direction, so any member may pause. */
export async function pauseSending(workspaceId: string, campaignId: string): Promise<void> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('campaign.write', access.userId, access.workspaceId);
  if (!UUID.test(campaignId)) throw new ForbiddenError();

  const paused = await sendingStore().pauseCampaign(
    { workspaceId: access.workspaceId, campaignId },
    ['sending', 'queued'],
    'paused_by_user',
  );
  if (!paused) throw new ConflictError('This campaign is not sending, so it cannot be paused.');

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'campaign.paused',
    entityType: 'campaign',
    entityId: campaignId,
    metadata: { reason: 'paused_by_user' },
  });
}

/**
 * Resumes a paused campaign that had started sending.
 *
 * ARCHITECTURE §19.1: preflight runs again on resume. The sender may have lost
 * verification while the campaign was paused, which is often *why* it was
 * paused. Admin and above, because resuming sends email.
 */
export async function resumeSending(workspaceId: string, campaignId: string): Promise<void> {
  const access = await requireWorkspace(workspaceId, { minimumRole: 'admin' });
  await enforceRateLimit('campaign.write', access.userId, access.workspaceId);
  if (!UUID.test(campaignId)) throw new ForbiddenError();

  const config = sendingConfig();
  if (config.mode === 'disabled') {
    throw new ConflictError('Sending is disabled for this deployment, so there is nothing to resume into.');
  }

  const store = sendingStore();
  const ref = { workspaceId: access.workspaceId, campaignId };
  const context = await store.loadCampaignContext(ref);
  if (context === null) throw new ForbiddenError();
  if (context.campaign.status !== 'paused' || context.campaign.launched_at === null) {
    throw new ConflictError(
      'Only a campaign that started sending can be resumed. A campaign that never started must be unscheduled and scheduled again.',
    );
  }

  const verdict = evaluateLaunchPreflight(context, {
    sendingMode: config.mode,
    unsubscribeAvailable: config.unsubscribeConfigured,
  });
  if (!verdict.ready) {
    const first = verdict.blockers[0];
    throw new ConflictError(
      first === undefined ? 'This campaign cannot resume yet.' : `This campaign cannot resume yet: ${first.message}`,
    );
  }

  // Compare-and-set through the service role: `authenticated` holds no grant on
  // `status`, by design (migration 0009). The transition trigger still judges it.
  const { data, error } = await serviceForWorkspace(access.workspaceId)
    .update('campaigns', { status: 'sending' })
    .eq('id', campaignId)
    .eq('status', 'paused')
    .select('id')
    .maybeSingle();
  if (error !== null) {
    logger.error('campaign resume failed', { dbError: error.message, code: error.code });
    throw new ConflictError('This campaign cannot be resumed right now.', error);
  }
  if (data === null) throw new ConflictError('This campaign changed while it was being resumed.');

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'campaign.resumed',
    entityType: 'campaign',
    entityId: campaignId,
    metadata: { warnings: verdict.warnings.map((issue) => issue.code) },
  });
}

/**
 * A person's decision about a message whose outcome is unknown (ADR-0001 §4.5).
 *
 * `redispatch` may deliver a duplicate, and the audit record says a person chose
 * that knowingly. `leave` records the message as not sent by us, without
 * contacting the recipient again. Admin and above for redispatch.
 */
export async function resolveUncertainSend(
  workspaceId: string,
  jobId: string,
  decision: unknown,
): Promise<void> {
  if (decision !== 'redispatch' && decision !== 'leave') {
    throw new ValidationError('Choose whether to send the message again or leave it.');
  }
  const access = await requireWorkspace(workspaceId, {
    ...(decision === 'redispatch' ? { minimumRole: 'admin' as const } : {}),
  });
  await enforceRateLimit('campaign.write', access.userId, access.workspaceId);
  if (!UUID.test(jobId)) throw new ForbiddenError();

  const { data, error } = await serviceForWorkspace(access.workspaceId).rpc('sending_resolve_uncertain', {
    p_workspace_id: access.workspaceId,
    p_job_id: jobId,
    p_decision: decision,
  });
  if (error !== null) throw new InternalError(error);
  if (data === null) {
    throw new ConflictError(
      decision === 'redispatch'
        ? 'That message is no longer waiting for a decision, or has used all its attempts.'
        : 'That message is no longer waiting for a decision.',
    );
  }

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: decision === 'redispatch' ? 'send.uncertain_redispatched' : 'send.uncertain_left',
    entityType: 'email_job',
    entityId: jobId,
    metadata: decision === 'redispatch' ? { policy: 'manual', duplicateRiskAcknowledged: true } : {},
  });
}
