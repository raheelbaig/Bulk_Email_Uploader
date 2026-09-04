'use server';

import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { currentWorkspace } from '@/lib/auth/workspace';
import { isAppError } from '@/lib/errors';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import {
  createImport,
  inspectImport,
  confirmMapping,
  runQueuedImport,
  type CreatedImport,
  type InspectionResult,
} from '@/lib/imports/service';
import { sweepStagedFiles } from '@/lib/imports/lifecycle';
import { columnMappingSchema } from '@/lib/imports/mapping';

/**
 * Server actions for the import flow.
 *
 * Every one resolves the workspace server-side through `currentWorkspace()`.
 * None accepts a workspace id from the form — a forged hidden field achieves
 * nothing, which is the point of the pattern P1 established.
 *
 * The import id *is* accepted from the client, because it has to be; it is
 * validated and authorized inside the service layer against the resolved
 * workspace, so an id belonging to another tenant is refused there.
 */

export interface ImportActionState {
  ok: boolean;
  message: string | null;
  /** Present after a successful create, for the client to upload with. */
  created?: CreatedImport;
  /** Present after a successful inspect, for the mapping screen. */
  inspection?: InspectionResult;
}

export const IMPORT_IDLE: ImportActionState = { ok: false, message: null };

async function run(
  route: string,
  fn: () => Promise<ImportActionState>,
): Promise<ImportActionState> {
  return runWithContext({ requestId: newRequestId(), route }, async () => {
    try {
      return await fn();
    } catch (err) {
      // Next's redirect/notFound signals must pass through untouched.
      if (err instanceof Error && 'digest' in err && typeof err.digest === 'string') throw err;

      if (isAppError(err)) {
        logger.warn('import action rejected', { route, code: err.code, cause: err.cause });
        return { ok: false, message: err.userMessage };
      }
      logger.error('import action failed', { route, cause: err });
      return { ok: false, message: 'Something went wrong on our side. Try again shortly.' };
    }
  });
}

/** Step 1 — reserve an import and a signed upload URL. */
export async function createImportAction(input: {
  filename: string;
  byteSize: number;
  contentType: string;
  targetListId: string | null;
}): Promise<ImportActionState> {
  return run('action:createImport', async () => {
    const { workspaceId } = await currentWorkspace();
    const created = await createImport(workspaceId, {
      filename: input.filename,
      byteSize: input.byteSize,
      contentType: input.contentType,
      targetListId: input.targetListId,
    });
    return { ok: true, message: null, created };
  });
}

/** Step 2 — read the uploaded file and propose a mapping. Writes no contacts. */
export async function inspectImportAction(importId: string): Promise<ImportActionState> {
  return run('action:inspectImport', async () => {
    const { workspaceId } = await currentWorkspace();
    const inspection = await inspectImport(workspaceId, importId);
    return { ok: true, message: null, inspection };
  });
}

/**
 * Step 3 — the user's confirmation, and the start of processing.
 *
 * Parsing runs in `after()`: the response returns as soon as the import is
 * queued, and the work continues after it. The browser is never held open for a
 * 50,000-row file, and the queue row means a crash mid-parse leaves a claimable
 * job rather than an import stuck in `processing` with no way back.
 */
export async function confirmMappingAction(input: {
  importId: string;
  mapping: unknown;
  targetListId: string | null;
}): Promise<ImportActionState> {
  return run('action:confirmMapping', async () => {
    const { workspaceId } = await currentWorkspace();

    // Parsed here as well as in the service so a malformed payload is a clear
    // validation error rather than a cast that fails deeper in.
    const mapping = columnMappingSchema.parse(input.mapping);

    await confirmMapping(workspaceId, input.importId, mapping, input.targetListId);

    after(async () => {
      await runWithContext(
        { requestId: newRequestId(), route: 'background:runImport', workspaceId },
        async () => {
          try {
            await runQueuedImport(workspaceId, input.importId);
          } catch (cause) {
            logger.error('background import run failed', { importId: input.importId, cause });
          }
          try {
            // Bounded maintenance, on the same pass. Becomes a pg_cron schedule
            // when P5 introduces it; the function does not change.
            await sweepStagedFiles(workspaceId);
          } catch (cause) {
            logger.warn('staged file sweep failed', { cause });
          }
        },
      );
    });

    revalidatePath('/imports');
    return { ok: true, message: 'Import started.' };
  });
}

/**
 * Retries a queued import whose background pass did not finish.
 *
 * Idempotent by construction: the claim is atomic, so pressing this while the
 * import is already running does nothing at all.
 */
export async function retryImportAction(importId: string): Promise<ImportActionState> {
  return run('action:retryImport', async () => {
    const { workspaceId } = await currentWorkspace();
    const outcome = await runQueuedImport(workspaceId, importId);
    revalidatePath('/imports');
    revalidatePath(`/imports/${importId}`);

    if (outcome.kind === 'skipped') {
      return { ok: true, message: 'That import is already being processed.' };
    }
    if (outcome.kind === 'failed') {
      return { ok: false, message: outcome.message };
    }
    return { ok: true, message: 'Import complete.' };
  });
}
