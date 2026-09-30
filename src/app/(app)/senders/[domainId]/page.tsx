import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AtSign } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { getSenderDomain } from '@/lib/sender/service';
import { isAppError } from '@/lib/errors';
import { READINESS_TONE } from '@/lib/sender/status';
import { verifyDomainAction, removeDomainAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { CopyButton } from '@/components/copy-button';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import {
  DOMAIN_READINESS_LABEL,
  DnsHostTip,
  dmarcAdvice,
  domainSummary,
  friendlyCheckError,
} from '@/components/sender-copy';
import { SenderChecks, checksFor } from '@/components/sender-checks';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';

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
  const { workspaceId, role } = await workspaceForPage();

  const view = await getSenderDomain(workspaceId, domainId).catch((err: unknown) => {
    // Not-yours and not-found are the same answer, here as in the service.
    if (isAppError(err) && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) notFound();
    throw err;
  });

  const canRemove = role === 'owner' || role === 'admin';
  const isAdmin = canRemove;
  const record = view.record;
  const dkimRecords = view.records.filter((r) => r.purpose === 'dkim');
  const mailFromRecords = view.records.filter(
    (r) => r.purpose === 'mail_from_mx' || r.purpose === 'mail_from_spf',
  );
  const dmarcRecords = view.records.filter((r) => r.purpose === 'dmarc');
  const advice = dmarcAdvice(record.dmarc_status);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: '/senders', label: 'Senders' }}
        title={record.domain}
        meta={<StatusBadge tone={READINESS_TONE[view.readiness]} label={DOMAIN_READINESS_LABEL[view.readiness]} />}
        description={domainSummary(view.readiness, record.dmarc_status)}
        actions={
          view.usable ? (
            <Link href="/senders/identities#new" className={buttonVariants()}>
              <AtSign aria-hidden />
              Add sender address
            </Link>
          ) : undefined
        }
      />

      <SectionCard
        title="Verification status"
        description="We check your DNS records for you. Once SPF, DKIM and MAIL FROM pass, you can send from this domain."
      >
        <div className="flex flex-col gap-4">
          <SenderChecks checks={checksFor(record)} detailed />

          {record.last_check_error !== null && (
            <Alert tone="destructive">
              {friendlyCheckError(record.last_check_error)}
              {isAdmin && (
                <details className="mt-2 text-xs">
                  <summary className="w-fit cursor-pointer hover:underline">Technical details</summary>
                  <p className="mt-1 break-words">{record.last_check_error}</p>
                </details>
              )}
            </Alert>
          )}

          {view.usable && advice !== null && <Alert tone="info">{advice}</Alert>}

          <div className="flex flex-wrap items-center gap-3">
            <ActionForm
              action={verifyDomainAction}
              submitLabel="Check again"
              pendingLabel="Checking…"
              variant={view.usable ? 'outline' : 'default'}
            >
              <input type="hidden" name="domainId" value={record.id} />
            </ActionForm>
            <span className="text-sm text-(--color-muted-foreground)">
              {record.last_checked_at === null
                ? 'Not checked yet.'
                : `Last checked ${new Date(record.last_checked_at).toLocaleString()}.`}
            </span>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="DNS records to add"
        description="Copy each record into the DNS settings at your domain provider (for example GoDaddy, Cloudflare or Namecheap). Changes usually show up within an hour, but can take up to 72 hours."
      >
        <div className="mb-6">
          <DnsHostTip
            domain={record.domain}
            {...(dkimRecords[0] === undefined ? {} : { exampleHost: dkimRecords[0].host })}
          />
        </div>
        <ol className="flex flex-col gap-8">
          <RecordGroup
            step={1}
            title="DKIM — email signature"
            badge="Required"
            description="Proves your emails really come from this domain and weren’t changed on the way."
            records={dkimRecords}
            empty="These records appear once the email provider has set up your domain. Use “Check again” in a few minutes."
          />
          <RecordGroup
            step={2}
            title="MAIL FROM and SPF — bounce address"
            badge="Required"
            description="Lets receiving email providers match your emails to your domain and confirm it’s allowed to send, so they pass spam checks."
            records={mailFromRecords}
            empty="These records appear once your domain has been set up for sending. Use “Check again” in a few minutes."
          />
          <RecordGroup
            step={3}
            title="DMARC — impersonation protection"
            badge="Recommended"
            description="Tells inboxes what to do with emails that pretend to be from you. The record below starts in “monitor only” mode, which never blocks your own email. It can be made stricter later."
            records={dmarcRecords}
            empty=""
          />
        </ol>
      </SectionCard>

      {canRemove && (
        <SectionCard
          title="Remove this domain"
          className="border-(--color-danger-border)"
          description={
            view.identityCount > 0
              ? `This domain still has ${view.identityCount} sender ${
                  view.identityCount === 1 ? 'address' : 'addresses'
                }. Remove those first.`
              : 'Removes the domain from this workspace. You won’t be able to send from it until you add and verify it again.'
          }
        >
          {view.identityCount > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="destructive" size="sm" disabled>
                Remove domain
              </Button>
              <Link href="/senders/identities" className="text-sm font-medium text-(--color-primary) hover:underline">
                Manage sender addresses
              </Link>
            </div>
          ) : (
            <ActionForm
              action={removeDomainAction}
              submitLabel="Remove domain"
              pendingLabel="Removing…"
              variant="destructive"
              confirm={{
                title: `Remove ${record.domain}?`,
                description:
                  'The domain and its verification progress are removed from this workspace. To send from it again you’ll have to add it and verify it again. The DNS records at your domain provider aren’t changed.',
                irreversible: true,
              }}
            >
              <input type="hidden" name="domainId" value={record.id} />
            </ActionForm>
          )}
        </SectionCard>
      )}
    </div>
  );
}

function RecordGroup({
  step,
  title,
  badge,
  description,
  records,
  empty,
}: {
  step: number;
  title: string;
  badge: string;
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
    <li className="flex flex-col gap-3">
      <div className="flex gap-3">
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold text-(--color-muted-foreground)"
        >
          {step}
        </span>
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {title}
            <Badge tone={badge === 'Required' ? 'info' : 'neutral'}>{badge}</Badge>
          </h3>
          <p className="mt-0.5 text-sm text-(--color-muted-foreground)">{description}</p>
        </div>
      </div>

      {records.length === 0 ? (
        empty.length > 0 && <p className="pl-9 text-sm text-(--color-muted-foreground)">{empty}</p>
      ) : (
        <div className="flex flex-col gap-3 sm:pl-9">
          {records.map((dns) => (
            <div key={`${dns.type}:${dns.host}`} className="rounded-lg border bg-(--color-surface-subtle) p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-medium">
                <Badge>{dns.type}</Badge>
                {dns.label}
                {dns.priority !== undefined && (
                  <span className="text-(--color-muted-foreground)">priority {dns.priority}</span>
                )}
              </div>
              <RecordLine label="Host" value={dns.host} />
              <RecordLine label="Value" value={dns.value} />
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function RecordLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-12 shrink-0 text-xs text-(--color-muted-foreground)">{label}</span>
      <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-(--color-surface) px-2 py-1 font-mono text-xs whitespace-nowrap">
        {value}
      </code>
      <CopyButton value={value} label={label.toLowerCase()} />
    </div>
  );
}
