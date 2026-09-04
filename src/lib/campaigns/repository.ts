import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { serviceForWorkspace } from '@/lib/db/service';
import { logger } from '@/lib/observability/logger';
import { ConflictError, InternalError } from '@/lib/errors';
import { EMPTY_AUDIENCE, type AudienceCounts } from '@/lib/eligibility';
import { buildPage, clampLimit, type PageDirection } from '@/lib/pagination';
import type {
  AudienceMember,
  CampaignDraftPatch,
  CampaignListOptions,
  CampaignRecord,
  CampaignRepository,
  ListSummary,
  TransitionPatch,
} from './ports';
import type { CampaignStatus } from './status';

/**
 * The production campaign repository.
 *
 * ── Two credentials, and why ──────────────────────────────────────────────
 *
 * Reads and the edits a person is allowed to make go through the caller's own
 * JWT, so RLS remains a second, independent layer behind the `requireWorkspace`
 * check in the service.
 *
 * State transitions go through the workspace-scoped service role, because
 * `authenticated` deliberately holds no grant on `status` or
 * `template_snapshot` at all (migration 0009). That is not the service role
 * "getting around" the restriction — the restriction exists so that a status
 * change can only come from a code path that decided to make one. The database's
 * transition trigger still applies to the service role, so what that path may
 * decide is itself constrained: `scheduled → sending` is refused here exactly as
 * it would be from a browser.
 *
 * Every service-role query is built by `serviceForWorkspace`, which cannot
 * produce one without its tenant filter, and each transition additionally
 * filters on the campaign id and the expected status.
 */

const COLUMNS =
  'id, workspace_id, name, status, template_id, sender_identity_id, list_id, ' +
  'template_snapshot, scheduled_at, launched_at, completed_at, requires_unsubscribe, ' +
  'max_rate_override, pause_reason, launched_by, n_total, n_sent, n_delivered, ' +
  'n_bounced, n_complained, n_failed, n_unsubscribed, n_suppressed, created_at, updated_at';

const LIST_COLUMNS = 'id, name, contact_count';

const AUDIENCE_COLUMNS =
  'id, email_normalized, first_name, last_name, company, website, phone, custom, status';

const PG_FK_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

function toRecord(row: unknown): CampaignRecord {
  return row as CampaignRecord;
}

