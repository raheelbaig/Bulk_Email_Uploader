/**
 * The import runner.
 *
 * Reads a staged file, classifies every row into exactly one of five buckets,
 * writes contacts in chunks, records a reason for everything that did not become
 * a new contact, and reports counters that reconcile to the row total.
 *
 * The three properties this file exists to guarantee:
 *
 *   1. **No row is silently dropped.** Every row read increments exactly one
 *      counter. The database refuses a completed import whose counters do not
 *      sum to `rows_total` (`ck_rows_reconcile`), so a bug here fails the write
 *      rather than producing a plausible-looking wrong answer.
 *
 *   2. **A late failure does not discard early work.** Chunks commit
 *      independently. A failure at row 40,001 leaves 40,000 rows imported, the
 *      import marked `failed`, and the counters describing what actually
 *      happened — never "success", and never a rollback of committed rows.
 *
 *   3. **Duplicate protection is the unique constraint, not a pre-check.**
 *      `SELECT` then `INSERT` is racy under two concurrent imports of the same
 *      address; `on conflict do update` is not. See migration 0006.
 *
 * This module has no email-sending capability and no path to one. It writes
 * contacts and list memberships, and that is the whole of its effect.
 */

import {
  IMPORT_CHUNK_ROWS,
  MAX_PERSISTED_REJECTIONS,
  MAX_SPREADSHEET_ROWS,
  type ImportFormat,
  type RejectionBucket,
  type RowBucket,
} from './constants';
import { checkFileContent } from './detect';
import { CsvStreamParser, defaultDelimiterFor, detectDelimiter } from './csv';
import { readXlsx, SpreadsheetError } from './xlsx';
import { readXls } from './xls';
import {
  compileMapping,
  classifyRow,
  safeRawRow,
  REASON,
  type CompiledMapping,
  type PreparedContact,
} from './classify';
import { columnMappingSchema, dedupeHeaders } from './mapping';
import type {
  ImportRepository,
  ImportStorage,
  RejectionRecord,
  UpsertRow,
} from './ports';
import { checkEligibilityBatch, type EligibilityReader } from '@/lib/eligibility';

export interface RunnerPorts {
  repository: ImportRepository;
  storage: ImportStorage;
  eligibility: EligibilityReader;
}

export interface RunnerOptions {
  chunkRows?: number;
  /** Test seam. Production always deletes the staged file on success. */
  deleteStagedFile?: boolean;
  /** Injected fault, used to prove partial-failure reporting. Test-only. */
  onChunk?: (chunkIndex: number, firstRowNumber: number) => void | Promise<void>;
}

export type RunnerOutcome =
  | { kind: 'completed'; counters: Counters }
  | { kind: 'failed'; counters: Counters; message: string; failedAtRow: number | null }
  | { kind: 'skipped'; reason: 'not_claimed' | 'not_processing' | 'missing' };

export interface Counters {
  total: number;
  valid: number;
  invalid: number;
  duplicate: number;
  suppressed: number;
  rejected: number;
}

const LINE_FEED = String.fromCharCode(10);

/** A row that survived classification and is waiting for its chunk to fill. */
interface Candidate {
  rowNumber: number;
  contact: PreparedContact;
  raw: Record<string, string>;
}

class BucketTally {
  readonly counts: Counters = {
    total: 0,
    valid: 0,
    invalid: 0,
    duplicate: 0,
    suppressed: 0,
    rejected: 0,
  };

  add(bucket: RowBucket): void {
    this.counts[bucket] += 1;
    this.counts.total += 1;
  }

  /** Only for the rows attributed so far — never derived from a file's length. */
  get attributed(): number {
    return (
      this.counts.valid +
      this.counts.invalid +
      this.counts.duplicate +
      this.counts.suppressed +
      this.counts.rejected
    );
  }
}

class ImportFailure extends Error {
  readonly failedAtRow: number | null;
  readonly userMessage: string;

  constructor(userMessage: string, failedAtRow: number | null, cause?: unknown) {
    super(userMessage);
    this.name = 'ImportFailure';
    this.userMessage = userMessage;
    this.failedAtRow = failedAtRow;
    this.cause = cause;
  }
}

