import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { testEligibilityReader } from './helpers/p1';
import { attemptsFor, campaignRow, jobsFor, seedLaunchableCampaign, type LaunchableCampaign } from './helpers/p5';
import { testSendingStore } from './helpers/sending-store';
import { runSendTick, type WorkerDeps } from '@/lib/sending/worker';
import type { ExecutionMode } from '@/lib/sending/ports';
import type { OutboundEmailProvider, OutboundMessage } from '@/lib/sending/provider/types';

/**
 * Phase A of the second QA pass: can a configuration change alone send an old
 * scheduled campaign?
 *
 * Driven through the production configuration path: `process.env` is parsed by
 * the real `serverEnv`, turned into a verdict by the real `sendingConfig`, and
 * providers come from the real `outboundProviderFor`. The unsubscribe key is
 * generated per run — a local secret, never a real one. `fetch` — the only
 * network primitive either SES client uses — is replaced by a stub that fails
 * the test if anything calls it, so nothing here can leave the process.
 *
 * The rule under test (migration 0012): a campaign launches only in the sending
 * mode it was approved for when a person scheduled it.
 */

const LOCAL_UNSUBSCRIBE_SECRET = randomBytes(32).toString('hex');
const LOCAL_WORKER_SECRET = randomBytes(32).toString('hex');

const BASE_ENV = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-anon-key-anon-key',
  NEXT_PUBLIC_APP_URL: 'https://mail.example.com',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-service-role',
  UNSUBSCRIBE_SECRET_V1: LOCAL_UNSUBSCRIBE_SECRET,
  WORKER_HMAC_SECRET: LOCAL_WORKER_SECRET,
};

/**
 * A live deployment configured in every respect — with placeholder AWS values
 * that are not credentials for any account. The network is stubbed, so the SES
 * provider the factory issues can never reach AWS; the tests assert it is never
 * even asked.
 */
const FAKE_LIVE_CONFIG = {
  EMAIL_SENDING_MODE: 'live',
  APP_ENVIRONMENT: 'production',
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'AKIDPLACEHOLDER00000',
  AWS_SECRET_ACCESS_KEY: 'placeholder-not-a-real-secret-key',
  AWS_SES_CONFIGURATION_SET: 'placeholder-set',
  // P6 live-gate requirement (event_pipeline). A placeholder, not a real topic.
  AWS_SNS_TOPIC_ARN: 'arn:aws:sns:eu-west-1:000000000000:placeholder-topic',
};

const savedEnv = { ...process.env };
const network = vi.fn(async () => {
  throw new Error('network access attempted during a no-send test');
});

