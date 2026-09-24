/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SEND TICK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One pass of the sending engine. Invoked by the scheduler through the
 * HMAC-authenticated worker endpoint roughly once a minute; safe to invoke more
 * often, concurrently, or after an outage of any length.
 *
 * ── The sequence (ARCHITECTURE §13.2, amended by ADR-0001 and ADR-0002) ───
 *
 *   0. Mode `disabled` → return. Nothing is read or written. A live deployment
 *      whose live gate is not satisfied promotes nothing new.
 *   1. Reap claims that provably never reached the provider (ADR-0001 §3.3).
 *   2. Reconcile attempts whose outcome never became known (ADR-0001 §3.4).
 *   3. Hold campaigns whose scheduled time was missed by more than the grace
 *      window (ADR-0002 §5.1). They are paused, never launched.
 *   4. Promote due campaigns: re-run preflight against the frozen snapshot and
 *      the sender's current state; launch those that pass, pause those that do
 *      not (scheduled → queued).
 *   5. Materialise queued campaigns' jobs (queued → sending).
 *   6. For each sending campaign: re-check the sender and the unsubscribe
 *      mechanism, reserve budget, claim, re-check eligibility, and send — one
 *      attempt row committed before every provider call.
 *   7. Finish campaigns with nothing left to do (sending → completed | failed).
 *
 * ── What makes this safe to run twice at once ─────────────────────────────
 *
 * Nothing here is correct *because* only one tick runs. Every state change is a
 * guarded conditional update in SQL: two ticks promoting the same campaign get
 * one `true` and one `false`; two ticks claiming get disjoint batches; the
 * budget is reserved under a row lock. There is no advisory lock — PostgREST
 * cannot hold one across calls, and the design does not need it (§13.3 already
 * called it a pacing control, not a correctness control).
 *
 * ── What it never does ─────────────────────────────────────────────────────
 *
 * It never retries an unknown outcome. It never sends for a campaign that is not
 * `sending`. It never sends a live campaign through anything but a provider the
 * live gate approved in this very tick. It never logs a recipient address,
 * message body or token.
 *
 * Deliberately free of `server-only`: every dependency is injected, so the test
 * suite runs this exact function against a real database with a fake provider.
 */

import { checkEligibilityBatch, type EligibilityReader } from '@/lib/eligibility';
import { parseTemplateSnapshot } from '@/lib/campaigns/snapshot';
import { evaluateSenderReadiness } from '@/lib/sender/readiness';
import type { AuditEntry } from '@/lib/audit';
import { composeMessage } from './compose';
import type { LiveGateVerdict, SendingMode } from './gate';
import { evaluateLaunchPreflight } from './launch';
import type { CampaignRef, ClaimedJob, ExecutionMode, SendingStore } from './ports';
import type { OutboundEmailProvider, SendOutcome } from './provider/types';
import { HALT_RETRY_DELAY_MS, nextAttemptAt } from './retry';

export interface WorkerConfig {
  mode: SendingMode;
  ratePerMinute: number;
  batchMax: number;
  reaperTimeoutMinutes: number;
  reconcileGraceMinutes: number;
  uncertainPolicy: 'hold' | 'redispatch';
  scheduleGraceMinutes: number;
  unsubscribeConfigured: boolean;
  live: LiveGateVerdict;
}

/** Provider-derived budget for live sending (ARCHITECTURE §15.3, §18.1). */
export interface ProviderBudget {
  perMinute: number;
  remainingToday: number;
}

export interface WorkerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface WorkerDeps {
  store: SendingStore;
  config: WorkerConfig;
  /** Null when no provider may be used for that mode right now. */
  providerFor(mode: ExecutionMode): OutboundEmailProvider | null;
  eligibility: EligibilityReader;
  unsubscribeUrl(claims: { workspaceId: string; campaignId: string; jobId: string }): string | null;
  /**
   * Fresh provider limits, fetched every tick (ADR-0002 §5.2: a stale quota
   * blocks sending, and the simplest way never to hold a stale quota is never to
   * cache one). Null means "could not be read", and live sending waits.
   */
  providerBudget(): Promise<ProviderBudget | null>;
  audit(entry: AuditEntry): Promise<void>;
  logger: WorkerLogger;
  now?: () => Date;
  /** Wall-clock budget for the tick, in ms. Unsent claims are handed back. */
  deadlineMs?: number;
  /** Concurrent provider calls per batch (§13.5). */
  concurrency?: number;
  random?: () => number;
}

