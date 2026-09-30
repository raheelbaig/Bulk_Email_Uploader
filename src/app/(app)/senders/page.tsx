import Link from 'next/link';
import { ArrowRight, AtSign, Globe, Plus } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { listSenderDomains } from '@/lib/sender/service';
import { isProviderConfigured } from '@/lib/sender/provider';
import { READINESS_TONE } from '@/lib/sender/status';
import { addDomainAction } from './actions';
import { ActionForm } from '@/components/action-form';
import { Checklist } from '@/components/checklist';
import { CreatePanel } from '@/components/create-panel';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { DOMAIN_READINESS_LABEL, SendersTabs, domainSummary, friendlyCheckError } from '@/components/sender-copy';
import { SenderChecks, checksFor } from '@/components/sender-checks';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export const dynamic = 'force-dynamic';

/**
 * Sender domains.
 *
 * Every status shown here was written by the server after asking SES and DNS.
 * There is no control on this page that sets one — "Check again" runs the
 * verifier, whose answer comes from the provider.
 */
export default async function SenderDomainsPage() {
  const { workspaceId, role } = await workspaceForPage();
  const domains = await listSenderDomains(workspaceId);
  const configured = isProviderConfigured();
  const isAdmin = role === 'owner' || role === 'admin';

  const usableDomain = domains.some((view) => view.usable);
  const addressCount = domains.reduce((total, view) => total + view.identityCount, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Senders"
        description="Who your emails come from. Verify a domain you own (like yourcompany.com), then add the address you’ll send from on it."
        actions={
          <Link href="#new" className={buttonVariants()}>
            <Plus aria-hidden />
            Add domain
          </Link>
        }
      />

      <SendersTabs active="domains" />

      {!configured && (
        <Alert tone="warning" title="Domain verification isn’t switched on yet">
          {isAdmin
            ? 'Checking domains needs the email service to be connected in this installation’s server settings, which isn’t done in the app. You can still add your domain now.'
            : 'Checking domains isn’t available yet — ask your workspace owner. You can still add your domain now.'}
          {isAdmin && (
            <details className="mt-2">
              <summary className="w-fit cursor-pointer text-sm underline-offset-4 hover:underline">
                Technical details
              </summary>
              <p className="mt-1 text-sm">
                The sending provider is not configured for this deployment, so domains cannot be provisioned or
                verified. Add the AWS credentials described in <code>.env.example</code>.
              </p>
            </details>
          )}
        </Alert>
      )}

      {(!usableDomain || addressCount === 0) && (
        <section aria-labelledby="sender-setup" className="overflow-hidden rounded-xl border bg-(--color-card) shadow-xs">
          <div className="px-5 pt-5 pb-3 sm:px-6">
            <h2 id="sender-setup" className="text-base font-semibold tracking-tight">
              Set up your sender in two steps
            </h2>
            <p className="mt-0.5 text-sm text-(--color-muted-foreground)">
              Verifying your domain proves you own it, so your emails reach inboxes instead of spam folders.
            </p>
          </div>
          <div className="border-t">
            <Checklist
              items={[
                {
                  key: 'domain',
                  done: usableDomain,
                  title: 'Verify your domain',
                  description:
                    domains.length === 0
                      ? 'Add your domain, then copy the DNS records we give you into your domain provider’s settings.'
                      : 'Add the DNS records shown on your domain’s page. Checks usually pass within an hour, but can take up to 72 hours — so it’s worth doing this first.',
                  doneLabel: 'Your domain is verified',
                  action:
                    domains.length === 0
                      ? { href: '#new', label: 'Add domain' }
                      : { href: `/senders/${domains[0]!.record.id}`, label: 'View DNS records' },
                },
                {
                  key: 'address',
                  done: addressCount > 0,
                  title: 'Add a sender address',
                  description: 'The name and email your campaigns come from, for example “Acme <hello@acme.com>”.',
                  doneLabel: `${addressCount} sender ${addressCount === 1 ? 'address' : 'addresses'} added`,
                  action: { href: '/senders/identities#new', label: 'Add sender address' },
                },
              ]}
            />
          </div>
        </section>
      )}

      <CreatePanel
        title="Add a domain"
        description="Enter the domain your email addresses end with. We’ll give you a few DNS records to add at your domain provider."
      >
        <ActionForm
          action={addDomainAction}
          submitLabel="Add domain"
          pendingLabel="Setting up…"
          size="default"
          className="flex flex-col gap-4 sm:max-w-md"
        >
          <Field
            name="domain"
            label="Domain"
            required
            placeholder="yourcompany.com"
            maxLength={253}
            hint="Just the domain — no https://, no page path, and no email address."
          />
        </ActionForm>
      </CreatePanel>

      {domains.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No verified sender yet"
          description="Your emails need a verified sender before they can be delivered. Start by adding the domain you send email from."
          action={
            <Link href="#new" className={buttonVariants()}>
              <Plus aria-hidden />
              Add domain
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {domains.map((view) => (
            <article
              key={view.record.id}
              className="flex flex-col rounded-xl border bg-(--color-card) shadow-xs transition-[border-color,box-shadow] hover:border-(--color-border-strong) hover:shadow-sm"
            >
              <div className="flex flex-col gap-3 p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold">
                    <Globe className="size-4 shrink-0 text-(--color-muted-foreground)" aria-hidden />
                    <span className="truncate">{view.record.domain}</span>
                  </h2>
                  <StatusBadge
                    tone={READINESS_TONE[view.readiness]}
                    label={DOMAIN_READINESS_LABEL[view.readiness]}
                  />
                </div>
                <p className="text-sm text-(--color-muted-foreground)">
                  {domainSummary(view.readiness, view.record.dmarc_status)}
                </p>
                <SenderChecks checks={checksFor(view.record)} />
                {view.record.last_check_error !== null && (
                  <p className="text-sm text-(--color-danger-foreground)">
                    {friendlyCheckError(view.record.last_check_error)}
                  </p>
                )}
              </div>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t bg-(--color-surface-subtle) px-5 py-3">
                <span className="flex items-center gap-1.5 text-sm text-(--color-muted-foreground)">
                  <AtSign className="size-3.5" aria-hidden />
                  {view.identityCount} sender {view.identityCount === 1 ? 'address' : 'addresses'}
                </span>
                <Link
                  href={`/senders/${view.record.id}`}
                  className="inline-flex items-center gap-1 text-sm font-medium text-(--color-primary) hover:underline"
                >
                  {view.usable ? 'Details' : 'Finish setup'}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
