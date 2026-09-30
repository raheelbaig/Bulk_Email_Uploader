import Link from 'next/link';
import { AtSign, CheckCircle2, Clock, Globe, Plus } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { listSenderIdentities } from '@/lib/sender/identities';
import { listSenderDomains } from '@/lib/sender/service';
import { createIdentityAction, deleteIdentityAction, updateIdentityAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { CreatePanel } from '@/components/create-panel';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { SENDER_BLOCKER_COPY, SENDER_WARNING_COPY, SendersTabs } from '@/components/sender-copy';
import { StatusBadge } from '@/components/status-badge';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export const dynamic = 'force-dynamic';

/**
 * Sender addresses.
 *
 * "Usable" is not a column on this page — it is the verdict of the sender
 * readiness authority (`lib/sender/readiness.ts`), the same function P4's
 * campaign preflight will call. The badge and the reason text below it are the
 * authority's own output, so what a user is told here and what a campaign is
 * allowed to do cannot drift apart.
 */
export default async function SenderIdentitiesPage() {
  const { workspaceId } = await workspaceForPage();
  const [identities, domains] = await Promise.all([
    listSenderIdentities(workspaceId),
    listSenderDomains(workspaceId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Senders"
        description="The name and email address people see when your campaign lands in their inbox. Each address must be on a domain you’ve added."
        actions={
          domains.length === 0 ? (
            <Link href="/senders#new" className={buttonVariants()}>
              <Plus aria-hidden />
              Add domain first
            </Link>
          ) : (
            <Link href="#new" className={buttonVariants()}>
              <Plus aria-hidden />
              Add sender address
            </Link>
          )
        }
      />

      <SendersTabs active="addresses" />

      {domains.length > 0 && (
        <CreatePanel
          title="Add a sender address"
          description="You can prepare an address while its domain is still verifying — it becomes usable once verification passes."
        >
          <ActionForm action={createIdentityAction} submitLabel="Add sender address" pendingLabel="Adding…" size="default">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                name="fromName"
                label="Sender name"
                required
                maxLength={120}
                placeholder="e.g. Acme Team"
                hint="Shown as the sender in the inbox."
              />
              <Field
                name="fromEmail"
                label="Email address"
                type="email"
                required
                maxLength={254}
                placeholder={`hello@${domains[0]?.record.domain ?? 'example.com'}`}
                hint={`Must end with ${domains.map((d) => `@${d.record.domain}`).join(' or ')}`}
              />
            </div>
            <Field
              name="replyTo"
              label="Reply-to address"
              type="email"
              maxLength={254}
              hint="Where replies go, if different from the address above."
              className="sm:max-w-md"
            />
          </ActionForm>
        </CreatePanel>
      )}

      {identities.length === 0 ? (
        domains.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="Add a domain first"
            description="A sender address has to be on a domain you’ve verified, like hello@yourcompany.com. Start by adding your domain."
            action={
              <Link href="/senders#new" className={buttonVariants()}>
                <Plus aria-hidden />
                Add domain
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={AtSign}
            title="No sender addresses yet"
            description="Add the name and email address your campaigns will come from."
            action={
              <Link href="#new" className={buttonVariants()}>
                <Plus aria-hidden />
                Add sender address
              </Link>
            }
          />
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {identities.map(({ record, domain, readiness }) => (
            <li key={record.id} className="rounded-xl border bg-(--color-card) shadow-xs">
              <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <span
                    aria-hidden
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-(--color-primary-subtle) text-sm font-semibold text-(--color-primary-subtle-foreground)"
                  >
                    {record.from_name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{record.from_name}</p>
                    <p className="truncate text-sm text-(--color-muted-foreground)">{record.from_email}</p>
                    <p className="mt-1 text-sm text-(--color-muted-foreground)">
                      Replies go to {record.reply_to ?? 'the same address'}
                      {domain !== null && (
                        <>
                          {' · '}
                          <Link href={`/senders/${domain.id}`} className="underline-offset-4 hover:underline">
                            {domain.domain}
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <StatusBadge
                  tone={readiness.ready ? 'positive' : 'warning'}
                  label={readiness.ready ? 'Ready to send' : 'Not verified yet'}
                  icon={readiness.ready ? CheckCircle2 : Clock}
                  className="w-fit"
                />
              </div>

              {(readiness.blockers.length > 0 || (readiness.ready && readiness.warnings.length > 0)) && (
                <ul className="mx-5 mb-4 flex flex-col gap-1 rounded-lg border bg-(--color-surface-subtle) px-3 py-2 text-sm text-(--color-muted-foreground)">
                  {[...new Set(readiness.blockers.map((blocker) => SENDER_BLOCKER_COPY[blocker]))].map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                  {readiness.ready &&
                    readiness.warnings.map((warning) => <li key={warning}>{SENDER_WARNING_COPY[warning]}</li>)}
                </ul>
              )}

              <div className="flex flex-col gap-3 rounded-b-xl border-t bg-(--color-surface-subtle) px-5 py-3 sm:flex-row sm:items-start sm:justify-between">
                <details className="min-w-0 flex-1">
                  <summary className="w-fit cursor-pointer rounded text-sm font-medium text-(--color-primary) hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)">
                    Edit name or reply-to
                  </summary>
                  <div className="mt-3 max-w-md">
                    <ActionForm
                      action={updateIdentityAction}
                      submitLabel="Save changes"
                      successMessageMs={5000}
                      pendingLabel="Saving…"
                      variant="outline"
                    >
                      <input type="hidden" name="identityId" value={record.id} />
                      <Field
                        name="fromName"
                        idSuffix={record.id}
                        label="Sender name"
                        required
                        maxLength={120}
                        defaultValue={record.from_name}
                      />
                      <Field
                        name="replyTo"
                        idSuffix={record.id}
                        label="Reply-to address"
                        type="email"
                        maxLength={254}
                        defaultValue={record.reply_to ?? ''}
                      />
                    </ActionForm>
                  </div>
                </details>
                <ActionForm
                  action={deleteIdentityAction}
                  submitLabel="Remove"
                  pendingLabel="Removing…"
                  variant="ghost"
                  className="flex flex-col items-start gap-2 sm:items-end"
                  confirm={{
                    title: `Remove ${record.from_email}?`,
                    description:
                      'Campaigns can no longer be sent from this address. You can add it again later. An address that a campaign still uses can’t be removed.',
                    confirmLabel: 'Remove sender address',
                  }}
                >
                  <input type="hidden" name="identityId" value={record.id} />
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
