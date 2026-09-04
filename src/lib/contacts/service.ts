import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireWorkspace } from '@/lib/auth/workspace';
import { normalizeEmail, NORMALIZE_FAILURE_MESSAGE } from '@/lib/email/normalize';
import { ValidationError, ConflictError, ForbiddenError, InternalError } from '@/lib/errors';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import {
  buildPage,
  clampLimit,
  type Cursor,
  type Page,
  type PageDirection,
} from '@/lib/pagination';

/**
 * Contacts.
 *
 * Every function takes a `workspaceId` that is verified through
 * `requireWorkspace` before any query runs. The id arriving from the browser is
 * a claim to be checked, never an authorization input; RLS is the second layer
 * behind that check, not a replacement for it.
 */

export const CONTACT_STATUSES = ['active', 'suppressed', 'invalid'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export interface Contact {
  id: string;
  workspace_id: string;
  email_normalized: string;
  email_raw: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  custom: Record<string, unknown>;
  status: ContactStatus;
  import_id: string | null;
  created_at: string;
  updated_at: string | null;
}

const SELECT_COLUMNS =
  'id, workspace_id, email_normalized, email_raw, first_name, last_name, company, website, phone, custom, status, import_id, created_at, updated_at';

/** Trimmed, and empty strings become null so the database stores one "absent". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional();

export const contactInputSchema = z.object({
  email: z.string().min(1, 'Enter an email address.').max(320),
  firstName: optionalText(120),
  lastName: optionalText(120),
  company: optionalText(200),
  website: optionalText(300),
  phone: optionalText(50),
  custom: z.record(z.string(), z.unknown()).optional(),
});

export type ContactInput = z.infer<typeof contactInputSchema>;

/** Minimum query length. Below this a trigram search matches most of the table. */
export const MIN_SEARCH_LENGTH = 2;

export interface ListContactsOptions {
  search?: string | undefined;
  status?: ContactStatus | undefined;
  listId?: string | undefined;
  limit?: number | undefined;
  cursor?: Cursor | undefined;
  direction?: PageDirection | undefined;
}

function normalizeOrThrow(email: string): { normalized: string; raw: string } {
  const result = normalizeEmail(email);
  if (!result.ok) throw new ValidationError(NORMALIZE_FAILURE_MESSAGE[result.reason]);
  return { normalized: result.normalized, raw: result.raw };
}

function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

export async function listContacts(
  workspaceId: string,
  options: ListContactsOptions = {},
): Promise<Page<Contact>> {
  await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();

  const limit = clampLimit(options.limit);
  const direction: PageDirection = options.direction ?? 'forward';
  const ascending = direction === 'backward';

  let query = supabase
    .from('contacts')
    .select(SELECT_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending })
    .order('id', { ascending })
    // limit + 1: the extra row reveals hasMore without a count query.
    .limit(limit + 1);

  if (options.status !== undefined) {
    query = query.eq('status', options.status);
  }

  const search = options.search?.trim();
  if (search !== undefined && search.length >= MIN_SEARCH_LENGTH) {
    // Filters the stored generated column, which is served by the GIN trigram
    // index. `%` and `_` are escaped so a user cannot turn a search into a
    // full-table wildcard scan.
    const escaped = search.replace(/[\\%_]/g, (c) => `\\${c}`);
    query = query.ilike('search_text', `%${escaped}%`);
  }

  if (options.listId !== undefined) {
    const members = await supabase
      .from('list_members')
      .select('contact_id')
      .eq('workspace_id', workspaceId)
      .eq('list_id', options.listId);

    if (members.error !== null) {
      logger.error('list member lookup failed', { dbError: members.error.message });
      throw new InternalError(members.error);
    }
    const ids = rows<{ contact_id: string }>(members.data).map((m) => m.contact_id);
    if (ids.length === 0) {
      return { items: [], nextCursor: null, prevCursor: null, hasMore: false };
    }
    query = query.in('id', ids);
  }

  const cursor = options.cursor;
  if (cursor !== undefined) {
    // Keyset predicate over the composite sort key. PostgREST expresses the
    // row-value comparison as an OR of the two lexicographic cases.
    const op = ascending ? 'gt' : 'lt';
    query = query.or(
      `created_at.${op}.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.${op}.${cursor.id})`,
    );
  }

  const { data, error } = await query;
  if (error !== null) {
    logger.error('contact list query failed', { dbError: error.message });
    throw new InternalError(error);
  }

  return buildPage(rows<Contact>(data), limit, direction, cursor !== undefined);
}

