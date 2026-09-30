import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CalendarClock, Eye, Info, Lock, Plus } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { isAppError } from '@/lib/errors';
import {
  buildCampaignPreview,
  listAudienceOptions,
  previewCampaignPreflight,
} from '@/lib/campaigns/service';
import { listSenderIdentities } from '@/lib/sender/identities';
import { listTemplateOptions } from '@/lib/templates/service';
import { formatInZone, toLocalInputValue } from '@/lib/campaigns/schedule';
import { STATUS_LABEL, TERMINAL_STATUSES, pauseReasonLabel } from '@/lib/campaigns/status';
import type { PreflightCode, PreflightIssue } from '@/lib/campaigns/preflight';
import { checkboxShownField } from '@/lib/form-fields';
import { sendingConfig } from '@/lib/sending/config';
import { LIVE_REQUIREMENT_MESSAGE, SENDING_MODE_LABEL, SENDING_MODE_NOTICE } from '@/lib/sending/gate';
import { getDeliverySummary } from '@/lib/sending/service';
import {
  cancelCampaignAction,
  deleteCampaignAction,
  pauseSendingAction,
  resolveUncertainAction,
  resumeSendingAction,
  runPreflightAction,
  scheduleCampaignAction,
  unscheduleCampaignAction,
  updateCampaignAction,
} from '../actions';
import { DeliveryPanel } from '@/components/delivery-panel';
import { ActionForm } from '@/components/action-form';
import { AutoSaveForm } from '@/components/auto-save-form';
import { Checklist, type ChecklistItem } from '@/components/checklist';
import { FieldShell } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { friendlyResult } from '@/components/preflight-copy';
import { PreflightReport } from '@/components/preflight-report';
import { SENDER_BLOCKER_COPY } from '@/components/sender-copy';
import { CampaignStatusBadge, StatusBadge } from '@/components/status-badge';
import { Stepper, type StepItem, type StepState } from '@/components/stepper';
import { MessagePreview } from '@/components/template-preview';
import { SENDING_MODE_EXPLANATION, SENDING_MODE_HEADLINE } from '@/components/sending-copy';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * The campaign builder.
 *
 * Six steps, in the order a person thinks about them: details, who receives it,
 * what they receive, who it comes from, review, schedule. Every choice saves
 * itself through the same server action as soon as it changes (`AutoSaveForm`),
 * so what the page shows is always what is stored. The stepper and the
 * readiness list beside the Schedule button are derived from the saved campaign
 * and the server's preflight verdict, never from client state.
 *
 * ── One column, at every width ────────────────────────────────────────────
 *
 * The page column is capped (`max-w-6xl`), so a side-by-side preview would
 * always squeeze the steps into ~600px. The preview lives in the Review step
 * instead, full width, where a person actually checks the email.
 *
 * ── "Ready" means "can be scheduled" ──────────────────────────────────────
 *
 * The builder runs preflight with the `check` intent, which treats a missing
 * send time as a notice (the person hasn't got there yet). Scheduling runs it
 * again with the `schedule` intent, where a missing time blocks. So this page
 * adds the send time to its own readiness and never says "ready" while
 * scheduling would still refuse. The server-side gates are unchanged.
 *
 * ── Two things this page deliberately does not do ────────────────────────
 *
 * It does not load the audience. The counts come from an indexed aggregate in
 * the database, and the preview's contact picker is a bounded sample.
 *
 * It does not offer a way to send. The final control is "Schedule campaign";
 * delivery happens when the time arrives, and the notice beside the button
 * states what this installation's sending setting will do with it.
 */

const STEP_BADGE: Record<StepState, { tone: 'positive' | 'warning' | 'neutral' | 'info'; label: string }> = {
  complete: { tone: 'positive', label: 'Done' },
  attention: { tone: 'warning', label: 'Needs attention' },
  current: { tone: 'info', label: 'Next step' },
  upcoming: { tone: 'neutral', label: 'Not started' },
};

function Step({
  id,
  number,
  title,
  description,
  state,
  children,
}: {
  id: string;
  number: number;
  title: string;
  description?: string;
  state?: StepState;
  children: React.ReactNode;
}) {
  const badge = state === undefined ? undefined : STEP_BADGE[state];
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        'scroll-mt-24 rounded-xl border bg-(--color-card) shadow-xs',
        state === 'attention' && 'border-(--color-warning-border)',
        state === 'current' && 'border-(--color-primary)/30 ring-4 ring-(--color-primary-subtle)',
      )}
    >
      <header className="flex flex-col gap-2 px-5 pt-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="flex min-w-0 gap-3">
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
              state === 'complete'
                ? 'border-(--color-success) bg-(--color-success) text-white'
                : state === 'current'
                  ? 'border-(--color-primary) bg-(--color-primary) text-(--color-primary-foreground)'
                  : 'border-(--color-border-strong) text-(--color-muted-foreground)',
            )}
            aria-hidden
          >
            {number}
          </span>
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">
              <span className="sr-only">Step {number}: </span>
              {title}
            </h2>
            {description !== undefined && (
              <p className="mt-0.5 text-sm leading-relaxed text-(--color-muted-foreground)">{description}</p>
            )}
          </div>
        </div>
        {badge !== undefined && (
          <StatusBadge tone={badge.tone} label={badge.label} className="ml-10 w-fit sm:ml-0" />
        )}
      </header>
      <div className="px-5 pt-4 pb-5 sm:px-6 sm:pb-6 sm:pl-16">{children}</div>
    </section>
  );
}

