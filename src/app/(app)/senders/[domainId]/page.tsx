import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { getSenderDomain } from '@/lib/sender/service';
import { isAppError } from '@/lib/errors';
import { READINESS_LABEL, READINESS_TONE } from '@/lib/sender/status';
import { DMARC_GUIDANCE } from '@/lib/sender/dns/dmarc';
import { verifyDomainAction, removeDomainAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { CopyButton } from '@/components/copy-button';
import { SenderChecks, checksFor } from '@/components/sender-checks';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

/**
 * The setup page for one domain.
 *
 * Shows exactly the records the provider requires and nothing invented: DKIM
 * records appear only once SES has issued the tokens, and the DMARC record is
 * labelled as a recommendation because this system assesses DMARC rather than
 * requiring it.
 */
export default async function SenderDomainPage({
  params,
}: {
  params: Promise<{ domainId: string }>;
}) {
  const { domainId } = await params;
  const { workspaceId, role } = await currentWorkspace();

  const view = await getSenderDomain(workspaceId, domainId).catch((err: unknown) => {
    // Not-yours and not-found are the same answer, here as in the service.
    if (isAppError(err) && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) notFound();
    throw err;
  });

  const canRemove = role === 'owner' || role === 'admin';
  const record = view.record;
  const dkimRecords = view.records.filter((r) => r.purpose === 'dkim');
  const mailFromRecords = view.records.filter(
    (r) => r.purpose === 'mail_from_mx' || r.purpose === 'mail_from_spf',
  );
  const dmarcRecords = view.records.filter((r) => r.purpose === 'dmarc');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/senders"
          className="mb-2 inline-flex items-center gap-1 text-sm text-[--color-muted-foreground] underline underline-offset-4"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          Sender domains
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{record.domain}</h1>
          <Badge tone={READINESS_TONE[view.readiness]}>{READINESS_LABEL[view.readiness]}</Badge>
        </div>
        <p className="mt-1 text-sm text-[--color-muted-foreground]">{view.summary}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SenderChecks checks={checksFor(record)} />

          {record.last_check_error !== null && (
            <Alert tone="destructive">{record.last_check_error}</Alert>
          )}

          {record.dmarc_status !== 'verified' && (
            <p className="text-sm text-[--color-muted-foreground]">
              {record.dmarc_status === 'not_configured'
                ? DMARC_GUIDANCE.missing
                : record.dmarc_status === 'failed'
                  ? DMARC_GUIDANCE.malformed
                  : DMARC_GUIDANCE.monitoring_only}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <ActionForm
              action={verifyDomainAction}
              submitLabel="Check again"
              pendingLabel="Checking…"
              variant="outline"
            >
              <input type="hidden" name="domainId" value={record.id} />
            </ActionForm>
            <span className="text-xs text-[--color-muted-foreground]">
              {record.last_checked_at === null
                ? 'Not checked yet.'
                : `Last checked ${new Date(record.last_checked_at).toLocaleString()}.`}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>DNS records</CardTitle>
          <p className="text-sm text-[--color-muted-foreground]">
            Add these at your DNS provider. Changes can take up to 72 hours to propagate, though
            they are usually visible within an hour.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <RecordGroup
            title="DKIM"
            description="Proves messages were signed by this domain. Required."
            records={dkimRecords}
            empty="DKIM records are issued by the provider when the domain is set up. Use “Check again” once provisioning completes."
          />
          <RecordGroup
            title="MAIL FROM"
            description="Points the envelope sender at a subdomain you control, so SPF and DMARC align. Required."
            records={mailFromRecords}
            empty="No custom MAIL FROM has been configured for this domain yet."
          />
          <RecordGroup
            title="DMARC"
            description="Tells receivers what to do with mail that fails authentication. Recommended — start with p=none, then move to quarantine and reject."
            records={dmarcRecords}
            empty=""
          />
        </CardContent>
      </Card>

      {canRemove && (
        <Card>
          <CardHeader>
            <CardTitle>Remove this domain</CardTitle>
            <p className="text-sm text-[--color-muted-foreground]">
              {view.identityCount > 0
                ? `This domain still has ${view.identityCount} sender ${
                    view.identityCount === 1 ? 'address' : 'addresses'
                  }. Remove those first.`
                : 'Removes the domain from this workspace. The identity at the sending provider is left in place and must be removed there.'}
            </p>
          </CardHeader>
          <CardContent>
            <form action={removeDomainAction}>
              <input type="hidden" name="domainId" value={record.id} />
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={view.identityCount > 0}
              >
                Remove domain
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function RecordGroup({
  title,
  description,
  records,
  empty,
}: {
  title: string;
  description: string;
  records: Array<{
    label: string;
    type: string;
    host: string;
    value: string;
    priority?: number | undefined;
  }>;
  empty: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-[--color-muted-foreground]">{description}</p>
      </div>

      {records.length === 0 ? (
        empty.length > 0 && <p className="text-xs text-[--color-muted-foreground]">{empty}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {records.map((dns) => (
            <div key={`${dns.type}:${dns.host}`} className="rounded-md border p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium">
                <Badge>{dns.type}</Badge>
                {dns.label}
                {dns.priority !== undefined && (
                  <span className="text-[--color-muted-foreground]">priority {dns.priority}</span>
                )}
              </div>
              <RecordLine label="Host" value={dns.host} />
              <RecordLine label="Value" value={dns.value} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="w-12 shrink-0 text-xs text-[--color-muted-foreground]">{label}</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs">{value}</code>
      <CopyButton value={value} label={label.toLowerCase()} />
    </div>
  );
}
