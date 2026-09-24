import { ActionForm } from '@/components/action-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { CampaignRecord } from '@/lib/campaigns/ports';
import { pauseReasonLabel } from '@/lib/campaigns/status';
import type { DeliverySummary } from '@/lib/sending/service';
import type { FormState } from '@/lib/form-state';

/**
 * A launched campaign's progress, and the controls that act on it.
 *
 * `completed` is never shown as a bare success: the breakdown is always beside
 * it (ARCHITECTURE §14.5), because a campaign where half the list was
 * suppressed is "completed" too.
 */

type Action = (state: FormState, form: FormData) => Promise<FormState>;

const ROWS: Array<{ key: keyof DeliverySummary['counts']; label: string }> = [
  { key: 'sent', label: 'Accepted by provider' },
  { key: 'pending', label: 'Waiting' },
  { key: 'claimed', label: 'In progress' },
  { key: 'send_uncertain', label: 'Unconfirmed' },
  { key: 'failed', label: 'Failed' },
  { key: 'suppressed', label: 'Suppressed' },
  { key: 'skipped', label: 'Skipped (inactive or removed)' },
  { key: 'cancelled', label: 'Cancelled' },
];

export function DeliveryPanel({
  campaign,
  summary,
  pauseAction,
  resumeAction,
  resolveAction,
}: {
  campaign: CampaignRecord;
  summary: DeliverySummary;
  pauseAction: Action;
  resumeAction: Action;
  resolveAction: Action;
}) {
  const dryRun = campaign.execution_mode === 'dry_run';
  const pauseReason = campaign.status === 'paused' ? pauseReasonLabel(campaign.pause_reason) : null;

  return (
    <section className="rounded-lg border">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-medium">Delivery</h2>
        {campaign.execution_mode !== null && (
          <Badge tone={dryRun ? 'warning' : 'positive'}>{dryRun ? 'Dry run' : 'Live'}</Badge>
        )}
      </header>
      <div className="flex flex-col gap-4 px-4 py-4">
        {dryRun && (
          <Alert>
            This campaign ran as a dry run. The whole pipeline executed, but no email was delivered to
            anyone — message ids starting <code>dryrun-</code> were issued by the dry-run sink.
          </Alert>
        )}
        {pauseReason !== null && <Alert tone="destructive">{pauseReason}</Alert>}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-[--color-muted-foreground]">Recipients</dt>
            <dd className="font-medium">{summary.total.toLocaleString()}</dd>
          </div>
          {ROWS.filter((row) => summary.counts[row.key] > 0 || row.key === 'sent').map((row) => (
            <div key={row.key}>
              <dt className="text-xs text-[--color-muted-foreground]">{row.label}</dt>
              <dd>{summary.counts[row.key].toLocaleString()}</dd>
            </div>
          ))}
          {campaign.n_unsubscribed > 0 && (
            <div>
              <dt className="text-xs text-[--color-muted-foreground]">Unsubscribed</dt>
              <dd>{campaign.n_unsubscribed.toLocaleString()}</dd>
            </div>
          )}
        </dl>

        {(campaign.status === 'sending' || campaign.status === 'queued') && (
          <ActionForm action={pauseAction} submitLabel="Pause sending" pendingLabel="Pausing…" variant="outline">
            <input type="hidden" name="campaignId" value={campaign.id} />
          </ActionForm>
        )}
        {campaign.status === 'paused' && campaign.launched_at !== null && (
          <ActionForm action={resumeAction} submitLabel="Resume sending" pendingLabel="Checking…">
            <input type="hidden" name="campaignId" value={campaign.id} />
            <p className="text-xs text-[--color-muted-foreground]">
              Resuming runs every check again, including sender verification.
            </p>
          </ActionForm>
        )}

        {summary.uncertain.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">
              {summary.counts.send_uncertain === 1
                ? '1 message could not be confirmed'
                : `${summary.counts.send_uncertain.toLocaleString()} messages could not be confirmed`}
            </h3>
            <p className="text-xs text-[--color-muted-foreground]">
              We asked Amazon SES to send these but lost the connection before it confirmed. Each may or may
              not have been delivered. Sending again could mean the person receives it twice. The campaign
              finishes once every one of these has a decision.
            </p>
            <ul className="flex flex-col gap-2">
              {summary.uncertain.map((job) => (
                <li key={job.id} className="flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-sm">
                  <span className="flex-1 font-mono text-xs">{job.toEmail}</span>
                  <ActionForm action={resolveAction} submitLabel="Leave it" variant="outline" className="flex">
                    <input type="hidden" name="campaignId" value={campaign.id} />
                    <input type="hidden" name="jobId" value={job.id} />
                    <input type="hidden" name="decision" value="leave" />
                  </ActionForm>
                  <ActionForm action={resolveAction} submitLabel="Send again anyway" variant="destructive" className="flex">
                    <input type="hidden" name="campaignId" value={campaign.id} />
                    <input type="hidden" name="jobId" value={job.id} />
                    <input type="hidden" name="decision" value="redispatch" />
                  </ActionForm>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
