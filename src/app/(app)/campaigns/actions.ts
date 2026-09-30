'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentWorkspace } from '@/lib/auth/workspace';
import { isAppError } from '@/lib/errors';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import type { FormState } from '@/lib/form-state';
import { readCheckbox } from '@/lib/form-fields';
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
      // Unticked → 'false'; absent → undefined (the service defaults to true).
      requiresUnsubscribe: readCheckbox(form, 'requiresUnsubscribe'),
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
    const requiresUnsubscribe = readCheckbox(form, 'requiresUnsubscribe');
    if (requiresUnsubscribe !== undefined) input['requiresUnsubscribe'] = requiresUnsubscribe;

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
      // The "check" run treats a missing send time as a notice; scheduling does
      // not. Don't say "can be scheduled" while it still can't.
      const timeMissing = result.info.some((issue) => issue.code === 'schedule_missing');
      return {
        ok: true,
        message: `Checks passed${result.warnings.length > 0 ? ` with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}` : ''}. ${timeMissing ? 'Choose when this campaign should be sent, then schedule it.' : 'This campaign can be scheduled.'}`,
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
 * The wording of the success message is deliberate: it says whether the
 * campaign will be delivered. A person who schedules something and is not told that would
 * reasonably assume it went out.
 */
export async function scheduleCampaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:scheduleCampaign', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');

    const { campaign } = await scheduleCampaign(workspaceId, campaignId);
    refresh(campaignId);

    const message =
      campaign.approved_send_mode === 'live'
        ? 'Campaign scheduled. It will be sent to its recipients at the scheduled time.'
        : campaign.approved_send_mode === 'dry_run'
          ? 'Campaign scheduled in test mode. At the scheduled time every step runs, but no email is delivered.'
          : 'Campaign scheduled. Email sending is turned off, so it won’t be sent. If sending is turned on later, you’ll need to schedule it again.';

    return { ok: true, message };
  });
}

export async function unscheduleCampaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:unscheduleCampaign', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');

    await unscheduleCampaign(workspaceId, campaignId);
    refresh(campaignId);

    return { ok: true, message: 'Campaign moved back to draft. You can make changes and schedule it again.' };
  });
}

// Cancel and delete return a FormState so a refusal — the worker moved the
// campaign on since the page rendered — is shown as a message rather than
// thrown into the error boundary.

export async function cancelCampaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:cancelCampaign', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');
    await cancelCampaign(workspaceId, campaignId);
    refresh(campaignId);
    return { ok: true, message: 'Campaign cancelled. Nothing further will be sent.' };
  });
}

export async function deleteCampaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:deleteCampaign', async () => {
    const { workspaceId } = await currentWorkspace();
    await deleteCampaign(workspaceId, text(form, 'campaignId'));
    revalidatePath('/campaigns');
    redirect('/campaigns');
  });
}

export async function pauseSendingAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:pauseSending', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');
    await pauseSending(workspaceId, campaignId);
    refresh(campaignId);
    return {
      ok: true,
      message: 'Paused. Emails that already went out can’t be recalled; nothing further will be sent.',
    };
  });
}

export async function resumeSendingAction(_prev: FormState, form: FormData): Promise<FormState> {
  return run('action:resumeSending', async () => {
    const { workspaceId } = await currentWorkspace();
    const campaignId = text(form, 'campaignId');
    await resumeSending(workspaceId, campaignId);
    refresh(campaignId);
    return { ok: true, message: 'Checks passed. The campaign will continue shortly.' };
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
