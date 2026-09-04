import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import {
  buildCampaignPreview,
  listAudienceOptions,
  previewCampaignPreflight,
} from '@/lib/campaigns/service';
import { listSenderIdentities } from '@/lib/sender/identities';
import { listTemplateOptions } from '@/lib/templates/service';
import { formatInZone, toLocalInputValue } from '@/lib/campaigns/schedule';
import { SCHEDULED_INERT_NOTICE, STATUS_LABEL, STATUS_TONE } from '@/lib/campaigns/status';
import { BLOCKER_MESSAGE } from '@/lib/sender/readiness';
import {
  cancelCampaignAction,
  deleteCampaignAction,
  runPreflightAction,
  scheduleCampaignAction,
  unscheduleCampaignAction,
  updateCampaignAction,
} from '../actions';
import { ActionForm } from '@/components/action-form';
import { PreflightReport } from '@/components/preflight-report';
import { MessagePreview } from '@/components/template-preview';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

export const dynamic = 'force-dynamic';

/**
 * The campaign builder.
 *
 * Seven steps, in the order the decisions depend on each other: audience,
 * sender, template, personalization, review, preflight, schedule.
 *
 * ── Two things this page deliberately does not do ────────────────────────
 *
 * It does not load the audience. The counts come from an indexed aggregate in
 * the database, and the preview's contact picker is a bounded sample — a page
 * that shipped a hundred-thousand-row list to a browser to populate a dropdown
 * would be the scan this whole design avoids.
 *
 * It does not offer a way to send. The final control is "Schedule campaign", and
 * the notice beside it says plainly that nothing will be delivered.
 */
