/**
 * Values-only XLSX reader.
 *
 * Reads exactly four parts of the package — the workbook, its relationships, the
 * shared string table, and the first worksheet — plus the style table when it is
 * needed to tell a date from a number. Everything else in the container is
 * ignored and never decompressed.
 *
 * What is deliberately not done (ARCHITECTURE §20.3):
 *
 *   - Formulas are not evaluated, and `<f>` is not even read. Only `<v>`, the
 *     value Excel cached when it last calculated, is taken. A cell containing
 *     `=WEBSERVICE(...)` yields its cached text or nothing at all.
 *   - Macros are not read. `xl/vbaProject.bin` is left compressed in the
 *     archive; a macro-enabled workbook is data, not code, to this reader.
 *   - External links, OLE objects, DDE links and remote references are never
 *     resolved. `xl/externalLinks/*` is not opened.
 *   - Hyperlinks are not followed. They are not read at all.
 *   - The XML scanner refuses DOCTYPE and entity declarations (see xml.ts), so
 *     entity expansion and XXE have no entry point.
 *
 * There is no streaming story for this format: the parts are zipped XML and the
 * shared string table is referenced by index from anywhere in the sheet, so the
 * whole worksheet part must be materialised. That is precisely why the row cap
 * in §20.4 exists, and why CSV has none.
 */

import { MAX_CELL_CHARS, MAX_COLUMNS, MAX_SPREADSHEET_ROWS, rowCapMessage } from './constants';
import { ZipArchive, ZipError, type ZipLimits } from './zip';
import { scanXml, XmlSecurityError } from './xml';

export class SpreadsheetError extends Error {
  readonly kind: 'malformed' | 'bomb' | 'unsupported' | 'too_many_rows' | 'empty';
  constructor(kind: SpreadsheetError['kind'], message: string) {
    super(message);
    this.name = 'SpreadsheetError';
    this.kind = kind;
  }
}

export interface SpreadsheetReadOptions {
  maxRows?: number;
  zipLimits?: ZipLimits;
}

export interface SpreadsheetResult {
  rows: string[][];
  /** Rows present in the sheet, which may exceed `rows.length` when capped. */
  rowsSeen: number;
  sheetName: string | null;
}

/** Converts a cell reference's column part (`AB` in `AB12`) to a 0-based index. */
export function columnIndexFromRef(ref: string): number | null {
  let index = 0;
  let seen = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      index = index * 26 + (code - 64);
      seen += 1;
      if (seen > 3) return null;
      continue;
    }
    if (code >= 97 && code <= 122) {
      index = index * 26 + (code - 96);
      seen += 1;
      if (seen > 3) return null;
      continue;
    }
    break;
  }
  return seen === 0 ? null : index - 1;
}

/** Excel's serial date epoch, and the 1900 leap-year bug it is famous for. */
function serialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465) return null;
  // Serial 60 is 29 February 1900, a day that did not exist. Values above it are
  // one day ahead of the true count, which is why the offset is 25569 for the
  // Unix epoch (1 January 1970 = serial 25569).
  const days = serial < 61 ? serial : serial - 1;
  const ms = Math.round((days - 25568) * 86_400_000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;

  const iso = date.toISOString();
  const hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9;
  return hasTime ? iso.slice(0, 19).replace('T', ' ') : (iso.slice(0, 10) ?? null);
}

/** Built-in number-format ids that denote a date or time (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function formatCodeIsDate(code: string): boolean {
  // Strip quoted literals and escaped characters before looking for date tokens,
  // so a currency format like `"y"#,##0` is not mistaken for a year.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '');
  if (/\[(?:red|blue|green|black|white|yellow|magenta|cyan)\]/i.test(bare)) {
    return /[dmyhs]/.test(bare.replace(/\[[^\]]*\]/g, ''));
  }
  return /(?:\byy?y?y?\b|\bd{1,4}\b|\bm{1,5}\b|\bh{1,2}\b|\bs{1,2}\b|am\/pm)/i.test(bare);
}

interface StyleTable {
  /** Indexed by cellXfs position → true when that style formats a date. */
  dateStyles: boolean[];
}

function readStyles(archive: ZipArchive): StyleTable {
  const xml = archive.readText('xl/styles.xml');
  if (xml === undefined) return { dateStyles: [] };

  const customDateFormats = new Set<number>();
  const dateStyles: boolean[] = [];
  let inCellXfs = false;

  scanXml(xml, (event) => {
    if (event.type !== 'tag') return;
    const { tag } = event;

    if (tag.name === 'numFmt' && !tag.closing) {
      const id = Number.parseInt(tag.attributes['numFmtId'] ?? '', 10);
      const code = tag.attributes['formatCode'] ?? '';
      if (Number.isFinite(id) && formatCodeIsDate(code)) customDateFormats.add(id);
      return;
    }
    if (tag.name === 'cellXfs') {
      inCellXfs = !tag.closing;
      return;
    }
    if (tag.name === 'xf' && inCellXfs && !tag.closing) {
      const id = Number.parseInt(tag.attributes['numFmtId'] ?? '0', 10);
      dateStyles.push(BUILTIN_DATE_FORMATS.has(id) || customDateFormats.has(id));
    }
  });

  return { dateStyles };
}

