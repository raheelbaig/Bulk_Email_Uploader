'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentWorkspace } from '@/lib/auth/workspace';
import { isAppError } from '@/lib/errors';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import type { FormState } from '@/lib/form-state';
import {
  createContact,
  updateContact,
  deleteContact,
  type ContactInput,
} from '@/lib/contacts/service';
import {
  createContactList,
  renameContactList,
  deleteContactList,
  addListMember,
  removeListMember,
} from '@/lib/lists/service';
import { addSuppression, removeSuppression, SUPPRESSION_REASONS } from '@/lib/suppression/service';

/**
 * Server actions for contacts, lists and suppression.
 *
 * Every action resolves the workspace server-side through `currentWorkspace()`.
 * No action accepts a workspace id from the form — that is the whole point of
 * the pattern, and it means a forged hidden field achieves nothing.
 */


/**
 * Wraps an action so that a typed error becomes a user-safe message and anything
 * else becomes a generic one, with the detail logged against a correlation id.
 * Next.js redirect/notFound signals are re-thrown untouched.
 */
async function run(route: string, fn: () => Promise<FormState>): Promise<FormState> {
  return runWithContext({ requestId: newRequestId(), route }, async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && 'digest' in err && typeof err.digest === 'string') throw err;

      if (isAppError(err)) {
        logger.warn('action rejected', { route, code: err.code, cause: err.cause });
        return { ok: false, message: err.userMessage };
      }
      logger.error('action failed', { route, cause: err });
      return { ok: false, message: 'Something went wrong on our side. Try again shortly.' };
    }
  });
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

function contactInputFrom(form: FormData): ContactInput {
  return {
    email: text(form, 'email'),
    firstName: text(form, 'firstName'),
    lastName: text(form, 'lastName'),
    company: text(form, 'company'),
    website: text(form, 'website'),
    phone: text(form, 'phone'),
  };
}

// ── Contacts ────────────────────────────────────────────────────────────────

export async function createContactAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  return run('action:createContact', async () => {
    const { workspaceId } = await currentWorkspace();
    await createContact(workspaceId, contactInputFrom(form));
    revalidatePath('/contacts');
    return { ok: true, message: 'Contact added.' };
  });
}

export async function updateContactAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  return run('action:updateContact', async () => {
    const { workspaceId } = await currentWorkspace();
    const contactId = text(form, 'contactId');
    await updateContact(workspaceId, contactId, contactInputFrom(form));
    revalidatePath('/contacts');
    revalidatePath(`/contacts/${contactId}`);
    return { ok: true, message: 'Changes saved.' };
  });
}

export async function deleteContactAction(form: FormData): Promise<void> {
  const { workspaceId } = await currentWorkspace();
  await deleteContact(workspaceId, text(form, 'contactId'));
  revalidatePath('/contacts');
  redirect('/contacts');
}

// ── Lists ───────────────────────────────────────────────────────────────────

export async function createListAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:createList', async () => {
    const { workspaceId } = await currentWorkspace();
    await createContactList(workspaceId, text(form, 'name'));
    revalidatePath('/lists');
    return { ok: true, message: 'List created.' };
  });
}

export async function renameListAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:renameList', async () => {
    const { workspaceId } = await currentWorkspace();
    const listId = text(form, 'listId');
    await renameContactList(workspaceId, listId, text(form, 'name'));
    revalidatePath('/lists');
    revalidatePath(`/lists/${listId}`);
    return { ok: true, message: 'List renamed.' };
  });
}

export async function deleteListAction(form: FormData): Promise<void> {
  const { workspaceId } = await currentWorkspace();
  await deleteContactList(workspaceId, text(form, 'listId'));
  revalidatePath('/lists');
  redirect('/lists');
}

export async function addListMemberAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:addListMember', async () => {
    const { workspaceId } = await currentWorkspace();
    const listId = text(form, 'listId');
    const result = await addListMember(workspaceId, listId, text(form, 'contactId'));
    revalidatePath(`/lists/${listId}`);
    revalidatePath('/lists');
    return {
      ok: true,
      message: result.added ? 'Contact added to the list.' : 'That contact is already on the list.',
    };
  });
}

export async function removeListMemberAction(form: FormData): Promise<void> {
  const { workspaceId } = await currentWorkspace();
  const listId = String(form.get('listId') ?? '');
  await removeListMember(workspaceId, listId, String(form.get('contactId') ?? ''));
  revalidatePath(`/lists/${listId}`);
  revalidatePath('/lists');
}

// ── Suppression ─────────────────────────────────────────────────────────────

export async function addSuppressionAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:addSuppression', async () => {
    const { workspaceId } = await currentWorkspace();

    const rawReason = text(form, 'reason');
    const reason = (SUPPRESSION_REASONS as readonly string[]).includes(rawReason)
      ? (rawReason as (typeof SUPPRESSION_REASONS)[number])
      : 'manually_blocked';

    const result = await addSuppression(workspaceId, {
      email: text(form, 'email'),
      reason,
      source: 'manual',
      detail: text(form, 'detail'),
    });

    revalidatePath('/suppressions');
    revalidatePath('/contacts');
    return {
      ok: true,
      message: result.created
        ? 'Address suppressed. It can no longer be emailed from this workspace.'
        : 'That address was already suppressed.',
    };
  });
}

export async function removeSuppressionAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  return run('action:removeSuppression', async () => {
    const { workspaceId } = await currentWorkspace();
    await removeSuppression(workspaceId, text(form, 'suppressionId'));
    revalidatePath('/suppressions');
    revalidatePath('/contacts');
    return { ok: true, message: 'Suppression removed.' };
  });
}
