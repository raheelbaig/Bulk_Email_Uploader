import type { TestDb } from './db';
import type {
  ClaimedJob,
  ImportCounters,
  ImportRecord,
  ImportRepository,
  ImportStorage,
  RejectionRecord,
  UpsertOutcome,
  UpsertRow,
} from '@/lib/imports/ports';
import type { ImportStatus } from '@/lib/imports/constants';

/**
 * Test-side implementations of the import ports.
 *
 * These run the *real* engine against a *real* migrated database: the same
 * `public.import_upsert_contacts` function, the same `ck_rows_reconcile`
 * constraint, the same conditional-UPDATE claim. Only the transport differs —
 * SQL here, PostgREST in production — which is exactly what the port exists for
 * (see src/lib/imports/ports.ts).
 *
 * A mock would let a bug in the counter logic pass, because a mock agrees with
 * whatever the code says. The constraint does not.
 */

const IMPORT_COLUMNS = `
  id, workspace_id, actor_id, filename, byte_size::int as byte_size, content_type,
  storage_path, status::text as status, column_mapping, target_list_id,
  rows_total, rows_valid, rows_invalid, rows_duplicate, rows_suppressed, rows_rejected,
  error_message, started_at, finished_at, created_at
`;

export function testImportRepository(db: TestDb, workspaceId: string): ImportRepository {
  return {
    workspaceId,

    async get(importId) {
      const res = await db.raw<ImportRecord>(
        `select ${IMPORT_COLUMNS} from imports where id = $1 and workspace_id = $2`,
        [importId, workspaceId],
      );
      return res.rows[0] ?? null;
    },

    async transition(importId, from, to, patch = {}) {
      const assignments: string[] = ['status = $3::import_status'];
      const params: unknown[] = [importId, workspaceId, to];

      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        params.push(key === 'column_mapping' ? JSON.stringify(value) : value);
        assignments.push(
          key === 'column_mapping'
            ? `${key} = $${params.length}::jsonb`
            : `${key} = $${params.length}`,
        );
      }

      // One placeholder per expected status. PGlite does not bind a JS array to
      // a text[] parameter, and an IN list is portable either way.
      const statusPlaceholders = from.map((status) => {
        params.push(status);
        return `$${params.length}::import_status`;
      });

      try {
        const res = await db.raw<{ id: string }>(
          `update imports set ${assignments.join(', ')}
             where id = $1 and workspace_id = $2
               and status in (${statusPlaceholders.join(', ')})
           returning id`,
          params,
        );
        return res.rows.length > 0;
      } catch (cause) {
        // 23514 — a check constraint refused the row. The reconciliation
        // constraint is the interesting one, and the production repository
        // treats it identically: the transition simply did not happen.
        if (String((cause as Error).message).includes('ck_')) return false;
        throw cause;
      }
    },

    async updateCounters(importId, counters: Partial<ImportCounters>) {
      const entries = Object.entries(counters).filter(([, value]) => value !== undefined);
      if (entries.length === 0) return;
      const params: unknown[] = [importId, workspaceId];
      const assignments = entries.map(([key, value]) => {
        params.push(value);
        return `${key} = $${params.length}`;
      });
      await db.raw(
        `update imports set ${assignments.join(', ')} where id = $1 and workspace_id = $2`,
        params,
      );
    },

    async insertRejections(importId, rejections: readonly RejectionRecord[]) {
      for (const rejection of rejections) {
        await db.raw(
          `insert into import_rejections (import_id, row_number, raw_row, bucket, reason)
           values ($1, $2, $3::jsonb, $4, $5)`,
          [
            importId,
            rejection.row_number,
            JSON.stringify(rejection.raw_row),
            rejection.bucket,
            rejection.reason,
          ],
        );
      }
    },

    async clearRejections(importId) {
      await db.raw(`delete from import_rejections where import_id = $1`, [importId]);
    },

    async countRejections(importId) {
      const res = await db.raw<{ count: string }>(
        `select count(*)::text as count from import_rejections where import_id = $1`,
        [importId],
      );
      return Number(res.rows[0]?.count ?? 0);
    },

    async upsertContacts(importId, rows: readonly UpsertRow[], targetListId) {
      const res = await db.raw<UpsertOutcome>(
        `select email_normalized, inserted
           from public.import_upsert_contacts($1, $2, $3::jsonb, $4)`,
        [workspaceId, importId, JSON.stringify(rows), targetListId],
      );
      return res.rows;
    },

    async enqueue(importId) {
      await db.raw(
        `insert into import_jobs (import_id, workspace_id, status, available_at)
         values ($1, $2, 'queued', now())
         on conflict (import_id) do update
           set status = 'queued', available_at = now(), claimed_at = null, last_error = null`,
        [importId, workspaceId],
      );
    },

    async claim(importId): Promise<ClaimedJob | null> {
      // One statement, exactly as production. Two concurrent callers cannot both
      // see `status = 'queued'` and both update it.
      const res = await db.raw<ClaimedJob>(
        `update import_jobs
            set status = 'claimed', claimed_at = now(), attempts = attempts + 1
          where import_id = $1 and workspace_id = $2
            and status = 'queued' and available_at <= now()
        returning import_id, workspace_id, attempts, max_attempts`,
        [importId, workspaceId],
      );
      return res.rows[0] ?? null;
    },

    async completeJob(importId) {
      await db.raw(
        `update import_jobs set status = 'done', last_error = null
          where import_id = $1 and workspace_id = $2`,
        [importId, workspaceId],
      );
    },

    async failJob(importId, error) {
      const res = await db.raw<{ attempts: number; max_attempts: number }>(
        `select attempts, max_attempts from import_jobs where import_id = $1 and workspace_id = $2`,
        [importId, workspaceId],
      );
      const attempts = res.rows[0]?.attempts ?? 1;
      const maxAttempts = res.rows[0]?.max_attempts ?? 3;
      const willRetry = attempts < maxAttempts;

      await db.raw(
        `update import_jobs
            set status = $3,
                claimed_at = null,
                available_at = case when $3 = 'queued' then now() else available_at end,
                last_error = $4
          where import_id = $1 and workspace_id = $2`,
        [importId, workspaceId, willRetry ? 'queued' : 'dead', error.slice(0, 500)],
      );

      return { willRetry, attempts };
    },
  };
}

