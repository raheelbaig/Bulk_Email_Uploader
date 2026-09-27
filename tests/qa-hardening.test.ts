import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedContact, seedSuppression, testEligibilityReader } from './helpers/p1';
import { campaignRow, jobsFor, seedLaunchableCampaign, type LaunchableCampaign } from './helpers/p5';
import { testSendingStore } from './helpers/sending-store';
import { runSendTick, type WorkerConfig, type WorkerDeps } from '@/lib/sending/worker';
import { createDryRunProvider } from '@/lib/sending/provider/dry-run';
import type { OutboundEmailProvider, OutboundMessage } from '@/lib/sending/provider/types';
import { normalizeEmail } from '@/lib/email/normalize';

/**
 * Regression tests from the pre-production QA pass (2026-09-25).
 *
 * Each block pins a gap the audit found in the existing suite, or a defect it
 * fixed. The worker runs the production `runSendTick` against the real migrated
 * database; only the provider is a stand-in that records what it was handed.
 */

const BASE_CONFIG: WorkerConfig = {
  mode: 'dry_run',
  ratePerMinute: 1000,
  batchMax: 100,
  reaperTimeoutMinutes: 15,
  reconcileGraceMinutes: 30,
  uncertainPolicy: 'hold',
  scheduleGraceMinutes: 120,
  dailyCap: 100_000,
  contactCooldownMinutes: 24 * 60,
  unsubscribeConfigured: true,
  live: { allowed: false, unmet: ['mode_is_live'] },
};

