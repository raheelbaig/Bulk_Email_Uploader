/**
 * CSV export with formula-injection defence.
 *
 * ARCHITECTURE §20.5. A rejected-rows export is built entirely from data the
 * uploader supplied, and it is downloaded and opened in Excel by the person who
 * uploaded it — or by a colleague. A cell whose text begins `=` is a formula to
 * Excel, LibreOffice and Google Sheets, and `=cmd|'/c calc'!A1` in a contact's
 * company name is remote code execution on the machine that opens the file.
 *
 * The defence is to make such a cell inert before it is ever written:
 *
 *   1. Prefix the dangerous leading characters with an apostrophe, which
 *      spreadsheets read as "the rest of this cell is literal text".
 *   2. Quote and escape per RFC 4180, so the apostrophe survives and the value
 *      cannot break out of its field.
 *
 * Both are needed. Quoting alone does not help — `"=1+1"` is still a formula
 * when the quotes are the CSV's own — and prefixing alone leaves the delimiter
 * problem.
 */

/**
 * Leading characters that make a cell a formula.
 *
 * `=` and `@` start one directly; `+` and `-` start one in Excel; tab and
 * carriage return are stripped by the reader before the check, so a payload
 * cannot hide behind leading whitespace.
 */
const FORMULA_LEAD = new Set(['=', '+', '-', '@']);

/** Control characters removed outright. Written escaped so none appears in source. */
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

/**
 * Tab, LF and CR — the three the brief names as dangerous in leading position,
 * because a spreadsheet strips them on open and acts on whatever they hid.
 *
 * A leading *space* is deliberately absent: Excel does not strip it, so ` =1+1`
 * stays text and prefixing it would mangle ordinary values like `  Ann`.
 */
const LEADING_CONTROL = new RegExp('^[\\u0009\\u000A\\u000D]+');

/** Space as well, only for deciding which character is effectively first. */
const LEADING_BLANK = new RegExp('^[\\u0009\\u000A\\u000D\\u0020]+');

/**
 * Makes one value safe to write into a spreadsheet-readable file.
 *
 * Exported so the rule can be tested directly against each dangerous character
 * rather than only through a whole-file assertion.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = typeof value === 'string' ? value : String(value);
  text = text.replace(CONTROL, '');

  // A leading tab, LF or CR is stripped by the spreadsheet on open, exposing the
  // character behind it. Remove them here and judge what is effectively first,
  // ignoring plain spaces on the way so `  =1+1` is caught too.
  const withoutControl = text.replace(LEADING_CONTROL, '');
  const first = withoutControl.replace(LEADING_BLANK, '')[0];

  const dangerous =
    (first !== undefined && FORMULA_LEAD.has(first)) ||
    // The original began with tab, LF or CR, which the brief lists as dangerous
    // in its own right: neutralise it the same way.
    text !== withoutControl;

  if (dangerous) text = `'${withoutControl}`;

  // RFC 4180 quoting. Applied whenever the value contains a delimiter, a quote,
  // a newline, or the apostrophe we just added.
  if (/[",\r\n\t]/.test(text) || dangerous) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** True when a value would be treated as a formula if written unescaped. */
export function isFormulaInjection(value: string): boolean {
  const withoutControl = value.replace(LEADING_CONTROL, '');
  const first = withoutControl.replace(LEADING_BLANK, '')[0];
  return (first !== undefined && FORMULA_LEAD.has(first)) || value !== withoutControl;
}

export interface CsvExportOptions {
  /** Excel needs a BOM to read UTF-8 correctly on Windows. Default true. */
  byteOrderMark?: boolean;
  /** CRLF, per RFC 4180 and what Excel expects. Default true. */
  crlf?: boolean;
}

/**
 * Renders rows to CSV text.
 *
 * `rows` are objects; `columns` fixes the order and the header labels, so a row
 * missing a key produces an empty cell rather than shifting every later column.
 */
export function toCsv(
  columns: ReadonlyArray<{ key: string; label: string }>,
  rows: ReadonlyArray<Record<string, unknown>>,
  options: CsvExportOptions = {},
): string {
  const newline = options.crlf === false ? '\n' : '\r\n';
  const lines: string[] = [];

  lines.push(columns.map((column) => escapeCsvCell(column.label)).join(','));
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvCell(row[column.key])).join(','));
  }

  const body = lines.join(newline) + newline;
  return options.byteOrderMark === false ? body : `${String.fromCharCode(0xfeff)}${body}`;
}

/**
 * The Content-Disposition value for a download.
 *
 * The filename is derived from user-supplied text, so it is stripped to a safe
 * set and quoted. An unescaped quote or newline here is a response-splitting
 * and header-injection vector, not merely an odd filename.
 */
export function contentDisposition(filename: string): string {
  const safe = filename
    .replace(CONTROL, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 100);
  const fallback = safe.length === 0 ? 'export.csv' : safe;
  return `attachment; filename="${fallback}"`;
}
