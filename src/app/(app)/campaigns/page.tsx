import Link from 'next/link';
import { Plus, Send } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { listCampaigns, workspaceTimeZone } from '@/lib/campaigns/service';
import { formatInZone } from '@/lib/campaigns/schedule';
import { SCHEDULED_INERT_NOTICE, STATUS_LABEL, STATUS_TONE } from '@/lib/campaigns/status';
import { createCampaignAction } from './actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const { workspaceId } = await currentWorkspace();
  const [page, timeZone] = await Promise.all([
    listCampaigns(workspaceId, { limit: 50 }),
    workspaceTimeZone(workspaceId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          Choose an audience, a sender and a template, run the checks, and schedule.
        </p>
      </div>

      <Alert>{SCHEDULED_INERT_NOTICE}</Alert>

      <details className="rounded-lg border" open={page.items.length === 0}>
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
          <Plus className="h-4 w-4" aria-hidden />
          New campaign
        </summary>
        <div className="border-t px-4 py-4">
          <ActionForm action={createCampaignAction} submitLabel="Create campaign" pendingLabel="Creating…">
            <Field
              name="name"
              label="Campaign name"
              required
              maxLength={160}
              placeholder="March newsletter"
              hint="Internal only. Recipients never see this."
            />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="requiresUnsubscribe"
                value="true"
                defaultChecked
                className="mt-0.5"
              />
              <span>
                This campaign requires an unsubscribe link
                <span className="block text-xs text-[--color-muted-foreground]">
                  Leave this on for anything marketing-related. Only transactional mail qualifies
                  to have it off.
                </span>
              </span>
            </label>
          </ActionForm>
        </div>
      </details>

      {page.items.length === 0 ? (
        <EmptyState>No campaigns yet.</EmptyState>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Campaign</TH>
              <TH>Status</TH>
              <TH>Scheduled</TH>
              <TH>Created</TH>
            </TR>
          </THead>
          <TBody>
            {page.items.map((campaign) => (
              <TR key={campaign.id}>
                <TD>
                  <Link
                    href={`/campaigns/${campaign.id}`}
                    className="flex items-center gap-2 underline underline-offset-4"
                  >
                    <Send className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {campaign.name}
                  </Link>
                </TD>
                <TD>
                  <Badge tone={STATUS_TONE[campaign.status]}>{STATUS_LABEL[campaign.status]}</Badge>
                </TD>
                <TD className="text-[--color-muted-foreground]">
                  {campaign.scheduled_at === null
                    ? '—'
                    : formatInZone(campaign.scheduled_at, timeZone)}
                </TD>
                <TD className="text-[--color-muted-foreground]">
                  {formatInZone(campaign.created_at, timeZone)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
