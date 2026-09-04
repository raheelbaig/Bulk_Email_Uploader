import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/observability/logger';
import { ConflictError, InternalError } from '@/lib/errors';
import { buildPage, clampLimit, type PageDirection } from '@/lib/pagination';
import type {
  TemplateDeleteOutcome,
  TemplateListOptions,
  TemplateRecord,
  TemplateRepository,
  TemplateWrite,
} from './ports';

/**
 * The production template repository.
 *
 * Reads and writes go through the caller's own JWT, so RLS remains a second,
 * independent layer behind the `requireWorkspace` check in the service. There is
 * no service-role mode here: unlike sender verification, nothing about a
 * template is derived state that a background job writes, so nothing needs to
 * bypass RLS. `version` is maintained by a trigger inside the database
 * (migration 0009), not by this layer.
 */

const COLUMNS =
  'id, workspace_id, name, subject, preview_text, html, text, variables, version, created_at, updated_at';

const PG_UNIQUE_VIOLATION = '23505';
/** Foreign-key violation — here, a campaign still referencing the template. */
const PG_FK_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

function toRecord(row: unknown): TemplateRecord {
  const record = row as TemplateRecord;
  return { ...record, variables: record.variables ?? [] };
}

export async function templateRepository(workspaceId: string): Promise<TemplateRepository> {
  const supabase = await createSupabaseServerClient();

  const fail = (operation: string, error: { message: string; code?: string }): never => {
    logger.error('template repository operation failed', {
      operation,
      dbError: error.message,
      code: error.code,
    });
    throw new InternalError(error);
  };

  /**
   * Translates the constraint violations migration 0009 can raise.
   *
   * A unique violation is a duplicate name; a check violation means the input
   * got past the application's own limits somehow, which is a bug worth
   * reporting as a conflict rather than a 500 the user cannot act on.
   */
  const write = async (
    operation: string,
    run: () => Promise<{ data: unknown; error: { message: string; code?: string } | null }>,
  ): Promise<TemplateRecord | null> => {
    const { data, error } = await run();
    if (error !== null) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        throw new ConflictError('A template with that name already exists.', error);
      }
      if (error.code === PG_CHECK_VIOLATION) {
        throw new ConflictError('That template is too large or contains something we cannot store.', error);
      }
      return fail(operation, error);
    }
    return data === null ? null : toRecord(data);
  };

  const payload = (input: TemplateWrite) => ({
    name: input.name,
    subject: input.subject,
    preview_text: input.previewText,
    html: input.html,
    text: input.text,
    variables: input.variables,
  });

  return {
    workspaceId,

    async list(options: TemplateListOptions = {}) {
      const limit = clampLimit(options.limit);
      const direction: PageDirection = options.direction ?? 'forward';
      const ascending = direction === 'backward';

      let query = supabase
        .from('templates')
        .select(COLUMNS)
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending })
        .order('id', { ascending })
        .limit(limit + 1);

      const cursor = options.cursor;
      if (cursor !== undefined) {
        const op = ascending ? 'gt' : 'lt';
        query = query.or(
          `created_at.${op}.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.${op}.${cursor.id})`,
        );
      }

      const { data, error } = await query;
      if (error !== null) fail('list', error);

      return buildPage(
        ((data ?? []) as unknown[]).map(toRecord),
        limit,
        direction,
        cursor !== undefined,
      );
    },

    async listAll(limit = 200) {
      const { data, error } = await supabase
        .from('templates')
        .select(COLUMNS)
        .eq('workspace_id', workspaceId)
        .order('name', { ascending: true })
        .limit(limit);

      if (error !== null) fail('listAll', error);
      return ((data ?? []) as unknown[]).map(toRecord);
    },

    async get(templateId) {
      const { data, error } = await supabase
        .from('templates')
        .select(COLUMNS)
        .eq('workspace_id', workspaceId)
        .eq('id', templateId)
        .maybeSingle();

      if (error !== null) fail('get', error);
      return data === null ? null : toRecord(data);
    },

    async insert(input) {
      const record = await write('insert', async () =>
        supabase
          .from('templates')
          .insert({ workspace_id: workspaceId, ...payload(input) })
          .select(COLUMNS)
          .maybeSingle(),
      );
      if (record === null) throw new InternalError('template insert returned no row');
      return record;
    },

    update(templateId, input) {
      return write('update', async () =>
        supabase
          .from('templates')
          .update(payload(input))
          .eq('workspace_id', workspaceId)
          .eq('id', templateId)
          .select(COLUMNS)
          .maybeSingle(),
      );
    },

    async remove(templateId): Promise<TemplateDeleteOutcome> {
      const { data, error } = await supabase
        .from('templates')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('id', templateId)
        .select('id')
        .maybeSingle();

      if (error !== null) {
        if (error.code === PG_FK_VIOLATION) return 'in_use';
        fail('remove', error);
      }
      return data === null ? 'missing' : 'deleted';
    },

    async countCampaignsUsing(templateId) {
      const { count, error } = await supabase
        .from('campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('template_id', templateId);

      if (error !== null) fail('countCampaignsUsing', error);
      return count ?? 0;
    },
  };
}