export async function getContact(workspaceId: string, contactId: string): Promise<Contact> {
  await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('contacts')
    .select(SELECT_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('id', contactId)
    .maybeSingle();

  // Absent and inaccessible are answered identically — distinguishing them lets
  // a caller enumerate ids across workspaces.
  if (error !== null || data === null) throw new ForbiddenError(error ?? undefined);
  return data as unknown as Contact;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────────

export async function createContact(workspaceId: string, input: ContactInput): Promise<Contact> {
  const access = await requireWorkspace(workspaceId);
  const parsed = contactInputSchema.parse(input);
  const email = normalizeOrThrow(parsed.email);

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('contacts')
    .insert({
      // workspace_id comes from the verified access record, never from input.
      workspace_id: access.workspaceId,
      email_normalized: email.normalized,
      email_raw: email.raw,
      first_name: parsed.firstName ?? null,
      last_name: parsed.lastName ?? null,
      company: parsed.company ?? null,
      website: parsed.website ?? null,
      phone: parsed.phone ?? null,
      custom: parsed.custom ?? {},
    })
    .select(SELECT_COLUMNS)
    .maybeSingle();

  if (error !== null) {
    // 23505 — uq_contacts_ws_email. The constraint is what prevents duplicates;
    // this branch only translates it into something a person can act on.
    if (error.code === '23505') {
      throw new ConflictError('A contact with that email address already exists.', error);
    }
    logger.error('contact insert failed', { dbError: error.message, code: error.code });
    throw new InternalError(error);
  }
  if (data === null) throw new InternalError('insert returned no row');

  const contact = data as unknown as Contact;

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'contact.created',
    entityType: 'contact',
    entityId: contact.id,
    // Domain only. The full address is personal data that the contacts table
    // already holds; duplicating it into a permanently retained audit log adds
    // exposure without adding accountability.
    metadata: { emailDomain: email.normalized.split('@')[1] ?? null },
  });

  return contact;
}

export async function updateContact(
  workspaceId: string,
  contactId: string,
  input: ContactInput,
): Promise<Contact> {
  const access = await requireWorkspace(workspaceId);
  const parsed = contactInputSchema.parse(input);
  const email = normalizeOrThrow(parsed.email);

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('contacts')
    .update({
      // No workspace_id here, and the column is absent from the UPDATE grant, so
      // a contact cannot move between workspaces by any route.
      email_normalized: email.normalized,
      email_raw: email.raw,
      first_name: parsed.firstName ?? null,
      last_name: parsed.lastName ?? null,
      company: parsed.company ?? null,
      website: parsed.website ?? null,
      phone: parsed.phone ?? null,
      custom: parsed.custom ?? {},
    })
    .eq('workspace_id', access.workspaceId)
    .eq('id', contactId)
    .select(SELECT_COLUMNS)
    .maybeSingle();

  if (error !== null) {
    if (error.code === '23505') {
      throw new ConflictError('Another contact already uses that email address.', error);
    }
    logger.error('contact update failed', { dbError: error.message, code: error.code });
    throw new InternalError(error);
  }
  if (data === null) throw new ForbiddenError();

  const contact = data as unknown as Contact;

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'contact.updated',
    entityType: 'contact',
    entityId: contact.id,
    metadata: { emailChanged: contact.email_normalized !== email.normalized },
  });

  return contact;
}

/**
 * Deletes a contact.
 *
 * Suppressions are keyed by address, not contact id, so they are untouched.
 * Deleting a contact never makes a suppressed address sendable again — see
 * `tests/suppression.test.ts`.
 */
export async function deleteContact(workspaceId: string, contactId: string): Promise<void> {
  const access = await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('contacts')
    .delete()
    .eq('workspace_id', access.workspaceId)
    .eq('id', contactId)
    .select('id')
    .maybeSingle();

  if (error !== null) {
    logger.error('contact delete failed', { dbError: error.message });
    throw new InternalError(error);
  }
  if (data === null) throw new ForbiddenError();

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'contact.deleted',
    entityType: 'contact',
    entityId: contactId,
  });
}
