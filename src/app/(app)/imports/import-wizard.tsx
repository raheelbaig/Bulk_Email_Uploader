'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { UploadCloud, ArrowRight, ShieldCheck, FileSpreadsheet } from 'lucide-react';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
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
  createImportAction,
  inspectImportAction,
  confirmMappingAction,
  type ImportActionState,
} from './actions';

/**
 * The three-step import flow: upload → map → confirm.
 *
 * The mapping step exists because it is a safety boundary, not because a wizard
 * looked nice: a file whose columns are in an unexpected order must not import
 * silently (ARCHITECTURE §20.2). Everything else is deliberately one screen.
 *
 * The file goes straight from the browser to a private bucket through a signed,
 * path-bound URL. It does not pass through a server action, which on this
 * platform would cap the upload at a few megabytes.
 */

interface ListOption {
  id: string;
  name: string;
}

type Step = 'upload' | 'mapping' | 'started';

const MAX_MB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));

function targetKey(target: MappingTarget): string {
  if (target.kind === 'field') return `field:${target.field}`;
  if (target.kind === 'custom') return `custom:${target.key}`;
  return 'ignore';
}

export function ImportWizard({ lists }: { lists: ListOption[] }) {
  const [step, setStep] = useState<Step>('upload');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [targetListId, setTargetListId] = useState<string>('');
  const [importId, setImportId] = useState<string | null>(null);

  const [headerRow, setHeaderRow] = useState(0);
  const [headers, setHeaders] = useState<string[]>([]);
  const [sample, setSample] = useState<string[][]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [customKeys, setCustomKeys] = useState<string[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);

  const applyState = (state: ImportActionState): boolean => {
    if (!state.ok) {
      setError(state.message ?? 'That did not work.');
      return false;
    }
    setError(null);
    return true;
  };

  const chooseFile = useCallback((chosen: File | null) => {
    setError(null);
    if (chosen === null) {
      setFile(null);
      return;
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setError(`Files must be ${MAX_MB} MB or smaller.`);
      return;
    }
    const dot = chosen.name.lastIndexOf('.');
    const extension = dot === -1 ? '' : chosen.name.slice(dot).toLowerCase();
    if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
      setFile(null);
      setError('Upload a .csv, .tsv, .xlsx or .xls file.');
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
    if (file === null) return;
    setUploading(true);
    setError(null);

    try {
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
        setError('That upload did not finish. Check your connection and try again.');
        return;
      }

      const inspected = await inspectImportAction(created.created.importId);
      if (!applyState(inspected) || inspected.inspection === undefined) return;

      const { proposal, sample: sampleRows } = inspected.inspection;
      setImportId(created.created.importId);
      setHeaderRow(proposal.headerRow);
      setHeaders(proposal.headers);
      setSample(sampleRows);
      setTargets(proposal.columns.map((column) => targetKey(column.target)));
      setCustomKeys(
        proposal.columns.map((column) =>
          column.target.kind === 'custom' ? column.target.key : '',
        ),
      );
      setNotice(
        proposal.emailUnresolved
          ? 'We could not tell which column holds the email address. Choose it below.'
          : null,
      );
      setStep('mapping');
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
      return;
    }

    startTransition(async () => {
      const state = await confirmMappingAction({
        importId,
        mapping,
        targetListId: targetListId.length === 0 ? null : targetListId,
      });
      if (!applyState(state)) return;
      setStep('started');
    });
  };

  // Fields already claimed, so the same field cannot be chosen twice.
  const claimed = new Set(
    targets
      .filter((value) => value.startsWith('field:'))
      .map((value) => value.slice(6)),
  );

  return (
    <div className="flex flex-col gap-6">
      {error !== null && <Alert tone="destructive">{error}</Alert>}
      {notice !== null && step === 'mapping' && <Alert>{notice}</Alert>}

      {step === 'upload' && (
        <div className="flex flex-col gap-4 rounded-lg border p-5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UploadCloud className="h-4 w-4" aria-hidden />
            Step 1 — choose a file
          </div>

          <label
            htmlFor="import-file"
            className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed px-6 py-10 text-center"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              chooseFile(event.dataTransfer.files[0] ?? null);
            }}
          >
            <FileSpreadsheet className="h-6 w-6 text-[--color-muted-foreground]" aria-hidden />
            <span className="text-sm font-medium">
              {file === null ? 'Drop a file here, or click to choose' : file.name}
            </span>
            <span className="text-xs text-[--color-muted-foreground]">
              {file === null
                ? `CSV, TSV, XLSX or XLS · up to ${MAX_MB} MB`
                : `${(file.size / 1024).toFixed(0)} KB`}
            </span>
            <input
              ref={inputRef}
              id="import-file"
              type="file"
              className="hidden"
              accept={ACCEPTED_EXTENSIONS.join(',')}
              onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="target-list" className="text-sm font-medium">
              Add imported contacts to a list
              <span className="ml-1 text-xs text-[--color-muted-foreground]">optional</span>
            </label>
            <Select
              id="target-list"
              value={targetListId}
              onChange={(event) => setTargetListId(event.target.value)}
            >
              <option value="">No list</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </Select>
          </div>

          <p className="flex items-start gap-2 text-xs text-[--color-muted-foreground]">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Your file is uploaded to private storage and deleted as soon as the import
              finishes. Spreadsheets are read for their values only — macros, formulas and
              embedded links are never opened or run. Spreadsheet files are limited to{' '}
              {MAX_SPREADSHEET_ROWS.toLocaleString('en-US')} rows; CSV has no limit.
            </span>
          </p>

          <div>
            <Button type="button" size="sm" disabled={file === null || uploading} onClick={upload}>
              {uploading ? 'Reading file…' : 'Continue'}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      )}

      {step === 'mapping' && (
        <div className="flex flex-col gap-4 rounded-lg border p-5">
          <div>
            <div className="text-sm font-medium">Step 2 — check the columns</div>
            <p className="mt-1 text-sm text-[--color-muted-foreground]">
              Nothing has been imported yet. Confirm which spreadsheet column holds which
              contact field, then start the import.
            </p>
          </div>

          <Table>
            <THead>
              <TR>
                <TH>Spreadsheet column</TH>
                <TH>Sample</TH>
                <TH>Contact field</TH>
              </TR>
            </THead>
            <TBody>
              {headers.map((header, index) => {
                const value = targets[index] ?? 'ignore';
                return (
                  <TR key={`${header}-${index}`}>
                    <TD className="font-medium">{header}</TD>
                    <TD className="max-w-[16rem] truncate text-[--color-muted-foreground]">
                      {sample
                        .map((row) => row[index] ?? '')
                        .filter((cell) => cell.length > 0)
                        .slice(0, 2)
                        .join(' · ')}
                    </TD>
                    <TD>
                      <Select
                        aria-label={`Field for ${header}`}
                        value={value}
                        onChange={(event) => {
                          const next = [...targets];
                          next[index] = event.target.value;
                          setTargets(next);
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
                          <option value={`custom:${customKeys[index]}`}>
                            Custom field · {customKeys[index]}
                          </option>
                        )}
                      </Select>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={confirm}>
              {pending ? 'Starting…' : 'Start import'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setStep('upload');
                setNotice(null);
              }}
            >
              Back
            </Button>
          </div>
        </div>
      )}

      {step === 'started' && (
        <div className="flex flex-col gap-3 rounded-lg border p-5">
          <div className="text-sm font-medium">Step 3 — importing</div>
          <p className="text-sm text-[--color-muted-foreground]">
            Your file is being processed in the background. The results appear below as soon as
            it finishes — refresh to check.
          </p>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setStep('upload');
                setFile(null);
                setImportId(null);
              }}
            >
              Import another file
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
