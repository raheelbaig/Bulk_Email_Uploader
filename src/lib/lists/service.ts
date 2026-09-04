import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireWorkspace } from '@/lib/auth/workspace';
import { ValidationError, ConflictError, ForbiddenError, InternalError } from '@/lib/errors';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { buildPage, clampLimit, type Cursor, type Page, type PageDirection } from '@/lib/pagination';

/**
 * Contact lists and membership.
 *
 * Cross-workspace membership is prevented by the schema, not here: `list_members`
 * carries `workspace_id` and both foreign keys are composite, so PostgreSQL
 * itself refuses to link a contact in workspace A to a list in workspace B
 * (migration 0005). The checks in this module produce good error messages; the
 * database produces the guarantee.
 */

export interface ContactList {
  id: string;
  workspace_id: string;
  name: string;
  contact_count: number;
  created_at: string;
  updated_at: string | null;
}

const SELECT_COLUMNS = 'id, workspace_id, name, contact_count, created_at, updated_at';

export const listNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the list a name.')
  .max(120, 'List names are limited to 120 characters.');

const uuidSchema = z.uuid('That is not a valid id.');

function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lists
// ─────────────────────────────────────────────────────────────────────────────

export async function listContactLists(
  workspaceId: string,
  options: { limit?: number; cursor?: Cursor | undefined; direction?: PageDirection } = {},
): Promise<Page<ContactList>> {
  await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();

  const limit = clampLimit(options.limit);
  const direction: PageDirection = options.direction ?? 'forward';
  const ascending = direction === 'backward';

  let query = supabase
    .from('contact_lists')
    .select(SELECT_COLUMNS)
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
  if (error !== null) {
    logger.error('list query failed', { dbError: error.message });
    throw new InternalError(error);
  }

  return buildPage(rows<ContactList>(data), limit, direction, cursor !== undefined);
}

export async function getContactList(workspaceId: string, listId: string): Promise<ContactList> {
  await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('contact_lists')
    .select(SELECT_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('id', listId)
    .maybeSingle();

  if (error !== null || data === null) throw new ForbiddenError(error ?? undefined);
  return data as unknown as ContactList;
}

export async function createContactList(workspaceId: string, name: string): Promise<ContactList> {
  const access = await requireWorkspace(workspaceId);
  const parsedName = listNameSchema.parse(name);

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('contact_lists')
    .insert({ workspace_id: access.workspaceId, name: parsedName })
    .select(SELECT_COLUMNS)
    .maybeSingle();

  if (error !== null) {
    if (error.code === '23505') {
      throw new ConflictError('A list with that name already exists.', error);
    }
    logger.error('list insert failed', { dbError: error.message, code: error.code });
    throw new InternalError(error);
  }
  if (data === null) throw new InternalError('insert returned no row');

  const list = data as unknown as ContactList;

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'list.created',
    entityType: 'contact_list',
    entityId: list.id,
    metadata: { name: list.name },
  });

  return list;
}

export async function renameContactList(
  workspaceId: string,
  listId: string,
  name: string,
): Promise<ContactList> {
  const access = await requireWorkspace(workspaceId);
  const parsedName = listNameSchema.parse(name);

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('contact_lists')
    .update({ name: parsedName })
    .eq('workspace_id', access.workspaceId)
    .eq('id', listId)
    .select(SELECT_COLUMNS)
    .maybeSingle();

  if (error !== null) {
    if (error.code === '23505') {
      throw new ConflictError('A list with that name already exists.', error);
    }
    logger.error('list rename failed', { dbError: error.message, code: error.code });
    throw new InternalError(error);
  }
  if (data === null) throw new ForbiddenError();

  const list = data as unknown as ContactList;

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'list.updated',
    entityType: 'contact_list',
    entityId: list.id,
    metadata: { name: list.name },
  });

  return list;
}

/** Deletes the list. Membership rows cascade; the contacts themselves do not. */
export async function deleteContactList(workspaceId: string, listId: string): Promise<void> {
  const access = await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('contact_lists')
    .delete()
    .eq('workspace_id', access.workspaceId)
    .eq('id', listId)
    .select('id')
    .maybeSingle();

  if (error !== null) {
    logger.error('list delete failed', { dbError: error.message });
    throw new InternalError(error);
  }
  if (data === null) throw new ForbiddenError();

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'list.deleted',
    entityType: 'contact_list',
    entityId: listId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Membership
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds a contact to a list. Idempotent: adding twice is a no-op, not an error.
 *
 * `workspace_id` is written from the verified access record, so the composite
 * foreign keys reject the row outright if either the list or the contact belongs
 * to another workspace.
 */
export async function addListMember(
  workspaceId: string,
  listId: string,
  contactId: string,
): Promise<{ added: boolean }> {
  const access = await requireWorkspace(workspaceId);
  uuidSchema.parse(listId);
  uuidSchema.parse(contactId);

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('list_members')
    .upsert(
      { workspace_id: access.workspaceId, list_id: listId, contact_id: contactId },
      { onConflict: 'list_id,contact_id', ignoreDuplicates: true },
    )
    .select('list_id')
    .maybeSingle();

  if (error !== null) {
    // 23503 — a composite FK rejected the pair. Either the list or the contact
    // is not in this workspace, or does not exist. Both answer identically.
    if (error.code === '23503') {
      throw new ForbiddenError(error);
    }
    logger.error('list member insert failed', { dbError: error.message, code: error.code });
    throw new InternalError(error);
  }

  // ignoreDuplicates returns no row when the membership already existed.
  const added = data !== null;

  if (added) {
    await writeAuditLog({
      workspaceId: access.workspaceId,
      actorId: access.userId,
      actorType: 'user',
      action: 'list.member_added',
      entityType: 'contact_list',
      entityId: listId,
      metadata: { contactId },
    });
  }

  return { added };
}

export async function removeListMember(
  workspaceId: string,
  listId: string,
  contactId: string,
): Promise<{ removed: boolean }> {
  const access = await requireWorkspace(workspaceId);
  uuidSchema.parse(listId);
  uuidSchema.parse(contactId);

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('list_members')
    .delete()
    // The workspace filter is what stops a caller removing a membership that
    // belongs to another tenant; RLS denies it independently.
    .eq('workspace_id', access.workspaceId)
    .eq('list_id', listId)
    .eq('contact_id', contactId)
    .select('list_id')
    .maybeSingle();

  if (error !== null) {
    logger.error('list member delete failed', { dbError: error.message });
    throw new InternalError(error);
  }

  const removed = data !== null;

  if (removed) {
    await writeAuditLog({
      workspaceId: access.workspaceId,
      actorId: access.userId,
      actorType: 'user',
      action: 'list.member_removed',
      entityType: 'contact_list',
      entityId: listId,
      metadata: { contactId },
    });
  }

  return { removed };
}

/** The list ids a contact belongs to — used by the contact editor. */
export async function listIdsForContact(workspaceId: string, contactId: string): Promise<string[]> {
  await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('list_members')
    .select('list_id')
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contactId);

  if (error !== null) {
    logger.error('member lookup failed', { dbError: error.message });
    throw new InternalError(error);
  }
  return rows<{ list_id: string }>(data).map((r) => r.list_id);
}

export function assertValidListId(value: unknown): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError('That is not a valid list.');
  return parsed.data;
}