export interface TickSummary {
  mode: SendingMode;
  skipped?: 'disabled' | 'live_gate_closed';
  reaped: number;
  uncertain: number;
  redispatched: number;
  held: number;
  launched: number;
  launchRefused: number;
  materialized: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  unknown: number;
  ineligible: number;
  released: number;
  paused: number;
  finished: number;
}

const DEFAULT_DEADLINE_MS = 45_000;
const DEFAULT_CONCURRENCY = 4;
const PROMOTION_LIMIT = 20;
const ACTIVE_LIMIT = 20;

function emptySummary(mode: SendingMode): TickSummary {
  return {
    mode,
    reaped: 0,
    uncertain: 0,
    redispatched: 0,
    held: 0,
    launched: 0,
    launchRefused: 0,
    materialized: 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    unknown: 0,
    ineligible: 0,
    released: 0,
    paused: 0,
    finished: 0,
  };
}

export async function runSendTick(deps: WorkerDeps): Promise<TickSummary> {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();
  const deadline = started + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const summary = emptySummary(config.mode);

  // ── 0. The master switch ────────────────────────────────────────────────
  if (config.mode === 'disabled') {
    summary.skipped = 'disabled';
    return summary;
  }

  // The mode new launches get. In live mode with the gate closed, nothing new
  // launches — but maintenance still runs and dry-run campaigns still finish.
  const launchMode: ExecutionMode | null =
    config.mode === 'dry_run' ? 'dry_run' : config.live.allowed ? 'live' : null;
  if (launchMode === null) {
    summary.skipped = 'live_gate_closed';
    deps.logger.warn('live sending gate is closed; no campaign will launch', { unmet: config.live.unmet });
  }

  // ── 1–2. Maintenance ───────────────────────────────────────────────────
  summary.reaped = await store.reapClaimed(config.reaperTimeoutMinutes);

  const reconciled = await store.reconcileAttempts(config.reconcileGraceMinutes, config.uncertainPolicy);
  for (const row of reconciled) {
    summary.uncertain += row.uncertain;
    summary.redispatched += row.redispatched;
    if (row.uncertain > 0) {
      deps.logger.warn('send attempts could not be confirmed and are held', {
        workspaceId: row.workspaceId,
        count: row.uncertain,
      });
      await deps.audit({
        workspaceId: row.workspaceId,
        action: 'send.uncertain_held',
        actorType: 'system',
        metadata: { count: row.uncertain, graceMinutes: config.reconcileGraceMinutes },
      });
    }
    if (row.redispatched > 0) {
      await deps.audit({
        workspaceId: row.workspaceId,
        action: 'send.uncertain_redispatched',
        actorType: 'system',
        // ADR-0001 §7.8: recorded as a deliberate policy choice.
        metadata: { count: row.redispatched, policy: 'redispatch' },
      });
    }
  }

  // ── 3. Missed schedules ────────────────────────────────────────────────
  const held = await store.holdMissedCampaigns(config.scheduleGraceMinutes);
  summary.held = held.length;
  for (const campaign of held) {
    await deps.audit({
      workspaceId: campaign.workspaceId,
      action: 'campaign.missed_schedule',
      actorType: 'system',
      entityType: 'campaign',
      entityId: campaign.campaignId,
      metadata: {
        scheduledAt: campaign.scheduledAt,
        delayMinutes: Math.round((now().getTime() - new Date(campaign.scheduledAt).getTime()) / 60_000),
      },
    });
  }

  // ── 4. Promotion ───────────────────────────────────────────────────────
  if (launchMode !== null) {
    for (const ref of await store.dueCampaigns(config.scheduleGraceMinutes, PROMOTION_LIMIT)) {
      await promote(deps, ref, launchMode, summary, now);
    }
  }

  // ── 5–7. Materialise, send, finish ──────────────────────────────────────
  for (const active of await store.activeCampaigns(ACTIVE_LIMIT)) {
    const ref = { workspaceId: active.workspaceId, campaignId: active.campaignId };

    if (active.status === 'queued') {
      const total = await store.materializeCampaign(ref);
      if (total === null) continue;
      summary.materialized += 1;
      deps.logger.info('campaign jobs created', { campaignId: ref.campaignId, total });
    }

    if (now().getTime() < deadline) {
      await sendBatch(deps, ref, summary, now, deadline);
    }

    const finished = await store.finishCampaign(ref);
    if (finished !== null) {
      summary.finished += 1;
      await deps.audit({
        workspaceId: ref.workspaceId,
        action: finished === 'completed' ? 'campaign.completed' : 'campaign.failed',
        actorType: 'system',
        entityType: 'campaign',
        entityId: ref.campaignId,
      });
    }
  }

  deps.logger.info('send tick finished', { ...summary, durationMs: now().getTime() - started });
  return summary;
}

