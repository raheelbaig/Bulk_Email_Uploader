import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, CheckCircle2, Columns3, Download, Loader2, Trash2, Upload, Users, XCircle } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { getImport, listRejections } from '@/lib/imports/service';
import { isAppError } from '@/lib/errors';
import { ROW_BUCKETS, STAGED_FILE_MAX_AGE_MS } from '@/lib/imports/constants';
import { AutoRefresh } from '@/components/auto-refresh';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { STATUS_LABEL, STATUS_TONE, BUCKET_EXPLANATION, BUCKET_TITLE } from '../status';
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
  const { workspaceId } = await workspaceForPage();

  const record = await getImport(workspaceId, id).catch((err: unknown) => {
    // A forbidden import and a nonexistent one are the same answer, so an id
    // from another workspace cannot be distinguished from a typo — nor can a
    // malformed id.
    if (isAppError(err) && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND' || err.code === 'VALIDATION_FAILED')) notFound();
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
  const notAdded = record.rows_total - record.rows_valid;
  const completed = record.status === 'completed';
  const waiting = record.status === 'uploaded' || record.status === 'mapping';
  const expiresAt = new Date(new Date(record.created_at).getTime() + STAGED_FILE_MAX_AGE_MS);
  // The file of a waiting import is kept for 24 hours, then swept.
  const fileAvailable = waiting && expiresAt.getTime() > Date.now();
  // A running import that hasn't finished after a few minutes may have lost its
  // background pass; the retry is a no-op if it is in fact still running.
  const startedAt = record.started_at === null ? null : new Date(record.started_at).getTime();
  const stalled = record.status === 'processing' && startedAt !== null && Date.now() - startedAt > 3 * 60 * 1000;

  const headline = completed
    ? 'Import complete'
    : record.status === 'failed'
      ? 'This import didn’t finish'
      : record.status === 'processing'
        ? 'Importing your contacts…'
        : 'Waiting for you to match the columns';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: '/imports', label: 'Imports' }}
        title={record.filename}
        meta={<StatusBadge tone={STATUS_TONE[record.status]} label={STATUS_LABEL[record.status]} />}
        description={
          <>
            {(record.byte_size / 1024).toFixed(0)} KB ·{' '}
            {record.target_list_name === null ? 'not added to a list' : `added to ${record.target_list_name}`}{' '}
            · started {new Date(record.created_at).toLocaleString()}
            {record.finished_at !== null && <> · finished {new Date(record.finished_at).toLocaleString()}</>}
          </>
        }
      />

      {/* Outcome summary */}
      <section
        aria-labelledby="outcome-title"
        className={cn(
          'flex flex-col gap-5 rounded-xl border bg-(--color-card) p-5 shadow-xs sm:p-6',
          completed && 'border-(--color-success-border)',
          record.status === 'failed' && 'border-(--color-danger-border)',
        )}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              completed
                ? 'bg-(--color-success-subtle) text-(--color-success)'
                : record.status === 'failed'
                  ? 'bg-(--color-danger-subtle) text-(--color-danger)'
                  : 'bg-(--color-info-subtle) text-(--color-info)',
            )}
          >
            {completed ? (
              <CheckCircle2 className="size-5" aria-hidden />
            ) : record.status === 'failed' ? (
              <XCircle className="size-5" aria-hidden />
            ) : waiting ? (
              <Columns3 className="size-5" aria-hidden />
            ) : (
              <Loader2 className="size-5 animate-spin" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <h2 id="outcome-title" className="text-lg font-semibold tracking-tight">
              {headline}
            </h2>
            {waiting ? (
              <p className="mt-0.5 text-sm text-(--color-muted-foreground)">
                The file was uploaded, but nothing has been imported yet. Match its columns and confirm to
                import it.
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-(--color-muted-foreground)">
                {record.rows_valid.toLocaleString('en-US')}{' '}
                {record.rows_valid === 1 ? 'contact was' : 'contacts were'} added
                {notAdded > 0 && (
                  <>
                    {' '}· {notAdded.toLocaleString('en-US')} {notAdded === 1 ? 'row wasn’t' : 'rows weren’t'} added as new
                  </>
                )}
                {record.rows_total > 0 && <> · {record.rows_total.toLocaleString('en-US')} rows in the file</>}
              </p>
            )}
          </div>
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

        {waiting &&
          (fileAvailable ? (
            <div className="flex flex-col items-start gap-2">
              <Link href={`/imports?resume=${record.id}`} className={buttonVariants()}>
                Continue matching columns
                <ArrowRight aria-hidden />
              </Link>
              <p className="text-sm text-(--color-muted-foreground)">
                Your file is kept until {expiresAt.toLocaleString()} so you can finish. After that you’d need
                to upload it again.
              </p>
            </div>
          ) : (
            <Alert tone="warning">
              This upload wasn’t finished within 24 hours, so the file is no longer available. Upload it again
              to import it.
            </Alert>
          ))}

        {record.status === 'processing' && (
          <>
            <AutoRefresh />
            <Alert tone="info">
              This import is running in the background. This page updates by itself — you can also leave and
              come back later.
            </Alert>
          </>
        )}

        {stalled && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-(--color-muted-foreground)">
              Taking longer than expected? Resuming is safe — it never imports a row twice.
            </p>
            <RetryImport importId={record.id} />
          </div>
        )}

        {!waiting && (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {ROW_BUCKETS.map((bucket) => (
                <div
                  key={bucket}
                  className={cn(
                    'rounded-lg border px-3 py-2.5',
                    bucket === 'valid'
                      ? 'border-(--color-success-border) bg-(--color-success-subtle)'
                      : counters[bucket] > 0
                        ? 'bg-(--color-surface-subtle)'
                        : 'bg-(--color-surface)',
                  )}
                >
                  <dt className="text-xs font-medium text-(--color-muted-foreground)">{BUCKET_TITLE[bucket]}</dt>
                  <dd className="mt-0.5 text-xl font-semibold tabular-nums">
                    {counters[bucket].toLocaleString('en-US')}
                  </dd>
                  <dd className="mt-0.5 text-xs leading-snug text-(--color-muted-foreground)">
                    {BUCKET_EXPLANATION[bucket]}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-(--color-muted-foreground)">
              {reconciles
                ? 'Every row in your file is counted in exactly one of these.'
                : 'Still running — these will add up to the total when the import finishes.'}
            </p>
          </>
        )}

        <div className="flex flex-wrap gap-2 border-t pt-5">
          {!waiting && (
            <Link href="/contacts" className={buttonVariants(completed ? {} : { variant: 'outline' })}>
              <Users aria-hidden />
              View contacts
            </Link>
          )}
          {rejections.length > 0 && (
            <Button asChild variant="outline">
              <a href={`/api/imports/${record.id}/rejections`} download>
                <Download aria-hidden />
                Download rows not added
              </a>
            </Button>
          )}
          <Link href="/imports" className={buttonVariants({ variant: 'ghost' })}>
            <Upload aria-hidden />
            Import another file
          </Link>
        </div>
      </section>

      {rejections.length > 0 && (
        <SectionCard
          title="Rows that weren’t added as new contacts"
          description="The download includes each row’s original values, so you can fix them and import again. It’s safe to open in any spreadsheet app."
          bodyClassName="px-0 pb-0 sm:px-0 sm:pb-0"
        >
          <div className="border-t [&>div]:rounded-none [&>div]:border-0 [&>div]:shadow-none">
            <Table>
              <THead>
                <TR>
                  <TH className="w-20">Row</TH>
                  <TH className="w-48">What happened</TH>
                  <TH>Details</TH>
                </TR>
              </THead>
              <TBody>
                {rejections.map((rejection) => (
                  <TR key={rejection.id}>
                    <TD className="tabular-nums">{rejection.row_number}</TD>
                    <TD className="whitespace-nowrap">{BUCKET_TITLE[rejection.bucket]}</TD>
                    <TD className="min-w-[12rem] text-(--color-muted-foreground)">{rejection.reason}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </SectionCard>
      )}

      {completed && rejections.length === 0 && (
        <Alert tone="success">Every row imported cleanly — nothing was set aside.</Alert>
      )}

      {(completed || record.status === 'failed') && (
        <p className="flex items-center gap-1.5 text-sm text-(--color-muted-foreground)">
          <Trash2 className="size-3.5 shrink-0" aria-hidden />
          {completed
            ? 'Your uploaded file was deleted from storage when this import finished.'
            : 'Your uploaded file is deleted automatically within 24 hours of uploading it.'}
        </p>
      )}
    </div>
  );
}
