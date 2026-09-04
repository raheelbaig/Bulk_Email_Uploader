import 'server-only';
import { serviceForWorkspace } from '@/lib/db/service';
import { logger } from '@/lib/observability/logger';
import { STAGED_FILE_MAX_AGE_MS } from './constants';
import { importStorage } from './repository';

/**
 * Staged-file lifecycle.
 *
 * ARCHITECTURE §20.1: the staged file is deleted immediately on success, and
 * anything left behind goes within 24 hours. The runner does the first; this
 * does the second, for the cases the first cannot cover — a failed parse, an
 * upload that was never mapped, a browser closed halfway through, a process that
 * died between the upload and the import.
 *
 * Deliberately not the browser's job. A client-side delete runs only when the
 * client chooses to, which for an abandoned upload is never. Storage is not
 * where personal data should accumulate silently.
 */

export interface SweepResult {
  /** Object keys removed. */
  removed: string[];
  /** Imports whose files were removed while still non-terminal. */
  abandoned: string[];
}

/**
 * Sweeps one workspace's staged files.
 *
 * Bounded work: it looks only at imports older than the retention window that
 * are still holding a file, and it removes at most `limit` of them per call. A
 * sweep is a maintenance task, not an operation that may take a request's
 * entire time budget.
 *
 * Called opportunistically after each import finishes. When pg_cron arrives with
 * the sending engine (P5), this becomes a scheduled call and the opportunistic
 * one can go; the function itself does not change.
 */
export async function sweepStagedFiles(workspaceId: string, limit = 50): Promise<SweepResult> {
  const db = serviceForWorkspace(workspaceId);
  const storage = importStorage(workspaceId);
  const cutoff = new Date(Date.now() - STAGED_FILE_MAX_AGE_MS).toISOString();

  const { data, error } = await db
    .select('imports', 'id, status, storage_path, created_at')
    .lt('created_at', cutoff)
    .neq('storage_path', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error !== null) {
    logger.error('staged file sweep query failed', { dbError: error.message });
    return { removed: [], abandoned: [] };
  }

  const candidates = (data ?? []) as unknown as Array<{
    id: string;
    status: string;
    storage_path: string;
  }>;

  if (candidates.length === 0) return { removed: [], abandoned: [] };

  const removed: string[] = [];
  const abandoned: string[] = [];

  for (const candidate of candidates) {
    try {
      await storage.remove([candidate.storage_path]);
      removed.push(candidate.storage_path);
    } catch (cause) {
      // An already-absent object is the common case: the runner deleted it on
      // success and this pass is only confirming. Not worth an error log.
      logger.debug('staged file removal skipped', { importId: candidate.id, cause });
      continue;
    }

    // An import still in a non-terminal state whose file has now been deleted
    // can never complete. Recording that honestly is better than leaving a row
    // that looks like it is still working.
    if (candidate.status === 'uploaded' || candidate.status === 'mapping') {
      abandoned.push(candidate.id);
      await db
        .update('imports', {
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_message:
            'This upload was not completed within 24 hours, so the staged file was deleted. Upload the file again to import it.',
        })
        .eq('id', candidate.id)
        .in('status', ['uploaded', 'mapping']);
    }
  }

  if (removed.length > 0) {
    logger.info('swept staged import files', {
      workspaceId,
      removedCount: removed.length,
      abandonedCount: abandoned.length,
    });
  }

  return { removed, abandoned };
}
