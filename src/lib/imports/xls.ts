/**
 * Values-only BIFF8 reader for legacy .xls workbooks.
 *
 * Reads the cell records of the first worksheet substream and nothing else. As
 * with XLSX (see xlsx.ts), the safety property is what is *not* read:
 *
 *   - FORMULA records contribute only their cached result. The parsed
 *     expression that follows the cached value in the record is skipped without
 *     being decoded, so there is nothing to evaluate even by accident.
 *   - Macro storages (`_VBA_PROJECT_CUR`, `Macros`) are never extracted from the
 *     compound file. The reader asks for the `Workbook` stream by name.
 *   - Embedded OLE objects, DDE links, external workbook references
 *     (EXTERNSHEET/SUPBOOK) and drawing records are skipped as unknown record
 *     types.
 *   - Every record length is bounded by the stream, and the record walk always
 *     advances, so a malformed length cannot loop.
 *
 * Legacy .xls is supported because businesses still export it. It carries the
 * same row cap as XLSX for the same reason: the format cannot be streamed.
 */

import { MAX_CELL_CHARS, MAX_COLUMNS, MAX_SPREADSHEET_ROWS, rowCapMessage } from './constants';
import { Ole2Error, Ole2File } from './ole2';
import { SpreadsheetError, type SpreadsheetReadOptions, type SpreadsheetResult } from './xlsx';

// ── Record identifiers (MS-XLS) ─────────────────────────────────────────────
const REC_FORMULA = 0x0006;
const REC_EOF = 0x000a;
const REC_CONTINUE = 0x003c;
const REC_SST = 0x00fc;
const REC_LABELSST = 0x00fd;
const REC_LABEL = 0x0204;
const REC_NUMBER = 0x0203;
const REC_RK = 0x027e;
const REC_MULRK = 0x00bd;
const REC_BOOLERR = 0x0205;
const REC_BLANK = 0x0201;
const REC_MULBLANK = 0x00be;
const REC_BOF = 0x0809;
const REC_STRING = 0x0207;
const REC_FORMAT = 0x041e;
const REC_XF = 0x00e0;
const REC_RSTRING = 0x00d6;

const SUBSTREAM_WORKSHEET = 0x0010;

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

interface BiffRecord {
  id: number;
  data: Uint8Array;
}

/** Splits the workbook stream into records, bounded and always advancing. */
function* records(stream: Uint8Array): Generator<BiffRecord> {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let offset = 0;

  while (offset + 4 <= stream.length) {
    const id = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const start = offset + 4;
    const end = start + length;
    if (end > stream.length) return;
    yield { id, data: stream.subarray(start, end) };
    // +4 unconditionally: a zero-length record is legal and must still advance.
    offset = end;
  }
}

/**
 * A cursor over the SST record and the CONTINUE records that follow it.
 *
 * The shared string table is the one place BIFF8 genuinely requires care: a
 * string may straddle a record boundary, and when it does the continuation
 * restarts with a fresh flags byte declaring whether the *remainder* is 8- or
 * 16-bit. Treating CONTINUE records as a flat concatenation — the obvious
 * implementation — produces mojibake on exactly the files that contain
 * non-ASCII names.
 */
class SstCursor {
  private blockIndex = 0;
  private offset = 0;

  constructor(private readonly blocks: Uint8Array[]) {}

  get exhausted(): boolean {
    return this.blockIndex >= this.blocks.length;
  }

  private current(): Uint8Array | undefined {
    return this.blocks[this.blockIndex];
  }

  remainingInBlock(): number {
    const block = this.current();
    return block === undefined ? 0 : block.length - this.offset;
  }

  advanceBlock(): void {
    this.blockIndex += 1;
    this.offset = 0;
  }

