'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  FileSpreadsheet,
  Loader2,
  ShieldCheck,
  Upload,
  UploadCloud,
} from 'lucide-react';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { Stepper, type StepItem } from '@/components/stepper';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  ACCEPTED_EXTENSIONS,
  CONTACT_FIELDS,
  FIELD_LABEL,
  MAX_SPREADSHEET_ROWS,
  MAX_UPLOAD_BYTES,
  type ContactField,
} from '@/lib/imports/constants';
import type { ColumnMapping, MappingTarget } from '@/lib/imports/mapping';
import {
  abandonImportAction,
  createImportAction,
  inspectImportAction,
  confirmMappingAction,
  type ImportActionState,
} from './actions';

/**
 * The import flow: upload → match columns → review → import.
 *
 * The mapping step exists because it is a safety boundary, not because a wizard
 * looked nice: a file whose columns are in an unexpected order must not import
 * silently (ARCHITECTURE §20.2). The review step is presentation only — it
 * restates the mapping before the same confirm call starts the import.
 *
 * The file goes straight from the browser to a private bucket through a signed,
 * path-bound URL. It does not pass through a server action, which on this
 * platform would cap the upload at a few megabytes.
 *
 * ── Resuming, and not leaving imports behind ──────────────────────────────
 *
 * An import exists from the moment its file is uploaded, and waits in
 * `uploaded`/`mapping` until the columns are confirmed. So:
 *
 *   - once a file is uploaded the URL becomes `/imports?resume=<id>`, and the
 *     page hands that import back to this component — a refresh, or coming
 *     back from the import's own page, returns to "Match columns" by reading
 *     the staged file again (`inspectImport`), not by uploading a new one;
 *   - "Back" keeps the import. Continuing with the same file goes straight back
 *     to the columns; choosing a different file closes the old import first
 *     (`abandonImportAction`), so it is never left waiting forever.
 */

type InspectionResult = NonNullable<ImportActionState['inspection']>;

interface ListOption {
  id: string;
  name: string;
}

export interface ResumeImport {
  importId: string;
  filename: string;
  targetListId: string | null;
}

type Step = 'upload' | 'mapping' | 'review';

const MAX_MB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));

function targetKey(target: MappingTarget): string {
  if (target.kind === 'field') return `field:${target.field}`;
  if (target.kind === 'custom') return `custom:${target.key}`;
  return 'ignore';
}

function setResumeParam(importId: string | null): void {
  try {
    const url = importId === null ? '/imports' : `/imports?resume=${encodeURIComponent(importId)}`;
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // History unavailable: the import is still listed under Recent imports.
  }
}

