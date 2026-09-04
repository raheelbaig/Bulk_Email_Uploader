import 'server-only';
import { serviceForWorkspace } from '@/lib/db/service';
import { logger } from '@/lib/observability/logger';
import { InternalError } from '@/lib/errors';
import type { ImportStatus } from './constants';
import type {
  ClaimedJob,
  ImportCounters,
  ImportRecord,
  ImportRepository,
  ImportStorage,
  RejectionRecord,
  UpsertOutcome,
  UpsertRow,
} from './ports';

/**
 * Production implementations of the import ports.
 *
 * Everything here runs under the service role, which bypasses RLS. Tenant
 * isolation therefore comes entirely from `serviceForWorkspace`, which cannot
 * build a query without its workspace filter and cannot be handed a storage path
 * outside its own prefix. That is the whole safety argument for this file, and
 * why nothing in it takes a workspace id as a parameter.
 *
 * Why the service role at all, when contacts and lists use the caller's JWT:
 * imports must write `contacts.status` and `contacts.import_id`, and must move
 * `imports.status` through its state machine. All three are deliberately outside
 * the `authenticated` grant, precisely so a client cannot write them (migrations
 * 0005 and 0006). Authorization happens before this layer is reached, in
 * `requireWorkspace()`.
 */

const IMPORT_COLUMNS =
  'id, workspace_id, actor_id, filename, byte_size, content_type, storage_path, status, ' +
  'column_mapping, target_list_id, rows_total, rows_valid, rows_invalid, rows_duplicate, ' +
  'rows_suppressed, rows_rejected, error_message, started_at, finished_at, created_at';