  u8(): number {
    while (this.remainingInBlock() <= 0 && !this.exhausted) this.advanceBlock();
    const block = this.current();
    if (block === undefined) return 0;
    const value = block[this.offset] ?? 0;
    this.offset += 1;
    return value;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  skip(count: number): void {
    let left = count;
    while (left > 0 && !this.exhausted) {
      const available = this.remainingInBlock();
      if (available <= 0) {
        this.advanceBlock();
        continue;
      }
      const take = Math.min(available, left);
      this.offset += take;
      left -= take;
    }
  }

  /**
   * Reads `charCount` characters, re-reading the flags byte at each block
   * boundary as the format requires.
   */
  chars(charCount: number, wide: boolean): string {
    let out = '';
    let isWide = wide;
    let left = charCount;

    while (left > 0 && !this.exhausted) {
      if (this.remainingInBlock() <= 0) {
        this.advanceBlock();
        if (this.exhausted) break;
        // The continuation's own flags byte. Only bit 0 is meaningful here.
        isWide = (this.u8() & 0x01) !== 0;
        continue;
      }

      const block = this.current();
      if (block === undefined) break;

      if (isWide) {
        if (this.remainingInBlock() < 2) {
          // A boundary inside a character: the remaining byte is padding.
          this.advanceBlock();
          if (this.exhausted) break;
          isWide = (this.u8() & 0x01) !== 0;
          continue;
        }
        const low = block[this.offset] ?? 0;
        const high = block[this.offset + 1] ?? 0;
        this.offset += 2;
        if (out.length < MAX_CELL_CHARS) out += String.fromCharCode(low | (high << 8));
      } else {
        const byte = block[this.offset] ?? 0;
        this.offset += 1;
        // Compressed strings are Latin-1, not ASCII.
        if (out.length < MAX_CELL_CHARS) out += String.fromCharCode(byte);
      }
      left -= 1;
    }

    return out;
  }
}

function readSst(blocks: Uint8Array[]): string[] {
  const cursor = new SstCursor(blocks);
  cursor.u32(); // total references, unused
  const unique = cursor.u32();

  const strings: string[] = [];
  // Bounded: `unique` is attacker-controlled and a lie is cheap to write.
  const limit = Math.min(unique, 2_000_000);

  for (let i = 0; i < limit && !cursor.exhausted; i += 1) {
    const charCount = cursor.u16();
    const flags = cursor.u8();
    const wide = (flags & 0x01) !== 0;
    const hasExtended = (flags & 0x04) !== 0;
    const hasRich = (flags & 0x08) !== 0;

    const runCount = hasRich ? cursor.u16() : 0;
    const extendedSize = hasExtended ? cursor.u32() : 0;

    strings.push(cursor.chars(charCount, wide));

    // Formatting runs and the Far East extension carry no value; skipped, never
    // parsed.
    if (runCount > 0) cursor.skip(runCount * 4);
    if (extendedSize > 0) cursor.skip(extendedSize);
  }

  return strings;
}

/** A long XLUnicodeString: u16 length, u8 flags, characters. */
function readLongString(data: Uint8Array, offset: number): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (offset + 3 > data.length) return '';
  const charCount = view.getUint16(offset, true);
  const flags = data[offset + 2] ?? 0;
  const wide = (flags & 0x01) !== 0;

  let value = '';
  let cursor = offset + 3;
  for (let i = 0; i < charCount && cursor < data.length; i += 1) {
    if (wide) {
      value += String.fromCharCode((data[cursor] ?? 0) | ((data[cursor + 1] ?? 0) << 8));
      cursor += 2;
    } else {
      value += String.fromCharCode(data[cursor] ?? 0);
      cursor += 1;
    }
    if (value.length >= MAX_CELL_CHARS) break;
  }
  return value;
}

/** RK values pack a truncated IEEE-754 double or a 30-bit integer into 32 bits. */
function decodeRk(rk: number): number {
  const isInteger = (rk & 0x02) !== 0;
  const isHundredth = (rk & 0x01) !== 0;

  let value: number;
  if (isInteger) {
    // Arithmetic shift: the top bit is the sign.
    value = rk >> 2;
  } else {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint32(0, 0, true);
    view.setUint32(4, rk & 0xfffffffc, true);
    value = view.getFloat64(0, true);
  }
  return isHundredth ? value / 100 : value;
}

function formatCodeIsDate(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /(?:y{1,4}|d{1,4}|m{1,5}|h{1,2}|s{1,2}|am\/pm)/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

function serialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465) return null;
  const days = serial < 61 ? serial : serial - 1;
  const date = new Date(Math.round((days - 25568) * 86_400_000));
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  const hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9;
  return hasTime ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
}

interface SheetBuilder {
  set(row: number, column: number, value: string): void;
}

/**
 * Reads the first worksheet of a legacy workbook.
 *
 * Cells arrive addressed by (row, column) rather than in order, so the sheet is
 * assembled into a sparse map and densified at the end. The map is bounded by
 * the row cap, which is checked as rows are touched rather than after the fact.
 */
