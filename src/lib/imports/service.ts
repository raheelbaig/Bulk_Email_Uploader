import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireWorkspace } from '@/lib/auth/workspace';
import { serviceForWorkspace } from '@/lib/db/service';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { ForbiddenError, InternalError, ValidationError } from '@/lib/errors';
import { enforceRateLimit } from '@/lib/rate-limit';
import { serviceEligibilityReader } from '@/lib/eligibility/readers';
import { buildPage, clampLimit, type Cursor, type Page, type PageDirection } from '@/lib/pagination';
import {
  INSPECT_SAMPLE_ROWS,
  MAX_SPREADSHEET_ROWS,
  MAX_UPLOAD_BYTES,
  type ImportStatus,
} from './constants';
import { checkDeclaredFile, checkFileContent, sanitizeFilename } from './detect';
import { CsvStreamParser, defaultDelimiterFor, detectDelimiter } from './csv';
import { readXlsx } from './xlsx';
import { readXls } from './xls';
import {
  proposeMapping,
  validateMapping,
  dedupeHeaders,
  columnMappingSchema,
  MAPPING_PROBLEM_MESSAGE,
  type MappingProposal,
} from './mapping';
import { importRepository, importStorage } from './repository';
import { processImport, type RunnerOutcome } from './runner';
import type { ImportRecord, RejectionRecord } from './ports';

/**
 * The import engine's authorized surface.
 *
 * Every function begins with `requireWorkspace()`, so the workspace id arriving
 * from the browser is a claim that has been checked against a membership row
 * before anything else happens — identical to contacts and lists (P1). The
 * service role is only reached after that check, and only through accessors that
 * cannot build an unscoped query.
 *
 * The two-phase boundary lives here: `inspectImport` reads a file and proposes,
 * `confirmMapping` accepts a decision and queues the work. Nothing between them
 * writes a contact.
 */

const uuidSchema = z.uuid('That is not a valid import.');

export interface ImportSummary {
  id: string;
  filename: string;
  byte_size: number;
  status: ImportStatus;
  target_list_id: string | null;
  target_list_name: string | null;
  rows_total: number;
  rows_valid: number;
  rows_invalid: number;
  rows_duplicate: number;
  rows_suppressed: number;
  rows_rejected: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

const SUMMARY_COLUMNS =
  'id, filename, byte_size, status, target_list_id, rows_total, rows_valid, rows_invalid, ' +
  'rows_duplicate, rows_suppressed, rows_rejected, error_message, started_at, finished_at, created_at';

function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lists imports.
 *
 * Reads under the caller's JWT so RLS constrains the result independently of
 * the workspace filter — the same two-layer arrangement P1 uses. `imports` is
 * SELECT-only to `authenticated`, so this is the only thing a client can do to
 * the table directly.
 */
export async function listImports(
  workspaceId: string,
  options: { limit?: number; cursor?: Cursor | undefined; direction?: PageDirection } = {},
): Promise<Page<ImportSummary>> {
  await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();

  const limit = clampLimit(options.limit);
  const direction: PageDirection = options.direction ?? 'forward';
  const ascending = direction === 'backward';

  let query = supabase
    .from('imports')
    .select(`${SUMMARY_COLUMNS}, contact_lists(name)`)
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
    logger.error('import list query failed', { dbError: error.message });
    throw new InternalError(error);
  }

  const items = rows<Record<string, unknown>>(data).map(withListName);

  return buildPage(items, limit, direction, cursor !== undefined);
}

