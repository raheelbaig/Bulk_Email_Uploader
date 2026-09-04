import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seedContact, seedList, seedSuppression } from './helpers/p1';
import { seedSenderDomain, seedSenderIdentity, testSenderRepository, verifiedDomainState } from './helpers/sender';
import { campaignStatus, testCampaignRepository, testTemplateRepository } from './helpers/p4';
import type { SenderReadiness } from '@/lib/sender/readiness';

/**
 * The template and campaign services, against a real migrated database.
 *
 * Authorization, rate limiting and audit writing are stubbed — each is proven in
 * its own suite — so what is under test here is the campaign logic itself: what
 * a save stores, what a preflight does to the campaign's state, what scheduling
 * freezes, and what a caller is told when the answer is no.
 *
 * The repositories are the PGlite-backed implementations of the same ports the
 * production ones implement, so every constraint in migration 0009 is live: the
 * transition trigger, the snapshot freeze, the composite foreign keys and the
 * scheduled-campaign completeness check all apply exactly as they would in
 * production.
 */

let currentAccess = { userId: '', workspaceId: '', role: 'owner' as 'owner' | 'admin' | 'member' };
const auditWrites: Array<{ action: string; metadata: Record<string, unknown> | undefined }> = [];
const rateLimited: string[] = [];