async function pause(
  deps: WorkerDeps,
  ref: CampaignRef,
  from: readonly string[],
  reason: string,
  summary: TickSummary,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (await deps.store.pauseCampaign(ref, from, reason)) {
    summary.paused += 1;
    await deps.audit({
      workspaceId: ref.workspaceId,
      action: 'campaign.paused',
      actorType: 'system',
      entityType: 'campaign',
      entityId: ref.campaignId,
      metadata: { reason, ...metadata },
    });
  }
}

async function promote(
  deps: WorkerDeps,
  ref: CampaignRef,
  mode: ExecutionMode,
  summary: TickSummary,
  now: () => Date,
): Promise<void> {
  const context = await deps.store.loadCampaignContext(ref);
  if (context === null || context.campaign.status !== 'scheduled') return;

  const verdict = evaluateLaunchPreflight(context, {
    sendingMode: deps.config.mode,
    unsubscribeAvailable: deps.config.unsubscribeConfigured,
    now: now(),
  });

  if (!verdict.ready) {
    summary.launchRefused += 1;
    const codes = verdict.blockers.map((issue) => issue.code);
    // A campaign that fails its final check is held, not retried every minute
    // until its grace window runs out. A person decides what happens next.
    await pause(deps, ref, ['scheduled'], `preflight_failed:${codes.join(',')}`.slice(0, 500), summary, {
      blockers: codes,
    });
    return;
  }

  if (await deps.store.promoteCampaign(ref, mode)) {
    summary.launched += 1;
    await deps.audit({
      workspaceId: ref.workspaceId,
      action: 'campaign.launched',
      actorType: 'system',
      entityType: 'campaign',
      entityId: ref.campaignId,
      metadata: {
        mode,
        eligibleRecipients: context.audience.eligible,
        warnings: verdict.warnings.map((issue) => issue.code),
      },
    });
  }
}

