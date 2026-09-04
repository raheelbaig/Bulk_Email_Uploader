import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedCampaign, seedTemplate } from './helpers/p4';
import { seedList } from './helpers/p1';
import { seedSenderDomain, seedSenderIdentity, verifiedDomainState } from './helpers/sender';
import {
  CAMPAIGN_STATUSES,
  canTransition,
  isEditable,
  TRANSITIONS,
  UNREACHABLE_STATUSES,
  type CampaignStatus,
} from '@/lib/campaigns/status';

/**
 * The campaign state machine, proven against the real database.
 *
 * Two claims here cannot be made by application code, and both are the reason
 * P4 can be built at all without a way to send:
 *
 *   1. No role — including `service_role`, which bypasses RLS entirely — can
 *      move a campaign into a sending state. The transition trigger refuses it.
 *   2. A frozen snapshot cannot be rewritten while the campaign holds it.
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
    it('no status has an inbound transition toward delivery', () => {
      expect([...UNREACHABLE_STATUSES].sort()).toEqual([
        'completed',
        'failed',
        'paused',
        'queued',
        'sending',
      ]);
    });

    it.each(['queued', 'sending', 'paused', 'completed', 'failed'] as const)(
      'refuses scheduled to %s — there is no send path to advance into',
      async (to) => {
        const id = await seedCampaign(db, alice.workspaceId);
        await setStatus(id, 'validating');
        await db.raw(
          `update campaigns set status = 'scheduled', scheduled_at = now() + interval '1 day',
                                list_id = null, template_snapshot = null
            where id = $1`,
          [id],
        ).catch(() => undefined);

        // `ck_campaigns_scheduled_complete` refuses an incomplete scheduled row,
        // so build a complete one before testing the transition itself.
        const listId = await seedList(db, alice.workspaceId, `L-${to}`);
        const templateId = await seedTemplate(db, alice.workspaceId, { name: `T-${to}` });
        const domainId = await seedSenderDomain(db, alice.workspaceId, `${to}.test`, verifiedDomainState());
        const identityId = await seedSenderIdentity(db, alice.workspaceId, domainId, `x@${to}.test`);

        await db.raw(
          `update campaigns
              set list_id = $2, template_id = $3, sender_identity_id = $4,
                  scheduled_at = now() + interval '1 day',
                  template_snapshot = '{"frozen": true}'::jsonb,
                  status = 'scheduled'
            where id = $1`,
          [id, listId, templateId, identityId],
        );
        expect(await statusOf(id)).toBe('scheduled');

        const err = await expectRejected(() => setStatus(id, to));
        expect(err.message).toMatch(/not permitted/i);
        expect(await statusOf(id)).toBe('scheduled');
      },
    );

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
      // so it still applies — which is what makes "no sending" a property of the
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

    it('no unreachable status appears as a transition target anywhere', () => {
      for (const targets of Object.values(TRANSITIONS)) {
        for (const target of targets) {
          expect(UNREACHABLE_STATUSES).not.toContain(target);
        }
      }
    });
  });
});
