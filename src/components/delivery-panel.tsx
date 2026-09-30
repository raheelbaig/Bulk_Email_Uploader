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
  { key: 'sent', label: 'Sent' },
  { key: 'pending', label: 'Waiting to send' },
  { key: 'claimed', label: 'Sending now' },
  { key: 'send_uncertain', label: 'Unconfirmed' },
  { key: 'failed', label: 'Failed' },
  { key: 'suppressed', label: 'Unsubscribed or blocked' },
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
    <section aria-labelledby="delivery-title" className="rounded-xl border bg-(--color-card) shadow-xs">
      <header className="flex flex-wrap items-start justify-between gap-2 px-5 pt-5 sm:px-6">
        <div>
          <h2 id="delivery-title" className="text-base font-semibold tracking-tight">
            Delivery progress
          </h2>
          <p className="mt-0.5 text-sm text-(--color-muted-foreground)">
            Where every recipient of this campaign stands.
          </p>
        </div>
        {campaign.execution_mode !== null && (
          <Badge tone={dryRun ? 'warning' : 'positive'}>{dryRun ? 'Test run — nothing delivered' : 'Live'}</Badge>
        )}
      </header>
      <div className="flex flex-col gap-5 px-5 pt-4 pb-5 sm:px-6 sm:pb-6">
        {dryRun && (
          <Alert tone="info">
            This campaign ran in test mode. Every step ran as it would for real, but no email was delivered
            to anyone.
          </Alert>
        )}
        {pauseReason !== null && <Alert tone="destructive">{pauseReason}</Alert>}

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border bg-(--color-surface-subtle) px-3 py-2.5">
            <dt className="text-xs text-(--color-muted-foreground)">Recipients</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{summary.total.toLocaleString()}</dd>
          </div>
          {ROWS.filter((row) => summary.counts[row.key] > 0 || row.key === 'sent').map((row) => (
            <div
              key={row.key}
              className={
                row.key === 'sent'
                  ? 'rounded-lg border border-(--color-success-border) bg-(--color-success-subtle) px-3 py-2.5'
                  : row.key === 'failed' || row.key === 'send_uncertain'
                    ? 'rounded-lg border border-(--color-warning-border) bg-(--color-warning-subtle) px-3 py-2.5'
                    : 'rounded-lg border px-3 py-2.5'
              }
            >
              <dt className="text-xs text-(--color-muted-foreground)">{row.label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">{summary.counts[row.key].toLocaleString()}</dd>
            </div>
          ))}
          {campaign.n_unsubscribed > 0 && (
            <div className="rounded-lg border px-3 py-2.5">
              <dt className="text-xs text-(--color-muted-foreground)">Unsubscribed since</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">{campaign.n_unsubscribed.toLocaleString()}</dd>
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
            <p className="text-sm text-(--color-muted-foreground)">
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
            <p className="text-sm text-(--color-muted-foreground)">
              We asked the email service to send these but lost the connection before it confirmed. Each may
              or may not have been delivered. Sending again could mean the person receives it twice. The campaign
              finishes once every one of these has a decision.
            </p>
            <ul className="flex flex-col gap-2">
              {summary.uncertain.map((job) => (
                <li key={job.id} className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{job.toEmail}</span>
                  <ActionForm action={resolveAction} submitLabel="Leave it" variant="outline" className="flex">
                    <input type="hidden" name="campaignId" value={campaign.id} />
                    <input type="hidden" name="jobId" value={job.id} />
                    <input type="hidden" name="decision" value="leave" />
                  </ActionForm>
                  <ActionForm
                    action={resolveAction}
                    submitLabel="Send again anyway"
                    variant="destructive"
                    className="flex"
                    confirm={{
                      title: `Send again to ${job.toEmail}?`,
                      description:
                        'The first attempt may already have been delivered, so this person could receive the email twice.',
                      irreversible: true,
                    }}
                  >
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