/**
 * Processes one queued import.
 *
 * Claiming comes first and is atomic: a redelivered queue message, a double
 * click, or two runners starting at once produce exactly one processing pass.
 * The loser returns `skipped`, which is a normal outcome rather than an error.
 */
export async function processImport(
  ports: RunnerPorts,
  importId: string,
  options: RunnerOptions = {},
): Promise<RunnerOutcome> {
  const { repository } = ports;

  const job = await repository.claim(importId);
  if (job === null) return { kind: 'skipped', reason: 'not_claimed' };

  const record = await repository.get(importId);
  if (record === null) {
    await repository.completeJob(importId);
    return { kind: 'skipped', reason: 'missing' };
  }
  if (record.status !== 'processing') {
    // The state machine, enforced here as well as by the transition itself: a
    // job whose import is not in `processing` must not write contacts.
    await repository.completeJob(importId);
    return { kind: 'skipped', reason: 'not_processing' };
  }

  const tally = new BucketTally();

  try {
    await repository.updateCounters(importId, {
      rows_total: 0,
      rows_valid: 0,
      rows_invalid: 0,
      rows_duplicate: 0,
      rows_suppressed: 0,
      rows_rejected: 0,
    });
    // A retry reprocesses from the beginning, so prior rejection rows would
    // otherwise be counted twice.
    await repository.clearRejections(importId);

    await runPipeline(ports, record, tally, options);

    const completed = await repository.transition(importId, ['processing'], 'completed', {
      finished_at: new Date().toISOString(),
      rows_total: tally.counts.total,
      rows_valid: tally.counts.valid,
      rows_invalid: tally.counts.invalid,
      rows_duplicate: tally.counts.duplicate,
      rows_suppressed: tally.counts.suppressed,
      rows_rejected: tally.counts.rejected,
    });

    if (!completed) {
      // Either another runner finished first or the counters did not reconcile
      // and the constraint refused the write. Both are honest failures.
      throw new ImportFailure(
        'The import finished but its results could not be recorded. Nothing was lost — the contacts that were imported are in your list.',
        null,
      );
    }

    await repository.completeJob(importId);

    if (options.deleteStagedFile !== false) {
      // Immediately on success, per ARCHITECTURE §20.1. A failure here must not
      // turn a completed import into a failed one; the 24-hour sweep is the
      // backstop.
      await ports.storage.remove([record.storage_path]).catch(() => undefined);
    }

    return { kind: 'completed', counters: tally.counts };
  } catch (cause) {
    const failure =
      cause instanceof ImportFailure
        ? cause
        : new ImportFailure(messageFor(cause), null, cause);

    const rowSuffix =
      failure.failedAtRow === null ? '' : ` Processing stopped at row ${failure.failedAtRow}.`;

    // The counters are written as they stand. Rows that were imported stay
    // imported and stay counted; `rows_total` describes what was attributed, not
    // what the file might have contained, so a failed import reconciles too.
    await ports.repository
      .transition(importId, ['processing'], 'failed', {
        finished_at: new Date().toISOString(),
        error_message: `${failure.userMessage}${rowSuffix}`.slice(0, 500),
        rows_total: tally.attributed,
        rows_valid: tally.counts.valid,
        rows_invalid: tally.counts.invalid,
        rows_duplicate: tally.counts.duplicate,
        rows_suppressed: tally.counts.suppressed,
        rows_rejected: tally.counts.rejected,
      })
      .catch(() => undefined);

    await ports.repository.failJob(importId, failure.userMessage).catch(() => undefined);

    return {
      kind: 'failed',
      counters: tally.counts,
      message: failure.userMessage,
      failedAtRow: failure.failedAtRow,
    };
  }
}

function messageFor(cause: unknown): string {
  if (cause instanceof SpreadsheetError) return cause.message;
  return 'This import could not be completed. The file may be corrupt or in an unexpected format.';
}

