import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedCampaign, seedTemplate } from './helpers/p4';
import { seedList } from './helpers/p1';
import { seedSenderDomain, seedSenderIdentity, verifiedDomainState } from './helpers/sender';
import {
  CAMPAIGN_STATUSES,
  canTransition,
  isEditable,
  TERMINAL_STATUSES,
  TRANSITIONS,
  type CampaignStatus,
} from '@/lib/campaigns/status';

/**
 * The campaign state machine, proven against the real database.
 *
 * Claims here cannot be made by application code:
 *
 *   1. No role — including `service_role`, which bypasses RLS entirely — can
 *      make a transition the machine does not list. P5 added the delivery
 *      transitions (migration 0010); every other jump is still refused.
 *   2. A campaign is launched once, only by `scheduled → queued`, and the
 *      launch stamp can never be rewritten or removed.
 *   3. A frozen snapshot cannot be rewritten while the campaign holds it.
 *
 * The third section asserts that the TypeScript mirror in `lib/campaigns/status.ts`
 * agrees with the SQL function, transition for transition, so the two cannot
 * drift apart silently.
 */
describe('campaign state machine', () => {
  let db: TestDb;
  let alice: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDb();
    alice = await db.createUser('alice@example.test');
  });
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.raw('delete from campaigns');
    await db.raw('delete from templates');
  });

  const setStatus = (campaignId: string, status: string) =>
    db.raw(`update campaigns set status = $2::campaign_status where id = $1`, [campaignId, status]);

  const statusOf = async (campaignId: string): Promise<string> => {
    const res = await db.raw<{ status: string }>(
      `select status::text as status from campaigns where id = $1`,
      [campaignId],
    );
    return res.rows[0]?.status ?? 'missing';
  };

  // ── The TypeScript mirror ─────────────────────────────────────────────────

  describe('the TypeScript mirror matches the SQL function', () => {
    it.each(
      CAMPAIGN_STATUSES.flatMap((from) =>
        CAMPAIGN_STATUSES.map((to) => [from, to] as [CampaignStatus, CampaignStatus]),
      ),
    )('%s to %s', async (from, to) => {
      const res = await db.raw<{ allowed: boolean }>(
        `select app.campaign_transition_allowed($1::campaign_status, $2::campaign_status) as allowed`,
        [from, to],
      );
      expect(res.rows[0]?.allowed, `${from} -> ${to}`).toBe(canTransition(from, to));
    });

    it('the enum in the database holds exactly the declared vocabulary', async () => {
      const res = await db.raw<{ label: string }>(
        `select e.enumlabel as label
           from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'campaign_status'
          order by e.enumsortorder`,
      );
      expect(res.rows.map((r) => r.label)).toEqual([...CAMPAIGN_STATUSES]);
    });
  });

  // ── What P4 can do ────────────────────────────────────────────────────────

  describe('the transitions P4 performs', () => {
    it('a campaign is born a draft', async () => {
      const id = await seedCampaign(db, alice.workspaceId);
      expect(await statusOf(id)).toBe('draft');
    });

    it.each([
      ['draft', 'validating'],
      ['validating', 'draft'],
      ['validating', 'cancelled'],
      ['draft', 'cancelled'],
    ] as const)('allows %s to %s', async (from, to) => {
      const id = await seedCampaign(db, alice.workspaceId);
      if (from !== 'draft') await setStatus(id, from);

      await expect(setStatus(id, to)).resolves.toBeTruthy();
      expect(await statusOf(id)).toBe(to);
    });

    it('walks draft to validating to scheduled and back again', async () => {
      const listId = await seedList(db, alice.workspaceId, 'Subscribers');
      const templateId = await seedTemplate(db, alice.workspaceId);
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'acme.test', verifiedDomainState());
      const identityId = await seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@acme.test', {
        verifiedAt: new Date().toISOString(),
      });
      const id = await seedCampaign(db, alice.workspaceId);

      await db.raw(
        `update campaigns
            set list_id = $2, template_id = $3, sender_identity_id = $4,
                scheduled_at = now() + interval '1 day'
          where id = $1`,
        [id, listId, templateId, identityId],
      );

      await setStatus(id, 'validating');
      await db.raw(
        `update campaigns set status = 'scheduled', template_snapshot = $2::jsonb where id = $1`,
        [id, JSON.stringify({ template_id: templateId, version: 1 })],
      );
      expect(await statusOf(id)).toBe('scheduled');

      await db.raw(`update campaigns set status = 'draft', template_snapshot = null where id = $1`, [id]);
      expect(await statusOf(id)).toBe('draft');
    });
  });

  // ── What no role can do ───────────────────────────────────────────────────

  describe('the transitions nothing can perform', () => {
    /** A complete scheduled campaign, built through the real transitions. */
    const scheduledCampaign = async (tag: string): Promise<string> => {
      const id = await seedCampaign(db, alice.workspaceId);
      const listId = await seedList(db, alice.workspaceId, `L-${tag}`);
      const templateId = await seedTemplate(db, alice.workspaceId, { name: `T-${tag}` });
      const domainId = await seedSenderDomain(db, alice.workspaceId, `${tag}.test`, verifiedDomainState());
      const identityId = await seedSenderIdentity(db, alice.workspaceId, domainId, `x@${tag}.test`);
      await db.raw(
        `update campaigns set list_id = $2, template_id = $3, sender_identity_id = $4,
                              scheduled_at = now() - interval '1 minute'
          where id = $1`,
        [id, listId, templateId, identityId],
      );
      await setStatus(id, 'validating');
      await db.raw(
        `update campaigns set status = 'scheduled', template_snapshot = '{"frozen": true}'::jsonb where id = $1`,
        [id],
      );
      return id;
    };

    it('the terminal states have no way out', () => {
      expect([...TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed', 'failed']);
      for (const status of TERMINAL_STATUSES) expect(TRANSITIONS[status]).toEqual([]);
    });

    it.each(['sending', 'completed', 'failed'] as const)(
      'refuses scheduled to %s — a campaign cannot skip its launch',
      async (to) => {
        const id = await scheduledCampaign(`skip-${to}`);
        const err = await expectRejected(() => setStatus(id, to));
        expect(err.message).toMatch(/not permitted/i);
        expect(await statusOf(id)).toBe('scheduled');
      },
    );

    it('scheduled to queued without a launch stamp is refused', async () => {
      const id = await scheduledCampaign('nostamp');
      const err = await expectRejected(() => setStatus(id, 'queued'));
      expect(err.message).toMatch(/ck_campaigns_launch|check constraint/i);
      expect(await statusOf(id)).toBe('scheduled');
    });

    it('launches through scheduled → queued → sending, stamping the launch once', async () => {
      const id = await scheduledCampaign('launch');
      await db.raw(
        `update campaigns set status = 'queued', launched_at = now(), execution_mode = 'dry_run' where id = $1`,
        [id],
      );
      await setStatus(id, 'sending');
      expect(await statusOf(id)).toBe('sending');

      const rewrite = await expectRejected(() =>
        db.raw(`update campaigns set execution_mode = 'live' where id = $1`, [id]),
      );
      expect(rewrite.message).toMatch(/launch stamp/i);
      const unstamp = await expectRejected(() =>
        db.raw(`update campaigns set launched_at = null, execution_mode = null where id = $1`, [id]),
      );
      expect(unstamp.message).toMatch(/launch stamp/i);
    });

    it('a campaign cannot be launched by any other transition', async () => {
      const id = await seedCampaign(db, alice.workspaceId);
      const err = await expectRejected(() =>
        db.raw(`update campaigns set launched_at = now(), execution_mode = 'live' where id = $1`, [id]),
      );
      expect(err.message).toMatch(/only by the scheduled/i);
    });

    it('a launched, paused campaign cannot return to draft', async () => {
      const id = await scheduledCampaign('nodraft');
      await db.raw(
        `update campaigns set status = 'queued', launched_at = now(), execution_mode = 'dry_run' where id = $1`,
        [id],
      );
      await setStatus(id, 'sending');
      await setStatus(id, 'paused');
      const err = await expectRejected(() =>
        db.raw(`update campaigns set status = 'draft', template_snapshot = null where id = $1`, [id]),
      );
      expect(err.message).toMatch(/cannot return to draft/i);
    });

    it('a never-launched, paused campaign cannot be resumed — only unscheduled', async () => {
      const id = await scheduledCampaign('noresume');
      await db.raw(`update campaigns set status = 'paused', pause_reason = 'missed_schedule' where id = $1`, [id]);
      const err = await expectRejected(() => setStatus(id, 'sending'));
      expect(err.message).toMatch(/never started/i);

      await db.raw(`update campaigns set status = 'draft', template_snapshot = null where id = $1`, [id]);
      const row = await db.raw<{ status: string; pause_reason: string | null }>(
        `select status::text as status, pause_reason from campaigns where id = $1`,
        [id],
      );
      expect(row.rows[0]).toEqual({ status: 'draft', pause_reason: null });
    });

    it.each([
      ['draft', 'sending'],
      ['draft', 'queued'],
      ['draft', 'completed'],
      ['validating', 'sending'],
      ['cancelled', 'draft'],
      ['cancelled', 'scheduled'],
    ] as const)('refuses %s to %s', async (from, to) => {
      const id = await seedCampaign(db, alice.workspaceId);
      if (from === 'validating') await setStatus(id, 'validating');
      if (from === 'cancelled') await setStatus(id, 'cancelled');

      const err = await expectRejected(() => setStatus(id, to));
      expect(err.message).toMatch(/not permitted/i);
    });

    it('the service role is not exempt', async () => {
      const id = await seedCampaign(db, alice.workspaceId);
      // service_role has BYPASSRLS and every grant. The trigger is not a policy,
      // so it still applies — which is what makes the machine a property of the
      // database rather than of the application.
      await db.asServiceRole(async (as) => {
        const err = await expectRejected(() =>
          as.raw(`update campaigns set status = 'sending' where id = $1`, [id]),
        );
        expect(err.message).toMatch(/not permitted/i);
      });
      expect(await statusOf(id)).toBe('draft');
    });

    it('a campaign cannot be created in any state but draft', async () => {
      const err = await expectRejected(() =>
        db.raw(
          `insert into campaigns (workspace_id, name, status) values ($1, 'Sneaky', 'sending')`,
          [alice.workspaceId],
        ),
      );
      expect(err.message).toMatch(/only be created in the draft state/i);
    });

    it('a campaign cannot be moved to another workspace', async () => {
      const bob = await db.createUser(`bob-${Math.random().toString(36).slice(2, 8)}@example.test`);
      const id = await seedCampaign(db, alice.workspaceId);

      const err = await expectRejected(() =>
        db.raw(`update campaigns set workspace_id = $2 where id = $1`, [id, bob.workspaceId]),
      );
      expect(err.message).toMatch(/between workspaces/i);
    });
  });

  // ── The scheduled state means something ───────────────────────────────────

  describe('a scheduled campaign is fully specified', () => {
    it('cannot be scheduled without a time, a snapshot and all three references', async () => {
      const id = await seedCampaign(db, alice.workspaceId);
      await setStatus(id, 'validating');

      const err = await expectRejected(() => setStatus(id, 'scheduled'));
      expect(err.message).toMatch(/ck_campaigns_scheduled_complete|check constraint/i);
      expect(await statusOf(id)).toBe('validating');
    });
  });

  // ── Editability ───────────────────────────────────────────────────────────

  describe('editability', () => {
    it('matches the RLS UPDATE policy', () => {
      expect(isEditable('draft')).toBe(true);
      expect(isEditable('validating')).toBe(true);
      for (const status of CAMPAIGN_STATUSES) {
        if (status !== 'draft' && status !== 'validating') expect(isEditable(status)).toBe(false);
      }
    });

    it('every status except draft is reachable, and draft is where every campaign starts', () => {
      const reachable = new Set(Object.values(TRANSITIONS).flat());
      for (const status of CAMPAIGN_STATUSES) {
        if (status !== 'draft') expect(reachable.has(status), status).toBe(true);
      }
    });
  });
});