vi.mock('@/lib/auth/workspace', () => ({
  requireWorkspace: async (workspaceId: string) => {
    const { ForbiddenError } = await import('@/lib/errors');
    if (workspaceId !== currentAccess.workspaceId) throw new ForbiddenError();
    return currentAccess;
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: async (action: string) => {
    rateLimited.push(action);
  },
}));

vi.mock('@/lib/audit', () => ({
  writeAuditLog: async (entry: { action: string; metadata?: Record<string, unknown> }) => {
    auditWrites.push({ action: entry.action, metadata: entry.metadata });
  },
}));

/** Swapped per test so a sender can be made ready or not ready at will. */
let senderReadiness: SenderReadiness = {
  ready: true,
  blockers: [],
  warnings: [],
  domainReadiness: 'VERIFIED',
};

vi.mock('@/lib/sender/identities', () => ({
  getSenderReadiness: async () => senderReadiness,
}));

const repositories = {
  campaigns: new Map<string, ReturnType<typeof testCampaignRepository>>(),
  templates: new Map<string, ReturnType<typeof testTemplateRepository>>(),
  senders: new Map<string, ReturnType<typeof testSenderRepository>>(),
};

vi.mock('@/lib/campaigns/repository', () => ({
  campaignRepository: async (workspaceId: string) => {
    const repo = repositories.campaigns.get(workspaceId);
    if (repo === undefined) throw new Error(`no campaign repository for ${workspaceId}`);
    return repo;
  },
}));

vi.mock('@/lib/templates/repository', () => ({
  templateRepository: async (workspaceId: string) => {
    const repo = repositories.templates.get(workspaceId);
    if (repo === undefined) throw new Error(`no template repository for ${workspaceId}`);
    return repo;
  },
}));

vi.mock('@/lib/sender/repository', () => ({
  senderRepository: async (workspaceId: string) => {
    const repo = repositories.senders.get(workspaceId);
    if (repo === undefined) throw new Error(`no sender repository for ${workspaceId}`);
    return repo;
  },
}));

const {
  buildCampaignPreview,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listAudienceOptions,
  listCampaigns,
  previewCampaignPreflight,
  runCampaignPreflight,
  scheduleCampaign,
  unscheduleCampaign,
  updateCampaignDraft,
} = await import('@/lib/campaigns/service');

const { createTemplate, deleteTemplate, getTemplate, listTemplates, updateTemplate } = await import(
  '@/lib/templates/service'
);

const { parseTemplateSnapshot } = await import('@/lib/campaigns/snapshot');

describe('campaign and template services', () => {
  let db: TestDb;
  let alice: { userId: string; workspaceId: string };
  let bob: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDb();
    alice = await db.createUser('alice@example.test');
    bob = await db.createUser('bob@example.test');

    for (const workspace of [alice, bob]) {
      repositories.campaigns.set(workspace.workspaceId, testCampaignRepository(db, workspace.workspaceId));
      repositories.templates.set(workspace.workspaceId, testTemplateRepository(db, workspace.workspaceId));
      repositories.senders.set(workspace.workspaceId, testSenderRepository(db, workspace.workspaceId));
    }
  });
  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.raw('delete from campaigns');
    await db.raw('delete from templates');
    await db.raw('delete from list_members');
    await db.raw('delete from suppressions');
    await db.raw('delete from contact_lists');
    await db.raw('delete from contacts');
    await db.raw('delete from sender_identities');
    await db.raw('delete from sender_domains');

    currentAccess = { userId: alice.userId, workspaceId: alice.workspaceId, role: 'owner' };
    senderReadiness = { ready: true, blockers: [], warnings: [], domainReadiness: 'VERIFIED' };
    auditWrites.length = 0;
    rateLimited.length = 0;
  });

  const ws = () => alice.workspaceId;

  const templateInput = {
    name: 'Newsletter',
    subject: 'Hello {{first_name}}',
    previewText: 'This month at {{company}}',
    html: '<p>Hello {{first_name}}, welcome to {{company}}.</p>',
  };

  /** A campaign with an audience, a ready sender, a template and a valid time. */
  async function readyCampaign(overrides: { requiresUnsubscribe?: boolean } = {}) {
    const listId = await seedList(db, ws(), `List ${Math.random().toString(36).slice(2, 8)}`);
    await db.raw('insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)', [
      ws(),
      listId,
      await seedContact(db, ws(), `member-${Math.random().toString(36).slice(2, 8)}@example.com`, {
        firstName: 'Real',
        company: 'Real Co',
      }),
    ]);

    const domainId = await seedSenderDomain(db, ws(), `d${Math.random().toString(36).slice(2, 8)}.test`, verifiedDomainState());
    const identityId = await seedSenderIdentity(db, ws(), domainId, `hello@${(
      await db.raw<{ domain: string }>('select domain from sender_domains where id = $1', [domainId])
    ).rows[0]?.domain}`, { verifiedAt: new Date().toISOString() });

    const template = await createTemplate(ws(), {
      ...templateInput,
      name: `T ${Math.random().toString(36).slice(2, 8)}`,
    });
    const campaign = await createCampaign(ws(), {
      name: 'March newsletter',
      ...(overrides.requiresUnsubscribe === undefined
        ? {}
        : { requiresUnsubscribe: String(overrides.requiresUnsubscribe) }),
    });

    const when = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const local = `${when.toISOString().slice(0, 16)}`;

    await updateCampaignDraft(ws(), campaign.id, {
      listId,
      senderIdentityId: identityId,
      templateId: template.record.id,
      scheduledAtLocal: local,
    });

    return { campaignId: campaign.id, listId, identityId, templateId: template.record.id };
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  describe('templates', () => {
    it('creates one, storing sanitised HTML and the extracted variables', async () => {
      const result = await createTemplate(ws(), {
        ...templateInput,
        html: `${templateInput.html}<script>alert(1)</script>`,
      });

      expect(result.record.html).not.toContain('<script');
      expect(result.record.variables).toEqual(['first_name', 'company']);
      expect(result.record.version).toBe(1);
      expect(result.sanitized).toBe(true);
      expect(result.textGenerated).toBe(true);
      expect(rateLimited).toContain('template.write');
    });

    it('audits the creation without recording the body', async () => {
      await createTemplate(ws(), templateInput);
      const entry = auditWrites.find((write) => write.action === 'template.created');

      expect(entry).toBeDefined();
      expect(entry?.metadata?.['name']).toBe('Newsletter');
      expect(JSON.stringify(entry?.metadata)).not.toContain('<p>');
      expect(entry?.metadata?.['htmlLength']).toBeGreaterThan(0);
    });

    it('updates one and lets the database bump the version', async () => {
      const created = await createTemplate(ws(), templateInput);
      const updated = await updateTemplate(ws(), created.record.id, {
        ...templateInput,
        subject: 'A new subject',
      });

      expect(updated.record.version).toBe(2);
      expect(auditWrites.some((write) => write.action === 'template.updated')).toBe(true);
    });

    it('refuses a duplicate name', async () => {
      await createTemplate(ws(), templateInput);
      await expect(createTemplate(ws(), templateInput)).rejects.toThrow(/already exists/i);
    });

    it('deletes one that nothing uses', async () => {
      const created = await createTemplate(ws(), templateInput);
      await deleteTemplate(ws(), created.record.id);

      expect(auditWrites.some((write) => write.action === 'template.deleted')).toBe(true);
      await expect(getTemplate(ws(), created.record.id)).rejects.toThrow();
    });

    it('refuses to delete one a campaign depends on', async () => {
      const { templateId } = await readyCampaign();
      await expect(deleteTemplate(ws(), templateId)).rejects.toThrow(/still use/i);
    });

    it('answers identically for another workspace template and one that does not exist', async () => {
      const created = await createTemplate(ws(), templateInput);
      currentAccess = { userId: bob.userId, workspaceId: bob.workspaceId, role: 'owner' };

      const foreign = await getTemplate(bob.workspaceId, created.record.id).catch((err: Error) => err);
      const missing = await getTemplate(bob.workspaceId, '00000000-0000-0000-0000-000000000000').catch(
        (err: Error) => err,
      );
      expect((foreign as Error).message).toBe((missing as Error).message);
    });

    it('refuses a workspace the caller is not in', async () => {
      await expect(listTemplates(bob.workspaceId)).rejects.toThrow(/do not have access/i);
    });
  });

  // ── Campaign creation and editing ─────────────────────────────────────────

  describe('campaign creation and editing', () => {
    it('creates a draft that requires unsubscribe by default', async () => {
      const campaign = await createCampaign(ws(), { name: 'March newsletter' });

      expect(campaign.status).toBe('draft');
      expect(campaign.requires_unsubscribe).toBe(true);
      expect(campaign.template_snapshot).toBeNull();
      expect(auditWrites.some((write) => write.action === 'campaign.created')).toBe(true);
    });

    it('records an explicit opt-out of unsubscribe', async () => {
      const campaign = await createCampaign(ws(), { name: 'Receipt', requiresUnsubscribe: 'false' });
      expect(campaign.requires_unsubscribe).toBe(false);
    });

    it('refuses an empty name', async () => {
      await expect(createCampaign(ws(), { name: '  ' })).rejects.toThrow(/name/i);
    });

    it('applies only the fields the caller sent', async () => {
      const { campaignId, listId } = await readyCampaign();

      // A sender-step submission must not clear the audience.
      const before = await getCampaign(ws(), campaignId);
      await updateCampaignDraft(ws(), campaignId, { name: 'Renamed only' });
      const after = await getCampaign(ws(), campaignId);

      expect(after.campaign.name).toBe('Renamed only');
      expect(after.campaign.list_id).toBe(listId);
      expect(after.campaign.template_id).toBe(before.campaign.template_id);
      expect(after.campaign.sender_identity_id).toBe(before.campaign.sender_identity_id);
    });

    it('clears a reference when given an empty value', async () => {
      const { campaignId } = await readyCampaign();
      const updated = await updateCampaignDraft(ws(), campaignId, { listId: '' });
      expect(updated.list_id).toBeNull();
    });

    it('refuses a malformed reference before it reaches the database', async () => {
      const campaign = await createCampaign(ws(), { name: 'X' });
      await expect(
        updateCampaignDraft(ws(), campaign.id, { listId: 'not-a-uuid' }),
      ).rejects.toThrow(/not a valid list/i);
    });

    it("refuses another workspace's list", async () => {
      const campaign = await createCampaign(ws(), { name: 'X' });
      const foreignList = await seedList(db, bob.workspaceId, 'Bob list');

      await expect(
        updateCampaignDraft(ws(), campaign.id, { listId: foreignList }),
      ).rejects.toThrow(/not available in this workspace/i);
    });

    it('converts a wall-clock time using the workspace timezone', async () => {
      await db.raw(`update workspace_settings set display_timezone = 'America/New_York' where workspace_id = $1`, [
        ws(),
      ]);

      const campaign = await createCampaign(ws(), { name: 'Timed' });
      const when = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      const dateOnly = when.toISOString().slice(0, 10);

      const updated = await updateCampaignDraft(ws(), campaign.id, {
        scheduledAtLocal: `${dateOnly}T09:00`,
      });

      // 09:00 in New York is 13:00 or 14:00 UTC, never 09:00 UTC.
      const stored = new Date(updated.scheduled_at ?? '');
      expect([13, 14]).toContain(stored.getUTCHours());

      await db.raw(`update workspace_settings set display_timezone = 'UTC' where workspace_id = $1`, [ws()]);
    });

    it('refuses a schedule in the past', async () => {
      const campaign = await createCampaign(ws(), { name: 'Late' });
      await expect(
        updateCampaignDraft(ws(), campaign.id, { scheduledAtLocal: '2020-01-01T09:00' }),
      ).rejects.toThrow(/already passed/i);
    });

    it('lists the audiences a campaign may target', async () => {
      await seedList(db, ws(), 'Alpha');
      await seedList(db, ws(), 'Beta');
      const options = await listAudienceOptions(ws());
      expect(options.map((option) => option.name)).toEqual(['Alpha', 'Beta']);
    });

    it('lists campaigns for the workspace only', async () => {
      await createCampaign(ws(), { name: 'Mine' });
      const page = await listCampaigns(ws());
      expect(page.items.map((campaign) => campaign.name)).toEqual(['Mine']);
    });
  });

  // ── Preflight ─────────────────────────────────────────────────────────────

  describe('preflight', () => {
    it('leaves a passing campaign in validating', async () => {
      const { campaignId } = await readyCampaign();
      const { result } = await runCampaignPreflight(ws(), campaignId);

      expect(result.ready).toBe(true);
      expect(await campaignStatus(db, campaignId)).toBe('validating');
      expect(auditWrites.some((write) => write.action === 'campaign.preflight_passed')).toBe(true);
    });

    it('returns a failing campaign to draft', async () => {
      const campaign = await createCampaign(ws(), { name: 'Incomplete' });
      const { result } = await runCampaignPreflight(ws(), campaign.id);

      expect(result.ready).toBe(false);
      expect(await campaignStatus(db, campaign.id)).toBe('draft');

      const entry = auditWrites.find((write) => write.action === 'campaign.preflight_failed');
      expect(entry?.metadata?.['blockers']).toContain('audience_missing');
    });

    it('audits codes and counts, never the message text', async () => {
      const { campaignId } = await readyCampaign();
      await runCampaignPreflight(ws(), campaignId);

      const entry = auditWrites.find((write) => write.action === 'campaign.preflight_passed');
      expect(JSON.stringify(entry?.metadata)).not.toMatch(/eligible of|Subscribers/);
    });

    it('blocks when the audience has no eligible recipients', async () => {
      const { campaignId, listId } = await readyCampaign();
      const members = await db.raw<{ email_normalized: string }>(
        `select c.email_normalized from list_members lm
           join contacts c on c.workspace_id = lm.workspace_id and c.id = lm.contact_id
          where lm.list_id = $1`,
        [listId],
      );
      for (const member of members.rows) await seedSuppression(db, ws(), member.email_normalized);

      const { result } = await runCampaignPreflight(ws(), campaignId);
      expect(result.blockers.map((issue) => issue.code)).toContain('audience_no_eligible');
    });

    it('blocks when the sender readiness authority says no', async () => {
      const { campaignId } = await readyCampaign();
      senderReadiness = {
        ready: false,
        blockers: ['dkim_not_verified'],
        warnings: [],
        domainReadiness: 'PENDING',
      };

      const { result } = await runCampaignPreflight(ws(), campaignId);
      expect(result.blockers.map((issue) => issue.code)).toContain('sender_dkim_not_verified');
    });

    it('does not write anything when it is only previewing the verdict', async () => {
      const { campaignId } = await readyCampaign();
      const { result } = await previewCampaignPreflight(ws(), campaignId);

      expect(result.ready).toBe(true);
      expect(await campaignStatus(db, campaignId)).toBe('draft');
      expect(auditWrites.some((write) => write.action.startsWith('campaign.preflight'))).toBe(false);
    });

    it('refuses to re-check a scheduled campaign', async () => {
      const { campaignId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);
      await expect(runCampaignPreflight(ws(), campaignId)).rejects.toThrow(/Unschedule/i);
    });
  });

  // ── Scheduling and the snapshot ───────────────────────────────────────────

  describe('scheduling', () => {
    it('freezes the template and records the time', async () => {
      const { campaignId, templateId } = await readyCampaign();
      const { campaign } = await scheduleCampaign(ws(), campaignId);

      expect(campaign.status).toBe('scheduled');
      expect(campaign.scheduled_at).not.toBeNull();

      const snapshot = parseTemplateSnapshot(campaign.template_snapshot);
      expect(snapshot?.template_id).toBe(templateId);
      expect(snapshot?.subject).toBe('Hello {{first_name}}');
      expect(snapshot?.version).toBe(1);
      expect(auditWrites.some((write) => write.action === 'campaign.scheduled')).toBe(true);
    });

    it('refuses to schedule a campaign that is not ready', async () => {
      const campaign = await createCampaign(ws(), { name: 'Not ready' });
      await expect(scheduleCampaign(ws(), campaign.id)).rejects.toThrow(/not ready to be scheduled/i);
      expect(await campaignStatus(db, campaign.id)).toBe('draft');
    });

    it('a later template edit does not change the frozen copy', async () => {
      const { campaignId, templateId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);

      await updateTemplate(ws(), templateId, {
        ...templateInput,
        name: (await getTemplate(ws(), templateId)).name,
        subject: 'Completely different subject',
        html: '<p>Completely different body</p>',
      });

      const view = await getCampaign(ws(), campaignId);
      expect(view.snapshot?.subject).toBe('Hello {{first_name}}');
      expect(view.snapshot?.html).toContain('welcome to {{company}}');
      expect(view.template?.subject).toBe('Completely different subject');
    });

    it('the snapshot is stable across repeated reads', async () => {
      const { campaignId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);

      const first = await getCampaign(ws(), campaignId);
      const second = await getCampaign(ws(), campaignId);
      expect(second.snapshot).toEqual(first.snapshot);
    });

    it('a scheduled campaign cannot be edited', async () => {
      const { campaignId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);

      await expect(updateCampaignDraft(ws(), campaignId, { name: 'Nope' })).rejects.toThrow(
        /Unschedule it/i,
      );
    });

    it('unscheduling returns it to draft and clears the frozen copy', async () => {
      const { campaignId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);

      const updated = await unscheduleCampaign(ws(), campaignId);
      expect(updated.status).toBe('draft');
      expect(updated.template_snapshot).toBeNull();
      expect(auditWrites.some((write) => write.action === 'campaign.unscheduled')).toBe(true);
    });

    it('refuses to unschedule something that is not scheduled', async () => {
      const campaign = await createCampaign(ws(), { name: 'Draft' });
      await expect(unscheduleCampaign(ws(), campaign.id)).rejects.toThrow(/not scheduled/i);
    });

    it('scheduling twice is refused rather than producing two schedules', async () => {
      const { campaignId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);
      await expect(scheduleCampaign(ws(), campaignId)).rejects.toThrow(/Unschedule/i);
    });

    it('a scheduled campaign whose time has arrived simply stays scheduled', async () => {
      const { campaignId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);

      // Move the schedule into the past directly. Nothing observes it: there is
      // no promotion sweep, no worker, and no transition out of `scheduled`
      // toward delivery for any role.
      await db.raw(`update campaigns set scheduled_at = now() - interval '1 hour' where id = $1`, [
        campaignId,
      ]);

      expect(await campaignStatus(db, campaignId)).toBe('scheduled');
      const view = await getCampaign(ws(), campaignId);
      expect(view.campaign.launched_at).toBeNull();
      expect(view.campaign.n_sent).toBe(0);
      expect(view.campaign.n_total).toBe(0);
    });
  });

  // ── Cancel and delete ─────────────────────────────────────────────────────

  describe('cancel and delete', () => {
    it('cancels a draft', async () => {
      const campaign = await createCampaign(ws(), { name: 'Abandoned' });
      const cancelled = await cancelCampaign(ws(), campaign.id);

      expect(cancelled.status).toBe('cancelled');
      expect(auditWrites.some((write) => write.action === 'campaign.cancelled')).toBe(true);
    });

    it('cancels a scheduled campaign', async () => {
      const { campaignId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);
      expect((await cancelCampaign(ws(), campaignId)).status).toBe('cancelled');
    });

    it('deletes a draft', async () => {
      const campaign = await createCampaign(ws(), { name: 'Gone' });
      await deleteCampaign(ws(), campaign.id);

      expect(auditWrites.some((write) => write.action === 'campaign.deleted')).toBe(true);
      await expect(getCampaign(ws(), campaign.id)).rejects.toThrow();
    });

    it('refuses to delete a scheduled campaign', async () => {
      const { campaignId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);
      await expect(deleteCampaign(ws(), campaignId)).rejects.toThrow(/draft or cancelled/i);
    });
  });

  // ── Preview ───────────────────────────────────────────────────────────────

  describe('preview', () => {
    it('renders the live template while the campaign is a draft', async () => {
      const { campaignId } = await readyCampaign();
      const preview = await buildCampaignPreview(ws(), campaignId);

      expect(preview?.fromSnapshot).toBe(false);
      expect(preview?.preview.subject).toBe('Hello Sample');
      expect(preview?.preview.fromEmail).toContain('hello@');
    });

    it('renders the frozen copy once the campaign is scheduled', async () => {
      const { campaignId, templateId } = await readyCampaign();
      await scheduleCampaign(ws(), campaignId);

      await updateTemplate(ws(), templateId, {
        ...templateInput,
        name: (await getTemplate(ws(), templateId)).name,
        subject: 'Edited after freezing',
      });

      const preview = await buildCampaignPreview(ws(), campaignId);
      expect(preview?.fromSnapshot).toBe(true);
      expect(preview?.preview.subject).toBe('Hello Sample');
    });

    it('offers a bounded sample of the audience, never the whole list', async () => {
      const { campaignId, listId } = await readyCampaign();
      for (let i = 0; i < 40; i += 1) {
        await db.raw(
          'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
          [ws(), listId, await seedContact(db, ws(), `bulk-${i}@example.com`)],
        );
      }

      const preview = await buildCampaignPreview(ws(), campaignId);
      expect(preview?.contacts.length).toBeLessThanOrEqual(25);
    });

    it('renders for a chosen contact', async () => {
      const { campaignId } = await readyCampaign();
      const listed = await buildCampaignPreview(ws(), campaignId);
      const contactId = listed?.contacts[0]?.id;

      const preview = await buildCampaignPreview(ws(), campaignId, { contactId });
      expect(preview?.preview.usedSampleContact).toBe(false);
      expect(preview?.preview.subject).toBe('Hello Real');
    });

    it('falls back to the sample contact for an id that is not in the audience', async () => {
      const { campaignId } = await readyCampaign();
      const preview = await buildCampaignPreview(ws(), campaignId, {
        contactId: '00000000-0000-0000-0000-000000000000',
      });
      expect(preview?.preview.usedSampleContact).toBe(true);
    });

    it('returns nothing when there is no content to preview', async () => {
      const campaign = await createCampaign(ws(), { name: 'Empty' });
      expect(await buildCampaignPreview(ws(), campaign.id)).toBeNull();
    });
  });

  // ── Cross-workspace ───────────────────────────────────────────────────────

  describe('cross-workspace access', () => {
    it('refuses every entry point for a workspace the caller is not in', async () => {
      const campaign = await createCampaign(ws(), { name: 'Alice campaign' });
      currentAccess = { userId: bob.userId, workspaceId: bob.workspaceId, role: 'owner' };

      await expect(getCampaign(alice.workspaceId, campaign.id)).rejects.toThrow(/do not have access/i);
      await expect(listCampaigns(alice.workspaceId)).rejects.toThrow(/do not have access/i);
      await expect(scheduleCampaign(alice.workspaceId, campaign.id)).rejects.toThrow(
        /do not have access/i,
      );
      await expect(deleteCampaign(alice.workspaceId, campaign.id)).rejects.toThrow(
        /do not have access/i,
      );
    });

    it("cannot reach another workspace's campaign through its own workspace id", async () => {
      const campaign = await createCampaign(ws(), { name: 'Alice campaign' });
      currentAccess = { userId: bob.userId, workspaceId: bob.workspaceId, role: 'owner' };

      // Bob's own workspace, Alice's campaign id: the repository is bound to
      // Bob's workspace and cannot see the row.
      await expect(getCampaign(bob.workspaceId, campaign.id)).rejects.toThrow(/do not have access/i);
    });
  });
});