/** Retry backoff. Short, bounded, and jittered so retries do not synchronise. */
function backoffSeconds(attempt: number): number {
  const base = Math.min(300, 15 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export function importRepository(workspaceId: string): ImportRepository {
  const db = serviceForWorkspace(workspaceId);

  const fail = (operation: string, error: { message: string; code?: string }): never => {
    logger.error('import repository operation failed', {
      operation,
      dbError: error.message,
      code: error.code,
    });
    throw new InternalError(error);
  };

  return {
    workspaceId,

    async get(importId: string): Promise<ImportRecord | null> {
      const { data, error } = await db
        .select('imports', IMPORT_COLUMNS)
        .eq('id', importId)
        .maybeSingle();
      if (error !== null) fail('get', error);
      return (data as unknown as ImportRecord | null) ?? null;
    },

    /**
     * A guarded transition.
     *
     * `.in('status', from)` is the guard, and it is what makes the state machine
     * server-side rather than advisory: the write only lands if the row is still
     * in an expected state, so two concurrent attempts cannot both succeed and a
     * client cannot drive a transition at all — it has no UPDATE grant.
     */
    async transition(
      importId: string,
      from: readonly ImportStatus[],
      to: ImportStatus,
      patch = {},
    ): Promise<boolean> {
      const { data, error } = await db
        .update('imports', { ...patch, status: to })
        .eq('id', importId)
        .in('status', from as string[])
        .select('id');

      if (error !== null) {
        // 23514 — a check constraint refused the row. The reconciliation
        // constraint is the one that matters: a completed import whose counters
        // do not sum to its total is rejected by the database, and the caller
        // must treat that as a failure rather than retrying blind.
        if (error.code === '23514') {
          logger.error('import transition violated a constraint', {
            importId,
            to,
            dbError: error.message,
          });
          return false;
        }
        fail('transition', error);
      }
      return Array.isArray(data) && data.length > 0;
    },

    async updateCounters(importId: string, counters: Partial<ImportCounters>): Promise<void> {
      const { error } = await db.update('imports', counters).eq('id', importId);
      if (error !== null) fail('updateCounters', error);
    },

    async insertRejections(importId: string, rejections: readonly RejectionRecord[]): Promise<void> {
      if (rejections.length === 0) return;
      const rows = rejections.map((rejection) => ({
        import_id: importId,
        row_number: rejection.row_number,
        raw_row: rejection.raw_row,
        bucket: rejection.bucket,
        reason: rejection.reason,
      }));

      // `import_rejections` has no workspace column — it is reached through its
      // parent — so this is the one write here that does not go through the
      // scoped insert helper. The import id was resolved from a
      // workspace-scoped read above.
      const { error } = await db.tenantlessTable('import_rejections').insert(rows);
      if (error !== null) fail('insertRejections', error);
    },

    async clearRejections(importId: string): Promise<void> {
      const { error } = await db
        .tenantlessTable('import_rejections')
        .delete()
        .eq('import_id', importId);
      if (error !== null) fail('clearRejections', error);
    },

    async countRejections(importId: string): Promise<number> {
      const { count, error } = await db
        .tenantlessTable('import_rejections')
        .select('id', { count: 'exact', head: true })
        .eq('import_id', importId);
      if (error !== null) fail('countRejections', error);
      return count ?? 0;
    },

    async upsertContacts(
      importId: string,
      rows: readonly UpsertRow[],
      targetListId: string | null,
    ): Promise<UpsertOutcome[]> {
      if (rows.length === 0) return [];

      const { data, error } = await db.rpc('import_upsert_contacts', {
        p_workspace_id: workspaceId,
        p_import_id: importId,
        p_rows: rows,
        p_list_id: targetListId,
      });

      if (error !== null) fail('upsertContacts', error);
      return ((data ?? []) as Array<{ email_normalized: string; inserted: boolean }>).map(
        (row) => ({ email_normalized: row.email_normalized, inserted: row.inserted }),
      );
    },

    // ── Queue ───────────────────────────────────────────────────────────────

    async enqueue(importId: string): Promise<void> {
      const { error } = await db.upsert(
        'import_jobs',
        [
          {
            import_id: importId,
            status: 'queued',
            available_at: new Date().toISOString(),
            claimed_at: null,
            last_error: null,
          },
        ],
        { onConflict: 'import_id' },
      );
      if (error !== null) fail('enqueue', error);
    },

    /**
     * The atomic claim.
     *
     * One conditional UPDATE, exactly as ARCHITECTURE §8.1 specifies for the
     * P5 job claim. Two runners racing this statement produce one winner and one
     * empty result set; the loser learns it lost from the row count, never from
     * a lock it has to hold.
     */
    async claim(importId: string): Promise<ClaimedJob | null> {
      const { data, error } = await db
        .update('import_jobs', { status: 'claimed', claimed_at: new Date().toISOString() })
        .eq('import_id', importId)
        .eq('status', 'queued')
        .lte('available_at', new Date().toISOString())
        .select('import_id, workspace_id, attempts, max_attempts');

      if (error !== null) fail('claim', error);
      const rows = (data ?? []) as unknown as ClaimedJob[];
      const claimed = rows[0];
      if (claimed === undefined) return null;

      // The attempt counter is incremented after a successful claim rather than
      // inside it, so `attempts` reflects passes actually started.
      await db
        .update('import_jobs', { attempts: claimed.attempts + 1 })
        .eq('import_id', importId);

      return { ...claimed, attempts: claimed.attempts + 1 };
    },

    async completeJob(importId: string): Promise<void> {
      const { error } = await db
        .update('import_jobs', { status: 'done', last_error: null })
        .eq('import_id', importId);
      if (error !== null) fail('completeJob', error);
    },

    async failJob(importId: string, errorMessage: string) {
      const { data, error } = await db
        .select('import_jobs', 'attempts, max_attempts')
        .eq('import_id', importId)
        .maybeSingle();
      if (error !== null) fail('failJob:read', error);

      const job = (data ?? null) as { attempts: number; max_attempts: number } | null;
      const attempts = job?.attempts ?? 1;
      const maxAttempts = job?.max_attempts ?? 3;
      const willRetry = attempts < maxAttempts;

      const patch = willRetry
        ? {
            status: 'queued',
            claimed_at: null,
            available_at: new Date(Date.now() + backoffSeconds(attempts) * 1000).toISOString(),
            last_error: errorMessage.slice(0, 500),
          }
        : {
            // Dead, not silently requeued forever. ARCHITECTURE §14.4: never
            // retry indefinitely — a permanently malformed file would otherwise
            // occupy the queue for as long as the deployment lives.
            status: 'dead',
            claimed_at: null,
            last_error: errorMessage.slice(0, 500),
          };

      const { error: updateError } = await db
        .update('import_jobs', patch)
        .eq('import_id', importId);
      if (updateError !== null) fail('failJob:write', updateError);

      return { willRetry, attempts };
    },
  };
}

/**
 * Storage access for one workspace's staged files.
 *
 * `openStream` is what keeps CSV parsing memory-bounded. Supabase's download
 * returns a `Blob`, whose `stream()` is a real `ReadableStream` — so the runner
 * receives chunks, not a 25 MB string.
 */
export function importStorage(workspaceId: string): ImportStorage {
  const scoped = serviceForWorkspace(workspaceId).storage;

  return {
    head(path: string, bytes: number): Promise<Uint8Array> {
      return scoped.head(path, bytes);
    },

    download(path: string): Promise<Uint8Array> {
      return scoped.download(path);
    },

    openStream(path: string): Promise<AsyncIterable<Uint8Array>> {
      return scoped.downloadStream(path);
    },

    async remove(paths: readonly string[]): Promise<void> {
      await scoped.remove([...paths]);
    },

    list(prefix: string) {
      return scoped.list(prefix);
    },
  };
}