/** Where the parsing and classification actually happen. */
async function runPipeline(
  ports: RunnerPorts,
  record: {
    id: string;
    workspace_id: string;
    filename: string;
    byte_size: number;
    storage_path: string;
    column_mapping: unknown;
    target_list_id: string | null;
  },
  tally: BucketTally,
  options: RunnerOptions,
): Promise<void> {
  const parsedMapping = columnMappingSchema.safeParse(record.column_mapping);
  if (!parsedMapping.success) {
    throw new ImportFailure('This import has no confirmed column mapping.', null);
  }
  const mapping = compileMapping(parsedMapping.data);
  const headers = dedupeHeaders(parsedMapping.data.columns.map((column) => column.header));

  // Magic bytes are checked again here, not only at upload. Between the two
  // moments the object could have been replaced; the parser must never be
  // routed by anything but the bytes it is about to read.
  const head = await ports.storage.head(record.storage_path, 8);
  const check = checkFileContent({
    filename: record.filename,
    bytes: head,
    byteSize: record.byte_size,
  });
  if (!check.ok) throw new ImportFailure(check.message, null);

  const state = new PipelineState(ports, record, mapping, headers, tally, options);

  if (check.format === 'csv' || check.format === 'tsv') {
    await streamDelimited(ports, record.storage_path, check.format, state);
  } else {
    await readWorkbook(ports, record.storage_path, check.format, state);
  }

  await state.flush();
}

/**
 * CSV and TSV: parsed incrementally from the download stream.
 *
 * Never materialises the file. The first chunk is used to sniff the delimiter,
 * then fed to the parser like any other, so sniffing costs no extra read.
 */
async function streamDelimited(
  ports: RunnerPorts,
  path: string,
  format: ImportFormat,
  state: PipelineState,
): Promise<void> {
  const stream = await ports.storage.openStream(path);
  const decoder = new TextDecoder('utf-8');

  let parser: CsvStreamParser | undefined;
  let sniffBuffer = '';

  /** Creates the parser once the delimiter is known, and drains the sample. */
  const startParsing = async (text: string): Promise<CsvStreamParser> => {
    const created = new CsvStreamParser({
      delimiter: detectDelimiter(text, defaultDelimiterFor(format)),
    });
    for (const row of created.push(text)) await state.offer(row);
    return created;
  };

  for await (const chunk of stream) {
    // `stream: true` is what makes a multi-byte character split across a chunk
    // boundary decode correctly rather than becoming two replacement chars.
    const text = decoder.decode(chunk, { stream: true });

    if (parser === undefined) {
      sniffBuffer += text;
      // Wait for a full line, or a reasonable sample, before deciding.
      if (!sniffBuffer.includes(LINE_FEED) && sniffBuffer.length < 8192) continue;
      parser = await startParsing(sniffBuffer);
      sniffBuffer = '';
      continue;
    }

    for (const row of parser.push(text)) await state.offer(row);
  }

  const tail = decoder.decode();

  if (parser === undefined) {
    // A file with no newline at all is still one row.
    parser = await startParsing(sniffBuffer + tail);
  } else if (tail.length > 0) {
    for (const row of parser.push(tail)) await state.offer(row);
  }

  for (const row of parser.end()) await state.offer(row);
}

/** XLSX and XLS: materialised, capped, and read values-only. */
async function readWorkbook(
  ports: RunnerPorts,
  path: string,
  format: ImportFormat,
  state: PipelineState,
): Promise<void> {
  const bytes = await ports.storage.download(path);
  const result =
    format === 'xlsx'
      ? readXlsx(bytes, { maxRows: MAX_SPREADSHEET_ROWS })
      : readXls(bytes, { maxRows: MAX_SPREADSHEET_ROWS });

  for (const row of result.rows) {
    await state.offer(row);
  }
}

/**
 * Per-import pipeline state.
 *
 * Holds three things and nothing else: the in-file dedupe index, the current
 * chunk, and the pending rejection rows. All three are bounded — the dedupe
 * index by the file's unique addresses, the chunk by `chunkRows`, and the
 * rejections by the flush that follows each chunk.
 */