export async function getImport(workspaceId: string, importId: string): Promise<ImportSummary> {
  await requireWorkspace(workspaceId);
  uuidSchema.parse(importId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('imports')
    .select(`${SUMMARY_COLUMNS}, contact_lists(name)`)
    .eq('workspace_id', workspaceId)
    .eq('id', importId)
    .maybeSingle();

  // Absent and inaccessible answer identically, so import ids cannot be
  // enumerated across workspaces.
  if (error !== null || data === null) throw new ForbiddenError(error ?? undefined);

  return withListName(data as Record<string, unknown>);
}

/**
 * Flattens the embedded list name.
 *
 * PostgREST returns an embedded relation as an object or an array depending on
 * the inferred cardinality, and its generated types disagree with both often
 * enough that handling one shape would break on the other.
 */
function withListName(row: Record<string, unknown>): ImportSummary {
  const { contact_lists: embedded, ...rest } = row;
  const list = Array.isArray(embedded) ? embedded[0] : embedded;
  const name =
    list !== null && typeof list === 'object' && 'name' in list
      ? String((list as { name: unknown }).name)
      : null;
  return { ...rest, target_list_name: name } as unknown as ImportSummary;
}

export async function listRejections(
  workspaceId: string,
  importId: string,
  limit = 200,
): Promise<Array<RejectionRecord & { id: string }>> {
  await requireWorkspace(workspaceId);
  uuidSchema.parse(importId);
  // Proves the import belongs to this workspace before its rejections are read.
  await getImport(workspaceId, importId);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('import_rejections')
    .select('id, row_number, raw_row, bucket, reason')
    .eq('import_id', importId)
    .order('row_number', { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 5000));

  if (error !== null) {
    logger.error('rejection query failed', { dbError: error.message });
    throw new InternalError(error);
  }
  return rows<RejectionRecord & { id: string }>(data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase A — create and inspect
// ─────────────────────────────────────────────────────────────────────────────

export const createImportSchema = z.object({
  filename: z.string().min(1).max(255),
  byteSize: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  contentType: z.string().min(1).max(128),
  targetListId: z.union([z.uuid(), z.literal(''), z.null()]).optional(),
});

export type CreateImportInput = z.infer<typeof createImportSchema>;

export interface CreatedImport {
  importId: string;
  storagePath: string;
  /** A one-time, path-bound upload URL. Never a bucket-wide credential. */
  uploadUrl: string;
  uploadToken: string;
}

/**
 * Creates the import row and a signed upload URL.
 *
 * The declared size, type and extension are validated *before* a URL is issued,
 * so an oversized or unsupported file never reaches storage (§20.3). The
 * signed URL is bound to one object key derived from server-generated ids — the
 * caller cannot influence where the bytes land, and the key is inside the
 * workspace prefix that the bucket policies and `ScopedStorage` both enforce.
 */
export async function createImport(
  workspaceId: string,
  input: CreateImportInput,
): Promise<CreatedImport> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('import.create', access.userId, access.workspaceId);

  const parsed = createImportSchema.parse(input);
  const check = checkDeclaredFile({
    filename: parsed.filename,
    byteSize: parsed.byteSize,
    contentType: parsed.contentType,
  });
  if (!check.ok) throw new ValidationError(check.message);

  const targetListId =
    parsed.targetListId === undefined || parsed.targetListId === '' ? null : parsed.targetListId;

  // A list from another workspace must not be attachable. Checked here for a
  // clear error; the composite foreign key on `list_members` and the workspace
  // check inside `import_upsert_contacts` both refuse it independently.
  if (targetListId !== null) await assertListInWorkspace(access.workspaceId, targetListId);

  const filename = sanitizeFilename(parsed.filename);
  const db = serviceForWorkspace(access.workspaceId);

  const { data, error } = await db
    .insert('imports', [
      {
        actor_id: access.userId,
        filename,
        byte_size: parsed.byteSize,
        content_type: parsed.contentType.slice(0, 128),
        // Rewritten below once the id exists; a placeholder keeps the NOT NULL
        // constraint honest rather than making the column nullable.
        storage_path: 'pending',
        status: 'uploaded',
        target_list_id: targetListId,
      },
    ])
    .select('id');

  if (error !== null) {
    logger.error('import insert failed', { dbError: error.message, code: error.code });
    throw new InternalError(error);
  }

  const created = rows<{ id: string }>(data)[0];
  if (created === undefined) throw new InternalError('import insert returned no row');

  const storagePath = db.storage.keyFor(created.id, filename);

  const { error: pathError } = await db
    .update('imports', { storage_path: storagePath })
    .eq('id', created.id);
  if (pathError !== null) throw new InternalError(pathError);

  let signed: { signedUrl: string; token: string };
  try {
    signed = await db.storage.createSignedUploadUrl(storagePath);
  } catch (cause) {
    logger.error('signed upload url failed', { cause });
    throw new InternalError(cause);
  }

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'import.started',
    entityType: 'import',
    entityId: created.id,
    // Metadata is minimal by design (§20, §23.3): shape and size, never the
    // file's contents and never the address of anyone in it.
    metadata: {
      byteSize: parsed.byteSize,
      format: check.format,
      hasTargetList: targetListId !== null,
    },
  });

  return {
    importId: created.id,
    storagePath,
    uploadUrl: signed.signedUrl,
    uploadToken: signed.token,
  };
}

