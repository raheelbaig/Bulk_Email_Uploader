'use server';

import { revalidatePath } from 'next/cache';
import { currentWorkspace } from '@/lib/auth/workspace';
import { isAppError } from '@/lib/errors';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import type { FormState } from '@/lib/form-state';
import { updatePostalAddress } from '@/lib/workspace/settings';

/**
 * Workspace settings actions. The workspace is resolved server-side; no action
 * accepts one from the form.
 */
export async function updatePostalAddressAction(_prev: FormState, form: FormData): Promise<FormState> {
  return runWithContext({ requestId: newRequestId(), route: 'action:updatePostalAddress' }, async () => {
    try {
      const { workspaceId } = await currentWorkspace();
      const value = form.get('postalAddress');
      const saved = await updatePostalAddress(workspaceId, typeof value === 'string' ? value : '');
      revalidatePath('/settings');
      return {
        ok: true,
        message:
          saved === null
            ? 'Address removed. Campaigns that require an unsubscribe link cannot be scheduled or sent until one is added.'
            : 'Address saved. It is added to the footer of every bulk message.',
      };
    } catch (err) {
      if (err instanceof Error && 'digest' in err && typeof err.digest === 'string') throw err;
      if (isAppError(err)) {
        logger.warn('settings action rejected', { code: err.code, cause: err.cause });
        return { ok: false, message: err.userMessage };
      }
      logger.error('settings action failed', { cause: err });
      return { ok: false, message: 'Something went wrong on our side. Try again shortly.' };
    }
  });
}
