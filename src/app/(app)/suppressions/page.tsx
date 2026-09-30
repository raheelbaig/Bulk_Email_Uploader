import Link from 'next/link';
import { Ban, Lock, Search, ShieldCheck } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import {
  listSuppressions,
  SUPPRESSION_REASONS,
  isReversible,
  type SuppressionReason,
} from '@/lib/suppression/service';
import { decodeCursor, encodeCursor, type PageDirection } from '@/lib/pagination';
import { addSuppressionAction, removeSuppressionAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { CreatePanel } from '@/components/create-panel';
import { Field, FieldShell } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { Pager } from '@/components/pager';
import { StatusBadge } from '@/components/status-badge';
import { SUPPRESSION_REASON_LABEL, suppressionSourceLabel } from '@/components/suppression-copy';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

/**
 * Reasons a person may create by hand.
 *
 * The others are recorded by the system from provider events (P6). Offering
 * "complaint" in a manual form would invite mislabelling, and the label decides
 * whether the record can ever be removed.
 */
const MANUAL_REASONS: SuppressionReason[] = ['manually_blocked', 'invalid', 'unsubscribe'];

function asReason(value: string | undefined): SuppressionReason | undefined {
  return SUPPRESSION_REASONS.includes(value as SuppressionReason)
    ? (value as SuppressionReason)
    : undefined;
}

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const { workspaceId, role } = await workspaceForPage();
  const canRemove = role === 'owner' || role === 'admin';

  const search = one('q');
  const reason = asReason(one('reason'));
  const direction: PageDirection = one('dir') === 'backward' ? 'backward' : 'forward';

  const page = await listSuppressions(workspaceId, {
    search,
    reason,
    cursor: decodeCursor(one('cursor')),
    direction,
  });
  const filtered = search !== undefined || reason !== undefined;
  const firstPage = one('cursor') === undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Unsubscribed & blocked"
        description="People who will never receive email from this workspace — because they unsubscribed, their address didn’t work, or your team blocked it. This is checked every time a campaign sends."
        actions={
          <Link href="#new" className={buttonVariants()}>
            <Ban aria-hidden />
            Block an address
          </Link>
        }
      />

      <CreatePanel
        title="Block an address"
        description="This address won’t receive any campaign from this workspace, even if it’s on a list."
      >
        <ActionForm
          action={addSuppressionAction}
          submitLabel="Block address"
          pendingLabel="Blocking…"
          size="default"
          confirm={{
            title: 'Block this address?',
            description:
              'This address won’t receive any campaign from this workspace, even if it’s on a list. An owner or admin can unblock it later.',
            confirmLabel: 'Block address',
            byField: {
              name: 'reason',
              values: {
                unsubscribe: {
                  title: 'Mark this address as unsubscribed?',
                  description:
                    'This address will never receive a campaign from this workspace again, even if it’s on a list. Only use this when the person asked not to be emailed.',
                  irreversible: true,
                  confirmLabel: 'Mark as unsubscribed',
                },
                invalid: {
                  title: 'Block this address as invalid?',
                  description:
                    'This address won’t receive any campaign from this workspace, even if it’s on a list. An owner or admin can unblock it later.',
                  confirmLabel: 'Block address',
                },
              },
            },
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="email" label="Email address" type="email" required maxLength={320} autoComplete="off" />
            <FieldShell id="reason-new" label="Reason" required>
              <Select id="reason-new" name="reason" defaultValue="manually_blocked" className="w-full">
                {MANUAL_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {SUPPRESSION_REASON_LABEL[value]}
                  </option>
                ))}
              </Select>
            </FieldShell>
          </div>
          <Field
            name="detail"
            label="Note"
            maxLength={500}
            hint="Why this address was blocked. Kept in your workspace’s history."
          />
          <p className="text-sm text-(--color-muted-foreground)">
            “Blocked by your team” and “Invalid address” can be undone later by an owner or admin.
            “Unsubscribed” is permanent.
          </p>
        </ActionForm>
      </CreatePanel>

      {page.items.length === 0 && !filtered && firstPage ? (
        <EmptyState
          icon={ShieldCheck}
          title="No one is unsubscribed or blocked"
          description="When someone clicks the unsubscribe link in one of your emails, they’ll appear here automatically and won’t be emailed again. You can also block an address yourself."
          action={
            <Link href="#new" className={buttonVariants({ variant: 'outline' })}>
              <Ban aria-hidden />
              Block an address
            </Link>
          }
        />
      ) : (
        <>
          <form
            method="get"
            role="search"
            aria-label="Filter blocked addresses"
            className="flex flex-col gap-3 rounded-xl border bg-(--color-card) p-3 shadow-xs sm:flex-row sm:items-center"
          >
            <div className="relative min-w-0 flex-1">
              <label htmlFor="q" className="sr-only">
                Search by email
              </label>
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-(--color-muted-foreground)"
                aria-hidden
              />
              <Input
                id="q"
                name="q"
                type="search"
                defaultValue={search ?? ''}
                placeholder="Email starts with…"
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="reason" className="sr-only">
                Reason
              </label>
              <Select id="reason" name="reason" defaultValue={reason ?? ''} className="min-w-0 flex-1 sm:w-52 sm:flex-none">
                <option value="">All reasons</option>
                {SUPPRESSION_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {SUPPRESSION_REASON_LABEL[value]}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="secondary">
                Search
              </Button>
              {filtered && (
                <Link href="/suppressions" className={buttonVariants({ variant: 'ghost' })}>
                  Clear
                </Link>
              )}
            </div>
          </form>

          {page.items.length === 0 ? (
            <EmptyState
              compact
              icon={Search}
              title="No matching addresses"
              description="Try a different search, or clear the filters."
              action={
                <Link href="/suppressions" className={buttonVariants({ variant: 'outline' })}>
                  Clear filters
                </Link>
              }
            />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>Email</TH>
                    <TH>Reason</TH>
                    <TH className="hidden md:table-cell">Source</TH>
                    <TH className="hidden sm:table-cell">Date</TH>
                    <TH className="text-right">
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {page.items.map((record) => {
                    const reversible = isReversible(record.reason);
                    const removable = canRemove && reversible;
                    return (
                      <TR key={record.id}>
                        <TD className="max-w-[14rem] truncate font-medium sm:max-w-none">{record.email_normalized}</TD>
                        <TD>
                          <StatusBadge
                            tone={reversible ? 'warning' : 'danger'}
                            label={SUPPRESSION_REASON_LABEL[record.reason] ?? record.reason}
                            icon={Ban}
                          />
                        </TD>
                        <TD className="hidden text-(--color-muted-foreground) md:table-cell">
                          {suppressionSourceLabel(record.source)}
                        </TD>
                        <TD className="hidden whitespace-nowrap text-(--color-muted-foreground) sm:table-cell">
                          {new Date(record.created_at).toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </TD>
                        <TD className="text-right">
                          {removable ? (
                            <ActionForm
                              action={removeSuppressionAction}
                              submitLabel="Unblock"
                              pendingLabel="Unblocking…"
                              variant="ghost"
                              className="flex flex-col items-end gap-1"
                              actionsClassName="justify-end"
                              confirm={{
                                title: `Unblock ${record.email_normalized}?`,
                                description:
                                  'This address will be able to receive your campaigns again if it’s on a list you send to.',
                                confirmLabel: 'Unblock address',
                              }}
                            >
                              <input type="hidden" name="suppressionId" value={record.id} />
                            </ActionForm>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-(--color-muted-foreground)"
                              title={
                                reversible
                                  ? 'Only an owner or admin can unblock an address.'
                                  : 'The person asked not to be emailed, or their address doesn’t work. This can’t be undone.'
                              }
                            >
                              <Lock className="size-3" aria-hidden />
                              {reversible ? 'Admins only' : 'Permanent'}
                            </span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>

              <p className="flex items-start gap-1.5 text-sm text-(--color-muted-foreground)">
                <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  <span className="font-medium text-(--color-foreground)">Permanent</span> means the person
                  unsubscribed, marked an email as spam, their address doesn’t work, or the email provider blocked it — they can’t be emailed again.
                  Addresses blocked by your team or marked invalid can be unblocked by an owner or admin.
                </span>
              </p>

              <Pager
                basePath="/suppressions"
                params={{ q: search, reason }}
                nextCursor={page.nextCursor === null ? null : encodeCursor(page.nextCursor)}
                prevCursor={page.prevCursor === null ? null : encodeCursor(page.prevCursor)}
                showing={page.items.length}
                noun="address"
                plural="addresses"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
