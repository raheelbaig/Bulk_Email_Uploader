import Link from 'next/link';
import { ShieldBan } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import {
  listSuppressions,
  SUPPRESSION_REASONS,
  isReversible,
  type SuppressionReason,
} from '@/lib/suppression/service';
import { decodeCursor, encodeCursor, type PageDirection } from '@/lib/pagination';
import { addSuppressionAction, removeSuppressionAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { Pager } from '@/components/pager';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

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

  const { workspaceId, role } = await currentWorkspace();
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Suppressions</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          Addresses this workspace will never email. Checked on every send, not just at import.
        </p>
      </div>

      <details className="rounded-lg border">
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
          <ShieldBan className="h-4 w-4" aria-hidden />
          Suppress an address
        </summary>
        <div className="border-t px-4 py-4">
          <ActionForm
            action={addSuppressionAction}
            submitLabel="Suppress address"
            pendingLabel="Suppressing…"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field name="email" label="Email" type="email" required maxLength={320} />
              <div className="flex flex-col gap-1.5">
                <label htmlFor="reason" className="text-sm font-medium">
                  Reason
                </label>
                <Select id="reason" name="reason" defaultValue="manually_blocked">
                  {MANUAL_REASONS.map((value) => (
                    <option key={value} value={value}>
                      {value.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <Field
              name="detail"
              label="Note"
              maxLength={500}
              hint="Why this address was suppressed. Kept for the audit trail."
            />
          </ActionForm>
        </div>
      </details>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="q" className="text-xs font-medium text-[--color-muted-foreground]">
            Search
          </label>
          <Input
            id="q"
            name="q"
            defaultValue={search ?? ''}
            placeholder="Starts with…"
            className="w-64"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="reason" className="text-xs font-medium text-[--color-muted-foreground]">
            Reason
          </label>
          <Select id="reason" name="reason" defaultValue={reason ?? ''}>
            <option value="">All reasons</option>
            {SUPPRESSION_REASONS.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline" size="sm">
          Apply
        </Button>
        {(search !== undefined || reason !== undefined) && (
          <Link href="/suppressions" className="px-2 py-1.5 text-sm underline underline-offset-4">
            Clear
          </Link>
        )}
      </form>

      {page.items.length === 0 ? (
        <EmptyState>
          {search !== undefined || reason !== undefined
            ? 'No suppressions match those filters.'
            : 'No suppressed addresses. Bounces and complaints will appear here automatically once sending is enabled.'}
        </EmptyState>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Email</TH>
                <TH>Reason</TH>
                <TH>Source</TH>
                <TH>Created</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {page.items.map((record) => {
                const removable = canRemove && isReversible(record.reason);
                return (
                  <TR key={record.id}>
                    <TD className="font-medium">{record.email_normalized}</TD>
                    <TD>
                      <Badge tone={isReversible(record.reason) ? 'warning' : 'danger'}>
                        {record.reason.replace(/_/g, ' ')}
                      </Badge>
                    </TD>
                    <TD className="text-[--color-muted-foreground]">{record.source}</TD>
                    <TD className="whitespace-nowrap text-[--color-muted-foreground]">
                      {new Date(record.created_at).toLocaleDateString()}
                    </TD>
                    <TD className="text-right">
                      {removable ? (
                        <ActionForm
                          action={removeSuppressionAction}
                          submitLabel="Remove"
                          pendingLabel="Removing…"
                          variant="ghost"
                          className="flex justify-end"
                        >
                          <input type="hidden" name="suppressionId" value={record.id} />
                        </ActionForm>
                      ) : (
                        <span
                          className="text-xs text-[--color-muted-foreground]"
                          title={
                            isReversible(record.reason)
                              ? 'Only an owner or admin can remove a suppression.'
                              : 'The recipient asked not to be emailed, or their provider rejected the address. This cannot be undone.'
                          }
                        >
                          Permanent
                        </span>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>

          <Pager
            basePath="/suppressions"
            params={{ q: search, reason }}
            nextCursor={page.nextCursor === null ? null : encodeCursor(page.nextCursor)}
            prevCursor={page.prevCursor === null ? null : encodeCursor(page.prevCursor)}
            showing={page.items.length}
          />
        </>
      )}
    </div>
  );
}
