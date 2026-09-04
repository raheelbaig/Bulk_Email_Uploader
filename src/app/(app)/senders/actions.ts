'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentWorkspace } from '@/lib/auth/workspace';
import { isAppError } from '@/lib/errors';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import type { FormState } from '@/lib/form-state';
import {
  addSenderDomain,
  refreshSenderDomain,
  removeSenderDomain,
} from '@/lib/sender/service';
import {
  createSenderIdentity,
  deleteSenderIdentity,
  updateSenderIdentity,
} from '@/lib/sender/identities';

/**
 * Server actions for sender configuration.
 *
 * The workspace is resolved server-side through `currentWorkspace()`; no action
 * accepts a workspace id from the form. Domain and identity ids *are* accepted,
 * because they have to be — each is authorized inside the service layer against
 * the resolved workspace, so an id belonging to another tenant is refused there
 * with the same answer as one that does not exist.
 *
 * Nothing here can set a verification status. The only action that changes one
 * is `verifyDomainAction`, which triggers a check whose result comes from SES
 * and DNS; the form has no field that could influence the outcome.
 */

async function run(route: string, fn: () => Promise<FormState>): Promise<FormState> {
  return runWithContext({ requestId: newRequestId(), route }, async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && 'digest' in err && typeof err.digest === 'string') throw err;

      if (isAppError(err)) {
        logger.warn('sender action rejected', { route, code: err.code, cause: err.cause });
        return { ok: false, message: err.userMessage };
      }
      logger.error('sender action failed', { route, cause: err });
      return { ok: false, message: 'Something went wrong on our side. Try again shortly.' };
    }
  });
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

// ── Domains ─────────────────────────────────────────────────────────────────

export async function addDomainAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:addSenderDomain', async () => {
    const { workspaceId } = await currentWorkspace();
    const result = await addSenderDomain(workspaceId, text(form, 'domain'));

    revalidatePath('/senders');
    revalidatePath(`/senders/${result.view.record.id}`);

    return {
      ok: true,
      message: result.created
        ? 'Domain added. Publish the DNS records below, then check verification.'
        : 'That domain is already set up. Its current DNS records are below.',
    };
  });
}

export async function verifyDomainAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:verifySenderDomain', async () => {
    const { workspaceId } = await currentWorkspace();
    const domainId = text(form, 'domainId');
    const result = await refreshSenderDomain(workspaceId, domainId);

    revalidatePath('/senders');
    revalidatePath(`/senders/${domainId}`);

    if (result.patch.last_check_error !== null) {
      return { ok: false, message: result.patch.last_check_error };
    }
    return {
      ok: true,
      message: result.usable
        ? 'Verification complete. This domain can be used to send.'
        : 'Checked. Some records are still outstanding — see the status below.',
    };
  });
}

export async function removeDomainAction(form: FormData): Promise<void> {
  const { workspaceId } = await currentWorkspace();
  await removeSenderDomain(workspaceId, String(form.get('domainId') ?? ''));
  revalidatePath('/senders');
  redirect('/senders');
}

// ── Identities ──────────────────────────────────────────────────────────────

export async function createIdentityAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:createSenderIdentity', async () => {
    const { workspaceId } = await currentWorkspace();
    await createSenderIdentity(workspaceId, {
      fromEmail: text(form, 'fromEmail'),
      fromName: text(form, 'fromName'),
      replyTo: text(form, 'replyTo'),
    });

    revalidatePath('/senders/identities');
    revalidatePath('/senders');
    return { ok: true, message: 'Sender address added.' };
  });
}

export async function updateIdentityAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:updateSenderIdentity', async () => {
    const { workspaceId } = await currentWorkspace();
    await updateSenderIdentity(workspaceId, text(form, 'identityId'), {
      fromName: text(form, 'fromName'),
      replyTo: text(form, 'replyTo'),
    });

    revalidatePath('/senders/identities');
    return { ok: true, message: 'Changes saved.' };
  });
}

export async function deleteIdentityAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:deleteSenderIdentity', async () => {
    const { workspaceId } = await currentWorkspace();
    await deleteSenderIdentity(workspaceId, text(form, 'identityId'));

    revalidatePath('/senders/identities');
    revalidatePath('/senders');
    return { ok: true, message: 'Sender address removed.' };
  });
}