describe('pre-production QA hardening', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function user(): Promise<{ userId: string; workspaceId: string }> {
    return db.createUser(`qa-${Math.random().toString(36).slice(2, 10)}@example.test`);
  }

  function harness(
    overrides: Partial<WorkerConfig> = {},
    options: {
      providerFor?: WorkerDeps['providerFor'];
      store?: WorkerDeps['store'];
    } = {},
  ): { deps: WorkerDeps; sent: OutboundMessage[] } {
    const sent: OutboundMessage[] = [];
    const dryRun = createDryRunProvider({ inspect: (m) => sent.push(m) });
    return {
      sent,
      deps: {
        store: options.store ?? testSendingStore(db),
        config: { ...BASE_CONFIG, ...overrides },
        providerFor: options.providerFor ?? ((mode) => (mode === 'dry_run' ? dryRun : null)),
        eligibility: testEligibilityReader(db),
        unsubscribeUrl: () => 'https://mail.example.com/u/token',
        providerBudget: async () => ({ perMinute: 1000, remainingToday: 1000 }),
        audit: async () => {},
        logger: { info() {}, warn() {}, error() {} },
      },
    };
  }

  /** The sweeps are global, so every other test's campaigns are parked first. */
  async function launchable(options: Parameters<typeof seedLaunchableCampaign>[2] = {}): Promise<LaunchableCampaign> {
    const c = await seedLaunchableCampaign(db, (await user()).workspaceId, options);
    await db.raw(
      `update campaigns set status = 'paused', pause_reason = 'test_parked'
        where id <> $1 and status in ('scheduled', 'sending', 'queued')`,
      [c.campaignId],
    );
    await db.raw(`delete from rate_ledger`);
    return c;
  }

  async function count(table: 'email_jobs' | 'send_attempts', campaignId: string): Promise<number> {
    const sql =
      table === 'email_jobs'
        ? `select count(*)::int as n from email_jobs where campaign_id = $1`
        : `select count(*)::int as n from send_attempts a join email_jobs j on j.id = a.job_id where j.campaign_id = $1`;
    const res = await db.raw<{ n: number }>(sql, [campaignId]);
    return res.rows[0]?.n ?? 0;
  }

  // ── Canonical addresses are a database guarantee (migration 0011) ─────────
  //
  // `authenticated` holds INSERT on contacts and UPDATE on email_normalized, so a
  // member with the anon key could write a row the application's normalizer
  // never saw. A case variant of an existing address then became a second
  // recipient of the same campaign, and the SQL suppression predicate (an exact
  // match) did not see it as suppressed.

  describe('only canonical addresses can be stored', () => {
    it('a member cannot insert a case variant of an existing contact through the API', async () => {
      const alice = await user();
      await seedContact(db, alice.workspaceId, 'dup@example.com');

      const err = await expectRejected(() =>
        db.asUser(alice.userId, (u) =>
          u.raw(
            `insert into contacts (workspace_id, email_normalized, email_raw) values ($1, $2, $2)`,
            [alice.workspaceId, 'Dup@Example.com'],
          ),
        ),
      );
      expect(err.message).toMatch(/ck_contacts_email_canonical|check constraint/i);
    });

    it('a member cannot insert a structurally invalid address through the API', async () => {
      const alice = await user();
      for (const bad of ['not-an-email', 'a b@example.com', 'x@localhost', 'x@example.c0m', '@example.com']) {
        const err = await expectRejected(() =>
          db.asUser(alice.userId, (u) =>
            u.raw(
              `insert into contacts (workspace_id, email_normalized, email_raw) values ($1, $2, $2)`,
              [alice.workspaceId, bad],
            ),
          ),
        );
        expect(err.message).toMatch(/check constraint/i);
      }
    });

    it('a member cannot rewrite a contact address into a non-canonical form', async () => {
      const alice = await user();
      const id = await seedContact(db, alice.workspaceId, 'rewrite@example.com');
      const err = await expectRejected(() =>
        db.asUser(alice.userId, (u) =>
          u.raw(`update contacts set email_normalized = 'REWRITE@example.com' where id = $1`, [id]),
        ),
      );
      expect(err.message).toMatch(/check constraint/i);
    });

    it('a suppression must be canonical too, or it would match nothing', async () => {
      const alice = await user();
      const err = await expectRejected(() =>
        db.asUser(alice.userId, (u) =>
          u.raw(
            `insert into suppressions (workspace_id, email_normalized, reason, source)
             values ($1, 'Blocked@Example.com', 'manually_blocked', 'manual')`,
            [alice.workspaceId],
          ),
        ),
      );
      expect(err.message).toMatch(/ck_suppressions_email_canonical|check constraint/i);
    });

    it('accepts every address the application normalizer produces', async () => {
      const alice = await user();
      const inputs = [
        'Plain@Example.com',
        '  padded@example.org ',
        'first.last+tag@sub.example.co.uk',
        "o'brien@example.ie",
        'x_y-z@my-domain.example',
        'ＡＢＣ@example.com', // fullwidth ABC, folded by NFKC
        'digits123@123.example.com',
      ];
      for (const input of inputs) {
        const result = normalizeEmail(input);
        expect(result.ok, input).toBe(true);
        if (!result.ok) continue;
        await db.asUser(alice.userId, (u) =>
          u.raw(`insert into contacts (workspace_id, email_normalized, email_raw) values ($1, $2, $3)`, [
            alice.workspaceId,
            result.normalized,
            result.raw,
          ]),
        );
        await seedSuppression(db, alice.workspaceId, result.normalized);
      }
    });
  });

  // ── Suppression is re-checked on the send path, not only at the claim ─────

  describe('a suppression that lands after the claim, before the provider call', () => {
    it('is honoured: the message is not handed to the provider', async () => {
      const c = await launchable({ recipients: 2 });
      const target = c.emails[0]!;
      const real = testSendingStore(db);

      // The suppression is written the instant the claim returns — the narrowest
      // window there is. The SQL predicate inside the claim has already passed;
      // only the eligibility authority's final check can stop this send.
      const store = {
        ...real,
        async claimJobs(...args: Parameters<typeof real.claimJobs>) {
          const claimed = await real.claimJobs(...args);
          await seedSuppression(db, c.workspaceId, target, 'unsubscribe');
          return claimed;
        },
      };

      const h = harness({}, { store });
      await runSendTick(h.deps);

      expect(h.sent.map((m) => m.to)).toEqual([c.emails[1]]);
      const job = (await jobsFor(db, c.campaignId)).find((j) => j.to_email === target);
      expect(job?.status).toBe('suppressed');
      // No attempt row: the provider was never asked.
      const attempts = await db.raw<{ n: number }>(
        `select count(*)::int as n from send_attempts where job_id = $1`,
        [job?.id],
      );
      expect(attempts.rows[0]?.n).toBe(0);
    });
  });

  // ── EMAIL_SENDING_MODE=disabled is a kill switch, not only a launch gate ───

  describe('disabled mode', () => {
    it('stops a campaign already mid-send: no provider call, no attempt, no new job', async () => {
      const c = await launchable({ recipients: 4 });
      // One dry-run tick at one message per minute: the campaign is now sending.
      await runSendTick(harness({ ratePerMinute: 1 }).deps);
      expect((await campaignRow(db, c.campaignId)).status).toBe('sending');
      const jobsBefore = await count('email_jobs', c.campaignId);
      const attemptsBefore = await count('send_attempts', c.campaignId);

      await db.raw(`delete from rate_ledger`);
      const h = harness({ mode: 'disabled' });
      for (let i = 0; i < 3; i += 1) {
        expect((await runSendTick(h.deps)).skipped).toBe('disabled');
      }

      expect(h.sent).toEqual([]);
      expect(await count('email_jobs', c.campaignId)).toBe(jobsBefore);
      expect(await count('send_attempts', c.campaignId)).toBe(attemptsBefore);
      expect((await campaignRow(db, c.campaignId)).n_sent).toBe(1);
    });

    it('repeated ticks against a due campaign create no job, no attempt and no budget row', async () => {
      const c = await launchable({ recipients: 3 });
      let providerAsked = 0;
      const h = harness(
        { mode: 'disabled' },
        {
          providerFor: () => {
            providerAsked += 1;
            return null;
          },
        },
      );
      for (let i = 0; i < 5; i += 1) await runSendTick(h.deps);

      expect(providerAsked).toBe(0);
      expect(await count('email_jobs', c.campaignId)).toBe(0);
      expect(await count('send_attempts', c.campaignId)).toBe(0);
      const ledger = await db.raw<{ n: number }>(`select count(*)::int as n from rate_ledger`);
      expect(ledger.rows[0]?.n).toBe(0);
      expect((await campaignRow(db, c.campaignId)).status).toBe('scheduled');
    });
  });

  // ── The provider factory's answer is checked, not trusted ─────────────────

  describe('a provider whose mode does not match the campaign', () => {
    it('is refused: a dry-run campaign is never handed to a live provider', async () => {
      const c = await launchable({ recipients: 2 });
      const handed: OutboundMessage[] = [];
      const wrong: OutboundEmailProvider = {
        mode: 'live',
        async send(message) {
          handed.push(message);
          return { status: 'accepted', providerMessageId: 'should-not-happen' };
        },
      };
      const h = harness({}, { providerFor: () => wrong });
      await runSendTick(h.deps);

      expect(handed).toEqual([]);
      expect((await jobsFor(db, c.campaignId)).every((j) => j.status === 'pending')).toBe(true);
      expect(await count('send_attempts', c.campaignId)).toBe(0);
    });
  });
});
