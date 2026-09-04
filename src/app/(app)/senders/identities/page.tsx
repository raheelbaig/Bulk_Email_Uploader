import Link from 'next/link';
import { ArrowLeft, AtSign } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { listSenderIdentities } from '@/lib/sender/identities';
import { listSenderDomains } from '@/lib/sender/service';
import { BLOCKER_MESSAGE, WARNING_MESSAGE } from '@/lib/sender/readiness';
import { createIdentityAction, deleteIdentityAction, updateIdentityAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/table';

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
  const { workspaceId } = await currentWorkspace();
  const [identities, domains] = await Promise.all([
    listSenderIdentities(workspaceId),
    listSenderDomains(workspaceId),
  ]);

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
        <h1 className="text-2xl font-semibold tracking-tight">Sender addresses</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          The addresses this workspace may send from. Each one must sit under a sending domain you
          have added — that is enforced by the database, not only by this form.
        </p>
      </div>

      <details className="rounded-lg border" open={identities.length === 0}>
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
          <AtSign className="h-4 w-4" aria-hidden />
          Add a sender address
        </summary>
        <div className="border-t px-4 py-4">
          {domains.length === 0 ? (
            <p className="text-sm text-[--color-muted-foreground]">
              Add a sending domain first — a sender address can only exist under one.
            </p>
          ) : (
            <ActionForm
              action={createIdentityAction}
              submitLabel="Add address"
              pendingLabel="Adding…"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  name="fromEmail"
                  label="From address"
                  type="email"
                  required
                  maxLength={254}
                  placeholder={`hello@${domains[0]?.record.domain ?? 'example.com'}`}
                  hint={`Must be on one of: ${domains.map((d) => d.record.domain).join(', ')}`}
                />
                <Field name="fromName" label="From name" required maxLength={120} />
              </div>
              <Field
                name="replyTo"
                label="Reply-to"
                type="email"
                maxLength={254}
                hint="Where replies go, if not the from address."
              />
            </ActionForm>
          )}
        </div>
      </details>

      {identities.length === 0 ? (
        <EmptyState>No sender addresses yet.</EmptyState>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Email</TH>
              <TH>Domain</TH>
              <TH>Status</TH>
              <TH>Reply-to</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {identities.map(({ record, domain, readiness }) => (
              <TR key={record.id}>
                <TD className="font-medium">{record.from_name}</TD>
                <TD>{record.from_email}</TD>
                <TD className="text-[--color-muted-foreground]">
                  {domain === null ? (
                    '—'
                  ) : (
                    <Link
                      href={`/senders/${domain.id}`}
                      className="underline underline-offset-4"
                    >
                      {domain.domain}
                    </Link>
                  )}
                </TD>
                <TD>
                  <Badge tone={readiness.ready ? 'positive' : 'warning'}>
                    {readiness.ready ? 'Ready' : 'Not ready'}
                  </Badge>
                  <div className="mt-1 flex flex-col gap-0.5 text-xs text-[--color-muted-foreground]">
                    {readiness.blockers.map((blocker) => (
                      <span key={blocker}>{BLOCKER_MESSAGE[blocker]}</span>
                    ))}
                    {readiness.ready &&
                      readiness.warnings.map((warning) => (
                        <span key={warning}>{WARNING_MESSAGE[warning]}</span>
                      ))}
                  </div>
                </TD>
                <TD className="text-[--color-muted-foreground]">{record.reply_to ?? '—'}</TD>
                <TD>
                  <div className="flex flex-col items-end gap-2">
                    <details className="w-full">
                      <summary className="cursor-pointer text-right text-xs underline underline-offset-4">
                        Edit
                      </summary>
                      <div className="mt-2">
                        <ActionForm
                          action={updateIdentityAction}
                          submitLabel="Save"
                          pendingLabel="Saving…"
                          variant="outline"
                        >
                          <input type="hidden" name="identityId" value={record.id} />
                          <Field
                            name="fromName"
                            idSuffix={record.id}
                            label="From name"
                            required
                            maxLength={120}
                            defaultValue={record.from_name}
                          />
                          <Field
                            name="replyTo"
                            idSuffix={record.id}
                            label="Reply-to"
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
                      className="flex justify-end"
                    >
                      <input type="hidden" name="identityId" value={record.id} />
                    </ActionForm>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