describe('a configuration change cannot send an old scheduled campaign', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    vi.stubGlobal('fetch', network);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    await db?.close();
  });
  afterEach(() => {
    network.mockClear();
  });

  async function useEnv(extra: Record<string, string> = {}): Promise<void> {
    process.env = { ...BASE_ENV, ...extra } as NodeJS.ProcessEnv;
    const { resetServerEnvCache } = await import('@/lib/env');
    resetServerEnvCache();
  }

  /** Worker dependencies built the way the worker route builds them. */
  async function productionDeps(): Promise<{ deps: WorkerDeps; asked: ExecutionMode[]; delivered: OutboundMessage[] }> {
    const { sendingConfig } = await import('@/lib/sending/config');
    const { outboundProviderFor } = await import('@/lib/sending/provider');
    const { unsubscribeUrlFor } = await import('@/lib/unsubscribe/server');
    const config = sendingConfig();
    const asked: ExecutionMode[] = [];
    const delivered: OutboundMessage[] = [];
    return {
      asked,
      delivered,
      deps: {
        store: testSendingStore(db),
        config,
        providerFor: (mode) => {
          asked.push(mode);
          const provider = outboundProviderFor(mode);
          if (provider === null) return null;
          // Records what reaches the real provider, then hands it on unchanged.
          const recording: OutboundEmailProvider = {
            mode: provider.mode,
            async send(message) {
              delivered.push(message);
              return provider.send(message);
            },
          };
          return recording;
        },
        eligibility: testEligibilityReader(db),
        unsubscribeUrl: (claims) => unsubscribeUrlFor(claims, config.appUrl),
        providerBudget: async () => ({ perMinute: 1000, remainingToday: 1000 }),
        audit: async () => {},
        logger: { info() {}, warn() {}, error() {} },
      },
    };
  }

  async function scheduledUnder(mode: 'disabled' | 'dry_run' | 'live' | null, recipients = 2): Promise<LaunchableCampaign> {
    const user = await db.createUser(`appr-${Math.random().toString(36).slice(2, 10)}@example.test`);
    const c = await seedLaunchableCampaign(db, user.workspaceId, { recipients, approvedMode: mode });
    await db.raw(
      `update campaigns set status = 'paused', pause_reason = 'test_parked'
        where id <> $1 and status in ('scheduled', 'sending', 'queued')`,
      [c.campaignId],
    );
    await db.raw(`delete from rate_ledger`);
    return c;
  }

  async function counts(campaignId: string): Promise<{ jobs: number; attempts: number }> {
    const jobs = await db.raw<{ n: number }>(`select count(*)::int as n from email_jobs where campaign_id = $1`, [campaignId]);
    const attempts = await db.raw<{ n: number }>(
      `select count(*)::int as n from send_attempts a join email_jobs j on j.id = a.job_id where j.campaign_id = $1`,
      [campaignId],
    );
    return { jobs: jobs.rows[0]?.n ?? 0, attempts: attempts.rows[0]?.n ?? 0 };
  }

  it('1–5. disabled: a scheduled campaign survives any number of ticks untouched', async () => {
    await useEnv();
    const c = await scheduledUnder('disabled');
    const { deps, asked } = await productionDeps();
    expect(deps.config.mode).toBe('disabled');

    for (let i = 0; i < 5; i += 1) expect((await runSendTick(deps)).skipped).toBe('disabled');

    expect(asked).toEqual([]);
    expect(await counts(c.campaignId)).toEqual({ jobs: 0, attempts: 0 });
    expect((await campaignRow(db, c.campaignId)).status).toBe('scheduled');
    expect(network).not.toHaveBeenCalled();
  });

  it('6–10. disabled → dry_run: the old campaign is held, not launched; re-approved, it runs as a dry run only', async () => {
    await useEnv();
    const c = await scheduledUnder('disabled');

    await useEnv({ EMAIL_SENDING_MODE: 'dry_run' });
    const first = await productionDeps();
    const summary = await runSendTick(first.deps);

    expect(summary).toMatchObject({ launched: 0, launchRefused: 1, paused: 1 });
    expect(await campaignRow(db, c.campaignId)).toMatchObject({
      status: 'paused',
      pause_reason: 'approved_for_disabled',
      launched_at: null,
      execution_mode: null,
    });
    expect(await counts(c.campaignId)).toEqual({ jobs: 0, attempts: 0 });

    // A person returns it to draft — the approval goes with it — and schedules it
    // again under dry_run, as the schedule service does (a fresh freeze of the
    // same content, and the approval recorded in the same statement).
    const frozen = await db.raw<{ snapshot: unknown }>(`select template_snapshot as snapshot from campaigns where id = $1`, [
      c.campaignId,
    ]);
    await db.raw(`update campaigns set status = 'draft', template_snapshot = null where id = $1`, [c.campaignId]);
    const drafted = await db.raw<{ approved_send_mode: string | null }>(
      `select approved_send_mode from campaigns where id = $1`,
      [c.campaignId],
    );
    expect(drafted.rows[0]?.approved_send_mode).toBeNull();
    await db.raw(`update campaigns set status = 'validating' where id = $1`, [c.campaignId]);
    await db.raw(
      `update campaigns set status = 'scheduled', template_snapshot = $2::jsonb,
                            approved_send_mode = 'dry_run', scheduled_at = now() - interval '1 minute'
        where id = $1`,
      [c.campaignId, JSON.stringify(frozen.rows[0]?.snapshot)],
    );

    const second = await productionDeps();
    await runSendTick(second.deps);

    const row = await campaignRow(db, c.campaignId);
    expect(row).toMatchObject({ status: 'completed', execution_mode: 'dry_run', n_sent: 2 });
    expect(second.delivered).toHaveLength(2);
    expect(second.asked.every((mode) => mode === 'dry_run')).toBe(true);
    for (const job of await jobsFor(db, c.campaignId)) {
      expect(job.provider_message_id ?? 'dryrun-').toMatch(/^dryrun-/);
      for (const attempt of await attemptsFor(db, job.id)) expect(attempt.mode).toBe('dry_run');
    }
    expect(second.delivered.every((m) => m.tags['mode'] === 'dry_run')).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it('11. disabled → fully configured live: campaigns scheduled earlier are held and SES is never asked', async () => {
    await useEnv();
    const fromDisabled = await scheduledUnder('disabled');
    const fromDryRun = await seedLaunchableCampaign(db, fromDisabled.workspaceId, { recipients: 2, approvedMode: 'dry_run' });

    await useEnv(FAKE_LIVE_CONFIG);
    const { deps, asked, delivered } = await productionDeps();
    // The live gate is fully open: this is the configuration that would send.
    expect(deps.config.live).toEqual({ allowed: true, unmet: [] });

    const summary = await runSendTick(deps);

    expect(summary.launched).toBe(0);
    for (const [c, reason] of [
      [fromDisabled, 'approved_for_disabled'],
      [fromDryRun, 'approved_for_dry_run'],
    ] as const) {
      expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'paused', pause_reason: reason, launched_at: null });
      expect(await counts(c.campaignId)).toEqual({ jobs: 0, attempts: 0 });
    }
    expect(asked).not.toContain('live');
    expect(delivered).toEqual([]);
    expect(network).not.toHaveBeenCalled();

    // And further ticks change nothing: a held campaign waits for a person.
    await runSendTick(deps);
    expect(network).not.toHaveBeenCalled();
    expect(await counts(fromDisabled.campaignId)).toEqual({ jobs: 0, attempts: 0 });
  });

  it('a campaign scheduled before approvals existed (NULL) is held in every mode', async () => {
    await useEnv({ EMAIL_SENDING_MODE: 'dry_run' });
    const c = await scheduledUnder(null);
    const { deps } = await productionDeps();
    await runSendTick(deps);
    expect(await campaignRow(db, c.campaignId)).toMatchObject({ status: 'paused', pause_reason: 'not_approved' });
    expect(network).not.toHaveBeenCalled();
  });

  describe('the database holds the rule on its own', () => {
    it('the launch function refuses a mode the campaign was not approved for', async () => {
      const c = await scheduledUnder('disabled');
      for (const mode of ['dry_run', 'live']) {
        const res = await db.asServiceRole((svc) =>
          svc.raw<{ ok: boolean }>(`select sending_promote_campaign($1, $2, $3) as ok`, [c.workspaceId, c.campaignId, mode]),
        );
        expect(res.rows[0]?.ok).toBe(false);
      }
      expect((await campaignRow(db, c.campaignId)).status).toBe('scheduled');
    });

    it('the trigger refuses a launch stamp that disagrees with the approval, for any role', async () => {
      const c = await scheduledUnder('dry_run');
      const err = await expectRejected(() =>
        db.raw(`update campaigns set status = 'queued', launched_at = now(), execution_mode = 'live' where id = $1`, [
          c.campaignId,
        ]),
      );
      expect(err.message).toMatch(/approved for/i);
    });

    it('an approval can only be written by the statement that schedules', async () => {
      const c = await scheduledUnder('disabled');
      const err = await expectRejected(() =>
        db.raw(`update campaigns set approved_send_mode = 'live' where id = $1`, [c.campaignId]),
      );
      expect(err.message).toMatch(/approved for sending only when it is scheduled/i);
    });

    it('a signed-in member cannot approve a campaign for anything', async () => {
      const user = await db.createUser(`member-${Math.random().toString(36).slice(2, 8)}@example.test`);
      const campaign = await db.raw<{ id: string }>(
        `insert into campaigns (workspace_id, name) values ($1, 'Member draft') returning id`,
        [user.workspaceId],
      );
      const err = await expectRejected(() =>
        db.asUser(user.userId, (as) =>
          as.raw(`update campaigns set approved_send_mode = 'live' where id = $1`, [campaign.rows[0]?.id]),
        ),
      );
      expect(err.message).toMatch(/permission denied/i);
    });

    it('a campaign cannot be created already approved', async () => {
      const user = await db.createUser(`create-${Math.random().toString(36).slice(2, 8)}@example.test`);
      const err = await expectRejected(() =>
        db.raw(`insert into campaigns (workspace_id, name, approved_send_mode) values ($1, 'x', 'live')`, [
          user.workspaceId,
        ]),
      );
      expect(err.message).toMatch(/already approved/i);
    });
  });
});
