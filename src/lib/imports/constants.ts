/**
 * Import engine limits and vocabulary.
 *
 * Every bound the parser enforces is named here rather than inlined, because a
 * limit that appears once in a condition is a limit nobody can review. These are
 * the numbers ARCHITECTURE §20 fixes, plus the ones the format readers need to
 * stay memory-bounded on hostile input.
 *
 * Deliberately free of `server-only`: these constants are also the source of the
 * numbers the upload UI shows, and a limit the client displays differently from
 * the one the server enforces is a support ticket waiting to happen.
 */

/** ARCHITECTURE §20.3. Enforced at the bucket policy and again before parsing. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * ARCHITECTURE §20.4. Spreadsheet formats have no streaming story — the workbook
 * must be materialised — so they carry a cap that CSV does not.
 */
export const MAX_SPREADSHEET_ROWS = 100_000;

/** Rows per insert transaction (§20.6). */
export const IMPORT_CHUNK_ROWS = 500;

/** Rows read during Phase A, enough to propose a mapping and show a sample. */
export const INSPECT_SAMPLE_ROWS = 20;

/** Header rows are searched for within this many leading rows. */
export const HEADER_SEARCH_ROWS = 10;

/** A spreadsheet wider than this is a pivot table or a mistake, not a contact list. */
export const MAX_COLUMNS = 256;

/** Bound on one cell. Longer values are truncated by the reader, not buffered. */
export const MAX_CELL_CHARS = 4096;

/** Custom fields per import. `contacts.custom` is capped at 4 KB by the schema. */
export const MAX_CUSTOM_FIELDS = 24;

/** Per-value bound for a custom field, so 24 of them cannot exceed the 4 KB cap. */
export const MAX_CUSTOM_VALUE_CHARS = 120;

/** Rejection rows persisted per import. Beyond this the count is still exact. */
export const MAX_PERSISTED_REJECTIONS = 5_000;

/** Staged uploads are swept after this long regardless of import state (§20.1). */
export const STAGED_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Private bucket for staged uploads. Never public — see migration 0007. */
export const IMPORT_BUCKET = 'imports';

// ── Formats ─────────────────────────────────────────────────────────────────

export const IMPORT_FORMATS = ['csv', 'tsv', 'xlsx', 'xls'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** Extensions accepted in the picker. The extension is a hint, never the router. */
export const ACCEPTED_EXTENSIONS = ['.csv', '.tsv', '.xlsx', '.xls'] as const;

/**
 * Content types a browser plausibly reports for those extensions.
 *
 * Checked because a declared type wildly at odds with the extension is a signal,
 * not because the value is trustworthy — it is set by the client.
 */
export const ACCEPTED_CONTENT_TYPES: readonly string[] = [
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
];

// ── Contact fields ──────────────────────────────────────────────────────────

export const CONTACT_FIELDS = [
  'email',
  'first_name',
  'last_name',
  'company',
  'website',
  'phone',
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];

/** Mandatory. An import with no email column cannot produce a contact. */
export const REQUIRED_FIELD: ContactField = 'email';

/** Column limits from migration 0005. A longer value rejects its row, honestly. */
export const FIELD_MAX_LENGTH: Record<ContactField, number> = {
  email: 320,
  first_name: 120,
  last_name: 120,
  company: 200,
  website: 300,
  phone: 50,
};

export const FIELD_LABEL: Record<ContactField, string> = {
  email: 'Email',
  first_name: 'First name',
  last_name: 'Last name',
  company: 'Company',
  website: 'Website',
  phone: 'Phone',
};

// ── Outcome buckets ─────────────────────────────────────────────────────────

/**
 * Every input row lands in exactly one of these, and they sum to `rows_total`.
 * `ck_rows_reconcile` (migration 0006) refuses to record a completed import for
 * which that is untrue.
 */
export const ROW_BUCKETS = ['valid', 'invalid', 'duplicate', 'suppressed', 'rejected'] as const;
export type RowBucket = (typeof ROW_BUCKETS)[number];

/** The four buckets that produce a rejection record. `valid` produces none. */
export const REJECTION_BUCKETS = ['invalid', 'duplicate', 'suppressed', 'rejected'] as const;
export type RejectionBucket = (typeof REJECTION_BUCKETS)[number];

export const BUCKET_LABEL: Record<RowBucket, string> = {
  valid: 'Valid',
  invalid: 'Invalid',
  duplicate: 'Duplicates',
  suppressed: 'Suppressed',
  rejected: 'Rejected',
};

// ── State machine ───────────────────────────────────────────────────────────

export const IMPORT_STATUSES = ['uploaded', 'mapping', 'processing', 'completed', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * The only transitions that exist (ARCHITECTURE §20.1).
 *
 * Data rather than a chain of `if`s, so the machine can be asserted against in
 * one test instead of inferred from the code that happens to implement it. Every
 * transition is applied server-side as a conditional UPDATE whose WHERE clause
 * names the expected current status, so two concurrent attempts cannot both win.
 */
export const IMPORT_TRANSITIONS: Record<ImportStatus, readonly ImportStatus[]> = {
  uploaded: ['mapping', 'failed'],
  mapping: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function canTransition(from: ImportStatus, to: ImportStatus): boolean {
  return IMPORT_TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: ImportStatus): boolean {
  return IMPORT_TRANSITIONS[status].length === 0;
}

/** The message §20.4 requires when a workbook exceeds the row cap. */
export function rowCapMessage(rowCount: number | null): string {
  const seen = rowCount === null ? '' : ` This one has at least ${rowCount.toLocaleString('en-US')}.`;
  return (
    `This spreadsheet contains too many rows. Spreadsheet files are limited to ` +
    `${MAX_SPREADSHEET_ROWS.toLocaleString('en-US')} rows because they must be loaded into memory.${seen} ` +
    `Please export it as CSV to import the full file.`
  );
}