/**
 * In-memory storage standing in for the private bucket.
 *
 * Keyed the same way — `{workspace_id}/{import_id}/{filename}` — and it enforces
 * the same prefix rule, so a test that reaches for another workspace's path gets
 * the same refusal the production accessor gives.
 */
export class MemoryStorage implements ImportStorage {
  private readonly objects = new Map<string, { bytes: Uint8Array; createdAt: string }>();
  readonly removed: string[] = [];

  constructor(private readonly workspaceId?: string) {}

  put(path: string, bytes: Uint8Array | string, createdAt = new Date().toISOString()): void {
    const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    this.objects.set(path, { bytes: data, createdAt });
  }

  has(path: string): boolean {
    return this.objects.has(path);
  }

  get size(): number {
    return this.objects.size;
  }

  private assertOwned(path: string): void {
    if (this.workspaceId === undefined) return;
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
      throw new Error('storage path is not well formed');
    }
    if (!path.startsWith(`${this.workspaceId}/`)) {
      throw new Error('storage path does not belong to this workspace');
    }
  }

  private require(path: string): Uint8Array {
    this.assertOwned(path);
    const object = this.objects.get(path);
    if (object === undefined) throw new Error(`no such object: ${path}`);
    return object.bytes;
  }

  async head(path: string, bytes: number): Promise<Uint8Array> {
    return this.require(path).subarray(0, bytes);
  }

  async download(path: string): Promise<Uint8Array> {
    return this.require(path);
  }

  async openStream(path: string): Promise<AsyncIterable<Uint8Array>> {
    const bytes = this.require(path);
    // Deliberately small chunks, and deliberately not aligned to line or
    // character boundaries: this is what proves the parser survives a split
    // inside a quoted field or a multi-byte character.
    return (async function* () {
      const size = 7;
      for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
      }
    })();
  }

  async remove(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      this.assertOwned(path);
      this.objects.delete(path);
      this.removed.push(path);
    }
  }

  async list(prefix: string): Promise<Array<{ name: string; createdAt: string | null }>> {
    return [...this.objects.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, object]) => ({ name, createdAt: object.createdAt }));
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export interface SeededImport {
  importId: string;
  storagePath: string;
}

/** Creates an import row already in `processing` with a confirmed mapping. */
export async function seedProcessingImport(
  db: TestDb,
  options: {
    workspaceId: string;
    actorId: string;
    filename: string;
    byteSize: number;
    mapping: unknown;
    targetListId?: string | null;
    contentType?: string;
  },
): Promise<SeededImport> {
  const res = await db.raw<{ id: string }>(
    `insert into imports
       (workspace_id, actor_id, filename, byte_size, content_type, storage_path,
        status, column_mapping, target_list_id, started_at)
     values ($1, $2, $3, $4, $5, 'pending', 'processing', $6::jsonb, $7, now())
     returning id`,
    [
      options.workspaceId,
      options.actorId,
      options.filename,
      options.byteSize,
      options.contentType ?? 'text/csv',
      JSON.stringify(options.mapping),
      options.targetListId ?? null,
    ],
  );
  const importId = res.rows[0]?.id;
  if (importId === undefined) throw new Error('failed to seed import');

  const storagePath = `${options.workspaceId}/${importId}/${options.filename}`;
  await db.raw(`update imports set storage_path = $2 where id = $1`, [importId, storagePath]);
  await db.raw(
    `insert into import_jobs (import_id, workspace_id, status) values ($1, $2, 'queued')`,
    [importId, options.workspaceId],
  );

  return { importId, storagePath };
}

/** A mapping for a header row of the given field names, in order. */
export function simpleMapping(
  fields: ReadonlyArray<string | { custom: string }>,
  headerRow = 0,
): unknown {
  return {
    headerRow,
    columns: fields.map((field, index) => ({
      index,
      header: typeof field === 'string' ? field : field.custom,
      target:
        typeof field === 'string'
          ? field === 'ignore'
            ? { kind: 'ignore' }
            : { kind: 'field', field }
          : { kind: 'custom', key: field.custom },
    })),
  };
}

export async function importRow(db: TestDb, importId: string): Promise<ImportRecord> {
  const res = await db.raw<ImportRecord>(`select ${IMPORT_COLUMNS} from imports where id = $1`, [
    importId,
  ]);
  const row = res.rows[0];
  if (row === undefined) throw new Error('import not found');
  return row;
}

export async function jobRow(
  db: TestDb,
  importId: string,
): Promise<{ status: string; attempts: number; last_error: string | null }> {
  const res = await db.raw<{ status: string; attempts: number; last_error: string | null }>(
    `select status, attempts, last_error from import_jobs where import_id = $1`,
    [importId],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('job not found');
  return row;
}

export async function statusOf(db: TestDb, importId: string): Promise<ImportStatus> {
  const res = await db.raw<{ status: ImportStatus }>(
    `select status::text as status from imports where id = $1`,
    [importId],
  );
  const status = res.rows[0]?.status;
  if (status === undefined) throw new Error('import not found');
  return status;
}
