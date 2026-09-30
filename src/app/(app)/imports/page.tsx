import Link from 'next/link';
import { ArrowRight, ChevronRight, FileSpreadsheet } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { getImport, listImports } from '@/lib/imports/service';
import { STAGED_FILE_MAX_AGE_MS } from '@/lib/imports/constants';
import { listContactLists } from '@/lib/lists/service';
import { decodeCursor, encodeCursor, type PageDirection } from '@/lib/pagination';
import { AutoRefresh } from '@/components/auto-refresh';
import { PageHeader } from '@/components/page-header';
import { Pager } from '@/components/pager';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { ImportWizard, type ResumeImport } from './import-wizard';
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

  const { workspaceId } = await workspaceForPage();
  const direction: PageDirection = one('dir') === 'backward' ? 'backward' : 'forward';

  const resumeParam = one('resume');
  const [page, lists, resumeRecord] = await Promise.all([
    listImports(workspaceId, { cursor: decodeCursor(one('cursor')), direction }),
    listContactLists(workspaceId, { limit: 100 }),
    // Authorized like any other read: another workspace's id, a malformed id
    // or a finished import simply resumes nothing.
    resumeParam === undefined ? null : getImport(workspaceId, resumeParam).catch(() => null),
  ]);

  const waiting = (status: string) => status === 'uploaded' || status === 'mapping';
  const resume: ResumeImport | undefined =
    resumeRecord !== null && waiting(resumeRecord.status)
      ? { importId: resumeRecord.id, filename: resumeRecord.filename, targetListId: resumeRecord.target_list_id }
      : undefined;
  // Imports still waiting for their columns, whose file hasn't expired yet.
  const cutoff = Date.now() - STAGED_FILE_MAX_AGE_MS;
  const unfinished = page.items.filter(
    (record) =>
      waiting(record.status) && record.id !== resume?.importId && new Date(record.created_at).getTime() > cutoff,
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Import contacts"
        description="Upload a spreadsheet, check which column is which, and import. Every row is accounted for — you’ll see exactly what was added and what wasn’t, and why."
      />

      {unfinished.length > 0 && (
        <Alert
          tone="warning"
          title={unfinished.length === 1 ? 'You have an unfinished import' : `You have ${unfinished.length} unfinished imports`}
        >
          <p>These files were uploaded but their columns haven’t been matched yet, so nothing was imported.</p>
          <ul className="mt-2 flex flex-col gap-2">
            {unfinished.map((record) => (
              <li key={record.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 truncate font-medium">{record.filename}</span>
                <Link
                  href={`/imports?resume=${record.id}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  Continue matching columns
                  <ArrowRight aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <ImportWizard
        lists={lists.items.map((list) => ({ id: list.id, name: list.name }))}
        {...(resume === undefined ? {} : { resume })}
      />

      <section aria-labelledby="recent-imports" className="flex flex-col gap-3">
        <h2 id="recent-imports" className="text-base font-semibold tracking-tight">
          Recent imports
        </h2>
        {page.items.some((record) => record.status === 'processing') && <AutoRefresh intervalMs={5000} />}

        {page.items.length === 0 ? (
          <p className="rounded-xl border border-dashed px-6 py-8 text-center text-sm text-(--color-muted-foreground)">
            Your past imports will appear here, with a breakdown of what was added.
          </p>
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>File</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Added</TH>
                  <TH className="hidden text-right md:table-cell">Rows</TH>
                  <TH className="hidden lg:table-cell">List</TH>
                  <TH className="hidden sm:table-cell">Date</TH>
                  <TH className="w-10">
                    <span className="sr-only">Open</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {page.items.map((record) => (
                  <TR key={record.id} className="group relative">
                    <TD className="max-w-[12rem] sm:max-w-[16rem]">
                      <Link
                        href={`/imports/${record.id}`}
                        className="flex min-w-0 items-center gap-2.5 after:absolute after:inset-0 focus-visible:outline-none after:focus-visible:ring-2 after:focus-visible:ring-(--color-ring) after:focus-visible:ring-inset"
                      >
                        <FileSpreadsheet className="size-4 shrink-0 text-(--color-muted-foreground)" aria-hidden />
                        <span className="truncate font-medium">{record.filename}</span>
                      </Link>
                    </TD>
                    <TD>
                      <StatusBadge tone={STATUS_TONE[record.status]} label={STATUS_LABEL[record.status]} />
                    </TD>
                    <TD className="text-right font-medium tabular-nums">
                      {record.rows_valid.toLocaleString('en-US')}
                    </TD>
                    <TD className="hidden text-right text-(--color-muted-foreground) tabular-nums md:table-cell">
                      {record.rows_total.toLocaleString('en-US')}
                    </TD>
                    <TD className="hidden max-w-[10rem] truncate text-(--color-muted-foreground) lg:table-cell">
                      {record.target_list_name ?? '—'}
                    </TD>
                    <TD className="hidden whitespace-nowrap text-(--color-muted-foreground) sm:table-cell">
                      {new Date(record.created_at).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TD>
                    <TD className="text-(--color-muted-foreground)">
                      <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
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
              noun="import"
            />
          </>
        )}
      </section>
    </div>
  );
}
