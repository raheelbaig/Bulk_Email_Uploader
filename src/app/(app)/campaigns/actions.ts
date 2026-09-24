'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentWorkspace } from '@/lib/auth/workspace';
import { isAppError } from '@/lib/errors';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import type { FormState } from '@/lib/form-state';
import {
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  runCampaignPreflight,
  scheduleCampaign,
  unscheduleCampaign,
  updateCampaignDraft,
} from '@/lib/campaigns/service';
import { pauseSending, resolveUncertainSend, resumeSending } from '@/lib/sending/service';

/**
 * Server actions for the campaign builder.
 *
 * ── What is not here ──────────────────────────────────────────────────────
 *
 * There is no "send now" action, no test-send action and no launch action. A
 * campaign is delivered only by the worker (`lib/sending/worker`), when its
 * scheduled time arrives and preflight passes again. What a person can do to a
 * campaign in flight is stop it (pause, cancel), let it continue (resume, which
 * re-runs preflight), and decide about messages whose outcome is unknown.
 *
 * The workspace is resolved server-side; no action accepts one from a form.
 * Campaign, list, sender and template ids are accepted and authorised in the
 * service, and the composite foreign keys refuse a cross-tenant reference even
 * if that check were somehow skipped.
 */

async function run(route: string, fn: () => Promise<FormState>): Promise<FormState> {
  return runWithContext({ requestId: newRequestId(), route }, async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && 'digest' in err && typeof err.digest === 'string') throw err;

      if (isAppError(err)) {
        logger.warn('campaign action rejected', { route, code: err.code, cause: err.cause });
        return { ok: false, message: err.userMessage };
      }
      logger.error('campaign action failed', { route, cause: err });
      return { ok: false, message: 'Something went wrong on our side. Try again shortly.' };
    }
  });
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

function refresh(campaignId: string): void {
  revalidatePath('/campaigns');
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function createCampaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  let createdId: string | null = null;

  const state = await run('action:createCampaign', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaign = await createCampaign(workspaceId, {
      name: text(form, 'name'),
      requiresUnsubscribe: form.get('requiresUnsubscribe') === 'false' ? 'false' : 'true',
    });
    createdId = campaign.id;

    revalidatePath('/campaigns');
    return { ok: true, message: 'Campaign created.' };
  });

  if (createdId !== null) redirect(`/campaigns/${createdId}`);
  return state;
}

/**
 * One action for every step of the builder.
 *
 * Each step submits only its own field, and `updateCampaignDraft` applies only
 * the keys that are present — so choosing a sender does not clear the audience.
 */
export async function updateCampaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:updateCampaign', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');

    const input: Record<string, unknown> = {};
    for (const key of ['name', 'listId', 'senderIdentityId', 'templateId', 'scheduledAtLocal'] as const) {
      if (form.has(key)) input[key] = text(form, key);
    }
    if (form.has('requiresUnsubscribe')) {
      input['requiresUnsubscribe'] = text(form, 'requiresUnsubscribe');
    }

    await updateCampaignDraft(workspaceId, campaignId, input);
    refresh(campaignId);

    return { ok: true, message: 'Campaign updated.' };
  });
}

export async function runPreflightAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:runCampaignPreflight', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');

    const { result } = await runCampaignPreflight(workspaceId, campaignId);
    refresh(campaignId);

    if (result.ready) {
      return {
        ok: true,
        message: `Checks passed${result.warnings.length > 0 ? ` with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}` : ''}. This campaign can be scheduled.`,
      };
    }
    return {
      ok: false,
      message: `${result.blockers.length} ${result.blockers.length === 1 ? 'problem' : 'problems'} must be fixed before this campaign can be scheduled.`,
    };
  });
}

/**
 * Freezes the template and records the schedule.
 *
 * The wording of the success message is deliberate: it says the campaign will
 * not be delivered. A person who schedules something and is not told that would
 * reasonably assume it went out.
 */
export async function scheduleCampaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:scheduleCampaign', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');

    await scheduleCampaign(workspaceId, campaignId);
    refresh(campaignId);

    return {
      ok: true,
      message:
        'Campaign scheduled and its content frozen. It starts at the scheduled time if the sending mode of this deployment allows it — the campaign page says which mode is active.',
    };
  });
}

export async function unscheduleCampaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:unscheduleCampaign', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');

    await unscheduleCampaign(workspaceId, campaignId);
    refresh(campaignId);

    return { ok: true, message: 'Campaign returned to draft. Its frozen content was cleared.' };
  });
}

export async function cancelCampaignAction(form: FormData): Promise<void> {
  const { workspaceId } = await currentWorkspace();
  const campaignId = String(form.get('campaignId') ?? '');
  await cancelCampaign(workspaceId, campaignId);
  refresh(campaignId);
}

export async function deleteCampaignAction(form: FormData): Promise<void> {
  const { workspaceId } = await currentWorkspace();
  await deleteCampaign(workspaceId, String(form.get('campaignId') ?? ''));
  revalidatePath('/campaigns');
  redirect('/campaigns');
}

export async function pauseSendingAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:pauseSending', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');
    await pauseSending(workspaceId, campaignId);
    refresh(campaignId);
    return {
      ok: true,
      message: 'Paused. Messages already handed to Amazon SES cannot be recalled; nothing further will go out.',
    };
  });
}

export async function resumeSendingAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:resumeSending', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');
    await resumeSending(workspaceId, campaignId);
    refresh(campaignId);
    return { ok: true, message: 'Checks passed. The campaign will continue on the next worker run.' };
  });
}

/**
 * A decision about one message whose delivery could not be confirmed. The
 * `redispatch` choice may deliver a duplicate; the UI says so beside the button.
 */
export async function resolveUncertainAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:resolveUncertain', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');
    const decision = text(form, 'decision');
    await resolveUncertainSend(workspaceId, text(form, 'jobId'), decision);
    refresh(campaignId);
    return {
      ok: true,
      message: decision === 'redispatch' ? 'The message will be sent again.' : 'The message was left as not sent.',
    };
  });
}