class PipelineState {
  private rowNumber = 0;
  private headerConsumed = false;
  private chunk: Candidate[] = [];
  private rejections: RejectionRecord[] = [];
  private rejectionsPersisted = 0;
  private chunkIndex = 0;
  private readonly chunkRows: number;

  /**
   * Normalized address → the row number that first claimed it.
   *
   * A `Map` rather than a `Set` because the reason string names the winning
   * row, which is the difference between "duplicate" and a duplicate a person
   * can actually go and look at. One entry per unique address, which for the
   * largest supported file is a few million bytes — acceptable, and the only
   * unavoidable per-file allocation in the engine.
   */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ports: RunnerPorts,
    private readonly record: { id: string; workspace_id: string; target_list_id: string | null },
    private readonly mapping: CompiledMapping,
    private readonly headers: readonly string[],
    private readonly tally: BucketTally,
    private readonly options: RunnerOptions,
  ) {
    this.chunkRows = options.chunkRows ?? IMPORT_CHUNK_ROWS;
  }

  /**
   * Offers one parsed row.
   *
   * Rows at or before the header row are consumed without being counted — they
   * are not input rows, they are the file's structure. Everything after is
   * counted exactly once.
   */
  async offer(row: readonly string[]): Promise<void> {
    if (!this.headerConsumed) {
      // Rows are 1-based for the user; `headerRow` is 0-based within the file.
      if (this.rowNumber < this.mapping.headerRow) {
        this.rowNumber += 1;
        return;
      }
      this.headerConsumed = true;
      this.rowNumber += 1;
      return;
    }

    this.rowNumber += 1;
    const rowNumber = this.rowNumber;

    const outcome = classifyRow(row, this.mapping);

    if (outcome.kind === 'settled') {
      this.tally.add(outcome.bucket);
      this.pushRejection(rowNumber, safeRawRow(row, this.headers), outcome.bucket, outcome.reason);
      return;
    }

    // In-file duplicates are resolved here, before any database work. The first
    // occurrence wins; later ones cost one Map lookup and no query at all.
    const firstRow = this.seen.get(outcome.contact.emailNormalized);
    if (firstRow !== undefined) {
      this.tally.add('duplicate');
      this.pushRejection(
        rowNumber,
        safeRawRow(row, this.headers),
        'duplicate',
        REASON.duplicateInFile(firstRow),
      );
      return;
    }
    this.seen.set(outcome.contact.emailNormalized, rowNumber);

    this.chunk.push({
      rowNumber,
      contact: outcome.contact,
      raw: safeRawRow(row, this.headers),
    });

    if (this.chunk.length >= this.chunkRows) await this.flushChunk();
  }

  /** Flushes the final partial chunk and any remaining rejection rows. */
  async flush(): Promise<void> {
    if (this.chunk.length > 0) await this.flushChunk();
    await this.persistRejections();
  }

  /**
   * Records a rejection.
   *
   * The counter is already exact; what is bounded is how many rows are
   * *stored*. A file of a million bad rows must not become a million rows in
   * the database, and the summary stays truthful either way — the stored rows
   * are a sample, the counts are complete.
   */
  private pushRejection(
    rowNumber: number,
    raw: Record<string, string>,
    bucket: RejectionBucket,
    reason: string,
  ): void {
    if (this.rejectionsPersisted + this.rejections.length >= MAX_PERSISTED_REJECTIONS) return;
    this.rejections.push({
      row_number: rowNumber,
      raw_row: raw,
      bucket,
      reason: reason.slice(0, 300),
    });
  }

  private async flushChunk(): Promise<void> {
    const chunk = this.chunk;
    this.chunk = [];
    if (chunk.length === 0) return;

    const firstRow = chunk[0]?.rowNumber ?? this.rowNumber;
    this.chunkIndex += 1;

    try {
      // Test seam for the partial-failure proof. Inside the try, so an injected
      // fault takes exactly the same path a real one would — a seam that
      // bypassed the error handling would prove nothing about it.
      if (this.options.onChunk !== undefined) {
        await this.options.onChunk(this.chunkIndex, firstRow);
      }

      const suppressed = await this.findSuppressed(chunk);

      const rows: UpsertRow[] = chunk.map((candidate) => ({
        email_normalized: candidate.contact.emailNormalized,
        email_raw: candidate.contact.emailRaw,
        first_name: candidate.contact.firstName,
        last_name: candidate.contact.lastName,
        company: candidate.contact.company,
        website: candidate.contact.website,
        phone: candidate.contact.phone,
        custom: candidate.contact.custom,
        // A suppressed address is still imported, with status `suppressed`, so
        // the user can see why it is unmailable instead of watching it vanish
        // (ARCHITECTURE §21.3). The suppression record itself is untouched.
        status: suppressed.has(candidate.contact.emailNormalized) ? 'suppressed' : 'active',
      }));

      const outcomes = await this.ports.repository.upsertContacts(
        this.record.id,
        rows,
        this.record.target_list_id,
      );

      const insertedByEmail = new Map(
        outcomes.map((outcome) => [outcome.email_normalized, outcome.inserted]),
      );

      for (const candidate of chunk) {
        const email = candidate.contact.emailNormalized;

        if (suppressed.has(email)) {
          this.tally.add('suppressed');
          this.pushRejection(candidate.rowNumber, candidate.raw, 'suppressed', REASON.suppressed);
          continue;
        }

        const inserted = insertedByEmail.get(email);
        if (inserted === true) {
          this.tally.add('valid');
          continue;
        }
        if (inserted === false) {
          // The address already existed. `on conflict do update` enriched it
          // without blanking anything, and the row counts as a duplicate.
          this.tally.add('duplicate');
          this.pushRejection(
            candidate.rowNumber,
            candidate.raw,
            'duplicate',
            REASON.duplicateInDatabase,
          );
          continue;
        }

        // The upsert returned nothing for this address. Never assumed to be a
        // success: it is counted as rejected with a specific reason, because
        // inventing a count is worse than reporting an unexplained row.
        this.tally.add('rejected');
        this.pushRejection(
          candidate.rowNumber,
          candidate.raw,
          'rejected',
          'The database did not confirm this row was written',
        );
      }

      await this.persistRejections();
      await this.ports.repository.updateCounters(this.record.id, {
        rows_total: this.tally.counts.total,
        rows_valid: this.tally.counts.valid,
        rows_invalid: this.tally.counts.invalid,
        rows_duplicate: this.tally.counts.duplicate,
        rows_suppressed: this.tally.counts.suppressed,
        rows_rejected: this.tally.counts.rejected,
      });
    } catch (cause) {
      // The chunk that failed is named by its first row, which is what the
      // honest partial report in §20.6 requires. Chunks already committed stay
      // committed.
      throw new ImportFailure(
        'This import stopped partway through. The rows already processed have been imported and are counted below.',
        firstRow,
        cause,
      );
    }
  }

  /**
   * Suppression, through the P1 eligibility authority.
   *
   * Deliberately not a query against `suppressions` from here. §1.3 and §11 of
   * the brief are explicit: one authority answers "may this address be mailed",
   * and every caller asks it rather than reimplementing the rule. What the
   * importer needs is the subset that is suppressed, which is the authority's
   * answer filtered by reason.
   */
  private async findSuppressed(chunk: readonly Candidate[]): Promise<Set<string>> {
    const emails = chunk.map((candidate) => candidate.contact.emailNormalized);
    const results = await checkEligibilityBatch(this.ports.eligibility, {
      workspaceId: this.record.workspace_id,
      emails,
    });

    const suppressed = new Set<string>();
    results.forEach((result) => {
      if (!result.eligible && result.reason === 'suppressed' && result.emailNormalized !== null) {
        suppressed.add(result.emailNormalized);
      }
    });
    return suppressed;
  }

  private async persistRejections(): Promise<void> {
    if (this.rejections.length === 0) return;
    const batch = this.rejections;
    this.rejections = [];
    await this.ports.repository.insertRejections(this.record.id, batch);
    this.rejectionsPersisted += batch.length;
  }
}
