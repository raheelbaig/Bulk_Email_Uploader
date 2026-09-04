import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectRejected, PG_INSUFFICIENT_PRIVILEGE, type TestDb } from './helpers/db';
import { seedContact, seedList } from './helpers/p1';
import { seedCampaign, seedTemplate } from './helpers/p4';
import { seedSenderDomain, seedSenderIdentity, verifiedDomainState } from './helpers/sender';

/**
 * Tenant isolation and tamper-resistance for templates and campaigns, proven
 * against a real PostgreSQL instance running the real migration files under the
 * real `authenticated` role.
 *
 * The claims that matter most cannot be made by application code:
 *
 *   1. A campaign cannot reference another workspace's list, sender or template
 *      — the composite foreign keys refuse it, so it is impossible rather than
 *      merely checked.
 *   2. A browser session holds no privilege on `status`, `template_snapshot` or
 *      any counter, so a status rewrite is refused by column privilege before
 *      any policy is consulted.
 *   3. A frozen snapshot cannot be edited while the campaign holds it.
 */
describe('templates and campaigns: isolation and tampering', () => {
  let db: TestDb;
  let alice: { userId: string; workspaceId: string };
  let bob: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDb();
    alice = await db.createUser('alice@example.test');
    bob = await db.createUser('bob@example.test');
  });
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.raw('delete from campaigns');
    await db.raw('delete from templates');
    await db.raw('delete from list_members');
    await db.raw('delete from contact_lists');
    await db.raw('delete from contacts');
    await db.raw('delete from sender_identities');
    await db.raw('delete from sender_domains');
  });

  // ── Templates ─────────────────────────────────────────────────────────────

  describe('template isolation', () => {
    it('a user reads only their own templates', async () => {
      await seedTemplate(db, alice.workspaceId, { name: 'Alice template' });
      await seedTemplate(db, bob.workspaceId, { name: 'Bob template' });

      const seen = await db.asUser(alice.userId, (as) =>
        as.raw<{ name: string }>('select name from templates'),
      );
      expect(seen.rows.map((r) => r.name)).toEqual(['Alice template']);
    });

    it('a direct read by id returns nothing across tenants', async () => {
      const templateId = await seedTemplate(db, bob.workspaceId);
      const seen = await db.asUser(alice.userId, (as) =>
        as.raw('select id from templates where id = $1', [templateId]),
      );
      expect(seen.rows).toHaveLength(0);
    });

    it('a user cannot insert a template into another workspace', async () => {
      const err = await expectRejected(() =>
        db.asUser(alice.userId, (as) =>
          as.raw(
            `insert into templates (workspace_id, name, subject, html, text)
             values ($1, 'Forged', 'Hi', '<p>x</p>', 'x')`,
            [bob.workspaceId],
          ),
        ),
      );
      expect(err.message).toMatch(/row-level security|policy/i);
    });

    it('a user cannot update another workspace template', async () => {
      const templateId = await seedTemplate(db, bob.workspaceId, { subject: 'Original' });
      const result = await db.asUser(alice.userId, (as) =>
        as.raw(`update templates set subject = 'Hijacked' where id = $1`, [templateId]),
      );
      expect(result.affectedRows).toBe(0);

      const after = await db.raw<{ subject: string }>('select subject from templates where id = $1', [
        templateId,
      ]);
      expect(after.rows[0]?.subject).toBe('Original');
    });

    it('a user cannot delete another workspace template', async () => {
      const templateId = await seedTemplate(db, bob.workspaceId);
      const result = await db.asUser(alice.userId, (as) =>
        as.raw('delete from templates where id = $1', [templateId]),
      );
      expect(result.affectedRows).toBe(0);
    });

    it('anon sees nothing at all', async () => {
      await seedTemplate(db, alice.workspaceId);
      const err = await expectRejected(() =>
        db.asAnon((as) => as.raw('select id from templates')),
      );
      expect((err as { code?: string }).code ?? '').toBe(PG_INSUFFICIENT_PRIVILEGE);
    });
  });

  describe('template version cannot be rewritten by a client', () => {
    it('there is no UPDATE privilege on `version` for authenticated', async () => {
      const templateId = await seedTemplate(db, alice.workspaceId);
      const err = await expectRejected(() =>
        db.asUser(alice.userId, (as) =>
          as.raw('update templates set version = 99 where id = $1', [templateId]),
        ),
      );
      expect((err as { code?: string }).code ?? '').toBe(PG_INSUFFICIENT_PRIVILEGE);
    });

    it('a content edit increments it, and a rename does not', async () => {
      const templateId = await seedTemplate(db, alice.workspaceId, { name: 'V' });

      await db.asUser(alice.userId, (as) =>
        as.raw(`update templates set subject = 'New subject' where id = $1`, [templateId]),
      );
      let res = await db.raw<{ version: number }>('select version from templates where id = $1', [
        templateId,
      ]);
      expect(res.rows[0]?.version).toBe(2);

      await db.asUser(alice.userId, (as) =>
        as.raw(`update templates set name = 'Renamed' where id = $1`, [templateId]),
      );
      res = await db.raw<{ version: number }>('select version from templates where id = $1', [
        templateId,
      ]);
      expect(res.rows[0]?.version).toBe(2);
    });
  });

  // ── Campaign references ───────────────────────────────────────────────────

  describe('a campaign cannot reference another tenant', () => {
    it('refuses another workspace list', async () => {
      const campaignId = await seedCampaign(db, alice.workspaceId);
      const foreignList = await seedList(db, bob.workspaceId, 'Bob list');

      const err = await expectRejected(() =>
        db.raw('update campaigns set list_id = $2 where id = $1', [campaignId, foreignList]),
      );
      expect(err.message).toMatch(/foreign key constraint/i);
    });

    it('refuses another workspace template', async () => {
      const campaignId = await seedCampaign(db, alice.workspaceId);
      const foreignTemplate = await seedTemplate(db, bob.workspaceId);

      const err = await expectRejected(() =>
        db.raw('update campaigns set template_id = $2 where id = $1', [campaignId, foreignTemplate]),
      );
      expect(err.message).toMatch(/foreign key constraint/i);
    });

    it('refuses another workspace sender identity', async () => {
      const campaignId = await seedCampaign(db, alice.workspaceId);
      const domainId = await seedSenderDomain(db, bob.workspaceId, 'bob.test', verifiedDomainState());
      const foreignIdentity = await seedSenderIdentity(db, bob.workspaceId, domainId, 'x@bob.test');

      const err = await expectRejected(() =>
        db.raw('update campaigns set sender_identity_id = $2 where id = $1', [
          campaignId,
          foreignIdentity,
        ]),
      );
      expect(err.message).toMatch(/foreign key constraint/i);
    });

    it('the refusal holds for the service role too — it is a key, not a policy', async () => {
      const campaignId = await seedCampaign(db, alice.workspaceId);
      const foreignList = await seedList(db, bob.workspaceId, 'Bob list 2');

      await db.asServiceRole(async (as) => {
        const err = await expectRejected(() =>
          as.raw('update campaigns set list_id = $2 where id = $1', [campaignId, foreignList]),
        );
        expect(err.message).toMatch(/foreign key constraint/i);
      });
    });

    it('accepts its own workspace references', async () => {
      const campaignId = await seedCampaign(db, alice.workspaceId);
      const listId = await seedList(db, alice.workspaceId, 'Alice list');
      const templateId = await seedTemplate(db, alice.workspaceId);
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'alice.test', verifiedDomainState());
      const identityId = await seedSenderIdentity(db, alice.workspaceId, domainId, 'x@alice.test');

      await expect(
        db.raw(
          'update campaigns set list_id = $2, template_id = $3, sender_identity_id = $4 where id = $1',
          [campaignId, listId, templateId, identityId],
        ),
      ).resolves.toBeTruthy();
    });
  });

  // ── Campaign isolation ────────────────────────────────────────────────────

  describe('campaign isolation', () => {
    it('a user reads only their own campaigns', async () => {
      await seedCampaign(db, alice.workspaceId, { name: 'Alice campaign' });
      await seedCampaign(db, bob.workspaceId, { name: 'Bob campaign' });

      const seen = await db.asUser(alice.userId, (as) =>
        as.raw<{ name: string }>('select name from campaigns'),
      );
      expect(seen.rows.map((r) => r.name)).toEqual(['Alice campaign']);
    });

    it('a user cannot insert a campaign into another workspace', async () => {
      const err = await expectRejected(() =>
        db.asUser(alice.userId, (as) =>
          as.raw(`insert into campaigns (workspace_id, name) values ($1, 'Forged')`, [
            bob.workspaceId,
          ]),
        ),
      );
      expect(err.message).toMatch(/row-level security|policy/i);
    });

    it('a user cannot rename another workspace campaign', async () => {
      const campaignId = await seedCampaign(db, bob.workspaceId, { name: 'Original' });
      const result = await db.asUser(alice.userId, (as) =>
        as.raw(`update campaigns set name = 'Hijacked' where id = $1`, [campaignId]),
      );
      expect(result.affectedRows).toBe(0);
    });

    it('a user cannot delete another workspace campaign', async () => {
      const campaignId = await seedCampaign(db, bob.workspaceId);
      const result = await db.asUser(alice.userId, (as) =>
        as.raw('delete from campaigns where id = $1', [campaignId]),
      );
      expect(result.affectedRows).toBe(0);
    });

    it('anon sees nothing at all', async () => {
      await seedCampaign(db, alice.workspaceId);
      const err = await expectRejected(() =>
        db.asAnon((as) => as.raw('select id from campaigns')),
      );
      expect((err as { code?: string }).code ?? '').toBe(PG_INSUFFICIENT_PRIVILEGE);
    });
  });

  // ── Status tampering ──────────────────────────────────────────────────────

  describe('status tampering', () => {
    it.each(['validating', 'scheduled', 'queued', 'sending', 'completed'] as const)(
      'a browser session cannot write status = %s on its own campaign',
      async (status) => {
        const campaignId = await seedCampaign(db, alice.workspaceId);
        const err = await expectRejected(() =>
          db.asUser(alice.userId, (as) =>
            as.raw(`update campaigns set status = $2::campaign_status where id = $1`, [
              campaignId,
              status,
            ]),
          ),
        );
        // Refused by column privilege, before any policy is consulted.
        expect((err as { code?: string }).code ?? '').toBe(PG_INSUFFICIENT_PRIVILEGE);
      },
    );

    it.each([
      'launched_at',
      'completed_at',
      'launched_by',
      'pause_reason',
      'n_sent',
      'n_delivered',
      'n_total',
    ] as const)('a browser session cannot write %s', async (column) => {
      const campaignId = await seedCampaign(db, alice.workspaceId);
      const value =
        column === 'launched_by'
          ? `'00000000-0000-0000-0000-000000000000'::uuid`
          : column.startsWith('n_')
            ? '1'
            : column.endsWith('_at')
              ? 'now()'
              : `'x'`;

      const err = await expectRejected(() =>
        db.asUser(alice.userId, (as) =>
          as.raw(`update campaigns set ${column} = ${value} where id = $1`, [campaignId]),
        ),
      );
      expect((err as { code?: string }).code ?? '').toBe(PG_INSUFFICIENT_PRIVILEGE);
    });

    it('a browser session can still edit the fields it owns', async () => {
      const campaignId = await seedCampaign(db, alice.workspaceId);
      await expect(
        db.asUser(alice.userId, (as) =>
          as.raw(
            `update campaigns set name = 'Renamed', requires_unsubscribe = false where id = $1`,
            [campaignId],
          ),
        ),
      ).resolves.toBeTruthy();
    });

    it('a scheduled campaign cannot be edited by its own workspace member', async () => {
      const campaignId = await scheduledCampaign();
      const result = await db.asUser(alice.userId, (as) =>
        as.raw(`update campaigns set name = 'Sneaky edit' where id = $1`, [campaignId]),
      );
      // The RLS UPDATE policy carries the state predicate; no row matches.
      expect(result.affectedRows).toBe(0);
    });

    it('a scheduled campaign cannot be deleted', async () => {
      const campaignId = await scheduledCampaign();
      const result = await db.asUser(alice.userId, (as) =>
        as.raw('delete from campaigns where id = $1', [campaignId]),
      );
      expect(result.affectedRows).toBe(0);
    });

    it('a draft campaign can be deleted', async () => {
      const campaignId = await seedCampaign(db, alice.workspaceId);
      const result = await db.asUser(alice.userId, (as) =>
        as.raw('delete from campaigns where id = $1', [campaignId]),
      );
      expect(result.affectedRows).toBe(1);
    });
  });

  // ── Snapshot tampering ────────────────────────────────────────────────────

  describe('snapshot tampering', () => {
    it('a browser session holds no privilege on template_snapshot', async () => {
      const campaignId = await seedCampaign(db, alice.workspaceId);
      const err = await expectRejected(() =>
        db.asUser(alice.userId, (as) =>
          as.raw(`update campaigns set template_snapshot = '{"x":1}'::jsonb where id = $1`, [
            campaignId,
          ]),
        ),
      );
      expect((err as { code?: string }).code ?? '').toBe(PG_INSUFFICIENT_PRIVILEGE);
    });

    it('the snapshot of a scheduled campaign cannot be rewritten, even by the service role', async () => {
      const campaignId = await scheduledCampaign();

      await db.asServiceRole(async (as) => {
        const err = await expectRejected(() =>
          as.raw(`update campaigns set template_snapshot = '{"tampered":true}'::jsonb where id = $1`, [
            campaignId,
          ]),
        );
        expect(err.message).toMatch(/snapshot of a scheduled campaign cannot be changed/i);
      });

      const after = await db.raw<{ snapshot: { frozen?: boolean } }>(
        'select template_snapshot as snapshot from campaigns where id = $1',
        [campaignId],
      );
      expect(after.rows[0]?.snapshot?.frozen).toBe(true);
    });

    it('the snapshot may be cleared as part of returning the campaign to draft', async () => {
      const campaignId = await scheduledCampaign();
      await expect(
        db.raw(`update campaigns set status = 'draft', template_snapshot = null where id = $1`, [
          campaignId,
        ]),
      ).resolves.toBeTruthy();
    });

    it('editing the template does not change a campaign frozen from it', async () => {
      const templateId = await seedTemplate(db, alice.workspaceId, {
        name: 'Frozen source',
        subject: 'Original subject',
        html: '<p>original</p>',
      });
      const campaignId = await scheduledCampaign({ templateId });

      await db.asUser(alice.userId, (as) =>
        as.raw(`update templates set subject = 'Edited subject', html = '<p>edited</p>' where id = $1`, [
          templateId,
        ]),
      );

      const after = await db.raw<{ snapshot: { subject: string; html: string } }>(
        'select template_snapshot as snapshot from campaigns where id = $1',
        [campaignId],
      );
      expect(after.rows[0]?.snapshot.subject).toBe('Original subject');
      expect(after.rows[0]?.snapshot.html).toBe('<p>original</p>');
    });

    it('a template a campaign depends on cannot be deleted at all', async () => {
      const templateId = await seedTemplate(db, alice.workspaceId, { name: 'In use' });
      await scheduledCampaign({ templateId });

      const err = await expectRejected(() =>
        db.asUser(alice.userId, (as) => as.raw('delete from templates where id = $1', [templateId])),
      );
      expect(err.message).toMatch(/foreign key constraint/i);
    });
  });

  // ── Audience access ───────────────────────────────────────────────────────

  describe('the audience count function is workspace-scoped', () => {
    it('returns nothing for another workspace list, even with its real id', async () => {
      const bobList = await seedList(db, bob.workspaceId, 'Bob subscribers');
      const contactId = await seedContact(db, bob.workspaceId, 'someone@bob.test');
      await db.raw(
        'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
        [bob.workspaceId, bobList, contactId],
      );

      // SECURITY INVOKER: the caller's RLS applies, so a forged workspace id
      // buys nothing — the underlying rows are simply not visible.
      const seen = await db.asUser(alice.userId, (as) =>
        as.raw<{ total: string }>('select total from public.campaign_audience_counts($1, $2)', [
          bob.workspaceId,
          bobList,
        ]),
      );
      expect(Number(seen.rows[0]?.total ?? '0')).toBe(0);
    });
  });

  /** A complete, scheduled campaign — the state the freeze rules apply to. */
  async function scheduledCampaign(options: { templateId?: string } = {}): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 8);
    const campaignId = await seedCampaign(db, alice.workspaceId, { name: `Scheduled ${suffix}` });
    const listId = await seedList(db, alice.workspaceId, `List ${suffix}`);
    const templateId =
      options.templateId ?? (await seedTemplate(db, alice.workspaceId, { name: `T ${suffix}` }));
    const domainId = await seedSenderDomain(
      db,
      alice.workspaceId,
      `d${suffix}.test`,
      verifiedDomainState(),
    );
    const identityId = await seedSenderIdentity(db, alice.workspaceId, domainId, `x@d${suffix}.test`);

    const template = await db.raw<{ subject: string; html: string; version: number }>(
      'select subject, html, version from templates where id = $1',
      [templateId],
    );
    const row = template.rows[0];

    await db.raw(
      `update campaigns
          set list_id = $2, template_id = $3, sender_identity_id = $4,
              scheduled_at = now() + interval '2 days', status = 'validating'
        where id = $1`,
      [campaignId, listId, templateId, identityId],
    );
    await db.raw(
      `update campaigns set status = 'scheduled', template_snapshot = $2::jsonb where id = $1`,
      [
        campaignId,
        JSON.stringify({
          frozen: true,
          template_id: templateId,
          version: row?.version ?? 1,
          subject: row?.subject ?? '',
          html: row?.html ?? '',
        }),
      ],
    );

    return campaignId;
  }
});