export async function campaignRepository(workspaceId: string): Promise<CampaignRepository> {
  const supabase = await createSupabaseServerClient();
  const service = serviceForWorkspace(workspaceId);

  const fail = (operation: string, error: { message: string; code?: string }): never => {
    logger.error('campaign repository operation failed', {
      operation,
      dbError: error.message,
      code: error.code,
    });
    throw new InternalError(error);
  };

  /**
   * Translates the violations migration 0009 raises.
   *
   * A foreign-key violation on a campaign write means the list, sender or
   * template named is not in this workspace — the composite keys make that the
   * only thing it can mean. A check violation from the transition trigger means
   * a forbidden state change reached the database, which the service should have
   * refused first; either way it is a conflict, not a 500.
   */
  const translate = (operation: string, error: { message: string; code?: string }): never => {
    if (error.code === PG_FK_VIOLATION) {
      throw new ConflictError(
        'That list, sender or template is not available in this workspace.',
        error,
      );
    }
    if (error.code === PG_CHECK_VIOLATION) {
      throw new ConflictError('That change is not allowed for this campaign right now.', error);
    }
    return fail(operation, error);
  };

  const getCampaign = async (campaignId: string): Promise<CampaignRecord | null> => {
    const { data, error } = await supabase
      .from('campaigns')
      .select(COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('id', campaignId)
      .maybeSingle();

    if (error !== null) fail('get', error);
    return data === null ? null : toRecord(data);
  };

  return {
    workspaceId,

    async timeZone() {
      const { data, error } = await supabase
        .from('workspace_settings')
        .select('display_timezone')
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      // A workspace with no settings row, or an unreadable one, falls back to
      // UTC rather than failing the page. An unexpected zone is caught by
      // `isValidTimeZone` before it is used.
      if (error !== null || data === null) return 'UTC';
      const value = data.display_timezone;
      return typeof value === 'string' && value.length > 0 ? value : 'UTC';
    },

    async getList(listId) {
      const { data, error } = await supabase
        .from('contact_lists')
        .select(LIST_COLUMNS)
        .eq('workspace_id', workspaceId)
        .eq('id', listId)
        .maybeSingle();

      if (error !== null) fail('getList', error);
      return data === null ? null : (data as unknown as ListSummary);
    },

    async listLists(limit = 200) {
      const { data, error } = await supabase
        .from('contact_lists')
        .select(LIST_COLUMNS)
        .eq('workspace_id', workspaceId)
        .order('name', { ascending: true })
        .limit(limit);

      if (error !== null) fail('listLists', error);
      return (data ?? []) as unknown as ListSummary[];
    },

    async list(options: CampaignListOptions = {}) {
      const limit = clampLimit(options.limit);
      const direction: PageDirection = options.direction ?? 'forward';
      const ascending = direction === 'backward';

      let query = supabase
        .from('campaigns')
        .select(COLUMNS)
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending })
        .order('id', { ascending })
        .limit(limit + 1);

      if (options.status !== undefined) query = query.eq('status', options.status);

      const cursor = options.cursor;
      if (cursor !== undefined) {
        const op = ascending ? 'gt' : 'lt';
        query = query.or(
          `created_at.${op}.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.${op}.${cursor.id})`,
        );
      }

      const { data, error } = await query;
      if (error !== null) fail('list', error);

      return buildPage(((data ?? []) as unknown[]).map(toRecord), limit, direction, cursor !== undefined);
    },

    get: getCampaign,

    async insert(input) {
      const { data, error } = await supabase
        .from('campaigns')
        .insert({
          workspace_id: workspaceId,
          name: input.name,
          requires_unsubscribe: input.requiresUnsubscribe,
        })
        .select(COLUMNS)
        .maybeSingle();

      if (error !== null) translate('insert', error);
      if (data === null) throw new InternalError('campaign insert returned no row');
      return toRecord(data);
    },

    async updateDraft(campaignId, patch: CampaignDraftPatch) {
      const payload: Record<string, unknown> = {};
      if (patch.name !== undefined) payload['name'] = patch.name;
      if (patch.templateId !== undefined) payload['template_id'] = patch.templateId;
      if (patch.senderIdentityId !== undefined) payload['sender_identity_id'] = patch.senderIdentityId;
      if (patch.listId !== undefined) payload['list_id'] = patch.listId;
      if (patch.scheduledAt !== undefined) payload['scheduled_at'] = patch.scheduledAt;
      if (patch.requiresUnsubscribe !== undefined) {
        payload['requires_unsubscribe'] = patch.requiresUnsubscribe;
      }
      if (Object.keys(payload).length === 0) return getCampaign(campaignId);

      const { data, error } = await supabase
        .from('campaigns')
        .update(payload)
        .eq('workspace_id', workspaceId)
        .eq('id', campaignId)
        // The state predicate is also in the RLS policy. Repeated here so the
        // failure is a clean "no row" rather than a policy denial, and so an
        // edit to a scheduled campaign cannot land even if a policy is relaxed.
        .in('status', ['draft', 'validating'])
        .select(COLUMNS)
        .maybeSingle();

      if (error !== null) translate('updateDraft', error);
      return data === null ? null : toRecord(data);
    },

    async transition(
      campaignId: string,
      from: readonly CampaignStatus[],
      to: CampaignStatus,
      patch: TransitionPatch = {},
    ) {
      const payload: Record<string, unknown> = { status: to };
      if (patch.templateSnapshot !== undefined) payload['template_snapshot'] = patch.templateSnapshot;
      if (patch.scheduledAt !== undefined) payload['scheduled_at'] = patch.scheduledAt;

      // The compare-and-set: `.in('status', from)` is what makes this safe under
      // concurrency. `serviceForWorkspace` adds the tenant filter and refuses to
      // build the query without it.
      const { data, error } = await service
        .update('campaigns', payload)
        .eq('id', campaignId)
        .in('status', [...from])
        .select(COLUMNS)
        .maybeSingle();

      if (error !== null) translate('transition', error);
      return data === null ? null : toRecord(data);
    },

    async remove(campaignId) {
      const { data, error } = await supabase
        .from('campaigns')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('id', campaignId)
        .select('id')
        .maybeSingle();

      if (error !== null) fail('remove', error);
      return data !== null;
    },

    async audienceCounts(listId): Promise<AudienceCounts> {
      const { data, error } = await supabase.rpc('campaign_audience_counts', {
        p_workspace_id: workspaceId,
        p_list_id: listId,
      });

      if (error !== null) fail('audienceCounts', error);

      const row = (Array.isArray(data) ? data[0] : data) as
        | { total: number; eligible: number; suppressed: number; inactive: number; capped: boolean }
        | undefined;
      if (row === undefined) return EMPTY_AUDIENCE;

      return {
        total: Number(row.total),
        eligible: Number(row.eligible),
        suppressed: Number(row.suppressed),
        inactive: Number(row.inactive),
        capped: row.capped === true,
      };
    },

    async audienceSample(listId, limit): Promise<AudienceMember[]> {
      // Two queries rather than a join: PostgREST embedding across
      // `list_members` would return a nested shape that is more work to unpick
      // than a second indexed read, and the membership index makes the first
      // one a seek.
      const { data: members, error: memberError } = await supabase
        .from('list_members')
        .select('contact_id')
        .eq('workspace_id', workspaceId)
        .eq('list_id', listId)
        .limit(Math.max(1, Math.min(limit, 200)));

      if (memberError !== null) fail('audienceSample.members', memberError);

      const ids = ((members ?? []) as unknown as { contact_id: string }[]).map((m) => m.contact_id);
      if (ids.length === 0) return [];

      const { data, error } = await supabase
        .from('contacts')
        .select(AUDIENCE_COLUMNS)
        .eq('workspace_id', workspaceId)
        .in('id', ids);

      if (error !== null) fail('audienceSample.contacts', error);

      return ((data ?? []) as unknown[]).map((row) => {
        const contact = row as AudienceMember;
        return { ...contact, custom: (contact.custom ?? {}) as Record<string, unknown> };
      });
    },
  };
}
