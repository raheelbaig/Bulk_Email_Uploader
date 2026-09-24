import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { testEligibilityReader, seedSuppression } from './helpers/p1';
import {
  ageJobs,
  attemptsFor,
  campaignRow,
  jobsFor,
  seedLaunchableCampaign,
  type LaunchableCampaign,
} from './helpers/p5';
import { testSendingStore } from './helpers/sending-store';
import { runSendTick, type WorkerConfig, type WorkerDeps } from '@/lib/sending/worker';
import { createDryRunProvider } from '@/lib/sending/provider/dry-run';
import type { OutboundEmailProvider, OutboundMessage, SendOutcome } from '@/lib/sending/provider/types';
import { mintUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/unsubscribe/token';
import type { AuditEntry } from '@/lib/audit';

/**
 * The sending engine, end to end, against a real migrated database.
 *
 * `runSendTick` is the production function. The store calls the production SQL
 * functions. Only the provider is a stand-in — the dry-run sink, or a scripted
 * one that answers the way SES would — so every claim, attempt, retry and
 * transition here is the real one.
 *
 * Organised by the test obligations in ADR-0001 §7 and ADR-0002 §8, plus the
 * P5 brief: dry run, idempotency, retries, unsubscribe, and the state machine.
 */

const KEY = { v1: 'unsubscribe-key-'.repeat(3) };

const BASE_CONFIG: WorkerConfig = {
  mode: 'dry_run',
  ratePerMinute: 1000,
  batchMax: 100,
  reaperTimeoutMinutes: 15,
  reconcileGraceMinutes: 30,
  uncertainPolicy: 'hold',
  scheduleGraceMinutes: 120,
  unsubscribeConfigured: true,
  live: { allowed: false, unmet: ['mode_is_live'] },
};

const LIVE_OPEN: Pick<WorkerConfig, 'mode' | 'live'> = { mode: 'live', live: { allowed: true, unmet: [] } };

/** A provider that answers from a script, recording everything it was asked to send. */
function scripted(
  mode: 'dry_run' | 'live',
  answer: (message: OutboundMessage, call: number) => SendOutcome,
): OutboundEmailProvider & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    mode,
    sent,
    async send(message) {
      sent.push(message);
      return answer(message, sent.length);
    },
  };
}

const accept = (): SendOutcome => ({ status: 'accepted', providerMessageId: `ses-${Math.random().toString(36).slice(2)}` });

interface Harness {
  deps: WorkerDeps;
  sent: OutboundMessage[];
  audits: AuditEntry[];
}