export function readXls(bytes: Uint8Array, options: SpreadsheetReadOptions = {}): SpreadsheetResult {
  const maxRows = options.maxRows ?? MAX_SPREADSHEET_ROWS;

  let stream: Uint8Array | undefined;
  try {
    const file = Ole2File.open(bytes);
    stream = file.readStream('Workbook', 'Book');
  } catch (cause) {
    if (cause instanceof Ole2Error) throw new SpreadsheetError('malformed', cause.message);
    throw new SpreadsheetError('malformed', 'This workbook could not be read — the file may be corrupt.');
  }

  if (stream === undefined || stream.length === 0) {
    throw new SpreadsheetError('malformed', 'This file is not a readable Excel workbook.');
  }

  const sharedStrings: string[] = [];
  const formats = new Map<number, string>();
  const xfFormatIds: number[] = [];

  const cells = new Map<number, Map<number, string>>();
  let maxRowIndex = -1;
  let maxColumnIndex = -1;
  let rowsSeen = 0;
  let capped = false;

  const builder: SheetBuilder = {
    set(row, column, value) {
      if (row < 0 || column < 0 || column >= MAX_COLUMNS) return;
      let line = cells.get(row);
      if (line === undefined) {
        if (cells.size >= maxRows) {
          capped = true;
          return;
        }
        line = new Map<number, string>();
        cells.set(row, line);
        rowsSeen += 1;
      }
      line.set(column, value);
      if (row > maxRowIndex) maxRowIndex = row;
      if (column > maxColumnIndex) maxColumnIndex = column;
    },
  };

  const isDateStyle = (xfIndex: number): boolean => {
    const formatId = xfFormatIds[xfIndex];
    if (formatId === undefined) return false;
    if (BUILTIN_DATE_FORMATS.has(formatId)) return true;
    const code = formats.get(formatId);
    return code !== undefined && formatCodeIsDate(code);
  };

  const numeric = (value: number, xfIndex: number): string => {
    if (isDateStyle(xfIndex)) {
      const iso = serialToIsoDate(value);
      if (iso !== null) return iso;
    }
    // Avoid exponential notation for the integers a spreadsheet actually holds.
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
  };

  let substream: 'globals' | 'worksheet' | 'other' = 'globals';
  let worksheetSeen = false;
  /** Set when a FORMULA's cached result is a string, consumed by the next STRING. */
  let pendingFormulaCell: { row: number; column: number } | null = null;
  let sstBlocks: Uint8Array[] | null = null;

  const flushSst = (): void => {
    if (sstBlocks === null) return;
    for (const value of readSst(sstBlocks)) sharedStrings.push(value);
    sstBlocks = null;
  };

  for (const record of records(stream)) {
    // A CONTINUE only ever extends the record before it; collecting them here
    // keeps that fact in one place.
    if (record.id === REC_CONTINUE) {
      if (sstBlocks !== null) sstBlocks.push(record.data);
      continue;
    }
    flushSst();

    const view = new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength);

    switch (record.id) {
      case REC_BOF: {
        if (record.data.length >= 4) {
          const type = view.getUint16(2, true);
          if (type === SUBSTREAM_WORKSHEET) {
            // Only the first worksheet is read. A second one ends the walk.
            if (worksheetSeen) {
              substream = 'other';
            } else {
              worksheetSeen = true;
              substream = 'worksheet';
            }
          } else if (type === 0x0005) {
            substream = 'globals';
          } else {
            substream = 'other';
          }
        }
        break;
      }
      case REC_EOF: {
        if (substream === 'worksheet') substream = 'other';
        break;
      }
      case REC_SST: {
        sstBlocks = [record.data];
        break;
      }
      case REC_FORMAT: {
        if (record.data.length >= 2) {
          const id = view.getUint16(0, true);
          formats.set(id, readLongString(record.data, 2));
        }
        break;
      }
      case REC_XF: {
        if (record.data.length >= 4) xfFormatIds.push(view.getUint16(2, true));
        break;
      }
      default:
        break;
    }

    if (substream !== 'worksheet') continue;
    if (capped) break;

    switch (record.id) {
      case REC_LABELSST: {
        if (record.data.length < 10) break;
        const row = view.getUint16(0, true);
        const column = view.getUint16(2, true);
        const index = view.getUint32(6, true);
        builder.set(row, column, sharedStrings[index] ?? '');
        break;
      }
      case REC_LABEL:
      case REC_RSTRING: {
        if (record.data.length < 6) break;
        builder.set(view.getUint16(0, true), view.getUint16(2, true), readLongString(record.data, 6));
        break;
      }
      case REC_NUMBER: {
        if (record.data.length < 14) break;
        builder.set(
          view.getUint16(0, true),
          view.getUint16(2, true),
          numeric(view.getFloat64(6, true), view.getUint16(4, true)),
        );
        break;
      }
      case REC_RK: {
        if (record.data.length < 10) break;
        builder.set(
          view.getUint16(0, true),
          view.getUint16(2, true),
          numeric(decodeRk(view.getUint32(6, true)), view.getUint16(4, true)),
        );
        break;
      }
      case REC_MULRK: {
        if (record.data.length < 6) break;
        const row = view.getUint16(0, true);
        const firstColumn = view.getUint16(2, true);
        const count = Math.floor((record.data.length - 6) / 6);
        for (let i = 0; i < count; i += 1) {
          const base = 4 + i * 6;
          builder.set(
            row,
            firstColumn + i,
            numeric(decodeRk(view.getUint32(base + 2, true)), view.getUint16(base, true)),
          );
        }
        break;
      }
      case REC_BOOLERR: {
        if (record.data.length < 8) break;
        const isError = (record.data[7] ?? 0) === 1;
        // An error cell holds no importable value; a boolean does.
        const value = isError ? '' : (record.data[6] ?? 0) === 0 ? 'FALSE' : 'TRUE';
        builder.set(view.getUint16(0, true), view.getUint16(2, true), value);
        break;
      }
      case REC_BLANK: {
        if (record.data.length < 6) break;
        builder.set(view.getUint16(0, true), view.getUint16(2, true), '');
        break;
      }
      case REC_MULBLANK: {
        if (record.data.length < 6) break;
        const row = view.getUint16(0, true);
        const firstColumn = view.getUint16(2, true);
        const count = Math.floor((record.data.length - 6) / 2);
        for (let i = 0; i < count; i += 1) builder.set(row, firstColumn + i, '');
        break;
      }
      case REC_FORMULA: {
        if (record.data.length < 20) break;
        const row = view.getUint16(0, true);
        const column = view.getUint16(2, true);
        const xf = view.getUint16(4, true);

        // The cached result. Bytes 6..13 are either an IEEE-754 double or a
        // tagged non-numeric value; the *expression* that follows is never
        // decoded, so nothing here can be evaluated.
        const marker = view.getUint16(12, true);
        if (marker === 0xffff) {
          const kind = record.data[6] ?? 0;
          if (kind === 0x00) {
            // A cached string arrives in the STRING record that follows.
            pendingFormulaCell = { row, column };
          } else if (kind === 0x01) {
            builder.set(row, column, (record.data[8] ?? 0) === 0 ? 'FALSE' : 'TRUE');
          } else {
            // Error or blank result.
            builder.set(row, column, '');
          }
        } else {
          builder.set(row, column, numeric(view.getFloat64(6, true), xf));
        }
        break;
      }
      case REC_STRING: {
        if (pendingFormulaCell !== null) {
          builder.set(pendingFormulaCell.row, pendingFormulaCell.column, readLongString(record.data, 0));
          pendingFormulaCell = null;
        }
        break;
      }
      default:
        break;
    }

    if (record.id !== REC_FORMULA && record.id !== REC_STRING) pendingFormulaCell = null;
  }
  flushSst();

  if (capped || rowsSeen > maxRows) {
    throw new SpreadsheetError('too_many_rows', rowCapMessage(Math.max(rowsSeen, maxRows + 1)));
  }
  if (cells.size === 0) {
    throw new SpreadsheetError('empty', 'That workbook has no rows in its first sheet.');
  }

  // Densify. Rows absent from the map are genuinely empty rows in the sheet and
  // are emitted as such, so row numbers reported to the user match the file.
  const width = Math.min(maxColumnIndex + 1, MAX_COLUMNS);
  const rows: string[][] = [];
  for (let r = 0; r <= maxRowIndex; r += 1) {
    const line = cells.get(r);
    const out: string[] = new Array<string>(width).fill('');
    if (line !== undefined) {
      for (const [column, value] of line) if (column < width) out[column] = value;
    }
    rows.push(out);
  }

  // Trailing blank rows are an artefact of the used-range, not data.
  while (rows.length > 0 && (rows[rows.length - 1] ?? []).every((cell) => cell.length === 0)) {
    rows.pop();
  }

  return { rows, rowsSeen: rows.length, sheetName: null };
}