async function assertListInWorkspace(workspaceId: string, listId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('contact_lists')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('id', listId)
    .maybeSingle();
  if (error !== null || data === null) throw new ForbiddenError(error ?? undefined);
}

export interface InspectionResult {
  importId: string;
  filename: string;
  format: string;
  proposal: MappingProposal;
  /** A handful of data rows, for the mapping screen. Never the whole file. */
  sample: string[][];
  totalRowsSampled: number;
}

/**
 * Phase A — reads only enough of the file to propose a mapping.
 *
 * The row cap is deliberately small here. Inspection exists to answer "what are
 * the columns and what does the data look like", and reading a whole 25 MB file
 * to answer that would make the mapping screen slow for no benefit.
 */
export async function inspectImport(
  workspaceId: string,
  importId: string,
): Promise<InspectionResult> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('import.inspect', access.userId, access.workspaceId);
  uuidSchema.parse(importId);

  const repository = importRepository(access.workspaceId);
  const record = await repository.get(importId);
  if (record === null) throw new ForbiddenError();

  if (record.status !== 'uploaded' && record.status !== 'mapping') {
    throw new ValidationError('That import has already been processed.');
  }

  const storage = importStorage(access.workspaceId);

  let bytes: Uint8Array;
  try {
    bytes = await storage.download(record.storage_path);
  } catch (cause) {
    logger.warn('staged file unreadable', { importId, cause });
    throw new ValidationError('That upload could not be read. Try uploading the file again.');
  }

  const check = checkFileContent({
    filename: record.filename,
    bytes,
    byteSize: bytes.length,
  });
  if (!check.ok) {
    await markFailed(repository, record, check.message);
    throw new ValidationError(check.message);
  }

  const sampleRows = readSampleRows(bytes, check.format);
  if (sampleRows.length === 0) {
    const message = 'That file has no rows to import.';
    await markFailed(repository, record, message);
    throw new ValidationError(message);
  }

  const proposal = proposeMapping(sampleRows);

  const moved = await repository.transition(importId, ['uploaded', 'mapping'], 'mapping');
  if (!moved) throw new ValidationError('That import has already been processed.');

  return {
    importId,
    filename: record.filename,
    format: check.format,
    proposal,
    sample: sampleRows.slice(proposal.headerRow + 1, proposal.headerRow + 1 + INSPECT_SAMPLE_ROWS),
    totalRowsSampled: sampleRows.length,
  };
}

/**
 * Reads the leading rows of a file, whatever its format.
 *
 * For CSV this stops after the sample is full, so a large file costs a few
 * kilobytes of parsing. For workbooks the format forces a full read, which is
 * bounded by the row cap and the zip guard.
 */