describe('the send tick', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  /** A fresh workspace per test, so campaigns from other tests are invisible. */
  async function workspace(): Promise<string> {
    const user = await db.createUser(`w-${Math.random().toString(36).slice(2, 10)}@example.test`);
    return user.workspaceId;
  }

  function harness(
    overrides: Partial<WorkerConfig> = {},
    options: { live?: OutboundEmailProvider; dryRun?: OutboundEmailProvider } = {},
  ): Harness {
    const sent: OutboundMessage[] = [];
    const audits: AuditEntry[] = [];
    const dryRun = options.dryRun ?? createDryRunProvider({ inspect: (m) => sent.push(m) });
    return {
      sent,
      audits,
      deps: {
        store: testSendingStore(db),
        config: { ...BASE_CONFIG, ...overrides },
        providerFor: (mode) => (mode === 'dry_run' ? dryRun : (options.live ?? null)),
        eligibility: testEligibilityReader(db),
        unsubscribeUrl: (claims) => `https://mail.example.com/u/${mintUnsubscribeToken(claims, KEY, 'v1')}`,
        providerBudget: async () => ({ perMinute: 1000, remainingToday: 1000 }),
        audit: async (entry) => {
          audits.push(entry);
        },
        logger: { info() {}, warn() {}, error() {} },
      },
    };
  }

  /**
   * Isolates a test's campaigns from every other test's: the sweeps are global,
   * so campaigns left behind by an earlier test are parked first.
   */
  async function parkOthers(keep: LaunchableCampaign): Promise<void> {
    await db.raw(
      `update campaigns set status = 'paused', pause_reason = 'test_parked'
        where id <> $1 and status in ('scheduled', 'sending', 'queued')`,
      [keep.campaignId],
    );
  }

  async function launchable(options: Parameters<typeof seedLaunchableCampaign>[2] = {}): Promise<LaunchableCampaign> {
    const c = await seedLaunchableCampaign(db, await workspace(), options);
    await parkOthers(c);
    return c;
  }

  // ── The master switch ──────────────────────────────────────────────────────

  describe('mode disabled (the default)', () => {
    it('does nothing at all: the campaign stays scheduled and no job exists', async () => {
      const c = await launchable();
      const h = harness({ mode: 'disabled' });
      const summary = await runSendTick(h.deps);

      expect(summary.skipped).toBe('disabled');
      expect((await campaignRow(db, c.campaignId)).status).toBe('scheduled');
      expect(await jobsFor(db, c.campaignId)).toEqual([]);
      expect(h.sent).toEqual([]);
      expect(h.audits).toEqual([]);
    });
  });

  // ── Dry run: the whole pipeline, nothing delivered ─────────────────────────

  describe('dry run', () => {
    it('runs scheduled → queued → sending → completed and delivers nothing', async () => {
      const c = await launchable({ recipients: 3 });
      const h = harness();
      const summary = await runSendTick(h.deps);

      expect(summary).toMatchObject({ launched: 1, materialized: 1, claimed: 3, sent: 3, finished: 1 });

      const row = await campaignRow(db, c.campaignId);
      expect(row).toMatchObject({ status: 'completed', execution_mode: 'dry_run', n_total: 3, n_sent: 3, n_failed: 0 });

      const jobs = await jobsFor(db, c.campaignId);
      expect(jobs.map((j) => j.status)).toEqual(['sent', 'sent', 'sent']);
      for (const job of jobs) {
        expect(job.provider_message_id).toMatch(/^dryrun-/);
        expect(await attemptsFor(db, job.id)).toEqual([
          { attempt_no: 1, state: 'accepted', mode: 'dry_run', provider_message_id: job.provider_message_id },
        ]);
      }

      expect(h.audits.map((a) => a.action)).toEqual(['campaign.launched', 'campaign.completed']);
      expect(h.audits[0]?.metadata).toMatchObject({ mode: 'dry_run' });
    });

    it('builds the message a live send would: one recipient, tags, and a working unsubscribe link', async () => {
      const c = await launchable({ recipients: 1 });
      const h = harness();
      await runSendTick(h.deps);

      expect(h.sent).toHaveLength(1);
      const message = h.sent[0]!;
      const job = (await jobsFor(db, c.campaignId))[0]!;

      expect(message.to).toBe(c.emails[0]);
      expect(message.subject).toBe('Hello Person0');
      expect(message.from).toEqual({ email: expect.stringMatching(/^news@send-/), name: 'Example News' });
      expect(message.tags).toEqual({
        workspace_id: c.workspaceId,
        campaign_id: c.campaignId,
        job_id: job.id,
        attempt_no: '1',
        mode: 'dry_run',
      });

      const link = /^<https:\/\/mail\.example\.com\/u\/([^>]+)>$/.exec(message.headers['List-Unsubscribe'] ?? '');
      expect(link).not.toBeNull();
      expect(verifyUnsubscribeToken(link![1], KEY)).toEqual({
        workspaceId: c.workspaceId,
        campaignId: c.campaignId,
        jobId: job.id,
      });
      expect(message.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    });

    it('a dry-run campaign stays a dry run even if the deployment later goes live', async () => {
      const c = await launchable({ recipients: 2 });
      // First tick in dry-run mode sends one message (rate 1) and launches as dry run.
      await runSendTick(harness({ ratePerMinute: 1 }).deps);
      expect((await campaignRow(db, c.campaignId)).execution_mode).toBe('dry_run');

      const live = scripted('live', accept);
      await db.raw(`delete from rate_ledger`);
      await runSendTick(harness(LIVE_OPEN, { live }).deps);

      expect(live.sent).toEqual([]);
      const jobs = await jobsFor(db, c.campaignId);
      expect(jobs.every((j) => j.provider_message_id?.startsWith('dryrun-'))).toBe(true);
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  describe('idempotency (ADR-0001 §7, ARCHITECTURE §13.6)', () => {
    it('a second tick sends nothing more — a finished job is never claimed again', async () => {
      const c = await launchable({ recipients: 3 });
      const provider = scripted('dry_run', accept);
      await runSendTick(harness({}, { dryRun: provider }).deps);
      await runSendTick(harness({}, { dryRun: provider }).deps);
      await runSendTick(harness({}, { dryRun: provider }).deps);

      expect(provider.sent).toHaveLength(3);
      for (const job of await jobsFor(db, c.campaignId)) expect(await attemptsFor(db, job.id)).toHaveLength(1);
    });

    it('two ticks racing the same campaign send each recipient exactly once', async () => {
      const c = await launchable({ recipients: 8 });
      const provider = scripted('dry_run', accept);
      await Promise.all([
        runSendTick(harness({}, { dryRun: provider }).deps),
        runSendTick(harness({}, { dryRun: provider }).deps),
        runSendTick(harness({}, { dryRun: provider }).deps),
      ]);

      const recipients = provider.sent.map((m) => m.to).sort();
      expect(recipients).toEqual([...c.emails].sort());
      expect(new Set(recipients).size).toBe(8);
      expect((await campaignRow(db, c.campaignId)).n_sent).toBe(8);
    });

    it('a campaign is launched once, however many ticks see it due', async () => {
      const c = await launchable({ recipients: 2 });
      const a = harness();
      const b = harness();
      await Promise.all([runSendTick(a.deps), runSendTick(b.deps)]);
      const launches = [...a.audits, ...b.audits].filter((e) => e.action === 'campaign.launched');
      expect(launches).toHaveLength(1);
      expect((await campaignRow(db, c.campaignId)).n_total).toBe(2);
    });

    it('an address listed twice under two contacts is still mailed once', async () => {
      const c = await launchable({ recipients: 2 });
      // Two contacts cannot share an address (uq_contacts_ws_email), so the
      // job-level guard is proven directly: the second insert is refused.
      await runSendTick(harness({ ratePerMinute: 1 }).deps);
      const err = await db
        .raw(
          `insert into email_jobs (workspace_id, campaign_id, contact_id, to_email)
           values ($1, $2, null, $3)`,
          [c.workspaceId, c.campaignId, c.emails[0]],
        )
        .catch((e: Error) => e);
      expect(String(err)).toMatch(/uq_email_jobs_campaign_email|duplicate key/);
    });
  });

  // ── ADR-0001 crash obligations ─────────────────────────────────────────────

  describe('crash recovery (ADR-0001 §7)', () => {
    async function launchedCampaign(recipients = 1): Promise<LaunchableCampaign> {
      const c = await launchable({ recipients });
      // Launch and materialise without sending: rate limit of zero requests.
      const store = testSendingStore(db);
      await store.promoteCampaign(c, 'dry_run');
      await store.materializeCampaign(c);
      return c;
    }

    it('obligation 2: a crash BEFORE the attempt row → reclaimed and sent exactly once', async () => {
      const c = await launchedCampaign(2);
      const store = testSendingStore(db);
      // A worker claims and dies before recording any attempt.
      const claimed = await store.claimJobs(c, 10);
      expect(claimed).toHaveLength(2);

      const provider = scripted('dry_run', accept);
      await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(provider.sent).toEqual([]); // still within the claim timeout

      await ageJobs(db, c.campaignId, 20);
      const summary = await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(summary.reaped).toBe(2);
      expect(provider.sent.map((m) => m.to).sort()).toEqual([...c.emails].sort());

      for (const job of await jobsFor(db, c.campaignId)) {
        expect(job.status).toBe('sent');
        // The reclaimed attempt reuses number 1: no attempt was ever made under it.
        expect((await attemptsFor(db, job.id)).map((a) => [a.attempt_no, a.state])).toEqual([[1, 'accepted']]);
      }
    });

    it('obligation 1 & 5: a crash AFTER the attempt row → never automatically resent', async () => {
      const c = await launchedCampaign(1);
      const store = testSendingStore(db);
      const [job] = await store.claimJobs(c, 10);
      await store.beginAttempt(c.workspaceId, job!.id, 'dry_run');
      // ... the process dies here, around the provider call.

      const provider = scripted('dry_run', accept);
      await ageJobs(db, c.campaignId, 20);
      const summary = await runSendTick(harness({}, { dryRun: provider }).deps);

      expect(summary.reaped).toBe(0); // the reaper will not touch a job with an open attempt
      expect(provider.sent).toEqual([]);
      expect((await jobsFor(db, c.campaignId))[0]?.status).toBe('claimed');
    });

    it('obligation 4: an attempt never confirmed → send_uncertain, held, counted, not resent', async () => {
      const c = await launchedCampaign(1);
      const unknown = scripted('dry_run', () => ({ status: 'unknown', code: 'timeout', detail: 'no answer' }));
      const first = await runSendTick(harness({}, { dryRun: unknown }).deps);
      expect(first.unknown).toBe(1);

      const [job] = await jobsFor(db, c.campaignId);
      expect(await attemptsFor(db, job!.id)).toEqual([
        { attempt_no: 1, state: 'dispatched', mode: 'dry_run', provider_message_id: null },
      ]);

      // Inside the grace window: nothing changes, nothing is resent.
      const provider = scripted('dry_run', accept);
      await ageJobs(db, c.campaignId, 20);
      await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(provider.sent).toEqual([]);

      // Past it: the attempt is unknown and the job is held for a person.
      await ageJobs(db, c.campaignId, 15);
      const h = harness({}, { dryRun: provider });
      const summary = await runSendTick(h.deps);
      expect(summary.uncertain).toBe(1);
      expect(provider.sent).toEqual([]);
      expect((await jobsFor(db, c.campaignId))[0]?.status).toBe('send_uncertain');
      expect((await attemptsFor(db, job!.id))[0]?.state).toBe('unknown');
      expect(h.audits.map((a) => a.action)).toContain('send.uncertain_held');

      // The campaign cannot complete while a decision is outstanding.
      expect((await campaignRow(db, c.campaignId)).status).toBe('sending');

      // Many more ticks: still nothing.
      await runSendTick(harness({}, { dryRun: provider }).deps);
      await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(provider.sent).toEqual([]);

      // A person leaves it: the job fails, the campaign can finish.
      await db.asServiceRole((as) => as.raw(`select sending_resolve_uncertain($1, $2, 'leave')`, [c.workspaceId, job!.id]));
      await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'failed', n_failed: 1, n_sent: 0 });
    });

    it('obligation 3: a late confirmation resolves the attempt and the job, and counts once', async () => {
      const c = await launchedCampaign(1);
      await runSendTick(harness({}, { dryRun: scripted('dry_run', () => ({ status: 'unknown', code: 'timeout', detail: '' })) }).deps);
      const [job] = await jobsFor(db, c.campaignId);
      const attempt = await db.raw<{ id: string }>(`select id from send_attempts where job_id = $1`, [job!.id]);
      const store = testSendingStore(db);

      // The event channel (P6) will call exactly this, possibly more than once.
      expect(await store.recordAccepted(c.workspaceId, attempt.rows[0]!.id, 'late-id')).toBe(true);
      expect(await store.recordAccepted(c.workspaceId, attempt.rows[0]!.id, 'late-id')).toBe(false);

      expect((await jobsFor(db, c.campaignId))[0]).toMatchObject({ status: 'sent', provider_message_id: 'late-id' });
      expect((await campaignRow(db, c.campaignId)).n_sent).toBe(1);
    });

    it('obligation 8: the redispatch policy resends an uncertain job once, and audits the choice', async () => {
      const c = await launchedCampaign(1);
      await runSendTick(harness({}, { dryRun: scripted('dry_run', () => ({ status: 'unknown', code: 'timeout', detail: '' })) }).deps);
      await ageJobs(db, c.campaignId, 40);
      await runSendTick(harness({ uncertainPolicy: 'redispatch' }).deps); // → send_uncertain

      const provider = scripted('dry_run', accept);
      const h = harness({ uncertainPolicy: 'redispatch' }, { dryRun: provider });
      await runSendTick(h.deps); // → pending → sent

      expect(provider.sent).toHaveLength(1);
      const [job] = await jobsFor(db, c.campaignId);
      expect((await attemptsFor(db, job!.id)).map((a) => [a.attempt_no, a.state])).toEqual([
        [1, 'unknown'],
        [2, 'accepted'],
      ]);
      const audit = h.audits.find((a) => a.action === 'send.uncertain_redispatched');
      expect(audit?.metadata).toMatchObject({ policy: 'redispatch', count: 1 });
    });
  });

  // ── Retries ────────────────────────────────────────────────────────────────

  describe('retries (ARCHITECTURE §14)', () => {
    it('a transient rejection is retried after backoff, and succeeds once', async () => {
      const c = await launchable({ recipients: 1 });
      const provider = scripted('dry_run', (_m, call) =>
        call === 1 ? { status: 'rejected', failure: 'transient', code: 'TooManyRequestsException', detail: 'slow down' } : accept(),
      );

      const first = await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(first.retried).toBe(1);
      const [pending] = await jobsFor(db, c.campaignId);
      expect(pending).toMatchObject({ status: 'pending', attempts: 1 });

      // Not before its time.
      await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(provider.sent).toHaveLength(1);

      await ageJobs(db, c.campaignId, 2);
      await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(provider.sent).toHaveLength(2);
      expect(provider.sent[1]?.tags['attempt_no']).toBe('2');

      const [job] = await jobsFor(db, c.campaignId);
      expect((await attemptsFor(db, job!.id)).map((a) => [a.attempt_no, a.state])).toEqual([
        [1, 'rejected'],
        [2, 'accepted'],
      ]);
      expect((await campaignRow(db, c.campaignId)).status).toBe('completed');
    });

    it('stops after five attempts and marks the job failed', async () => {
      const c = await launchable({ recipients: 1 });
      const provider = scripted('dry_run', () => ({
        status: 'rejected',
        failure: 'transient',
        code: 'ServiceUnavailable',
        detail: '',
      }));
      for (let i = 0; i < 7; i += 1) {
        await runSendTick(harness({}, { dryRun: provider }).deps);
        await ageJobs(db, c.campaignId, 120);
      }
      expect(provider.sent).toHaveLength(5);
      expect((await jobsFor(db, c.campaignId))[0]).toMatchObject({ status: 'failed', attempts: 5 });
      expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'failed', n_failed: 1 });
    });

    it('a permanent rejection fails the job at once', async () => {
      const c = await launchable({ recipients: 2 });
      const provider = scripted('dry_run', (m) =>
        m.to === c.emails[0]
          ? { status: 'rejected', failure: 'permanent', code: 'MessageRejected', detail: 'Email address is not verified.' }
          : accept(),
      );
      await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(provider.sent).toHaveLength(2);
      expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'completed', n_sent: 1, n_failed: 1 });
    });

    it('a halt pauses every sending campaign in the workspace, with its jobs intact', async () => {
      const c = await launchable({ recipients: 3 });
      const provider = scripted('dry_run', () => ({
        status: 'rejected',
        failure: 'halt',
        code: 'AccessDeniedException',
        detail: 'explicit deny',
      }));
      const h = harness({}, { dryRun: provider });
      await runSendTick({ ...h.deps, concurrency: 1 });

      expect(provider.sent).toHaveLength(1);
      expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'paused', pause_reason: 'provider_halt', n_failed: 0 });
      const jobs = await jobsFor(db, c.campaignId);
      expect(jobs.every((j) => j.status === 'pending')).toBe(true);
      expect(h.audits.find((a) => a.action === 'policy.auto_paused')?.metadata).toMatchObject({ reason: 'provider_halt' });
    });

    it('an adapter that throws is treated as unknown, never retried', async () => {
      const c = await launchable({ recipients: 1 });
      const provider: OutboundEmailProvider = {
        mode: 'dry_run',
        async send() {
          throw new Error('boom');
        },
      };
      const summary = await runSendTick(harness({}, { dryRun: provider }).deps);
      expect(summary.unknown).toBe(1);
      const [job] = await jobsFor(db, c.campaignId);
      expect((await attemptsFor(db, job!.id))[0]?.state).toBe('dispatched');
    });
  });

  // ── ADR-0002 recovery obligations ──────────────────────────────────────────

  describe('availability and recovery (ADR-0002 §8)', () => {
    it('obligation 1: a schedule missed by more than the grace window is held, not sent', async () => {
      const c = await launchable({ scheduledInMinutes: -300 });
      const h = harness();
      const summary = await runSendTick(h.deps);

      expect(summary.held).toBe(1);
      expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'paused', pause_reason: 'missed_schedule' });
      expect(h.sent).toEqual([]);
      expect(h.audits.find((a) => a.action === 'campaign.missed_schedule')?.metadata).toMatchObject({
        delayMinutes: expect.any(Number),
      });
    });

    it('obligation 2: a schedule missed by less than the grace window launches normally', async () => {
      const c = await launchable({ scheduledInMinutes: -60 });
      await runSendTick(harness().deps);
      expect((await campaignRow(db, c.campaignId)).status).toBe('completed');
    });

    it('a campaign not yet due is left alone', async () => {
      const c = await launchable({ scheduledInMinutes: 30 });
      await runSendTick(harness().deps);
      expect((await campaignRow(db, c.campaignId)).status).toBe('scheduled');
    });

    it('obligation 3: an interrupted launch, retried, produces the identical job set', async () => {
      const c = await launchable({ recipients: 4 });
      const store = testSendingStore(db);
      await store.promoteCampaign(c, 'dry_run');
      // The materialisation is interrupted and retried: queued → sending happens once.
      expect(await store.materializeCampaign(c)).toBe(4);
      expect(await store.materializeCampaign(c)).toBeNull();
      expect(await jobsFor(db, c.campaignId)).toHaveLength(4);
    });

    it('obligation 6: an idle period banks no budget — the first tick sends at the normal rate', async () => {
      const c = await launchable({ recipients: 5 });
      await db.raw(`delete from rate_ledger`);
      const summary = await runSendTick(harness({ ratePerMinute: 2 }).deps);
      expect(summary.sent).toBe(2);
      // A second tick in the same minute gets nothing further.
      const again = await runSendTick(harness({ ratePerMinute: 2 }).deps);
      expect(again.sent).toBe(0);
      expect((await campaignRow(db, c.campaignId)).n_sent).toBe(2);
    });
  });

  // ── The preflight runs again at launch ─────────────────────────────────────

  describe('launch-time preflight (ARCHITECTURE §19.1)', () => {
    it('a sender that is not verified stops the launch, and nothing is created', async () => {
      const c = await launchable({ senderVerified: false });
      const h = harness();
      const summary = await runSendTick(h.deps);

      expect(summary.launchRefused).toBe(1);
      const row = await campaignRow(db, c.campaignId);
      expect(row.status).toBe('paused');
      expect(row.pause_reason).toMatch(/^preflight_failed:.*sender_dkim_not_verified/);
      expect(await jobsFor(db, c.campaignId)).toEqual([]);
    });

    it('no unsubscribe mechanism stops the launch of a campaign that requires one', async () => {
      const c = await launchable();
      await runSendTick(harness({ unsubscribeConfigured: false }).deps);
      const row = await campaignRow(db, c.campaignId);
      expect(row.status).toBe('paused');
      expect(row.pause_reason).toContain('unsubscribe_mechanism_unavailable');
    });

    it('a campaign that does not require unsubscribe launches without one, and carries no link', async () => {
      const c = await launchable({ requiresUnsubscribe: false, recipients: 1 });
      const h = harness({ unsubscribeConfigured: false });
      await runSendTick(h.deps);
      expect((await campaignRow(db, c.campaignId)).status).toBe('completed');
      expect(h.sent[0]?.headers).toEqual({});
    });

    it('a sender that loses verification mid-campaign pauses it before the next message', async () => {
      const c = await launchable({ recipients: 3 });
      await runSendTick(harness({ ratePerMinute: 1 }).deps);
      await db.raw(`update sender_domains set dkim_status = 'failed' where id = $1`, [c.domainId]);
      await db.raw(`delete from rate_ledger`);

      const h = harness();
      await runSendTick(h.deps);
      expect(h.sent).toEqual([]);
      expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'paused', pause_reason: 'sender_not_ready', n_sent: 1 });
    });
  });

  // ── Suppression and eligibility during the send ────────────────────────────

  describe('recipients who become ineligible mid-campaign (ARCHITECTURE §9)', () => {
    it('a suppression added mid-campaign stops that recipient, and only that one', async () => {
      const c = await launchable({ recipients: 3 });
      await runSendTick(harness({ ratePerMinute: 1 }).deps); // one sent
      const sentTo = (await jobsFor(db, c.campaignId)).find((j) => j.status === 'sent')!.to_email;
      const target = c.emails.find((e) => e !== sentTo)!;
      await seedSuppression(db, c.workspaceId, target, 'unsubscribe');

      await db.raw(`delete from rate_ledger`);
      const h = harness();
      await runSendTick(h.deps);

      expect(h.sent.map((m) => m.to)).not.toContain(target);
      const job = (await jobsFor(db, c.campaignId)).find((j) => j.to_email === target);
      expect(job?.status).toBe('suppressed');
      expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'completed', n_sent: 2, n_suppressed: 1 });
    });

    it('a contact deactivated mid-campaign is skipped at the claim', async () => {
      const c = await launchable({ recipients: 2 });
      const store = testSendingStore(db);
      await store.promoteCampaign(c, 'dry_run');
      await store.materializeCampaign(c);
      await db.raw(`update contacts set status = 'invalid' where id = $1`, [c.contactIds[0]]);

      const h = harness();
      await runSendTick(h.deps);
      expect(h.sent.map((m) => m.to)).toEqual([c.emails[1]]);
      expect((await jobsFor(db, c.campaignId)).find((j) => j.to_email === c.emails[0])?.status).toBe('skipped');
    });

    it('suppressed recipients never become jobs at all', async () => {
      const ws = await workspace();
      const c = await seedLaunchableCampaign(db, ws, { recipients: 3 });
      await parkOthers(c);
      await seedSuppression(db, ws, c.emails[1]!, 'complaint');
      const h = harness();
      await runSendTick(h.deps);
      expect((await jobsFor(db, c.campaignId)).map((j) => j.to_email)).not.toContain(c.emails[1]);
      expect(h.sent).toHaveLength(2);
    });
  });

  // ── Pause, cancel, and the live gate ───────────────────────────────────────

  describe('control', () => {
    it('a paused campaign sends nothing until resumed', async () => {
      const c = await launchable({ recipients: 2 });
      const store = testSendingStore(db);
      await store.promoteCampaign(c, 'dry_run');
      await store.materializeCampaign(c);
      await store.pauseCampaign(c, ['sending'], 'paused_by_user');

      const h = harness();
      await runSendTick(h.deps);
      expect(h.sent).toEqual([]);

      await db.raw(`update campaigns set status = 'sending' where id = $1`, [c.campaignId]);
      await runSendTick(h.deps);
      expect(h.sent).toHaveLength(2);
    });

    it('cancelling mid-campaign cancels every message not yet sent', async () => {
      const c = await launchable({ recipients: 4 });
      await runSendTick(harness({ ratePerMinute: 1 }).deps);
      await db.raw(`update campaigns set status = 'cancelled' where id = $1`, [c.campaignId]);

      const statuses = (await jobsFor(db, c.campaignId)).map((j) => j.status).sort();
      expect(statuses).toEqual(['cancelled', 'cancelled', 'cancelled', 'sent']);
      await db.raw(`delete from rate_ledger`);
      const h = harness();
      await runSendTick(h.deps);
      expect(h.sent).toEqual([]);
    });

    it('live mode with the gate closed launches nothing', async () => {
      const c = await launchable();
      const live = scripted('live', accept);
      const summary = await runSendTick(
        harness({ mode: 'live', live: { allowed: false, unmet: ['configuration_set'] } }, { live }).deps,
      );
      expect(summary.skipped).toBe('live_gate_closed');
      expect((await campaignRow(db, c.campaignId)).status).toBe('scheduled');
      expect(live.sent).toEqual([]);
    });

    it('a live campaign waits, pending, while the gate is closed — and sends when it opens', async () => {
      const c = await launchable({ recipients: 2 });
      const live = scripted('live', accept);
      // Launches live, but the provider budget is zero this tick, so nothing is sent.
      const opening = harness(LIVE_OPEN, { live });
      await runSendTick({ ...opening.deps, providerBudget: async () => ({ perMinute: 0, remainingToday: 0 }) });
      expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'sending', execution_mode: 'live' });

      // Then the gate closes: nothing is sent, nothing is failed.
      const closed = await runSendTick(
        harness({ mode: 'live', live: { allowed: false, unmet: ['unsubscribe_secret'] } }, { live }).deps,
      );
      expect(closed.sent).toBe(0);
      expect(live.sent).toEqual([]);
      expect((await jobsFor(db, c.campaignId)).map((j) => j.status)).toEqual(['pending', 'pending']);

      // Nor does a dry-run deployment touch a live campaign's jobs.
      await runSendTick(harness({ mode: 'dry_run' }, { live }).deps);
      expect(live.sent).toEqual([]);

      // It reopens: the campaign continues from where it was.
      await runSendTick(harness(LIVE_OPEN, { live }).deps);
      expect(live.sent).toHaveLength(2);
      expect((await campaignRow(db, c.campaignId)).status).toBe('completed');
    });

    it('live sending honours the provider-derived budget', async () => {
      const c = await launchable({ recipients: 5 });
      const live = scripted('live', accept);
      const h = harness(LIVE_OPEN, { live });
      await runSendTick({ ...h.deps, providerBudget: async () => ({ perMinute: 100, remainingToday: 2 }) });
      expect(live.sent).toHaveLength(2);
      expect(live.sent.every((m) => m.tags['mode'] === 'live')).toBe(true);

      const jobs = await jobsFor(db, c.campaignId);
      expect(jobs.filter((j) => j.status === 'sent').every((j) => j.provider_message_id?.startsWith('ses-'))).toBe(true);
      expect((await campaignRow(db, c.campaignId)).execution_mode).toBe('live');
    });

    it('live sending waits when provider limits cannot be read (stale-quota guard)', async () => {
      await launchable({ recipients: 2 });
      const live = scripted('live', accept);
      const h = harness(LIVE_OPEN, { live });
      await runSendTick({ ...h.deps, providerBudget: async () => null });
      expect(live.sent).toEqual([]);
    });
  });

  // ── Unsubscribe ────────────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('records a suppression once, counts it once, and stops pending mail to that address', async () => {
      const ws = await workspace();
      const first = await seedLaunchableCampaign(db, ws, { emails: ['sam@example.org'] });
      await parkOthers(first);
      await runSendTick(harness().deps);
      const [job] = await jobsFor(db, first.campaignId);

      // A second campaign to the same person (the same contact, on a second
      // list), launched but not yet sent.
      const second = await seedLaunchableCampaign(db, ws, { emails: ['kim@example.org'] });
      await db.raw(`insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)`, [
        ws,
        second.listId,
        first.contactIds[0],
      ]);
      const store = testSendingStore(db);
      await store.promoteCampaign(second, 'dry_run');
      await store.materializeCampaign(second);

      const unsubscribe = () =>
        db.asServiceRole(async (as) =>
          (await as.raw<{ ok: boolean | null }>(`select sending_record_unsubscribe($1, $2) as ok`, [ws, job!.id])).rows[0]?.ok,
        );
      expect(await unsubscribe()).toBe(true);
      expect(await unsubscribe()).toBe(false); // providers retry one-click

      expect((await campaignRow(db, first.campaignId)).n_unsubscribed).toBe(1);
      const suppression = await db.raw<{ reason: string; source: string }>(
        `select reason::text as reason, source from suppressions where workspace_id = $1 and email_normalized = 'sam@example.org'`,
        [ws],
      );
      expect(suppression.rows).toEqual([{ reason: 'unsubscribe', source: 'unsubscribe_link' }]);

      const secondJobs = await jobsFor(db, second.campaignId);
      expect(secondJobs.find((j) => j.to_email === 'sam@example.org')?.status).toBe('suppressed');
      expect(secondJobs.find((j) => j.to_email === 'kim@example.org')?.status).toBe('pending');
    });
  });
});