export function ImportWizard({ lists, resume }: { lists: ListOption[]; resume?: ResumeImport }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('upload');
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [resuming, setResuming] = useState(resume !== undefined);
  const [dragging, setDragging] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [targetListId, setTargetListId] = useState<string>(resume?.targetListId ?? '');
  const [importId, setImportId] = useState<string | null>(resume?.importId ?? null);
  // The file the current import was created from, and its name (a resumed
  // import has a name but no File object in this browser tab).
  const uploadedFile = useRef<File | null>(null);
  const [uploadedName, setUploadedName] = useState<string | null>(resume?.filename ?? null);

  const [headerRow, setHeaderRow] = useState(0);
  const [headers, setHeaders] = useState<string[]>([]);
  const [sample, setSample] = useState<string[][]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [customKeys, setCustomKeys] = useState<string[]>([]);

  const applyState = (state: ImportActionState): boolean => {
    if (!state.ok) {
      setError(state.message ?? 'That did not work.');
      return false;
    }
    setError(null);
    return true;
  };

  const applyInspection = useCallback((inspection: InspectionResult) => {
    const { proposal, sample: sampleRows } = inspection;
    setHeaderRow(proposal.headerRow);
    setHeaders(proposal.headers);
    setSample(sampleRows);
    setTargets(proposal.columns.map((column) => targetKey(column.target)));
    setCustomKeys(
      proposal.columns.map((column) => (column.target.kind === 'custom' ? column.target.key : '')),
    );
    setNotice(
      proposal.emailUnresolved
        ? 'We couldn’t tell which column holds the email address. Choose it below.'
        : null,
    );
    setStep('mapping');
  }, []);

  // Resume an import that is waiting for its columns to be matched. Keyed on
  // the id, and run once per id: a revalidation that re-renders the page with
  // the same import must not re-read the file and reset the person's choices.
  const resumeId = resume?.importId;
  const resumeName = resume?.filename;
  const resumeList = resume?.targetListId ?? null;
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (resumeId === undefined || resumedFor.current === resumeId) return;
    resumedFor.current = resumeId;
    // Also reached by following a "Continue" link while this page is open.
    setResuming(true);
    setError(null);
    setFile(null);
    uploadedFile.current = null;
    setImportId(resumeId);
    setUploadedName(resumeName ?? null);
    setTargetListId(resumeList ?? '');
    void (async () => {
      const inspected = await inspectImportAction(resumeId);
      setResuming(false);
      if (!inspected.ok || inspected.inspection === undefined) {
        setError(
          `${inspected.message ?? 'That import couldn’t be opened.'} You can upload the file again below.`,
        );
        setImportId(null);
        setUploadedName(null);
        setResumeParam(null);
        setStep('upload');
        return;
      }
      applyInspection(inspected.inspection);
    })();
  }, [resumeId, resumeName, resumeList, applyInspection]);

  const chooseFile = useCallback((chosen: File | null) => {
    setFileError(null);
    setError(null);
    if (chosen === null) {
      setFile(null);
      return;
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setFileError(`Files must be ${MAX_MB} MB or smaller.`);
      return;
    }
    const dot = chosen.name.lastIndexOf('.');
    const extension = dot === -1 ? '' : chosen.name.slice(dot).toLowerCase();
    if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
      setFile(null);
      setFileError('Upload a .csv, .tsv, .xlsx or .xls file.');
      return;
    }
    setFile(chosen);
  }, []);

  /**
   * Upload, then inspect.
   *
   * The client-side size and extension checks above are a courtesy — the server
   * validates the declared file before issuing a URL, and validates the actual
   * magic bytes before parsing. Neither trusts anything decided here.
   */
  const upload = async (): Promise<void> => {
    // Same import, same file (or a resumed import and no new file): go back to
    // the columns without creating anything.
    if (importId !== null && headers.length > 0 && (file === null || file === uploadedFile.current)) {
      setError(null);
      setStep('mapping');
      return;
    }
    if (file === null) return;
    setUploading(true);
    setError(null);

    try {
      // A different file replaces the waiting import rather than orphaning it.
      if (importId !== null) {
        await abandonImportAction(importId);
        setImportId(null);
        setUploadedName(null);
        uploadedFile.current = null;
        setResumeParam(null);
      }

      const created = await createImportAction({
        filename: file.name,
        byteSize: file.size,
        contentType: file.type.length > 0 ? file.type : 'application/octet-stream',
        targetListId: targetListId.length === 0 ? null : targetListId,
      });
      if (!applyState(created) || created.created === undefined) return;

      const supabase = createSupabaseBrowserClient();
      const { error: uploadError } = await supabase.storage
        .from('imports')
        .uploadToSignedUrl(created.created.storagePath, created.created.uploadToken, file);

      if (uploadError !== null) {
        setError('That upload didn’t finish. Check your connection and try again.');
        return;
      }

      // From here the import exists: a refresh resumes it instead of losing it.
      setImportId(created.created.importId);
      uploadedFile.current = file;
      setUploadedName(file.name);
      setResumeParam(created.created.importId);

      const inspected = await inspectImportAction(created.created.importId);
      if (!applyState(inspected) || inspected.inspection === undefined) return;
      applyInspection(inspected.inspection);
    } finally {
      setUploading(false);
    }
  };

  const buildMapping = (): ColumnMapping => ({
    headerRow,
    columns: headers.map((header, index) => {
      const raw = targets[index] ?? 'ignore';
      let target: MappingTarget = { kind: 'ignore' };
      if (raw.startsWith('field:')) {
        target = { kind: 'field', field: raw.slice(6) as ContactField };
      } else if (raw.startsWith('custom:')) {
        const key = customKeys[index];
        if (key !== undefined && key.length > 0) target = { kind: 'custom', key };
      }
      return { index, header, target };
    }),
  });

  const confirm = (): void => {
    if (importId === null) return;
    const mapping = buildMapping();

    const hasEmail = mapping.columns.some(
      (column) => column.target.kind === 'field' && column.target.field === 'email',
    );
    if (!hasEmail) {
      setError('Choose which column holds the email address. Every import needs one.');
      setStep('mapping');
      return;
    }

    startTransition(async () => {
      const state = await confirmMappingAction({
        importId,
        mapping,
        targetListId: targetListId.length === 0 ? null : targetListId,
      });
      if (!applyState(state)) return;
      // The import's own page follows its progress and updates by itself.
      router.push(`/imports/${importId}`);
    });
  };

  // Fields already claimed, so the same field cannot be chosen twice.
  const claimed = new Set(
    targets.filter((value) => value.startsWith('field:')).map((value) => value.slice(6)),
  );

  // ── Presentation ──────────────────────────────────────────────────────────
  const stepIndex = step === 'upload' ? 0 : step === 'mapping' ? 1 : 2;
  const stepperSteps: StepItem[] = ['Upload file', 'Match columns', 'Review', 'Import'].map((label, index) => ({
    label,
    state: index < stepIndex ? 'complete' : index === stepIndex ? 'current' : 'upcoming',
  }));

  const mappedColumns = headers
    .map((header, index) => ({ header, value: targets[index] ?? 'ignore', index }))
    .filter((column) => column.value !== 'ignore');
  const skippedCount = headers.length - mappedColumns.length;
  const emailColumn = mappedColumns.find((column) => column.value === 'field:email');
  const listName = lists.find((list) => list.id === targetListId)?.name ?? null;
  const sampleForReview = sample.slice(0, 3);

  const describeTarget = (value: string, index: number): string => {
    if (value.startsWith('field:')) return FIELD_LABEL[value.slice(6) as ContactField];
    if (value.startsWith('custom:')) return `Custom field · ${customKeys[index] ?? ''}`;
    return 'Skipped';
  };

  const goToReview = (): void => {
    if (!targets.some((value) => value === 'field:email')) {
      setError('Choose which column holds the email address. Every import needs one.');
      return;
    }
    setError(null);
    setStep('review');
  };

  const stepError =
    error !== null ? (
      <Alert tone="destructive" title="Something needs your attention">
        {error}
      </Alert>
    ) : null;

  if (resuming) {
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-(--color-card) p-5 text-sm shadow-xs sm:p-6" role="status">
        <Loader2 className="size-4 animate-spin text-(--color-muted-foreground)" aria-hidden />
        Opening {resume?.filename ?? 'your file'} so you can finish matching columns…
      </div>
    );
  }

  const canContinue = file !== null || (importId !== null && headers.length > 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border bg-(--color-card) p-2 shadow-xs">
        <Stepper steps={stepperSteps} />
      </div>

      {step === 'upload' && (
        <section
          aria-labelledby="upload-title"
          className="flex flex-col gap-5 rounded-xl border bg-(--color-card) p-5 shadow-xs sm:p-6"
        >
          <div>
            <h2 id="upload-title" className="text-base font-semibold tracking-tight">
              Upload your contacts
            </h2>
            <p className="mt-0.5 text-sm text-(--color-muted-foreground)">
              Choose a spreadsheet with one person per row. It needs a column of email addresses — names,
              company and other details are optional.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="import-file"
              className={cn(
                'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors sm:px-6',
                'hover:bg-(--color-surface-subtle)',
                'focus-within:border-(--color-primary) focus-within:ring-4 focus-within:ring-(--color-primary-subtle)',
                dragging
                  ? 'border-(--color-primary) bg-(--color-primary-subtle)'
                  : fileError !== null
                    ? 'border-(--color-danger-border)'
                    : file === null
                      ? 'border-(--color-border-strong)'
                      : 'border-(--color-success-border) bg-(--color-success-subtle)',
              )}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (!dragging) setDragging(true);
              }}
              onDragLeave={(event) => {
                // Leaving for a child element is not leaving the drop zone.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                chooseFile(event.dataTransfer.files[0] ?? null);
              }}
            >
              <span className="flex size-11 items-center justify-center rounded-xl border bg-(--color-surface) shadow-xs">
                {file === null ? (
                  <UploadCloud
                    className={cn('size-5', dragging ? 'text-(--color-primary)' : 'text-(--color-muted-foreground)')}
                    aria-hidden
                  />
                ) : (
                  <FileSpreadsheet className="size-5 text-(--color-success)" aria-hidden />
                )}
              </span>
              <span className="max-w-full truncate text-sm font-medium">
                {dragging
                  ? 'Drop the file to choose it'
                  : file !== null
                    ? file.name
                    : uploadedName !== null
                      ? `${uploadedName} (already uploaded)`
                      : 'Drop a file here, or click to choose one'}
              </span>
              <span className="text-sm text-(--color-muted-foreground)">
                {file !== null
                  ? `${(file.size / 1024).toFixed(0)} KB · click to choose a different file`
                  : uploadedName !== null
                    ? 'Continue with this file, or click to choose a different one'
                    : `CSV, TSV, XLSX or XLS · up to ${MAX_MB} MB`}
              </span>
              <input
                id="import-file"
                type="file"
                className="sr-only"
                accept={ACCEPTED_EXTENSIONS.join(',')}
                aria-describedby={fileError !== null ? 'import-file-error' : undefined}
                onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {fileError !== null && (
              <p id="import-file-error" className="text-sm font-medium text-(--color-danger)">
                {fileError}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5 sm:max-w-md">
            <label htmlFor="target-list" className="text-sm font-medium">
              Add these contacts to a list
              <span className="ml-1.5 text-xs font-normal text-(--color-muted-foreground)">Optional</span>
            </label>
            <p className="-mt-0.5 text-sm text-(--color-muted-foreground)">
              Handy if you plan to send them a campaign. You can also do this later.
            </p>
            <Select
              id="target-list"
              value={targetListId}
              onChange={(event) => setTargetListId(event.target.value)}
              className="w-full"
            >
              <option value="">Don’t add to a list</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </Select>
          </div>

          <p className="flex items-start gap-2 rounded-lg bg-(--color-surface-subtle) p-3 text-sm text-(--color-muted-foreground)">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-(--color-success)" aria-hidden />
            <span>
              Your file is stored privately and deleted once the import finishes (or after 24 hours if you
              don’t finish). We only read the values — macros, formulas and links are never opened or run.
              Spreadsheet files are limited to {MAX_SPREADSHEET_ROWS.toLocaleString('en-US')} rows; CSV files
              have no limit.
            </span>
          </p>

          {stepError}

          <div className="flex flex-wrap items-center gap-3 border-t pt-5">
            <Button type="button" disabled={!canContinue || uploading} onClick={upload}>
              {uploading && <Loader2 className="animate-spin" aria-hidden />}
              {uploading ? 'Reading your file…' : 'Continue'}
              {!uploading && <ArrowRight aria-hidden />}
            </Button>
            <span className="text-sm text-(--color-muted-foreground)">Nothing is imported until you confirm.</span>
          </div>
        </section>
      )}

      {step === 'mapping' && (
        <section
          aria-labelledby="mapping-title"
          className="flex flex-col gap-5 rounded-xl border bg-(--color-card) p-5 shadow-xs sm:p-6"
        >
          <div>
            <h2 id="mapping-title" className="text-base font-semibold tracking-tight">
              Match your columns
            </h2>
            <p className="mt-0.5 text-sm text-(--color-muted-foreground)">
              {uploadedName !== null && <span className="font-medium text-(--color-foreground)">{uploadedName}. </span>}
              We’ve guessed what each column contains. Check each one and change it if needed. Nothing has been
              imported yet.
            </p>
          </div>

          {notice !== null && <Alert tone="warning">{notice}</Alert>}

          <div className="overflow-hidden rounded-lg border">
            <div
              aria-hidden
              className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(12rem,1fr)] gap-4 border-b bg-(--color-surface-subtle) px-4 py-2.5 text-xs font-medium text-(--color-muted-foreground) sm:grid"
            >
              <span>Column in your file</span>
              <span>Example values</span>
              <span>Save as</span>
            </div>
            <ul className="divide-y">
              {headers.map((header, index) => {
                const value = targets[index] ?? 'ignore';
                const examples = sample
                  .map((row) => row[index] ?? '')
                  .filter((cell) => cell.length > 0)
                  .slice(0, 2)
                  .join(' · ');
                const selectId = `map-${index}`;
                return (
                  <li
                    key={`${header}-${index}`}
                    className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(12rem,1fr)] sm:items-center sm:gap-4"
                  >
                    <label htmlFor={selectId} className="min-w-0">
                      <span className="block truncate text-sm font-medium">{header}</span>
                      <span className="block truncate text-xs text-(--color-muted-foreground) sm:hidden">
                        {examples.length > 0 ? `e.g. ${examples}` : 'No example values'}
                      </span>
                    </label>
                    <span className="hidden min-w-0 truncate text-sm text-(--color-muted-foreground) sm:block">
                      {examples.length > 0 ? examples : '—'}
                    </span>
                    <Select
                      id={selectId}
                      value={value}
                      className={cn('w-full min-w-0', value === 'ignore' && 'text-(--color-muted-foreground)')}
                      onChange={(event) => {
                        const next = [...targets];
                        next[index] = event.target.value;
                        setTargets(next);
                        if (event.target.value === 'field:email') setError(null);
                      }}
                    >
                      <option value="ignore">Skip this column</option>
                      {CONTACT_FIELDS.map((field) => (
                        <option
                          key={field}
                          value={`field:${field}`}
                          disabled={claimed.has(field) && value !== `field:${field}`}
                        >
                          {FIELD_LABEL[field]}
                          {field === 'email' ? ' (required)' : ''}
                        </option>
                      ))}
                      {customKeys[index] !== undefined && customKeys[index]!.length > 0 && (
                        <option value={`custom:${customKeys[index]}`}>Custom field · {customKeys[index]}</option>
                      )}
                    </Select>
                  </li>
                );
              })}
            </ul>
          </div>

          {stepError}

          <div className="flex flex-wrap items-center gap-2 border-t pt-5">
            <Button type="button" onClick={goToReview}>
              Review import
              <ArrowRight aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setError(null);
                setStep('upload');
              }}
            >
              <ArrowLeft aria-hidden />
              Back
            </Button>
          </div>
        </section>
      )}

      {step === 'review' && (
        <section
          aria-labelledby="review-title"
          className="flex flex-col gap-5 rounded-xl border bg-(--color-card) p-5 shadow-xs sm:p-6"
        >
          <div>
            <h2 id="review-title" className="text-base font-semibold tracking-tight">
              Review and import
            </h2>
            <p className="mt-0.5 text-sm text-(--color-muted-foreground)">
              Here’s what will happen. Rows without a usable email address, and people already in your contacts,
              are set aside — you’ll be able to download a list of them afterwards.
            </p>
          </div>

          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="min-w-0 rounded-lg border bg-(--color-surface-subtle) px-4 py-3">
              <dt className="text-sm text-(--color-muted-foreground)">File</dt>
              <dd className="mt-0.5 truncate font-medium">{uploadedName ?? file?.name ?? '—'}</dd>
            </div>
            <div className="min-w-0 rounded-lg border bg-(--color-surface-subtle) px-4 py-3">
              <dt className="text-sm text-(--color-muted-foreground)">Email addresses from</dt>
              <dd className="mt-0.5 truncate font-medium">{emailColumn?.header ?? '—'}</dd>
            </div>
            <div className="min-w-0 rounded-lg border bg-(--color-surface-subtle) px-4 py-3">
              <dt className="text-sm text-(--color-muted-foreground)">Add to list</dt>
              <dd className="mt-0.5 truncate font-medium">{listName ?? 'None'}</dd>
            </div>
          </dl>

          <div>
            <h3 className="text-sm font-medium">
              {mappedColumns.length} {mappedColumns.length === 1 ? 'column' : 'columns'} will be saved
              {skippedCount > 0 && (
                <span className="font-normal text-(--color-muted-foreground)"> · {skippedCount} skipped</span>
              )}
            </h3>
            <ul className="mt-2 flex flex-col divide-y rounded-lg border">
              {mappedColumns.map((column) => (
                <li
                  key={column.index}
                  className="flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <span className="min-w-0 truncate">{column.header}</span>
                  <span className="flex min-w-0 items-center gap-2 text-(--color-muted-foreground)">
                    <ArrowRight className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate font-medium text-(--color-foreground)">
                      {describeTarget(column.value, column.index)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {sampleForReview.length > 0 && mappedColumns.length > 0 && (
            <div>
              <h3 className="text-sm font-medium">How the first rows will be saved</h3>
              <p className="text-sm text-(--color-muted-foreground)">
                A preview from the top of your file. Check the values are in the right place.
              </p>
              <div className="relative mt-2 overflow-x-auto rounded-lg border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-(--color-surface-subtle) text-xs text-(--color-muted-foreground)">
                    <tr>
                      {mappedColumns.map((column) => (
                        <th key={column.index} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                          {describeTarget(column.value, column.index)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {sampleForReview.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {mappedColumns.map((column) => (
                          <td key={column.index} className="max-w-[14rem] truncate px-3 py-2 whitespace-nowrap">
                            {row[column.index] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {stepError}

          <div className="flex flex-wrap items-center gap-2 border-t pt-5">
            <Button type="button" disabled={pending} onClick={confirm}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
              {pending ? 'Starting…' : 'Start import'}
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setStep('mapping')}>
              <ArrowLeft aria-hidden />
              Back to columns
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