function readSampleRows(bytes: Uint8Array, format: string): string[][] {
  if (format === 'xlsx' || format === 'xls') {
    const result =
      format === 'xlsx'
        ? readXlsx(bytes, { maxRows: MAX_SPREADSHEET_ROWS })
        : readXls(bytes, { maxRows: MAX_SPREADSHEET_ROWS });
    return result.rows.slice(0, INSPECT_SAMPLE_ROWS * 2);
  }

  // 256 KB is far more than the sample needs and bounds the work regardless of
  // how long the file's lines are.
  const head = bytes.subarray(0, Math.min(bytes.length, 256 * 1024));
  const text = new TextDecoder('utf-8').decode(head);
  const parser = new CsvStreamParser({
    delimiter: detectDelimiter(text, defaultDelimiterFor(format)),
  });
  const parsed = [...parser.push(text), ...parser.end()];
  return parsed.slice(0, INSPECT_SAMPLE_ROWS * 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — confirm and process
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfirmMappingResult {
  importId: string;
  queued: boolean;
}

/**
 * Phase B — the user's decision, and the only door to processing.
 *
 * The mapping is re-validated against the file's real headers before it is
 * stored: a browser could otherwise confirm a mapping for columns that do not
 * exist, or omit the email column entirely. Only after that does the import
 * transition to `processing` and a job appear on the queue.
 */
export async function confirmMapping(
  workspaceId: string,
  importId: string,
  mappingInput: unknown,
  targetListId: string | null,
): Promise<ConfirmMappingResult> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('import.confirm', access.userId, access.workspaceId);
  uuidSchema.parse(importId);

  const repository = importRepository(access.workspaceId);
  const record = await repository.get(importId);
  if (record === null) throw new ForbiddenError();
  if (record.status !== 'mapping' && record.status !== 'uploaded') {
    throw new ValidationError('That import has already been processed.');
  }

  const storage = importStorage(access.workspaceId);
  let bytes: Uint8Array;
  try {
    bytes = await storage.download(record.storage_path);
  } catch {
    throw new ValidationError('That upload could not be read. Try uploading the file again.');
  }

  const check = checkFileContent({ filename: record.filename, bytes, byteSize: bytes.length });
  if (!check.ok) {
    await markFailed(repository, record, check.message);
    throw new ValidationError(check.message);
  }

  const sampleRows = readSampleRows(bytes, check.format);

  // The mapping is validated against the file's *actual* headers, read at the
  // header row the mapping itself declares. This is the check that makes the
  // two-phase boundary real: a browser can submit any mapping it likes, and one
  // naming columns this file does not have — or omitting the email column — is
  // refused here rather than producing a silently wrong import.
  const shape = columnMappingSchema.safeParse(mappingInput);
  if (!shape.success) throw new ValidationError(MAPPING_PROBLEM_MESSAGE.invalid_shape);

  const headerRowCells = sampleRows[shape.data.headerRow];
  if (headerRowCells === undefined) {
    throw new ValidationError('That mapping refers to a header row this file does not have.');
  }

  const candidate = validateMapping(shape.data, dedupeHeaders([...headerRowCells]));
  if (!candidate.ok) throw new ValidationError(candidate.message);

  const resolvedListId = targetListId === null || targetListId === '' ? null : targetListId;
  if (resolvedListId !== null) await assertListInWorkspace(access.workspaceId, resolvedListId);

  const moved = await repository.transition(importId, ['uploaded', 'mapping'], 'processing', {
    column_mapping: candidate.mapping,
    target_list_id: resolvedListId,
    started_at: new Date().toISOString(),
  });
  if (!moved) throw new ValidationError('That import has already been processed.');

  await repository.enqueue(importId);

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'import.mapped',
    entityType: 'import',
    entityId: importId,
    metadata: {
      // Field names only. The header text is user data and the cells certainly
      // are; neither belongs in a permanently retained audit record.
      mappedFields: candidate.mapping.columns
        .filter((column) => column.target.kind === 'field')
        .map((column) => (column.target.kind === 'field' ? column.target.field : ''))
        .filter((name) => name.length > 0),
      customFieldCount: candidate.mapping.columns.filter((c) => c.target.kind === 'custom').length,
      hasTargetList: resolvedListId !== null,
    },
  });

  return { importId, queued: true };
}

/**
 * Runs a queued import.
 *
 * Called immediately after confirmation (through `after()`, so the browser is
 * not held open) and again by any retry path. Safe to call repeatedly: the claim
 * is atomic, so a second caller finds the job taken and does nothing.
 */
export async function runQueuedImport(
  workspaceId: string,
  importId: string,
): Promise<RunnerOutcome> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('import.process', access.userId, access.workspaceId);
  uuidSchema.parse(importId);

  const repository = importRepository(access.workspaceId);
  const storage = importStorage(access.workspaceId);

  const outcome = await processImport({
    repository,
    storage,
    eligibility: serviceEligibilityReader(),
  }, importId);

  if (outcome.kind === 'completed') {
    await writeAuditLog({
      workspaceId: access.workspaceId,
      actorId: access.userId,
      actorType: 'user',
      action: 'import.completed',
      entityType: 'import',
      entityId: importId,
      metadata: { ...outcome.counters },
    });
  } else if (outcome.kind === 'failed') {
    await writeAuditLog({
      workspaceId: access.workspaceId,
      actorId: access.userId,
      actorType: 'user',
      action: 'import.failed',
      entityType: 'import',
      entityId: importId,
      metadata: {
        ...outcome.counters,
        failedAtRow: outcome.failedAtRow,
        // The user-safe message only. Never a database error, a constraint name
        // or a stack trace.
        reason: outcome.message,
      },
    });
  }

  return outcome;
}

/** Marks an import failed. Used when validation refuses a file after upload. */
async function markFailed(
  repository: ReturnType<typeof importRepository>,
  record: ImportRecord,
  message: string,
): Promise<void> {
  await repository
    .transition(record.id, ['uploaded', 'mapping', 'processing'], 'failed', {
      finished_at: new Date().toISOString(),
      error_message: message.slice(0, 500),
    })
    .catch(() => undefined);
}
