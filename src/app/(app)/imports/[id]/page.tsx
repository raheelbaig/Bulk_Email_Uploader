import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download, RefreshCw } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { getImport, listRejections } from '@/lib/imports/service';
import { isAppError } from '@/lib/errors';
import { ROW_BUCKETS, BUCKET_LABEL } from '@/lib/imports/constants';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/table';
import { STATUS_LABEL, STATUS_TONE, BUCKET_EXPLANATION } from '../status';
import { RetryImport } from './retry-import';

export const dynamic = 'force-dynamic';

/**
 * The import result.
 *
 * The counters shown here are the ones the database holds, and the database
 * refuses to record a completed import whose counters do not sum to its row
 * total. So the reconciliation line below is not a claim this page computes —
 * it is a restatement of a constraint that has already been enforced.
 */
export default async function ImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { workspaceId } = await currentWorkspace();

  const record = await getImport(workspaceId, id).catch((err: unknown) => {
    // A forbidden import and a nonexistent one are the same answer, so an id
    // from another workspace cannot be distinguished from a typo.
    if (isAppError(err) && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) notFound();
    throw err;
  });

  const rejections = record.rows_rejected + record.rows_invalid + record.rows_duplicate +
    record.rows_suppressed > 0
    ? await listRejections(workspaceId, id, 200)
    : [];

  const counters = {
    valid: record.rows_valid,
    invalid: record.rows_invalid,
    duplicate: record.rows_duplicate,
    suppressed: record.rows_suppressed,
    rejected: record.rows_rejected,
  } as const;

  const sum = ROW_BUCKETS.reduce((total, bucket) => total + counters[bucket], 0);
  const reconciles = sum === record.rows_total;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/imports" className="text-sm underline underline-offset-4">
            ← All imports
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{record.filename}</h1>
          <p className="text-sm text-[--color-muted-foreground]">
            {(record.byte_size / 1024).toFixed(0)} KB ·{' '}
            {record.target_list_name === null
              ? 'no target list'
              : `added to ${record.target_list_name}`}{' '}
            · {new Date(record.created_at).toLocaleString()}
            {record.finished_at !== null && (
              <> · finished {new Date(record.finished_at).toLocaleString()}</>
            )}
          </p>
        </div>
        <Badge tone={STATUS_TONE[record.status]}>{STATUS_LABEL[record.status]}</Badge>
      </div>

      {record.error_message !== null && (
        <Alert tone="destructive">
          {record.error_message}
          {record.rows_total > 0 && (
            <>
              {' '}
              The {record.rows_valid.toLocaleString('en-US')} contacts already imported were kept —
              nothing was rolled back.
            </>
          )}
        </Alert>
      )}

      {record.status === 'processing' && (
        <Alert>
          This import is running in the background. Refresh to see the result.
        </Alert>
      )}

      {(record.status === 'processing' || record.status === 'failed') && (
        <RetryImport importId={record.id} />
      )}

      <div className="rounded-lg border">
        <div className="border-b px-4 py-3 text-sm font-medium">
          {record.status === 'completed' ? 'Import complete' : 'Rows accounted for'}
        </div>
        <dl className="divide-y">
          <div className="flex items-center justify-between px-4 py-2.5">
            <dt className="text-sm font-medium">Total rows</dt>
            <dd className="text-sm font-semibold tabular-nums">
              {record.rows_total.toLocaleString('en-US')}
            </dd>
          </div>
          {ROW_BUCKETS.map((bucket) => (
            <div key={bucket} className="flex items-center justify-between px-4 py-2.5">
              <dt className="text-sm">
                {BUCKET_LABEL[bucket]}
                <span className="ml-2 text-xs text-[--color-muted-foreground]">
                  {BUCKET_EXPLANATION[bucket]}
                </span>
              </dt>
              <dd className="text-sm tabular-nums">{counters[bucket].toLocaleString('en-US')}</dd>
            </div>
          ))}
        </dl>
        <div className="border-t px-4 py-2.5 text-xs text-[--color-muted-foreground]">
          {reconciles
            ? 'Every row is accounted for in exactly one category.'
            : 'This import is still running — the categories will add up to the total when it finishes.'}
        </div>
      </div>

      {rejections.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold tracking-tight">Rows not imported as new</h2>
            <Button asChild size="sm" variant="outline">
              <a href={`/api/imports/${record.id}/rejections`} download>
                <Download className="h-3.5 w-3.5" aria-hidden />
                Download CSV
              </a>
            </Button>
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-20">Row</TH>
                <TH className="w-32">Category</TH>
                <TH>Reason</TH>
              </TR>
            </THead>
            <TBody>
              {rejections.map((rejection) => (
                <TR key={rejection.id}>
                  <TD className="tabular-nums">{rejection.row_number}</TD>
                  <TD>{BUCKET_LABEL[rejection.bucket]}</TD>
                  <TD className="text-[--color-muted-foreground]">{rejection.reason}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="text-xs text-[--color-muted-foreground]">
            The download includes the original cells for each row so you can correct and
            re-upload them. Values are escaped so the file cannot run anything when opened in a
            spreadsheet.
          </p>
        </div>
      )}

      {record.status === 'completed' && rejections.length === 0 && (
        <EmptyState>Every row imported cleanly.</EmptyState>
      )}

      <p className="flex items-center gap-1.5 text-xs text-[--color-muted-foreground]">
        <RefreshCw className="h-3 w-3" aria-hidden />
        The uploaded file was deleted from storage when this import finished.
      </p>
    </div>
  );
}