function hasAny(issues: PreflightIssue[], predicate: (code: PreflightCode) => boolean): boolean {
  return issues.some((issue) => predicate(issue.code));
}

/** Blockers the audience/email/sender/address/time items already explain. */
function coveredByItems(code: PreflightCode): boolean {
  return (
    code.startsWith('audience_') ||
    code.startsWith('template_') ||
    code.startsWith('personalization_') ||
    code.startsWith('sender_') ||
    code.startsWith('schedule_') ||
    code === 'postal_address_missing'
  );
}

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { workspaceId, role } = await workspaceForPage();
  const isAdmin = role === 'owner' || role === 'admin';

  const { result, view } = await previewCampaignPreflight(workspaceId, id).catch((err: unknown) => {
    // Absent, not-yours and malformed are the same answer: not found.
    if (isAppError(err) && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND' || err.code === 'VALIDATION_FAILED')) notFound();
    throw err;
  });
  const contactParam = query['contact'];
  const contactId = typeof contactParam === 'string' ? contactParam : undefined;

  const [lists, senders, templates, preview] = await Promise.all([
    listAudienceOptions(workspaceId),
    listSenderIdentities(workspaceId),
    listTemplateOptions(workspaceId),
    buildCampaignPreview(workspaceId, id, { contactId }),
  ]);

  const campaign = view.campaign;
  const editable = view.editable;
  const sending = sendingConfig();
  const launched = campaign.launched_at !== null;
  const delivery = launched ? await getDeliverySummary(workspaceId, campaign.id) : null;
  const sendingBlocked = sending.mode === 'live' && !sending.live.allowed;
  const modeNotice = sendingBlocked
    ? `Live mode is selected but not every requirement is met, so no campaign will start: ${sending.live.unmet
        .map((requirement) => LIVE_REQUIREMENT_MESSAGE[requirement])
        .join(' ')}`
    : SENDING_MODE_NOTICE[sending.mode];
  const friendly = friendlyResult(result);

  // ── Progress, derived from the saved campaign and the preflight verdict ──
  const blockers = result.blockers;
  const audienceProblem = hasAny(blockers, (code) => code.startsWith('audience_'));
  const templateProblem = hasAny(
    blockers,
    (code) => code.startsWith('template_') || code.startsWith('personalization_'),
  );
  const senderProblem = hasAny(blockers, (code) => code.startsWith('sender_'));
  const addressMissing = hasAny(blockers, (code) => code === 'postal_address_missing');
  const scheduleProblem = hasAny(blockers, (code) => code.startsWith('schedule_'));
  const otherBlockers = friendly.blockers.filter((issue) => !coveredByItems(issue.code));

  const audienceDone = campaign.list_id !== null && !audienceProblem;
  const templateDone = campaign.template_id !== null && !templateProblem;
  const senderDone = campaign.sender_identity_id !== null && !senderProblem;
  const timeMissing = campaign.scheduled_at === null;
  const timeDone = !timeMissing && !scheduleProblem;
  const scheduled = !editable && view.status !== 'draft';
  // Everything the schedule gate will ask for, including the send time.
  const canSchedule = editable && result.ready && timeDone;

  const stepState = (done: boolean, touched: boolean): StepState =>
    done ? 'complete' : touched ? 'attention' : 'upcoming';

  const rawSteps: Array<{ id: string; label: string; state: StepState }> = [
    { id: 'details', label: 'Details', state: 'complete' },
    { id: 'audience', label: 'Audience', state: stepState(audienceDone, campaign.list_id !== null) },
    { id: 'email', label: 'Email', state: stepState(templateDone, campaign.template_id !== null) },
    { id: 'sender', label: 'Sender', state: stepState(senderDone, campaign.sender_identity_id !== null) },
    {
      id: 'review',
      label: 'Review',
      state: result.ready || scheduled ? 'complete' : audienceDone && templateDone && senderDone ? 'attention' : 'upcoming',
    },
    {
      id: 'schedule',
      label: 'Schedule',
      state: scheduled ? 'complete' : scheduleProblem ? 'attention' : 'upcoming',
    },
  ];
  // The first unfinished step is "current", unless it already needs attention.
  const firstOpen = rawSteps.findIndex((step) => step.state === 'upcoming');
  const steps: StepItem[] = rawSteps.map((step, index) => ({
    label: step.label,
    href: `#${step.id}`,
    state: index === firstOpen && editable ? 'current' : step.state,
  }));
  const stateOf = (stepId: string): StepState => steps[rawSteps.findIndex((s) => s.id === stepId)]!.state;

  // ── The readiness list shown beside the Schedule button ──
  const needs: ChecklistItem[] = [
    { key: 'name', done: true, title: 'Campaign details', doneLabel: campaign.name },
    {
      key: 'audience',
      done: audienceDone,
      title: audienceDone ? 'Audience' : 'Choose who receives this email',
      description:
        campaign.list_id === null
          ? 'Pick one of your lists in the Audience step.'
          : 'Nobody on the chosen list can receive email right now.',
      ...(view.list === null
        ? {}
        : { doneLabel: `${view.list.name} · ${view.audience.eligible.toLocaleString()} will receive it` }),
      action: { href: '#audience', label: campaign.list_id === null ? 'Choose list' : 'Review audience' },
    },
    {
      key: 'template',
      done: templateDone,
      title: templateDone ? 'Email' : 'Choose the email to send',
      description:
        campaign.template_id === null
          ? 'Pick one of your templates in the Email step.'
          : 'The chosen template has a problem — see the Review step.',
      ...(view.template === null ? {} : { doneLabel: view.template.name }),
      action:
        campaign.template_id === null
          ? { href: '#email', label: 'Choose email' }
          : { href: `/templates/${campaign.template_id}`, label: 'Fix template' },
    },
    {
      key: 'sender',
      done: senderDone,
      title: senderDone ? 'Sender' : campaign.sender_identity_id === null ? 'Choose who it’s from' : 'Sender isn’t verified yet',
      description:
        campaign.sender_identity_id === null
          ? senders.length === 0
            ? 'You don’t have a sender yet. Set one up and verify it first.'
            : 'Pick the address your email will come from in the Sender step.'
          : 'The sender’s domain needs to finish verification before you can send.',
      ...(view.senderIdentity === null
        ? {}
        : { doneLabel: `${view.senderIdentity.from_name} <${view.senderIdentity.from_email}>` }),
      action:
        campaign.sender_identity_id === null && senders.length > 0
          ? { href: '#sender', label: 'Choose sender' }
          : { href: '/senders', label: 'Set up sender' },
    },
  ];
  if (campaign.requires_unsubscribe) {
    needs.push({
      key: 'address',
      done: !addressMissing,
      title: addressMissing ? 'Add your business address' : 'Business address',
      description: 'Marketing emails must show your postal address in the footer.',
      doneLabel: 'Shown in the footer of every email',
      action: { href: '/settings#business-address', label: 'Add address' },
    });
  }
  needs.push({
    key: 'time',
    done: timeDone,
    title: timeDone ? 'Send time' : 'Choose when this campaign should be sent.',
    description: timeMissing
      ? 'Pick a date and time above.'
      : (friendly.blockers.find((issue) => issue.code.startsWith('schedule_'))?.message ?? 'Pick a new date and time above.'),
    doneLabel: timeMissing ? '' : `${formatInZone(campaign.scheduled_at ?? '', view.timeZone)} (${view.timeZone})`,
  });
  if (otherBlockers.length > 0) {
    needs.push({
      key: 'other',
      done: false,
      title: otherBlockers.length === 1 ? otherBlockers[0]!.title : 'Other checks need attention',
      description: otherBlockers.map((issue) => issue.message).join(' '),
      action: { href: '#review', label: 'See details' },
    });
  }
  const open = needs.filter((item) => !item.done);
  const blockedReason =
    open.length === 0
      ? null
      : open.length === 1 && open[0]!.key === 'time'
        ? 'Choose when this campaign should be sent.'
        : `Finish ${open.length === 1 ? 'the item' : `the ${open.length} items`} marked above to schedule this campaign.`;

  // A scheduled campaign starts only under the sending setting it was scheduled with.
  const approvalMismatch =
    view.status === 'scheduled' && campaign.approved_send_mode !== sending.mode;

  const showCancel = !TERMINAL_STATUSES.includes(view.status) && view.status !== 'draft';
  const showDelete = !launched && (view.status === 'draft' || view.status === 'cancelled');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: '/campaigns', label: 'Campaigns' }}
        title={campaign.name}
        meta={<CampaignStatusBadge status={view.status} />}
        description={
          editable
            ? 'Work through the steps below. Your choices save automatically, and nothing is sent until you schedule it.'
            : view.status === 'scheduled'
              ? `Scheduled for ${formatInZone(campaign.scheduled_at ?? '', view.timeZone)} (${view.timeZone}).`
              : launched
                ? 'This campaign has started. Follow its progress below.'
                : `This campaign is ${STATUS_LABEL[view.status].toLowerCase()}.`
        }
        actions={
          preview === null ? undefined : (
            <Link href="#preview" className={buttonVariants({ variant: 'outline' })}>
              <Eye aria-hidden />
              Preview
            </Link>
          )
        }
      />

      {!launched && !TERMINAL_STATUSES.includes(view.status) && (
        <div className="rounded-xl border bg-(--color-card) p-2 shadow-xs">
          <Stepper steps={steps} />
        </div>
      )}

      {view.status === 'scheduled' && (
        <Alert tone={approvalMismatch ? 'warning' : 'info'} title="Scheduled — the email is locked">
          The email content is locked, so later edits to the template won’t change this campaign. To make
          changes, move it back to draft.
          <span className="mt-2 block font-medium">
            {approvalMismatch
              ? 'Email sending settings have changed since this campaign was scheduled, so it won’t start. Move it back to draft and schedule it again.'
              : sendingBlocked
                ? 'Email sending isn’t fully set up yet, so it won’t start until the setup is finished.'
                : sending.mode === 'disabled'
                  ? 'Email sending is turned off, so it won’t be sent. If sending is turned on later, you’ll need to schedule it again.'
                  : SENDING_MODE_EXPLANATION[sending.mode]}
          </span>
          {isAdmin && (
            <details className="mt-2 text-xs">
              <summary className="w-fit cursor-pointer hover:underline">Technical details</summary>
              <p className="mt-1">
                Approved for:{' '}
                {campaign.approved_send_mode === null ? 'none' : SENDING_MODE_LABEL[campaign.approved_send_mode]}.
                Current mode: {SENDING_MODE_LABEL[sending.mode]}. {modeNotice}
              </p>
            </details>
          )}
        </Alert>
      )}

      {view.status === 'paused' && !launched && (
        <Alert tone="destructive" title="This campaign didn’t start">
          {pauseReasonLabel(campaign.pause_reason)}
          <div className="mt-3">
            <ActionForm
              action={unscheduleCampaignAction}
              submitLabel="Return to draft"
              pendingLabel="Working…"
              variant="outline"
            >
              <input type="hidden" name="campaignId" value={campaign.id} />
            </ActionForm>
          </div>
        </Alert>
      )}

      {delivery !== null && (
        <DeliveryPanel
          campaign={campaign}
          summary={delivery}
          pauseAction={pauseSendingAction}
          resumeAction={resumeSendingAction}
          resolveAction={resolveUncertainAction}
        />
      )}

      <div className="flex min-w-0 flex-col gap-4">
        {/* 1 — Details */}
        <Step
          id="details"
          number={1}
          title="Campaign details"
          description="The name is for your team only — recipients never see it."
          state={stateOf('details')}
        >
          {editable ? (
            <AutoSaveForm action={updateCampaignAction} className="flex flex-col gap-2 sm:max-w-md" statusId="name-status">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <FieldShell id="campaign-name" label="Campaign name" required>
                <Input
                  id="campaign-name"
                  name="name"
                  required
                  maxLength={160}
                  defaultValue={campaign.name}
                  aria-describedby="name-status"
                />
              </FieldShell>
            </AutoSaveForm>
          ) : null}
          {editable ? (
            <AutoSaveForm
              action={updateCampaignAction}
              className="mt-4 flex flex-col gap-2 border-t pt-4 sm:max-w-md"
              statusId="unsubscribe-status"
            >
              <input type="hidden" name="campaignId" value={campaign.id} />
              {/* An unticked checkbox submits nothing; this tells the action it was shown. */}
              <input type="hidden" name={checkboxShownField('requiresUnsubscribe')} value="1" />
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="requiresUnsubscribe"
                  value="true"
                  defaultChecked={campaign.requires_unsubscribe}
                  aria-describedby="unsubscribe-status"
                  className="mt-0.5 size-4 accent-(--color-primary)"
                />
                <span>
                  <span className="font-medium">Include an unsubscribe link</span>
                  <span className="mt-0.5 block text-(--color-muted-foreground)">
                    Keep this on for newsletters, promotions and anything marketing-related. Turn it off only for
                    transactional email such as receipts.
                  </span>
                </span>
              </label>
            </AutoSaveForm>
          ) : (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-(--color-muted-foreground)">Name</dt>
                <dd className="font-medium">{campaign.name}</dd>
              </div>
              <div>
                <dt className="text-(--color-muted-foreground)">Unsubscribe link</dt>
                <dd className="font-medium">
                  {campaign.requires_unsubscribe ? 'Included in every email' : 'Not included (transactional email)'}
                </dd>
              </div>
            </dl>
          )}
        </Step>

        {/* 2 — Audience */}
        <Step
          id="audience"
          number={2}
          title="Who should receive this email?"
          description="Choose one of your lists. People who unsubscribed or were blocked are skipped automatically."
          state={stateOf('audience')}
        >
          {lists.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4">
              <p className="text-sm text-(--color-muted-foreground)">
                You don’t have any lists yet. Create one and add contacts to it first.
              </p>
              <Link href="/lists#new" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                <Plus aria-hidden />
                Create a list
              </Link>
            </div>
          ) : editable ? (
            <AutoSaveForm action={updateCampaignAction} statusId="listId-status">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <FieldShell id="listId" label="List" required>
                <Select
                  id="listId"
                  name="listId"
                  defaultValue={campaign.list_id ?? ''}
                  className="w-full"
                  aria-describedby="listId-status"
                >
                  <option value="">Choose a list…</option>
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name} ({list.contact_count.toLocaleString()} contacts)
                    </option>
                  ))}
                </Select>
              </FieldShell>
            </AutoSaveForm>
          ) : null}

          {view.list !== null && (
            <div className={cn(editable && lists.length > 0 && 'mt-4')}>
              {!editable && <p className="mb-3 text-sm font-medium">{view.list.name}</p>}
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: 'On the list', value: view.audience.total, strong: false },
                  { label: 'Will receive it', value: view.audience.eligible, strong: true },
                  { label: 'Unsubscribed or blocked', value: view.audience.suppressed, strong: false },
                  { label: 'Inactive', value: view.audience.inactive, strong: false },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className={cn(
                      'rounded-lg border px-3 py-2.5',
                      stat.strong
                        ? 'border-(--color-success-border) bg-(--color-success-subtle)'
                        : 'bg-(--color-surface-subtle)',
                    )}
                  >
                    <dt className="text-xs text-(--color-muted-foreground)">{stat.label}</dt>
                    <dd className="mt-0.5 text-lg font-semibold tabular-nums">{stat.value.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </Step>

        {/* 3 — Email */}
        <Step
          id="email"
          number={3}
          title="What email are they receiving?"
          description="Choose a template. When you schedule, a copy is saved with the campaign, so later edits to the template don’t change it."
          state={stateOf('email')}
        >
          {templates.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4">
              <p className="text-sm text-(--color-muted-foreground)">
                You don’t have any templates yet. Write your email first, then come back.
              </p>
              <Link href="/templates#new" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                <Plus aria-hidden />
                Create a template
              </Link>
            </div>
          ) : editable ? (
            <AutoSaveForm action={updateCampaignAction} statusId="templateId-status">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <FieldShell id="templateId" label="Template" required>
                <Select
                  id="templateId"
                  name="templateId"
                  defaultValue={campaign.template_id ?? ''}
                  className="w-full"
                  aria-describedby="templateId-status"
                >
                  <option value="">Choose a template…</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </Select>
              </FieldShell>
            </AutoSaveForm>
          ) : null}

          {view.template !== null && (
            <div className={cn('flex flex-col gap-2 text-sm', editable && templates.length > 0 && 'mt-4 border-t pt-4')}>
              {!editable && <p className="font-medium">{view.template.name}</p>}
              <p className="text-(--color-muted-foreground)">
                {view.template.variables.length === 0
                  ? 'This email isn’t personalized — everyone receives the same content.'
                  : 'Personalized with each person’s:'}
              </p>
              {view.template.variables.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {view.template.variables.map((name) => (
                    <Badge key={name}>{name.replace(/_/g, ' ')}</Badge>
                  ))}
                </div>
              )}
              <Link
                href={`/templates/${view.template.id}`}
                className="w-fit text-sm font-medium text-(--color-primary) hover:underline"
              >
                Edit this template
              </Link>
            </div>
          )}
        </Step>

        {/* 4 — Sender */}
        <Step
          id="sender"
          number={4}
          title="Who is sending this email?"
          description="Choose the address your email will come from. Only verified addresses can be used."
          state={stateOf('sender')}
        >
          {senders.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4">
              <p className="text-sm text-(--color-muted-foreground)">
                You don’t have a sender yet. Add the domain you send from, verify it, then add a sender
                address on it.
              </p>
              <Link href="/senders" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                Set up sender
              </Link>
            </div>
          ) : editable ? (
            <AutoSaveForm action={updateCampaignAction} statusId="senderIdentityId-status">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <FieldShell id="senderIdentityId" label="Send from" required>
                <Select
                  id="senderIdentityId"
                  name="senderIdentityId"
                  defaultValue={campaign.sender_identity_id ?? ''}
                  className="w-full"
                  aria-describedby="senderIdentityId-status"
                >
                  <option value="">Choose a sender…</option>
                  {senders.map((sender) => (
                    <option
                      key={sender.record.id}
                      value={sender.record.id}
                      disabled={!sender.readiness.ready && sender.record.id !== campaign.sender_identity_id}
                    >
                      {sender.record.from_name} &lt;{sender.record.from_email}&gt;
                      {sender.readiness.ready ? '' : ' — not verified yet'}
                    </option>
                  ))}
                </Select>
              </FieldShell>
            </AutoSaveForm>
          ) : null}

          {!editable && view.senderIdentity !== null && (
            <p className="text-sm font-medium">
              {view.senderIdentity.from_name} &lt;{view.senderIdentity.from_email}&gt;
            </p>
          )}

          {editable && senders.some((sender) => !sender.readiness.ready) && (
            <div className="mt-3 rounded-lg border bg-(--color-surface-subtle) p-3 text-sm">
              <p className="font-medium">Not ready to use yet</p>
              <ul className="mt-1.5 flex flex-col gap-1.5 text-(--color-muted-foreground)">
                {senders
                  .filter((sender) => !sender.readiness.ready)
                  .map((sender) => (
                    <li key={sender.record.id} className="break-words">
                      <span className="font-medium text-(--color-foreground)">{sender.record.from_email}</span>:{' '}
                      {[...new Set(sender.readiness.blockers.map((blocker) => SENDER_BLOCKER_COPY[blocker]))].join(' ')}
                    </li>
                  ))}
              </ul>
              <Link href="/senders" className="mt-2 inline-block font-medium text-(--color-primary) hover:underline">
                Go to Senders
              </Link>
            </div>
          )}
        </Step>

        {/* 5 — Review */}
        <Step
          id="review"
          number={5}
          title="Review"
          description="Check the email as recipients will see it. We check everything again when you schedule — and right before it sends."
          state={stateOf('review')}
        >
          <div className="flex flex-col gap-5">
            <div id="preview" className="flex min-w-0 scroll-mt-24 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Preview</h3>
                {preview !== null && preview.fromSnapshot && (
                  <StatusBadge tone="info" label="Locked copy" icon={Lock} />
                )}
              </div>
              {preview === null ? (
                <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-(--color-muted-foreground)">
                  Choose an email in step 3 to see a preview.
                </p>
              ) : (
                <>
                  {preview.contacts.length > 0 && (
                    <form method="get" action="#preview" className="flex flex-wrap items-center gap-2">
                      <label htmlFor="contact" className="shrink-0 text-sm text-(--color-muted-foreground)">
                        Preview as
                      </label>
                      <Select id="contact" name="contact" defaultValue={contactId ?? ''} className="min-w-0 flex-1 basis-48">
                        <option value="">Sample contact</option>
                        {preview.contacts.map((contact) => (
                          <option key={contact.id} value={contact.id}>
                            {contact.name === null ? contact.email : `${contact.name} — ${contact.email}`}
                          </option>
                        ))}
                      </Select>
                      <Button type="submit" variant="outline" size="sm">
                        Show
                      </Button>
                    </form>
                  )}
                  <MessagePreview preview={preview.preview} />
                </>
              )}
            </div>

            {launched ? (
              <p className="text-sm text-(--color-muted-foreground)">
                This campaign has started. Its checks ran again when it started, and run again if it’s resumed.
              </p>
            ) : (
              <details className="group border-t pt-4" open={!result.ready}>
                <summary className="flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-(--color-primary) hover:underline">
                  {result.ready ? 'Show everything we checked' : 'Show what needs fixing'}
                </summary>
                <div className="mt-3">
                  <PreflightReport result={friendly} ready={canSchedule || (scheduled && result.ready)} />
                </div>
                {isAdmin && (
                  <details className="mt-3 text-sm">
                    <summary className="w-fit cursor-pointer text-xs text-(--color-muted-foreground) hover:underline">
                      Technical details (owners and admins)
                    </summary>
                    <div className="mt-2 rounded-lg border bg-(--color-surface-subtle) p-3">
                      <PreflightReport result={result} />
                    </div>
                  </details>
                )}
              </details>
            )}
            {editable && (
              <ActionForm
                action={runPreflightAction}
                submitLabel="Check again"
                pendingLabel="Checking…"
                variant="outline"
                successMessageMs={6000}
              >
                <input type="hidden" name="campaignId" value={campaign.id} />
              </ActionForm>
            )}
          </div>
        </Step>

        {/* 6 — Schedule */}
        <Step
          id="schedule"
          number={6}
          title="When should it go out?"
          description={`Choose a date and time in your workspace’s time zone (${view.timeZone}), then schedule it.`}
          state={stateOf('schedule')}
        >
          {editable ? (
            <div className="flex flex-col gap-5">
              <AutoSaveForm action={updateCampaignAction} className="flex flex-col gap-2 sm:max-w-sm" statusId="scheduledAtLocal-status">
                <input type="hidden" name="campaignId" value={campaign.id} />
                <FieldShell id="scheduledAtLocal" label="Send date and time" required>
                  <Input
                    id="scheduledAtLocal"
                    type="datetime-local"
                    name="scheduledAtLocal"
                    aria-describedby="scheduledAtLocal-status"
                    defaultValue={
                      campaign.scheduled_at === null
                        ? ''
                        : toLocalInputValue(campaign.scheduled_at, view.timeZone)
                    }
                  />
                </FieldShell>
              </AutoSaveForm>

              <div className="overflow-hidden rounded-lg border">
                <h3 className="border-b bg-(--color-surface-subtle) px-5 py-3 text-sm font-semibold sm:px-6">
                  {canSchedule ? 'Ready to schedule' : 'Before you can schedule'}
                </h3>
                <Checklist items={needs} variant="requirements" highlightNext={false} />
              </div>

              <div className="flex gap-3 rounded-lg border bg-(--color-surface-subtle) p-4 text-sm">
                <Info className="mt-0.5 size-4 shrink-0 text-(--color-muted-foreground)" aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium">
                    {sendingBlocked ? 'Email sending isn’t fully set up yet' : SENDING_MODE_HEADLINE[sending.mode]}
                  </p>
                  <p className="mt-0.5 text-(--color-muted-foreground)">
                    {sendingBlocked
                      ? 'You can schedule this campaign, but it won’t start until the sending setup is finished.'
                      : SENDING_MODE_EXPLANATION[sending.mode]}
                  </p>
                  {isAdmin && (
                    <details className="mt-2">
                      <summary className="w-fit cursor-pointer text-xs text-(--color-muted-foreground) hover:underline">
                        Technical details
                      </summary>
                      <p className="mt-1 text-xs break-words text-(--color-muted-foreground)">{modeNotice}</p>
                    </details>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2 border-t pt-5">
                <ActionForm
                  action={scheduleCampaignAction}
                  submitLabel="Schedule campaign"
                  pendingLabel="Scheduling…"
                  size="default"
                  submitIcon={<CalendarClock aria-hidden />}
                  submitDisabled={!canSchedule}
                  {...(blockedReason === null ? {} : { submitDescribedBy: 'schedule-blocked' })}
                >
                  <input type="hidden" name="campaignId" value={campaign.id} />
                </ActionForm>
                {blockedReason !== null && (
                  <p id="schedule-blocked" className="text-sm font-medium text-(--color-warning-foreground)">
                    {blockedReason}
                  </p>
                )}
              </div>
            </div>
          ) : view.status === 'scheduled' ? (
            <div className="flex flex-col gap-3">
              <p className="flex flex-wrap items-center gap-x-2 text-sm">
                <CalendarClock className="size-4 text-(--color-muted-foreground)" aria-hidden />
                Scheduled for{' '}
                <span className="font-medium">
                  {formatInZone(campaign.scheduled_at ?? '', view.timeZone)}
                </span>{' '}
                ({view.timeZone}).
              </p>
              <ActionForm
                action={unscheduleCampaignAction}
                submitLabel="Move back to draft"
                pendingLabel="Working…"
                variant="outline"
              >
                <input type="hidden" name="campaignId" value={campaign.id} />
                <p className="text-sm text-(--color-muted-foreground)">
                  Moving it back to draft lets you make changes. You’ll need to schedule it again.
                </p>
              </ActionForm>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-(--color-muted-foreground)">
              <Lock className="size-4 shrink-0" aria-hidden />
              This campaign is {STATUS_LABEL[view.status].toLowerCase()} and can’t be scheduled.
            </p>
          )}
        </Step>

        {(showCancel || showDelete) && (
          <section
            aria-labelledby="danger-title"
            className="rounded-xl border border-(--color-danger-border) bg-(--color-card) p-5 shadow-xs sm:p-6"
          >
            <h2 id="danger-title" className="text-base font-semibold tracking-tight">
              {showCancel && showDelete ? 'Cancel or delete' : showCancel ? 'Cancel campaign' : 'Delete campaign'}
            </h2>
            <p className="mt-0.5 text-sm text-(--color-muted-foreground)">
              {showCancel && 'Cancelling stops the campaign for good — nothing further will be sent. '}
              {showDelete && 'Deleting removes the campaign completely.'}
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {showCancel && (
                <ActionForm
                  action={cancelCampaignAction}
                  submitLabel="Cancel campaign"
                  pendingLabel="Cancelling…"
                  variant="outline"
                  className="flex max-w-xs flex-col items-start gap-2"
                  confirm={{
                    title: `Cancel “${campaign.name}”?`,
                    description: launched
                      ? 'Sending stops now and nothing further will be sent. Emails that already went out can’t be recalled. A cancelled campaign can’t be restarted.'
                      : 'It won’t be sent. A cancelled campaign can’t be scheduled again — you’d need to create a new one.',
                    irreversible: true,
                    confirmLabel: 'Cancel campaign',
                  }}
                >
                  <input type="hidden" name="campaignId" value={campaign.id} />
                </ActionForm>
              )}
              {showDelete && (
                <ActionForm
                  action={deleteCampaignAction}
                  submitLabel="Delete campaign"
                  pendingLabel="Deleting…"
                  variant="destructive"
                  className="flex max-w-xs flex-col items-start gap-2"
                  confirm={{
                    title: `Delete “${campaign.name}”?`,
                    description:
                      'The campaign and its settings are deleted. Your lists, templates and senders aren’t affected.',
                    irreversible: true,
                  }}
                >
                  <input type="hidden" name="campaignId" value={campaign.id} />
                </ActionForm>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