function Step({
  number,
  title,
  description,
  children,
}: {
  number: number;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border">
      <header className="border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[--color-muted] text-xs">
            {number}
          </span>
          {title}
        </h2>
        {description !== undefined && (
          <p className="mt-0.5 pl-7 text-xs text-[--color-muted-foreground]">{description}</p>
        )}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
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
  const { workspaceId } = await currentWorkspace();

  const { result, view } = await previewCampaignPreflight(workspaceId, id);
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/campaigns"
            className="flex items-center gap-1 text-sm text-[--color-muted-foreground]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Campaigns
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold tracking-tight">
            {campaign.name}
            <Badge tone={STATUS_TONE[view.status]}>{STATUS_LABEL[view.status]}</Badge>
          </h1>
        </div>
        <div className="flex gap-2">
          {view.status !== 'cancelled' && (
            <form action={cancelCampaignAction}>
              <input type="hidden" name="campaignId" value={campaign.id} />
              <Button type="submit" variant="outline" size="sm">
                Cancel campaign
              </Button>
            </form>
          )}
          <form action={deleteCampaignAction}>
            <input type="hidden" name="campaignId" value={campaign.id} />
            <Button type="submit" variant="destructive" size="sm">
              Delete
            </Button>
          </form>
        </div>
      </div>

      {!editable && view.status === 'scheduled' && (
        <Alert>
          This campaign is scheduled and its content is frozen. {SCHEDULED_INERT_NOTICE} Unschedule
          it to make further changes.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className="flex flex-col gap-4">
          {/* 1 — Audience */}
          <Step
            number={1}
            title="Audience"
            description="Counts come from the server. The list itself is never loaded into this page."
          >
            <ActionForm action={updateCampaignAction} submitLabel="Save audience" pendingLabel="Saving…">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <Select name="listId" defaultValue={campaign.list_id ?? ''} disabled={!editable}>
                <option value="">No list selected</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name} ({list.contact_count.toLocaleString()} contacts)
                  </option>
                ))}
              </Select>
            </ActionForm>

            {view.list !== null && (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-[--color-muted-foreground]">In list</dt>
                  <dd>{view.audience.total.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[--color-muted-foreground]">Eligible</dt>
                  <dd className="font-medium">{view.audience.eligible.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[--color-muted-foreground]">Suppressed</dt>
                  <dd>{view.audience.suppressed.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[--color-muted-foreground]">Inactive</dt>
                  <dd>{view.audience.inactive.toLocaleString()}</dd>
                </div>
              </dl>
            )}
          </Step>

          {/* 2 — Sender */}
          <Step
            number={2}
            title="Sender"
            description="Only fully verified addresses can be used. Verification state comes from the sender readiness authority."
          >
            <ActionForm action={updateCampaignAction} submitLabel="Save sender" pendingLabel="Saving…">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <Select
                name="senderIdentityId"
                defaultValue={campaign.sender_identity_id ?? ''}
                disabled={!editable}
              >
                <option value="">No sender selected</option>
                {senders.map((sender) => (
                  <option
                    key={sender.record.id}
                    value={sender.record.id}
                    disabled={!sender.readiness.ready}
                  >
                    {sender.record.from_name} &lt;{sender.record.from_email}&gt;
                    {sender.readiness.ready ? '' : ' — not ready'}
                  </option>
                ))}
              </Select>
            </ActionForm>

            {senders.length === 0 && (
              <p className="mt-2 text-xs text-[--color-muted-foreground]">
                No sender addresses yet.{' '}
                <Link href="/senders" className="underline underline-offset-4">
                  Add and verify a sending domain
                </Link>{' '}
                first.
              </p>
            )}
            {senders.some((sender) => !sender.readiness.ready) && (
              <ul className="mt-2 space-y-0.5 text-xs text-[--color-muted-foreground]">
                {senders
                  .filter((sender) => !sender.readiness.ready)
                  .map((sender) => (
                    <li key={sender.record.id}>
                      <span className="font-medium">{sender.record.from_email}</span>:{' '}
                      {sender.readiness.blockers
                        .map((blocker) => BLOCKER_MESSAGE[blocker])
                        .join(' ')}
                    </li>
                  ))}
              </ul>
            )}
          </Step>

          {/* 3 — Template */}
          <Step number={3} title="Template" description="Frozen into the campaign when it is scheduled.">
            <ActionForm action={updateCampaignAction} submitLabel="Save template" pendingLabel="Saving…">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <Select name="templateId" defaultValue={campaign.template_id ?? ''} disabled={!editable}>
                <option value="">No template selected</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} (v{template.version})
                  </option>
                ))}
              </Select>
            </ActionForm>
            <p className="mt-2 text-xs text-[--color-muted-foreground]">
              <Link href="/templates" className="underline underline-offset-4">
                Manage templates
              </Link>
            </p>
          </Step>

          {/* 4 — Personalization */}
          <Step
            number={4}
            title="Personalization"
            description="Fields resolve from the contact record. Unknown fields block the campaign."
          >
            {view.template === null ? (
              <p className="text-sm text-[--color-muted-foreground]">Choose a template first.</p>
            ) : view.template.variables.length === 0 ? (
              <p className="text-sm text-[--color-muted-foreground]">
                This template uses no personalization — every recipient receives identical content.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {view.template.variables.map((name) => (
                  <Badge key={name}>{`{{${name}}}`}</Badge>
                ))}
              </div>
            )}
          </Step>

          {/* 5 & 6 — Review and preflight */}
          <Step
            number={5}
            title="Review and preflight"
            description="Every check, every time. Blockers must be cleared; warnings are yours to accept."
          >
            <PreflightReport result={result} />
            <div className="mt-3">
              <ActionForm
                action={runPreflightAction}
                submitLabel="Run checks"
                pendingLabel="Checking…"
                variant="outline"
              >
                <input type="hidden" name="campaignId" value={campaign.id} />
              </ActionForm>
            </div>
          </Step>

          {/* 7 — Schedule */}
          <Step
            number={6}
            title="Schedule"
            description={`Times are interpreted in this workspace's timezone (${view.timeZone}).`}
          >
            {editable ? (
              <div className="flex flex-col gap-4">
                <ActionForm
                  action={updateCampaignAction}
                  submitLabel="Save time"
                  pendingLabel="Saving…"
                  variant="outline"
                >
                  <input type="hidden" name="campaignId" value={campaign.id} />
                  <Input
                    type="datetime-local"
                    name="scheduledAtLocal"
                    defaultValue={
                      campaign.scheduled_at === null
                        ? ''
                        : toLocalInputValue(campaign.scheduled_at, view.timeZone)
                    }
                  />
                </ActionForm>

                <Alert>{SCHEDULED_INERT_NOTICE}</Alert>

                <ActionForm
                  action={scheduleCampaignAction}
                  submitLabel="Schedule campaign"
                  pendingLabel="Scheduling…"
                >
                  <input type="hidden" name="campaignId" value={campaign.id} />
                </ActionForm>
              </div>
            ) : view.status === 'scheduled' ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm">
                  Scheduled for{' '}
                  <span className="font-medium">
                    {formatInZone(campaign.scheduled_at ?? '', view.timeZone)}
                  </span>{' '}
                  ({view.timeZone}).
                </p>
                <ActionForm
                  action={unscheduleCampaignAction}
                  submitLabel="Unschedule"
                  pendingLabel="Working…"
                  variant="outline"
                >
                  <input type="hidden" name="campaignId" value={campaign.id} />
                </ActionForm>
              </div>
            ) : (
              <p className="text-sm text-[--color-muted-foreground]">
                This campaign is {STATUS_LABEL[view.status].toLowerCase()} and cannot be scheduled.
              </p>
            )}
          </Step>
        </div>

        {/* Preview */}
        <aside className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Preview</h2>
            {preview !== null && preview.fromSnapshot && <Badge>frozen copy</Badge>}
          </div>

          {preview === null ? (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-[--color-muted-foreground]">
              Choose a template to see the message.
            </p>
          ) : (
            <>
              {preview.contacts.length > 0 && (
                <form method="get" className="flex items-center gap-2">
                  <label htmlFor="contact" className="text-xs text-[--color-muted-foreground]">
                    Preview as
                  </label>
                  <Select id="contact" name="contact" defaultValue={contactId ?? ''} className="flex-1">
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
        </aside>
      </div>
    </div>
  );
}
