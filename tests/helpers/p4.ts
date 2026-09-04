import type { TestDb } from './db';
import type { TemplateRecord, TemplateRepository, TemplateWrite } from '@/lib/templates/ports';
import type {
  AudienceMember,
  CampaignDraftPatch,
  CampaignRecord,
  CampaignRepository,
  ListSummary,
  TransitionPatch,
} from '@/lib/campaigns/ports';
import type { CampaignStatus } from '@/lib/campaigns/status';
import type { AudienceCounts } from '@/lib/eligibility';
import { buildPage, clampLimit } from '@/lib/pagination';
import { ConflictError } from '@/lib/errors';

/**
 * P4 test doubles.
 *
 * Both repositories are backed by the *real* migrated database, so every
 * constraint migration 0009 carries — the composite foreign keys, the transition
 * trigger, the snapshot freeze, the scheduled-campaign completeness check — is
 * live in the service tests rather than mocked away. Only authorization, rate
 * limiting and audit writing are stubbed by the suites that use these, because
 * each of those is proven in its own suite.
 */

const TEMPLATE_COLUMNS =
  'id, workspace_id, name, subject, preview_text, html, text, variables, version, created_at, updated_at';

const CAMPAIGN_COLUMNS =
  'id, workspace_id, name, status::text as status, template_id, sender_identity_id, list_id, ' +
  'template_snapshot, scheduled_at, launched_at, completed_at, requires_unsubscribe, ' +
  'max_rate_override, pause_reason, launched_by, n_total, n_sent, n_delivered, n_bounced, ' +
  'n_complained, n_failed, n_unsubscribed, n_suppressed, created_at, updated_at';

function isUnique(err: unknown): boolean {
  return /duplicate key|unique constraint/i.test((err as Error).message);
}

function isForeignKey(err: unknown): boolean {
  return /foreign key constraint/i.test((err as Error).message);
}

/** Timestamps come back as Date objects from PGlite; the ports speak ISO strings. */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toTemplate(row: Record<string, unknown>): TemplateRecord {
  return {
    ...(row as unknown as TemplateRecord),
    variables: (row['variables'] as string[] | null) ?? [],
    created_at: iso(row['created_at']) ?? '',
    updated_at: iso(row['updated_at']),
  };
}

