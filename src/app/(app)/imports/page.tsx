import Link from 'next/link';
import { currentWorkspace } from '@/lib/auth/workspace';
import { listImports } from '@/lib/imports/service';
import { listContactLists } from '@/lib/lists/service';
import { decodeCursor, encodeCursor, type PageDirection } from '@/lib/pagination';
import { Pager } from '@/components/pager';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/table';
import { ImportWizard } from './import-wizard';
import { STATUS_TONE, STATUS_LABEL } from './status';

export const dynamic = 'force-dynamic';

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const { workspaceId } = await currentWorkspace();
  const direction: PageDirection = one('dir') === 'backward' ? 'backward' : 'forward';

  const [page, lists] = await Promise.all([
    listImports(workspaceId, { cursor: decodeCursor(one('cursor')), direction }),
    listContactLists(workspaceId, { limit: 100 }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Import contacts</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          Upload a spreadsheet, confirm which column is which, and import. Every row is
          accounted for — nothing is dropped without a reason you can read.
        </p>
      </div>

      <ImportWizard lists={lists.items.map((list) => ({ id: list.id, name: list.name }))} />

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Recent imports</h2>

        {page.items.length === 0 ? (
          <EmptyState>No imports yet.</EmptyState>
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>File</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Total</TH>
                  <TH className="text-right">Valid</TH>
                  <TH>List</TH>
                  <TH>Started</TH>
                  <TH className="text-right">Result</TH>
                </TR>
              </THead>
              <TBody>
                {page.items.map((record) => (
                  <TR key={record.id}>
                    <TD className="max-w-[14rem] truncate font-medium">{record.filename}</TD>
                    <TD>
                      <Badge tone={STATUS_TONE[record.status]}>
                        {STATUS_LABEL[record.status]}
                      </Badge>
                    </TD>
                    <TD className="text-right tabular-nums">
                      {record.rows_total.toLocaleString('en-US')}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {record.rows_valid.toLocaleString('en-US')}
                    </TD>
                    <TD className="text-[--color-muted-foreground]">
                      {record.target_list_name ?? '—'}
                    </TD>
                    <TD className="whitespace-nowrap text-[--color-muted-foreground]">
                      {new Date(record.created_at).toLocaleString()}
                    </TD>
                    <TD className="text-right">
                      <Link
                        href={`/imports/${record.id}`}
                        className="text-sm underline underline-offset-4"
                      >
                        View
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>

            <Pager
              basePath="/imports"
              params={{}}
              nextCursor={page.nextCursor === null ? null : encodeCursor(page.nextCursor)}
              prevCursor={page.prevCursor === null ? null : encodeCursor(page.prevCursor)}
              showing={page.items.length}
            />
          </>
        )}
      </div>
    </div>
  );
}