function readSharedStrings(archive: ZipArchive): string[] {
  const xml = archive.readText('xl/sharedStrings.xml');
  if (xml === undefined) return [];

  const strings: string[] = [];
  let depth = 0;
  let current = '';
  // Phonetic runs (`rPh`) are pronunciation hints for Japanese text and are not
  // part of the value; including them duplicates the string.
  let inPhonetic = false;
  let inText = false;

  scanXml(xml, (event) => {
    if (event.type === 'text') {
      if (inText && !inPhonetic && current.length < MAX_CELL_CHARS) current += event.text;
      return;
    }
    const { tag } = event;
    if (tag.name === 'si') {
      if (tag.closing) {
        strings.push(current.slice(0, MAX_CELL_CHARS));
        current = '';
        depth -= 1;
      } else if (!tag.selfClosing) {
        depth += 1;
        current = '';
      } else {
        strings.push('');
      }
      return;
    }
    if (depth === 0) return;
    if (tag.name === 'rPh') {
      inPhonetic = !tag.closing && !tag.selfClosing;
      return;
    }
    if (tag.name === 't') {
      inText = !tag.closing && !tag.selfClosing;
    }
  });

  return strings;
}

/** Resolves the first sheet's part name through the workbook relationships. */
function firstSheetPart(archive: ZipArchive): { part: string; name: string | null } {
  const workbook = archive.readText('xl/workbook.xml');
  const relsXml = archive.readText('xl/_rels/workbook.xml.rels');

  let sheetName: string | null = null;
  let relationshipId: string | null = null;

  if (workbook !== undefined) {
    let done = false;
    scanXml(workbook, (event) => {
      if (done || event.type !== 'tag') return;
      const { tag } = event;
      if (tag.name !== 'sheet' || tag.closing) return;
      sheetName = tag.attributes['name'] ?? null;
      relationshipId = tag.attributes['id'] ?? null;
      done = true;
      return false;
    });
  }

  if (relsXml !== undefined && relationshipId !== null) {
    let resolved: string | null = null;
    scanXml(relsXml, (event) => {
      if (event.type !== 'tag' || resolved !== null) return;
      const { tag } = event;
      if (tag.name !== 'Relationship' || tag.closing) return;
      if (tag.attributes['Id'] !== relationshipId) return;
      // An external target is a reference to another document. It is never
      // followed: this reader opens parts of this package and nothing else.
      if ((tag.attributes['TargetMode'] ?? '').toLowerCase() === 'external') return;
      const target = tag.attributes['Target'] ?? '';
      if (target.length === 0 || target.includes('..') || /^[a-z]+:\/\//i.test(target)) return;
      resolved = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      return false;
    });
    if (resolved !== null) return { part: resolved, name: sheetName };
  }

  // Fall back to the conventional name. Some generators omit the relationship.
  for (const candidate of ['xl/worksheets/sheet1.xml', 'xl/worksheets/Sheet1.xml']) {
    if (archive.has(candidate)) return { part: candidate, name: sheetName };
  }

  const anySheet = archive.names().find((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  if (anySheet !== undefined) return { part: anySheet, name: sheetName };

  throw new SpreadsheetError('malformed', 'This workbook contains no readable worksheet.');
}

/**
 * Reads the first worksheet, invoking `onRow` per row in sheet order.
 *
 * Sparse sheets are normalised: a row whose cells are A, C, F yields a dense
 * array with empty strings between them, so column positions line up with the
 * header regardless of which cells the file bothered to write.
 */
export function readXlsx(
  bytes: Uint8Array,
  options: SpreadsheetReadOptions = {},
): SpreadsheetResult {
  const maxRows = options.maxRows ?? MAX_SPREADSHEET_ROWS;

  let archive: ZipArchive;
  try {
    archive = options.zipLimits === undefined
      ? ZipArchive.open(bytes)
      : ZipArchive.open(bytes, options.zipLimits);
  } catch (cause) {
    throw toSpreadsheetError(cause);
  }

  try {
    const { part, name } = firstSheetPart(archive);
    const sheetXml = archive.readText(part);
    if (sheetXml === undefined) {
      throw new SpreadsheetError('malformed', 'This workbook contains no readable worksheet.');
    }

    const shared = readSharedStrings(archive);
    const styles = readStyles(archive);

    const rows: string[][] = [];
    let rowsSeen = 0;
    let capped = false;

    let currentRow: string[] | null = null;
    let cellIndex = 0;
    let cellType = '';
    let cellStyle = -1;
    let inValue = false;
    let inInlineText = false;
    let valueBuffer = '';
    // True inside `<f>`. Its text is skipped entirely — a formula is never read,
    // let alone evaluated.
    let inFormula = false;

    const flushCell = (): void => {
      if (currentRow === null) return;
      const value = decodeCellValue(valueBuffer, cellType, cellStyle, shared, styles);
      if (value.length > 0 || cellIndex < currentRow.length) {
        while (currentRow.length < cellIndex) currentRow.push('');
        if (cellIndex < MAX_COLUMNS) currentRow[cellIndex] = value;
      }
      valueBuffer = '';
    };

    scanXml(sheetXml, (event) => {
      if (event.type === 'text') {
        if (inFormula) return;
        if ((inValue || inInlineText) && valueBuffer.length < MAX_CELL_CHARS) {
          valueBuffer += event.text;
        }
        return;
      }

      const { tag } = event;

      switch (tag.name) {
        case 'row': {
          if (tag.closing) {
            if (currentRow !== null) {
              rowsSeen += 1;
              if (rows.length < maxRows) rows.push(currentRow);
              else capped = true;
              currentRow = null;
            }
            return capped ? false : undefined;
          }
          if (tag.selfClosing) {
            rowsSeen += 1;
            if (rows.length < maxRows) rows.push([]);
            else capped = true;
            return capped ? false : undefined;
          }
          currentRow = [];
          cellIndex = 0;
          return;
        }
        case 'c': {
          if (tag.closing) {
            flushCell();
            cellIndex += 1;
            cellType = '';
            cellStyle = -1;
            return;
          }
          cellType = tag.attributes['t'] ?? '';
          const styleAttribute = tag.attributes['s'];
          cellStyle = styleAttribute === undefined ? -1 : Number.parseInt(styleAttribute, 10);
          const ref = tag.attributes['r'];
          if (ref !== undefined) {
            const resolved = columnIndexFromRef(ref);
            if (resolved !== null && resolved >= 0) cellIndex = resolved;
          }
          valueBuffer = '';
          if (tag.selfClosing) {
            // An empty cell carrying only a style. It still occupies a column.
            flushCell();
            cellIndex += 1;
            cellType = '';
            cellStyle = -1;
          }
          return;
        }
        case 'v': {
          inValue = !tag.closing && !tag.selfClosing;
          return;
        }
        case 'f': {
          inFormula = !tag.closing && !tag.selfClosing;
          return;
        }
        case 't': {
          // Only meaningful inside `<is>` for an inline string; `<v>` handles
          // the shared-string case.
          inInlineText = !tag.closing && !tag.selfClosing;
          return;
        }
        default:
          return;
      }
    });

    if (capped || rowsSeen > maxRows) {
      throw new SpreadsheetError('too_many_rows', rowCapMessage(Math.max(rowsSeen, maxRows + 1)));
    }
    if (rows.length === 0) {
      throw new SpreadsheetError('empty', 'That workbook has no rows in its first sheet.');
    }

    return { rows, rowsSeen, sheetName: name };
  } catch (cause) {
    throw toSpreadsheetError(cause);
  }
}

function decodeCellValue(
  raw: string,
  type: string,
  styleIndex: number,
  shared: string[],
  styles: StyleTable,
): string {
  const value = raw.slice(0, MAX_CELL_CHARS);

  switch (type) {
    case 's': {
      const index = Number.parseInt(value, 10);
      return Number.isFinite(index) ? (shared[index] ?? '') : '';
    }
    case 'inlineStr':
    case 'str':
      return value.trim();
    case 'b':
      return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value;
    case 'e':
      // An error cell (#REF!, #VALUE!). It carries no data worth importing.
      return '';
    default:
      break;
  }

  if (value.length === 0) return '';

  if (styleIndex >= 0 && styles.dateStyles[styleIndex] === true) {
    const serial = Number.parseFloat(value);
    const iso = serialToIsoDate(serial);
    if (iso !== null) return iso;
  }

  return value.trim();
}

export function toSpreadsheetError(cause: unknown): SpreadsheetError {
  if (cause instanceof SpreadsheetError) return cause;
  if (cause instanceof ZipError) {
    const kind = cause.kind === 'bomb' ? 'bomb' : cause.kind === 'unsupported' ? 'unsupported' : 'malformed';
    return new SpreadsheetError(kind, cause.message);
  }
  if (cause instanceof XmlSecurityError) {
    return new SpreadsheetError('malformed', cause.message);
  }
  return new SpreadsheetError('malformed', 'This spreadsheet could not be read — the file may be corrupt.');
}
