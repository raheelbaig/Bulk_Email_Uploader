'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentWorkspace } from '@/lib/auth/workspace';
import { isAppError } from '@/lib/errors';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import type { FormState } from '@/lib/form-state';
import { createTemplate, deleteTemplate, updateTemplate } from '@/lib/templates/service';

/**
 * Server actions for templates.
 *
 * The workspace is resolved server-side through `currentWorkspace()`; no action
 * accepts a workspace id from the form. Template ids *are* accepted, and are
 * authorised inside the service against the resolved workspace, so an id
 * belonging to another tenant is refused there with the same answer as one that
 * does not exist.
 *
 * The HTML submitted here is untrusted and is treated as such by the service,
 * which sanitises before storing. Nothing on this path renders it.
 */

async function run(route: string, fn: () => Promise<FormState>): Promise<FormState> {
  return runWithContext({ requestId: newRequestId(), route }, async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && 'digest' in err && typeof err.digest === 'string') throw err;

      if (isAppError(err)) {
        logger.warn('template action rejected', { route, code: err.code, cause: err.cause });
        return { ok: false, message: err.userMessage };
      }
      logger.error('template action failed', { route, cause: err });
      return { ok: false, message: 'Something went wrong on our side. Try again shortly.' };
    }
  });
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

function templateInput(form: FormData) {
  return {
    name: text(form, 'name'),
    subject: text(form, 'subject'),
    previewText: text(form, 'previewText'),
    html: text(form, 'html'),
    // Blank means "derive it from the HTML" — see lib/templates/text.ts.
    text: text(form, 'text'),
  };
}

/** Describes what the save changed, so a silent sanitisation is never silent. */
function savedMessage(result: { sanitized: boolean; textGenerated: boolean }): string {
  const notes: string[] = [];
  if (result.sanitized) {
    notes.push('Some markup was removed because it is not allowed in a template.');
  }
  if (result.textGenerated) notes.push('The plain-text version was generated from the HTML.');
  return ['Template saved.', ...notes].join(' ');
}

export async function createTemplateAction(_prev: FormState, form: FormData): Promise<FormState> {
  let createdId: string | null = null;

  const state = await run('action:createTemplate', async () => {
    const { workspaceId } = await currentWorkspace();
    const result = await createTemplate(workspaceId, templateInput(form));
    createdId = result.record.id;

    revalidatePath('/templates');
    return { ok: true, message: savedMessage(result) };
  });

  // Redirect outside the try/catch: `redirect()` throws by design, and catching
  // it would turn a successful navigation into an error message.
  if (createdId !== null) redirect(`/templates/${createdId}`);
  return state;
}

export async function updateTemplateAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:updateTemplate', async () => {
    const { workspaceId } = await currentWorkspace();
    const templateId = text(form, 'templateId');
    const result = await updateTemplate(workspaceId, templateId, templateInput(form));

    revalidatePath('/templates');
    revalidatePath(`/templates/${templateId}`);

    return {
      ok: true,
      message: `${savedMessage(result)} Now at version ${result.record.version}. Campaigns already scheduled keep the content they were frozen with.`,
    };
  });
}

export async function deleteTemplateAction(form: FormData): Promise<void> {
  const { workspaceId } = await currentWorkspace();
  await deleteTemplate(workspaceId, String(form.get('templateId') ?? ''));
  revalidatePath('/templates');
  redirect('/templates');
}