async function sendBatch(
  deps: WorkerDeps,
  ref: CampaignRef,
  summary: TickSummary,
  now: () => Date,
  deadline: number,
): Promise<void> {
  const { store, config } = deps;

  // ADR-0002 §5.4: nothing observed before this tick is trusted. The campaign,
  // its sender and the unsubscribe mechanism are re-read every time.
  const context = await store.loadCampaignContext(ref);
  if (context === null || context.campaign.status !== 'sending') return;
  const campaign = context.campaign;
  const mode = campaign.execution_mode;
  if (mode === null) return;

  // A live campaign sends only while the gate is open. Its jobs wait, pending.
  if (mode === 'live' && !config.live.allowed) return;

  const readiness = evaluateSenderReadiness({
    identity: context.senderIdentity,
    domain: context.senderDomain,
    now: now(),
  });
  if (!readiness.ready || context.senderIdentity === null) {
    await pause(deps, ref, ['sending'], 'sender_not_ready', summary, { blockers: readiness.blockers });
    return;
  }
  if (campaign.requires_unsubscribe && !config.unsubscribeConfigured) {
    await pause(deps, ref, ['sending'], 'unsubscribe_unavailable', summary);
    return;
  }
  const snapshot = parseTemplateSnapshot(campaign.template_snapshot);
  if (snapshot === null) {
    await pause(deps, ref, ['sending'], 'preflight_failed:template_snapshot_missing', summary);
    return;
  }

  const provider = deps.providerFor(mode);
  if (provider === null || provider.mode !== mode) return;

  let perMinute = config.ratePerMinute;
  let requested = config.batchMax;
  if (mode === 'live') {
    const budget = await deps.providerBudget();
    if (budget === null) {
      deps.logger.warn('provider limits unavailable; live sending waits', { campaignId: ref.campaignId });
      return;
    }
    perMinute = Math.min(perMinute, budget.perMinute);
    requested = Math.min(requested, budget.remainingToday);
  }
  if (perMinute <= 0 || requested <= 0) return;

  const granted = await store.reserveBudget(ref.workspaceId, perMinute, requested);
  if (granted <= 0) return;

  const claimed = await store.claimJobs(ref, granted);
  summary.claimed += claimed.length;
  if (claimed.length === 0) return;

  // The eligibility authority, once more, immediately before sending. The claim
  // already applied its SQL form; this is the single-authority rule (§1.3) held
  // on the send path too, and it narrows the suppression window to milliseconds.
  const verdicts = await checkEligibilityBatch(deps.eligibility, {
    workspaceId: ref.workspaceId,
    emails: claimed.map((job) => job.toEmail),
    requireContact: true,
  });

  const sendable: ClaimedJob[] = [];
  for (const [index, job] of claimed.entries()) {
    const verdict = verdicts[index];
    if (verdict !== undefined && verdict.eligible) {
      sendable.push(job);
      continue;
    }
    const reason = verdict === undefined || verdict.eligible ? 'invalid_email' : verdict.reason;
    if (await store.releaseJob(ref.workspaceId, job.id, reason === 'suppressed' ? 'suppressed' : 'skipped', reason)) {
      summary.ineligible += 1;
    }
  }

  const sender = context.senderIdentity;
  let halted = false;

  const sendOne = async (job: ClaimedJob): Promise<void> => {
    if (halted || now().getTime() >= deadline) {
      if (await store.releaseJob(ref.workspaceId, job.id, 'pending', 'deferred')) summary.released += 1;
      return;
    }

    const composed = composeMessage({
      snapshot,
      mergeData: job.mergeData,
      toEmail: job.toEmail,
      sender: { fromEmail: sender.from_email, fromName: sender.from_name, replyTo: sender.reply_to },
      requiresUnsubscribe: campaign.requires_unsubscribe,
      unsubscribeUrl: campaign.requires_unsubscribe
        ? deps.unsubscribeUrl({ workspaceId: ref.workspaceId, campaignId: ref.campaignId, jobId: job.id })
        : null,
      tags: {
        workspace_id: ref.workspaceId,
        campaign_id: ref.campaignId,
        job_id: job.id,
        attempt_no: String(job.attempts),
        mode,
      },
    });
    if (!composed.ok) {
      // Nothing was attempted, so the job fails cleanly with no attempt row.
      if (await store.releaseJob(ref.workspaceId, job.id, 'failed', composed.reason)) summary.failed += 1;
      deps.logger.warn('message could not be composed', { jobId: job.id, reason: composed.reason });
      return;
    }

    // ADR-0001 step 2: intent is durable before the provider hears of it.
    const attempt = await store.beginAttempt(ref.workspaceId, job.id, mode);
    if (attempt === null) return;

    let outcome: SendOutcome;
    try {
      outcome = await provider.send(composed.message);
    } catch (cause) {
      // An adapter is not supposed to throw, but if one does, the only honest
      // reading is that we do not know what happened.
      outcome = { status: 'unknown', code: 'provider_threw', detail: cause instanceof Error ? cause.name : 'error' };
    }

    switch (outcome.status) {
      case 'accepted':
        await store.recordAccepted(ref.workspaceId, attempt.attemptId, outcome.providerMessageId);
        summary.sent += 1;
        return;

      case 'rejected': {
        const retryAt =
          outcome.failure === 'transient'
            ? nextAttemptAt(job.attempts, now(), deps.random)
            : outcome.failure === 'halt'
              ? new Date(now().getTime() + HALT_RETRY_DELAY_MS)
              : null;
        const next = await store.recordRejected(ref.workspaceId, attempt.attemptId, outcome.failure, outcome.code, retryAt);
        if (next === 'pending') summary.retried += 1;
        else if (next === 'failed') summary.failed += 1;
        if (outcome.failure === 'halt') halted = true;
        deps.logger.warn('provider rejected a message', {
          jobId: job.id,
          failure: outcome.failure,
          code: outcome.code,
          next,
        });
        return;
      }

      case 'unknown':
        // Left `dispatched`. The reconciler resolves it; nothing here retries it.
        summary.unknown += 1;
        deps.logger.warn('send outcome unknown; attempt held open', { jobId: job.id, code: outcome.code });
        return;
    }
  };

  await runPool(sendable, deps.concurrency ?? DEFAULT_CONCURRENCY, sendOne);

  if (halted) {
    const count = await store.pauseWorkspace(ref.workspaceId, 'provider_halt');
    summary.paused += count;
    await deps.audit({
      workspaceId: ref.workspaceId,
      action: 'policy.auto_paused',
      actorType: 'system',
      metadata: { reason: 'provider_halt', campaignsPaused: count },
    });
  }
}

/** Bounded concurrency without a dependency: `limit` workers draining one queue. */
async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}
