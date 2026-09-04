/**
 * Streaming delimited-text parser (RFC 4180, plus the deviations real files
 * contain).
 *
 * Incremental by construction: `push()` accepts an arbitrary slice of the file —
 * a chunk boundary may fall inside a quoted field, inside a CRLF, or inside a
 * multi-byte character — and emits whole rows as they complete. Nothing but the
 * current field and the current row is ever held, so peak memory is a function
 * of the widest row, not of the file (ARCHITECTURE §20.4, R5).
 *
 * A whole-file `split('\n')` would be a third of the code and wrong twice over:
 * it breaks on embedded newlines inside quotes, and it materialises a 25 MB file
 * as a 50 MB string plus an array of every line.
 */

import { MAX_CELL_CHARS, MAX_COLUMNS } from './constants';

export type Delimiter = ',' | ';' | '\t' | '|';

/** U+FEFF, built rather than written so no invisible character appears in source. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];

export interface CsvParserOptions {
  delimiter?: Delimiter;
  /** Longer cells are truncated here rather than buffered without limit. */
  maxCellChars?: number;
  maxColumns?: number;
}

/**
 * Sniffs the delimiter from the first line outside quotes.
 *
 * Counting occurrences across the whole sample would be swayed by commas inside
 * quoted prose, which is exactly the file this has to get right. Only the header
 * line is considered, and only characters outside quotes are counted.
 */
export function detectDelimiter(sample: string, fallback: Delimiter = ','): Delimiter {
  const counts = new Map<Delimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;

  for (let i = 0; i < sample.length; i += 1) {
    const char = sample[i];
    if (char === '"') {
      // A doubled quote inside a quoted field is an escaped quote, not a close.
      if (inQuotes && sample[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === '\n' || char === '\r') break;
    const known = DELIMITERS.find((d) => d === char);
    if (known !== undefined) counts.set(known, (counts.get(known) ?? 0) + 1);
  }

  let best: Delimiter | null = null;
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = counts.get(delimiter) ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best ?? fallback;
}

/** The delimiter a format implies before the file is seen. */
export function defaultDelimiterFor(format: string): Delimiter {
  return format === 'tsv' ? '\t' : ',';
}

/**
 * The parser.
 *
 * States are implicit in two booleans rather than an enum, because the machine
 * has exactly two interesting conditions — inside a quoted field, and having
 * just seen a closing quote — and naming five states would obscure that.
 */
export class CsvStreamParser {
  private readonly delimiter: string;
  private readonly maxCellChars: number;
  private readonly maxColumns: number;

  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  /** True immediately after a closing quote, so `""` can be told from `"a""b"`. */
  private quoteClosed = false;
  /** True after CR, so CRLF produces one row break rather than two. */
  private pendingCr = false;
  /** True until the first character is examined, for BOM removal. */
  private atStart = true;
  private truncatedCells = 0;
  private fieldTruncated = false;

  constructor(options: CsvParserOptions = {}) {
    this.delimiter = options.delimiter ?? ',';
    this.maxCellChars = options.maxCellChars ?? MAX_CELL_CHARS;
    this.maxColumns = options.maxColumns ?? MAX_COLUMNS;
  }

  /** Cells truncated at `maxCellChars` so far. Surfaced, never silent. */
  get truncatedCellCount(): number {
    return this.truncatedCells;
  }

  /** Feeds a chunk and returns every row completed by it. */
  push(chunk: string): string[][] {
    const rows: string[][] = [];

    for (let i = 0; i < chunk.length; i += 1) {
      const char = chunk[i] as string;

      if (this.atStart) {
        this.atStart = false;
        // UTF-8 BOM. Left in place it becomes part of the first header, which
        // then never matches anything.
        if (char === BYTE_ORDER_MARK) continue;
      }

      // A CR is only a row break when the next character is not LF, and the
      // next character may be in the next chunk — hence the pending flag.
      if (this.pendingCr) {
        this.pendingCr = false;
        if (char === '\n') {
          rows.push(this.finishRow());
          continue;
        }
        rows.push(this.finishRow());
        // fall through: this character starts the next row
      }

      if (this.inQuotes) {
        if (this.quoteClosed) {
          this.quoteClosed = false;
          if (char === '"') {
            this.appendChar('"');
            continue;
          }
          this.inQuotes = false;
          // Re-examine this character outside the quoted state.
          i -= 1;
          continue;
        }
        if (char === '"') {
          this.quoteClosed = true;
          continue;
        }
        this.appendChar(char);
        continue;
      }

      if (char === '"' && this.field.length === 0) {
        this.inQuotes = true;
        continue;
      }
      if (char === this.delimiter) {
        this.finishField();
        continue;
      }
      if (char === '\n') {
        rows.push(this.finishRow());
        continue;
      }
      if (char === '\r') {
        this.pendingCr = true;
        continue;
      }
      // A quote appearing mid-field ("a"b") is not valid RFC 4180. Real
      // exporters emit it; keeping the character is what a spreadsheet does.
      this.appendChar(char);
    }

    return rows;
  }

  /** Flushes any trailing row. A file need not end with a newline. */
  end(): string[][] {
    const rows: string[][] = [];
    if (this.pendingCr) {
      this.pendingCr = false;
      rows.push(this.finishRow());
      return rows;
    }
    // An unterminated quoted field at EOF: take what there is rather than
    // discarding the row. The row still has to survive validation.
    if (this.field.length > 0 || this.row.length > 0) {
      rows.push(this.finishRow());
    }
    return rows;
  }

  private appendChar(char: string): void {
    if (this.field.length >= this.maxCellChars) {
      if (!this.fieldTruncated) {
        this.fieldTruncated = true;
        this.truncatedCells += 1;
      }
      return;
    }
    this.field += char;
  }

  private finishField(): void {
    // Columns beyond the cap are dropped rather than grown into: a file with
    // 100,000 columns is an attack on memory, not a contact list.
    if (this.row.length < this.maxColumns) this.row.push(this.field);
    this.field = '';
    this.fieldTruncated = false;
  }

  private finishRow(): string[] {
    this.finishField();
    const row = this.row;
    this.row = [];
    this.inQuotes = false;
    this.quoteClosed = false;
    return row;
  }
}

/**
 * Parses a whole string. For tests and for the inspection sample only — the
 * import runner feeds `CsvStreamParser` from the download stream so a large file
 * is never a large string.
 */
export function parseCsv(text: string, options: CsvParserOptions = {}): string[][] {
  const parser = new CsvStreamParser(options);
  return [...parser.push(text), ...parser.end()];
}

/** True when a row carries nothing but empty cells — a blank line, in effect. */
export function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim().length === 0);
}