function toCampaign(row: Record<string, unknown>): CampaignRecord {
  return {
    ...(row as unknown as CampaignRecord),
    created_at: iso(row['created_at']) ?? '',
    updated_at: iso(row['updated_at']),
    scheduled_at: iso(row['scheduled_at']),
    launched_at: iso(row['launched_at']),
    completed_at: iso(row['completed_at']),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

export function testTemplateRepository(db: TestDb, workspaceId: string): TemplateRepository {
  const one = async (sql: string, params: unknown[]): Promise<TemplateRecord | null> => {
    const res = await db.raw<Record<string, unknown>>(sql, params);
    const row = res.rows[0];
    return row === undefined ? null : toTemplate(row);
  };

  const write = async (sql: string, params: unknown[]): Promise<TemplateRecord | null> => {
    try {
      return await one(sql, params);
    } catch (err) {
      // The same translation the production repository performs, so the service
      // sees identical errors from either implementation.
      if (isUnique(err)) throw new ConflictError('A template with that name already exists.', err);
      if (/check constraint/i.test((err as Error).message)) {
        throw new ConflictError('That template is too large or contains something we cannot store.', err);
      }
      throw err;
    }
  };

  return {
    workspaceId,

    async list(options = {}) {
      const limit = clampLimit(options.limit);
      const res = await db.raw<Record<string, unknown>>(
        `select ${TEMPLATE_COLUMNS} from templates where workspace_id = $1
          order by created_at desc, id desc limit $2`,
        [workspaceId, limit + 1],
      );
      return buildPage(res.rows.map(toTemplate), limit, 'forward', false);
    },

    async listAll(limit = 200) {
      const res = await db.raw<Record<string, unknown>>(
        `select ${TEMPLATE_COLUMNS} from templates where workspace_id = $1 order by name limit $2`,
        [workspaceId, limit],
      );
      return res.rows.map(toTemplate);
    },

    get: (templateId) =>
      one(`select ${TEMPLATE_COLUMNS} from templates where workspace_id = $1 and id = $2`, [
        workspaceId,
        templateId,
      ]),

    async insert(input: TemplateWrite) {
      const record = await write(
        `insert into templates (workspace_id, name, subject, preview_text, html, text, variables)
         values ($1, $2, $3, $4, $5, $6, $7::text[])
         returning ${TEMPLATE_COLUMNS}`,
        [workspaceId, input.name, input.subject, input.previewText, input.html, input.text, input.variables],
      );
      if (record === null) throw new Error('template insert returned no row');
      return record;
    },

    update: (templateId, input: TemplateWrite) =>
      write(
        `update templates
            set name = $3, subject = $4, preview_text = $5, html = $6, text = $7, variables = $8::text[]
          where workspace_id = $1 and id = $2
          returning ${TEMPLATE_COLUMNS}`,
        [
          workspaceId,
          templateId,
          input.name,
          input.subject,
          input.previewText,
          input.html,
          input.text,
          input.variables,
        ],
      ),

    async remove(templateId) {
      try {
        const res = await db.raw(
          `delete from templates where workspace_id = $1 and id = $2 returning id`,
          [workspaceId, templateId],
        );
        return res.rows.length > 0 ? 'deleted' : 'missing';
      } catch (err) {
        if (isForeignKey(err)) return 'in_use';
        throw err;
      }
    },

    async countCampaignsUsing(templateId) {
      const res = await db.raw<{ count: string }>(
        `select count(*)::text as count from campaigns where workspace_id = $1 and template_id = $2`,
        [workspaceId, templateId],
      );
      return Number(res.rows[0]?.count ?? '0');
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaigns
// ─────────────────────────────────────────────────────────────────────────────

export function testCampaignRepository(
  db: TestDb,
  workspaceId: string,
  options: { timeZone?: string } = {},
): CampaignRepository {
  const one = async (sql: string, params: unknown[]): Promise<CampaignRecord | null> => {
    const res = await db.raw<Record<string, unknown>>(sql, params);
    const row = res.rows[0];
    return row === undefined ? null : toCampaign(row);
  };

  return {
    workspaceId,

    async timeZone() {
      if (options.timeZone !== undefined) return options.timeZone;
      const res = await db.raw<{ display_timezone: string }>(
        `select display_timezone from workspace_settings where workspace_id = $1`,
        [workspaceId],
      );
      return res.rows[0]?.display_timezone ?? 'UTC';
    },

    async getList(listId) {
      const res = await db.raw<ListSummary>(
        `select id, name, contact_count from contact_lists where workspace_id = $1 and id = $2`,
        [workspaceId, listId],
      );
      return res.rows[0] ?? null;
    },

    async listLists(limit = 200) {
      const res = await db.raw<ListSummary>(
        `select id, name, contact_count from contact_lists where workspace_id = $1
          order by name limit $2`,
        [workspaceId, limit],
      );
      return res.rows;
    },

    async list(listOptions = {}) {
      const limit = clampLimit(listOptions.limit);
      const res = await db.raw<Record<string, unknown>>(
        `select ${CAMPAIGN_COLUMNS} from campaigns
          where workspace_id = $1 and ($2::text is null or status::text = $2)
          order by created_at desc, id desc limit $3`,
        [workspaceId, listOptions.status ?? null, limit + 1],
      );
      return buildPage(res.rows.map(toCampaign), limit, 'forward', false);
    },

    get: (campaignId) =>
      one(`select ${CAMPAIGN_COLUMNS} from campaigns where workspace_id = $1 and id = $2`, [
        workspaceId,
        campaignId,
      ]),

    async insert(input) {
      const record = await one(
        `insert into campaigns (workspace_id, name, requires_unsubscribe)
         values ($1, $2, $3) returning ${CAMPAIGN_COLUMNS}`,
        [workspaceId, input.name, input.requiresUnsubscribe],
      );
      if (record === null) throw new Error('campaign insert returned no row');
      return record;
    },

    async updateDraft(campaignId, patch: CampaignDraftPatch) {
      const sets: string[] = [];
      const params: unknown[] = [workspaceId, campaignId];
      const push = (column: string, value: unknown, cast = ''): void => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      };

      if (patch.name !== undefined) push('name', patch.name);
      if (patch.templateId !== undefined) push('template_id', patch.templateId, '::uuid');
      if (patch.senderIdentityId !== undefined) push('sender_identity_id', patch.senderIdentityId, '::uuid');
      if (patch.listId !== undefined) push('list_id', patch.listId, '::uuid');
      if (patch.scheduledAt !== undefined) push('scheduled_at', patch.scheduledAt, '::timestamptz');
      if (patch.requiresUnsubscribe !== undefined) push('requires_unsubscribe', patch.requiresUnsubscribe);

      if (sets.length === 0) {
        return one(`select ${CAMPAIGN_COLUMNS} from campaigns where workspace_id = $1 and id = $2`, [
          workspaceId,
          campaignId,
        ]);
      }

      try {
        return await one(
          `update campaigns set ${sets.join(', ')}
            where workspace_id = $1 and id = $2 and status in ('draft', 'validating')
            returning ${CAMPAIGN_COLUMNS}`,
          params,
        );
      } catch (err) {
        if (isForeignKey(err)) {
          throw new ConflictError('That list, sender or template is not available in this workspace.', err);
        }
        throw err;
      }
    },

    async transition(
      campaignId: string,
      from: readonly CampaignStatus[],
      to: CampaignStatus,
      patch: TransitionPatch = {},
    ) {
      const sets = ['status = $3::campaign_status'];
      const params: unknown[] = [workspaceId, campaignId, to, [...from]];

      if (patch.templateSnapshot !== undefined) {
        params.push(patch.templateSnapshot === null ? null : JSON.stringify(patch.templateSnapshot));
        sets.push(`template_snapshot = $${params.length}::jsonb`);
      }
      if (patch.scheduledAt !== undefined) {
        params.push(patch.scheduledAt);
        sets.push(`scheduled_at = $${params.length}::timestamptz`);
      }

      try {
        return await one(
          `update campaigns set ${sets.join(', ')}
            where workspace_id = $1 and id = $2 and status::text = any($4::text[])
            returning ${CAMPAIGN_COLUMNS}`,
          params,
        );
      } catch (err) {
        if (/check constraint|not permitted|cannot be changed/i.test((err as Error).message)) {
          throw new ConflictError('That change is not allowed for this campaign right now.', err);
        }
        throw err;
      }
    },

    async remove(campaignId) {
      const res = await db.raw(
        `delete from campaigns
          where workspace_id = $1 and id = $2 and status in ('draft', 'cancelled')
          returning id`,
        [workspaceId, campaignId],
      );
      return res.rows.length > 0;
    },

    async audienceCounts(listId): Promise<AudienceCounts> {
      const res = await db.raw<{
        total: string;
        eligible: string;
        suppressed: string;
        inactive: string;
        capped: boolean;
      }>(`select * from public.campaign_audience_counts($1, $2)`, [workspaceId, listId]);

      const row = res.rows[0];
      if (row === undefined) {
        return { total: 0, eligible: 0, suppressed: 0, inactive: 0, capped: false };
      }
      return {
        total: Number(row.total),
        eligible: Number(row.eligible),
        suppressed: Number(row.suppressed),
        inactive: Number(row.inactive),
        capped: row.capped === true,
      };
    },

    async audienceSample(listId, limit): Promise<AudienceMember[]> {
      const res = await db.raw<AudienceMember>(
        `select c.id, c.email_normalized, c.first_name, c.last_name, c.company, c.website,
                c.phone, c.custom, c.status
           from list_members lm
           join contacts c on c.workspace_id = lm.workspace_id and c.id = lm.contact_id
          where lm.workspace_id = $1 and lm.list_id = $2
          order by c.created_at
          limit $3`,
        [workspaceId, listId, Math.max(1, Math.min(limit, 200))],
      );
      return res.rows.map((row) => ({ ...row, custom: row.custom ?? {} }));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeds
// ─────────────────────────────────────────────────────────────────────────────

export async function seedTemplate(
  db: TestDb,
  workspaceId: string,
  overrides: Partial<{
    name: string;
    subject: string;
    previewText: string | null;
    html: string;
    text: string;
    variables: string[];
  }> = {},
): Promise<string> {
  const res = await db.raw<{ id: string }>(
    `insert into templates (workspace_id, name, subject, preview_text, html, text, variables)
     values ($1, $2, $3, $4, $5, $6, $7::text[]) returning id`,
    [
      workspaceId,
      overrides.name ?? `Template ${Math.random().toString(36).slice(2, 10)}`,
      overrides.subject ?? 'Hello {{first_name}}',
      overrides.previewText === undefined ? 'A short preheader' : overrides.previewText,
      overrides.html ?? '<p>Hello {{first_name}}, welcome to {{company}}.</p>',
      overrides.text ?? 'Hello {{first_name}}, welcome to {{company}}.',
      overrides.variables ?? ['first_name', 'company'],
    ],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('failed to seed template');
  return id;
}

export async function seedCampaign(
  db: TestDb,
  workspaceId: string,
  overrides: Partial<{ name: string; requiresUnsubscribe: boolean }> = {},
): Promise<string> {
  const res = await db.raw<{ id: string }>(
    `insert into campaigns (workspace_id, name, requires_unsubscribe) values ($1, $2, $3) returning id`,
    [
      workspaceId,
      overrides.name ?? `Campaign ${Math.random().toString(36).slice(2, 10)}`,
      overrides.requiresUnsubscribe ?? true,
    ],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('failed to seed campaign');
  return id;
}

export async function campaignStatus(db: TestDb, campaignId: string): Promise<string> {
  const res = await db.raw<{ status: string }>(
    `select status::text as status from campaigns where id = $1`,
    [campaignId],
  );
  return res.rows[0]?.status ?? 'missing';
}
