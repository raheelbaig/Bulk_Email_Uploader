import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { testEligibilityReader } from './helpers/p1';
import { campaignRow, jobsFor, seedLaunchableCampaign, QA_POSTAL_ADDRESS, type LaunchableCampaign } from './helpers/p5';
import { testSendingStore } from './helpers/sending-store';
import { runSendTick, type WorkerConfig, type WorkerDeps } from '@/lib/sending/worker';
import { createDryRunProvider } from '@/lib/sending/provider/dry-run';
import type { OutboundEmailProvider, OutboundMessage } from '@/lib/sending/provider/types';
import { parsePostalAddress } from '@/lib/workspace/settings';

/**
 * Phases E, F and G of the second QA pass: the daily cap, the cross-campaign
 * contact cooldown (migration 0013), the per-campaign rate override, and the
 * postal-address footer (migration 0014). Production `runSendTick` and SQL; the
 * provider is the dry-run sink or a scripted stand-in.
 */

const BASE: WorkerConfig = {
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

describe('send limits and footer', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  function harness(
    overrides: Partial<WorkerConfig> = {},
    live?: OutboundEmailProvider,
  ): { deps: WorkerDeps; sent: OutboundMessage[] } {
    const sent: OutboundMessage[] = [];
    const dryRun = createDryRunProvider({ inspect: (m) => sent.push(m) });
    return {
      sent,
      deps: {
        store: testSendingStore(db),
        config: { ...BASE, ...overrides },
        providerFor: (mode) => (mode === 'dry_run' ? dryRun : (live ?? null)),
        eligibility: testEligibilityReader(db),
        unsubscribeUrl: () => 'https://mail.example.com/u/token.sig',
        providerBudget: async () => ({ perMinute: 1000, remainingToday: 1000 }),
        audit: async () => {},
        logger: { info() {}, warn() {}, error() {} },
      },
    };
  }

  async function workspace(): Promise<string> {
    return (await db.createUser(`lim-${Math.random().toString(36).slice(2, 10)}@example.test`)).workspaceId;
  }

  /** Parks every other campaign, so the global sweeps see only the ones named. */
  async function only(...keep: LaunchableCampaign[]): Promise<void> {
    await db.raw(
      `update campaigns set status = 'paused', pause_reason = 'test_parked'
        where not (id = any($1::uuid[])) and status in ('scheduled', 'sending', 'queued')`,
      [keep.map((c) => c.campaignId)],
    );
    await db.raw(`delete from rate_ledger`);
  }

  const statuses = async (c: LaunchableCampaign) => (await jobsFor(db, c.campaignId)).map((j) => j.status).sort();

  // ── Phase E: daily cap ─────────────────────────────────────────────────────

  describe('the daily cap', () => {
    it('holds across ticks and minutes, and resets with the UTC day', async () => {
      const c = await seedLaunchableCampaign(db, await workspace(), { recipients: 5 });
      await only(c);
      const h = harness({ dailyCap: 3 });

      await runSendTick(h.deps);
      expect(h.sent).toHaveLength(3);

      // A new minute: the per-minute budget is fresh, the daily one is not.
      await db.raw(`update rate_ledger set window_start = window_start - interval '1 minute'`);
      await runSendTick(h.deps);
      expect(h.sent).toHaveLength(3);
      expect(await statuses(c)).toEqual(['pending', 'pending', 'sent', 'sent', 'sent']);

      // Yesterday's reservations do not count against today.
      await db.raw(`update rate_ledger set window_start = window_start - interval '1 day'`);
      await runSendTick(h.deps);
      expect(h.sent).toHaveLength(5);
      expect((await campaignRow(db, c.campaignId)).status).toBe('completed');
    });

    it('is per workspace and shared by every campaign in it', async () => {
      const ws = await workspace();
      const a = await seedLaunchableCampaign(db, ws, { recipients: 3 });
      const b = await seedLaunchableCampaign(db, ws, { recipients: 3 });
      await only(a, b);
      const h = harness({ dailyCap: 4, contactCooldownMinutes: 0 });
      await runSendTick(h.deps);
      // The first campaign is granted 4 but has 3 jobs; the unused unit is
      // refunded, and the second campaign gets it.
      expect(h.sent).toHaveLength(4);
    });

    it('overlapping ticks cannot jointly exceed it', async () => {
      const c = await seedLaunchableCampaign(db, await workspace(), { recipients: 8 });
      await only(c);
      const store = testSendingStore(db);
      await store.promoteCampaign(c, 'dry_run');
      await store.materializeCampaign(c);
      const grants = await Promise.all([1, 2, 3, 4].map(() => store.reserveBudget(c.workspaceId, 100, 3, 5)));
      expect(grants.reduce((sum, n) => sum + n, 0)).toBe(5);
    });

    it('cannot be skipped: the budget function refuses a missing cap', async () => {
      const ws = await workspace();
      const err = await expectRejected(() =>
        db.asServiceRole((svc) => svc.raw(`select sending_reserve_budget($1, 10, 5, null)`, [ws])),
      );
      expect(err.message).toMatch(/daily cap is required/i);
    });
  });

  // ── Phase F: contact cooldown ──────────────────────────────────────────────

  describe('the contact cooldown', () => {
    it('skips a person another campaign reached within the window, and records why', async () => {
      const ws = await workspace();
      const first = await seedLaunchableCampaign(db, ws, { recipients: 2 });
      await only(first);
      await runSendTick(harness().deps);
      expect(await statuses(first)).toEqual(['sent', 'sent']);

      // A second campaign to the same people, straight after.
      const second = await seedLaunchableCampaign(db, ws, { recipients: 0 });
      await db.raw(
        `insert into list_members (workspace_id, list_id, contact_id)
         select workspace_id, $1::uuid, contact_id from list_members where list_id = $2`,
        [second.listId, first.listId],
      );
      await only(second);
      const h = harness();
      await runSendTick(h.deps);

      expect(h.sent).toEqual([]);
      const jobs = await db.raw<{ status: string; last_error_code: string }>(
        `select status::text as status, last_error_code from email_jobs where campaign_id = $1`,
        [second.campaignId],
      );
      expect(jobs.rows).toEqual([
        { status: 'skipped', last_error_code: 'frequency_cap' },
        { status: 'skipped', last_error_code: 'frequency_cap' },
      ]);
    });

    it('lets them through once the window has passed, or when the cooldown is off', async () => {
      const ws = await workspace();
      const first = await seedLaunchableCampaign(db, ws, { recipients: 1 });
      await only(first);
      await runSendTick(harness().deps);

      const again = async (config: Partial<WorkerConfig>) => {
        const next = await seedLaunchableCampaign(db, ws, { recipients: 0 });
        await db.raw(
          `insert into list_members (workspace_id, list_id, contact_id)
           select workspace_id, $1::uuid, contact_id from list_members where list_id = $2`,
          [next.listId, first.listId],
        );
        await only(next);
        const h = harness(config);
        await runSendTick(h.deps);
        return h.sent.length;
      };

      expect(await again({ contactCooldownMinutes: 0 })).toBe(1);
      // Everything sent so far in this workspace is moved 25 hours into the past.
      await db.raw(`update email_jobs set sent_at = sent_at - interval '25 hours' where workspace_id = $1`, [ws]);
      expect(await again({})).toBe(1);
    });

    it('a dry run never blocks a live campaign, and a live send blocks the next live one', async () => {
      const ws = await workspace();
      const rehearsal = await seedLaunchableCampaign(db, ws, { recipients: 1 });
      await only(rehearsal);
      await runSendTick(harness().deps);

      const liveSent: OutboundMessage[] = [];
      const live: OutboundEmailProvider = {
        mode: 'live',
        async send(message) {
          liveSent.push(message);
          return { status: 'accepted', providerMessageId: `ses-${Math.random().toString(36).slice(2)}` };
        },
      };
      const openLive = { mode: 'live' as const, live: { allowed: true, unmet: [] } };

      const real = await seedLaunchableCampaign(db, ws, { recipients: 0, approvedMode: 'live' });
      await db.raw(
        `insert into list_members (workspace_id, list_id, contact_id)
         select workspace_id, $1::uuid, contact_id from list_members where list_id = $2`,
        [real.listId, rehearsal.listId],
      );
      await only(real);
      await runSendTick(harness(openLive, live).deps);
      expect(liveSent).toHaveLength(1);

      const repeat = await seedLaunchableCampaign(db, ws, { recipients: 0, approvedMode: 'live' });
      await db.raw(
        `insert into list_members (workspace_id, list_id, contact_id)
         select workspace_id, $1::uuid, contact_id from list_members where list_id = $2`,
        [repeat.listId, rehearsal.listId],
      );
      await only(repeat);
      await runSendTick(harness(openLive, live).deps);
      expect(liveSent).toHaveLength(1);
      expect(await statuses(repeat)).toEqual(['skipped']);
    });

    it('cannot be skipped: the claim function refuses a missing cooldown', async () => {
      const err = await expectRejected(() =>
        db.asServiceRole((svc) =>
          svc.raw(
            `select * from sending_claim_jobs('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 5, null)`,
          ),
        ),
      );
      expect(err.message).toMatch(/cooldown is required/i);
    });
  });

  // ── max_rate_override ──────────────────────────────────────────────────────

  describe('a campaign rate override', () => {
    it('can slow a campaign down', async () => {
      const c = await seedLaunchableCampaign(db, await workspace(), { recipients: 5 });
      await db.raw(`update campaigns set max_rate_override = 2 where id = $1`, [c.campaignId]);
      await only(c);
      const h = harness();
      await runSendTick(h.deps);
      expect(h.sent).toHaveLength(2);
    });

    it('cannot speed it up past the deployment rate', async () => {
      const c = await seedLaunchableCampaign(db, await workspace(), { recipients: 5 });
      await db.raw(`update campaigns set max_rate_override = 100000 where id = $1`, [c.campaignId]);
      await only(c);
      const h = harness({ ratePerMinute: 1 });
      await runSendTick(h.deps);
      expect(h.sent).toHaveLength(1);
    });
  });

  // ── Phase G: the footer ────────────────────────────────────────────────────

  describe('the postal address footer', () => {
    it('is in the HTML and the text of every bulk message, whatever the template says', async () => {
      const c = await seedLaunchableCampaign(db, await workspace(), { recipients: 1 });
      await only(c);
      const h = harness();
      await runSendTick(h.deps);
      const [message] = h.sent;
      for (const line of QA_POSTAL_ADDRESS.split('\n')) {
        expect(message?.html).toContain(line);
        expect(message?.text).toContain(line);
      }
      expect(message?.html).toMatch(/QA Test Co\.<br>1 Example Street<br>Testville EX 00000/);
    });

    it('is rendered as text: markup in the address is escaped', async () => {
      const c = await seedLaunchableCampaign(db, await workspace(), {
        recipients: 1,
        postalAddress: 'Evil <script>alert(1)</script> Ltd\n1 Example Street',
      });
      await only(c);
      const h = harness();
      await runSendTick(h.deps);
      expect(h.sent[0]?.html).not.toContain('<script>');
      expect(h.sent[0]?.html).toContain('&lt;script&gt;');
    });

    it('missing, it stops launch; removed mid-campaign, it pauses before the next message', async () => {
      const blocked = await seedLaunchableCampaign(db, await workspace(), { recipients: 1, postalAddress: null });
      await only(blocked);
      await runSendTick(harness().deps);
      const row = await campaignRow(db, blocked.campaignId);
      expect(row.status).toBe('paused');
      expect(row.pause_reason).toMatch(/postal_address_missing/);

      const running = await seedLaunchableCampaign(db, await workspace(), { recipients: 3 });
      await only(running);
      await runSendTick(harness({ ratePerMinute: 1 }).deps);
      await db.raw(`update workspace_settings set postal_address = null where workspace_id = $1`, [running.workspaceId]);
      await db.raw(`delete from rate_ledger`);
      const h = harness();
      await runSendTick(h.deps);
      expect(h.sent).toEqual([]);
      expect(await campaignRow(db, running.campaignId)).toMatchObject({
        status: 'paused',
        pause_reason: 'postal_address_missing',
        n_sent: 1,
      });
    });

    it('is not required for a campaign marked as transactional', async () => {
      const c = await seedLaunchableCampaign(db, await workspace(), {
        recipients: 1,
        postalAddress: null,
        requiresUnsubscribe: false,
      });
      await only(c);
      const h = harness();
      await runSendTick(h.deps);
      expect(h.sent).toHaveLength(1);
    });

    it('only an owner or admin may set it, and the database refuses control characters', async () => {
      const owner = await db.createUser(`addr-owner-${Math.random().toString(36).slice(2, 8)}@example.test`);
      const member = await db.createUser(`addr-member-${Math.random().toString(36).slice(2, 8)}@example.test`);
      await db.raw(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')`, [
        owner.workspaceId,
        member.userId,
      ]);

      const byMember = await db.asUser(member.userId, (as) =>
        as.raw(`update workspace_settings set postal_address = 'Member Co, 1 Street, Town' where workspace_id = $1`, [
          owner.workspaceId,
        ]),
      );
      expect(byMember.affectedRows).toBe(0);

      const byOwner = await db.asUser(owner.userId, (as) =>
        as.raw(`update workspace_settings set postal_address = 'Owner Co, 1 Street, Town' where workspace_id = $1`, [
          owner.workspaceId,
        ]),
      );
      expect(byOwner.affectedRows).toBe(1);

      const err = await expectRejected(() =>
        db.raw(`update workspace_settings set postal_address = $2 where workspace_id = $1`, [
          owner.workspaceId,
          'Bad\u0007Bell Co, 1 Street, Town',
        ]),
      );
      expect(err.message).toMatch(/check constraint/i);
    });

    it('input is normalised and bounded before it is stored', () => {
      expect(parsePostalAddress('  QA Test Co.\r\n\r\n  1 Example Street  \n')).toBe('QA Test Co.\n1 Example Street');
      expect(parsePostalAddress('   ')).toBeNull();
      expect(() => parsePostalAddress('Short')).toThrow(/too short/i);
      expect(() => parsePostalAddress('x'.repeat(301))).toThrow(/limited/i);
      expect(() => parsePostalAddress('Tab\there Co, 1 Street')).toThrow(/not allowed/i);
      expect(() => parsePostalAddress(Array.from({ length: 7 }, (_, i) => `Line ${i} xx`).join('\n'))).toThrow(/at most/i);
    });
  });
});
