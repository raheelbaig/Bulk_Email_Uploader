import Link from 'next/link';
import { ChevronRight, Plus, Send } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { listCampaigns, workspaceTimeZone } from '@/lib/campaigns/service';
import { formatInZone } from '@/lib/campaigns/schedule';
import { checkboxShownField } from '@/lib/form-fields';
import { sendingConfig } from '@/lib/sending/config';
import { createCampaignAction } from './actions';
import { ActionForm } from '@/components/action-form';
import { CreatePanel } from '@/components/create-panel';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { CampaignStatusBadge } from '@/components/status-badge';
import { SENDING_MODE_EXPLANATION, SENDING_MODE_HEADLINE } from '@/components/sending-copy';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

const STEPS = ['Name it', 'Choose who receives it', 'Choose the email', 'Choose the sender', 'Review', 'Schedule'];

export default async function CampaignsPage() {
  const { workspaceId } = await workspaceForPage();
  const [page, timeZone] = await Promise.all([
    listCampaigns(workspaceId, { limit: 50 }),
    workspaceTimeZone(workspaceId),
  ]);
  const mode = sendingConfig().mode;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Campaigns"
        description="Create, schedule and follow your email campaigns."
        actions={
          <Link href="#new" className={buttonVariants()}>
            <Plus aria-hidden />
            Create campaign
          </Link>
        }
      />

      {mode !== 'live' && (
        <Alert tone="info" title={SENDING_MODE_HEADLINE[mode]}>
          {SENDING_MODE_EXPLANATION[mode]}
        </Alert>
      )}

      <CreatePanel
        title="Create a campaign"
        description="Start with a name. On the next page you’ll choose who receives it, the email, and the sender — step by step."
      >
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
          <ActionForm action={createCampaignAction} submitLabel="Create and continue" pendingLabel="Creating…" size="default">
            <Field
              name="name"
              label="Campaign name"
              required
              maxLength={160}
              placeholder="e.g. March newsletter"
              hint="For your team only — recipients never see this."
            />
            <label className="flex items-start gap-3 rounded-lg border bg-(--color-surface-subtle) p-3 text-sm">
              {/* An unticked checkbox submits nothing; this tells the action it was shown. */}
              <input type="hidden" name={checkboxShownField('requiresUnsubscribe')} value="1" />
              <input
                type="checkbox"
                name="requiresUnsubscribe"
                value="true"
                defaultChecked
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
          </ActionForm>
          <div className="hidden rounded-lg border bg-(--color-surface-subtle) p-4 md:block">
            <p className="text-sm font-medium">What happens next</p>
            <ol className="mt-2 flex flex-col gap-1.5 text-sm text-(--color-muted-foreground)">
              {STEPS.map((step, index) => (
                <li key={step} className="flex items-center gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border bg-(--color-surface) text-[0.6875rem] font-semibold">
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </CreatePanel>

      {page.items.length === 0 ? (
        <EmptyState
          icon={Send}
          title="No campaigns yet"
          description="A campaign sends one of your email templates to one of your lists, from your verified sender. Create one to choose your audience, email, sender and schedule."
          action={
            <Link href="#new" className={buttonVariants()}>
              <Plus aria-hidden />
              Create campaign
            </Link>
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Campaign</TH>
              <TH>Status</TH>
              <TH className="hidden md:table-cell">Send time</TH>
              <TH className="hidden lg:table-cell">Created</TH>
              <TH className="w-10">
                <span className="sr-only">Open</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {page.items.map((campaign) => (
              <TR key={campaign.id} className="group relative">
                <TD className="max-w-[14rem] sm:max-w-md">
                  <Link
                    href={`/campaigns/${campaign.id}`}
                    className="flex min-w-0 items-center gap-3 after:absolute after:inset-0 focus-visible:outline-none after:focus-visible:ring-2 after:focus-visible:ring-(--color-ring) after:focus-visible:ring-inset"
                  >
                    <span className="hidden size-8 shrink-0 items-center justify-center rounded-lg border bg-(--color-surface-subtle) text-(--color-muted-foreground) sm:flex">
                      <Send className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{campaign.name}</span>
                      <span className="block truncate text-sm text-(--color-muted-foreground) md:hidden">
                        {campaign.scheduled_at === null
                          ? 'Not scheduled'
                          : formatInZone(campaign.scheduled_at, timeZone)}
                      </span>
                    </span>
                  </Link>
                </TD>
                <TD>
                  <CampaignStatusBadge status={campaign.status} />
                </TD>
                <TD className="hidden whitespace-nowrap text-(--color-muted-foreground) md:table-cell">
                  {campaign.scheduled_at === null ? 'Not scheduled' : formatInZone(campaign.scheduled_at, timeZone)}
                </TD>
                <TD className="hidden whitespace-nowrap text-(--color-muted-foreground) lg:table-cell">
                  {formatInZone(campaign.created_at, timeZone)}
                </TD>
                <TD className="text-(--color-muted-foreground)">
                  <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
