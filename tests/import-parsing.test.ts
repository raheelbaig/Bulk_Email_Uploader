import { describe, it, expect } from 'vitest';
import {
  CsvStreamParser,
  parseCsv,
  detectDelimiter,
  defaultDelimiterFor,
  isBlankRow,
} from '@/lib/imports/csv';
import {
  proposeMapping,
  validateMapping,
  detectHeaderRow,
  dedupeHeaders,
  normalizeHeader,
  customKeyFor,
  emailColumnIndex,
  columnMappingSchema,
} from '@/lib/imports/mapping';
import { classifyRow, compileMapping, safeRawRow, isEmptyRow } from '@/lib/imports/classify';
import { MAX_CUSTOM_FIELDS, MAX_COLUMNS } from '@/lib/imports/constants';
import { normalizeEmail } from '@/lib/email/normalize';

/**
 * Parsing, mapping and classification.
 *
 * These are the pure parts of the engine, so they can be tested exhaustively —
 * and the reconciliation property depends on `classifyRow` returning exactly one
 * outcome for every conceivable row, which is a claim worth checking directly
 * rather than only through an end-to-end import.
 */

describe('CSV parsing', () => {
  it('parses a plain file', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted delimiters', () => {
    expect(parseCsv('name,note\n"Smith, Ann","said ""hi"""\n')).toEqual([
      ['name', 'note'],
      ['Smith, Ann', 'said "hi"'],
    ]);
  });

  it('handles newlines inside quotes', () => {
    expect(parseCsv('a,b\n"line1\nline2",x\n')).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'x'],
    ]);
  });

  it('handles CRLF, LF and a bare CR', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const bom = String.fromCharCode(0xfeff);
    const rows = parseCsv(`${bom}email,name\na@b.com,Ann\n`);
    expect(rows[0]).toEqual(['email', 'name']);
  });

  it('keeps a final row with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('preserves empty cells and blank rows rather than dropping them', () => {
    expect(parseCsv('a,b,c\n1,,3\n,,\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
      ['', '', ''],
    ]);
  });

  it('preserves Unicode, including characters outside the BMP', () => {
    const rows = parseCsv('email,name\nyuki@example.jp,ゆき 😀\n');
    expect(rows[1]).toEqual(['yuki@example.jp', 'ゆき 😀']);
  });

  it('tolerates a quote appearing mid-field, as spreadsheets do', () => {
    expect(parseCsv('a\n12" pipe\n')).toEqual([['a'], ['12" pipe']]);
  });

  it('takes an unterminated quoted field rather than discarding the row', () => {
    expect(parseCsv('a,b\n"unclosed,x\n')).toEqual([['a', 'b'], ['unclosed,x\n']]);
  });

  // ── The property that makes it a streaming parser ────────────────────────

  it('produces identical rows however the input is chunked', () => {
    const text =
      'email,name,note\r\n' +
      'ann@example.com,"Smith, Ann","multi\nline"\r\n' +
      'yuki@example.jp,ゆき,ok\r\n' +
      'bob@example.com,Bob,"say ""hi"""\r\n';
    const expected = parseCsv(text);

    for (const size of [1, 2, 3, 5, 7, 13, 64, 1000]) {
      const parser = new CsvStreamParser({ delimiter: ',' });
      const rows: string[][] = [];
      for (let i = 0; i < text.length; i += size) {
        rows.push(...parser.push(text.slice(i, i + size)));
      }
      rows.push(...parser.end());
      expect(rows, `chunk size ${size}`).toEqual(expected);
    }
  });

  it('splits correctly when a chunk boundary falls inside CRLF', () => {
    const parser = new CsvStreamParser({ delimiter: ',' });
    const rows = [...parser.push('a,b\r'), ...parser.push('\n1,2\r\n'), ...parser.end()];
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('splits correctly when a chunk boundary falls inside an escaped quote', () => {
    const parser = new CsvStreamParser({ delimiter: ',' });
    const rows = [...parser.push('a\n"he said ""'), ...parser.push('hi"""\n'), ...parser.end()];
    expect(rows).toEqual([['a'], ['he said "hi"']]);
  });

  it('handles a large file without materialising it as rows', () => {
    // 20,000 rows fed in 4 KB chunks, counted as they arrive.
    const parser = new CsvStreamParser({ delimiter: ',' });
    let text = 'email,name\n';
    for (let i = 0; i < 20_000; i += 1) text += `user${i}@example.com,User ${i}\n`;

    let count = 0;
    for (let i = 0; i < text.length; i += 4096) {
      count += parser.push(text.slice(i, i + 4096)).length;
    }
    count += parser.end().length;
    expect(count).toBe(20_001);
  });

  it('truncates an absurd cell rather than buffering it without limit', () => {
    const parser = new CsvStreamParser({ delimiter: ',', maxCellChars: 10 });
    const rows = [...parser.push(`${'x'.repeat(5000)},b\n`), ...parser.end()];
    expect(rows[0]?.[0]).toHaveLength(10);
    expect(parser.truncatedCellCount).toBe(1);
  });

  it('drops columns beyond the cap rather than growing into them', () => {
    const wide = Array.from({ length: MAX_COLUMNS + 50 }, (_unused, i) => `c${i}`).join(',');
    const rows = parseCsv(`${wide}\n`);
    expect(rows[0]?.length).toBe(MAX_COLUMNS);
  });
});

describe('delimiter detection', () => {
  it.each([
    ['email,name\na@b.com,Ann', ','],
    ['email;name\na@b.com;Ann', ';'],
    ['email\tname\na@b.com\tAnn', '\t'],
    ['email|name\na@b.com|Ann', '|'],
  ])('detects the delimiter in %j', (sample, expected) => {
    expect(detectDelimiter(sample)).toBe(expected);
  });

  it('ignores delimiters inside quotes', () => {
    expect(detectDelimiter('"a;b;c;d;e";x\n')).toBe(';');
    expect(detectDelimiter('"a,b,c,d,e";x\n')).toBe(';');
  });

  it('only considers the first line', () => {
    expect(detectDelimiter('email\na;b;c;d\n')).toBe(',');
  });

  it('defaults by format when nothing is detectable', () => {
    expect(defaultDelimiterFor('tsv')).toBe('\t');
    expect(defaultDelimiterFor('csv')).toBe(',');
    expect(detectDelimiter('singlecolumn\n', '\t')).toBe('\t');
  });

  it('parses a TSV', () => {
    expect(parseCsv('email\tname\na@b.com\tAnn\n', { delimiter: '\t' })).toEqual([
      ['email', 'name'],
      ['a@b.com', 'Ann'],
    ]);
  });
});

describe('header handling', () => {
  it('names blank headers by their column position', () => {
    expect(dedupeHeaders(['Email', '', 'Company'])).toEqual(['Email', 'Column 2', 'Company']);
  });

  it('suffixes duplicate headers instead of collapsing them', () => {
    expect(dedupeHeaders(['Email', 'Email', 'email'])).toEqual(['Email', 'Email (2)', 'email (3)']);
  });

  it('trims and collapses whitespace', () => {
    expect(dedupeHeaders(['  Email  ', 'First   Name'])).toEqual(['Email', 'First Name']);
  });

  it('folds case and punctuation for comparison', () => {
    expect(normalizeHeader('E-Mail Address')).toBe('e_mail_address');
    expect(normalizeHeader('  First   Name!  ')).toBe('first_name');
    expect(normalizeHeader('***')).toBe('');
  });

  it('derives safe custom keys and never collides', () => {
    const taken = new Set<string>();
    const first = customKeyFor('Deal Size ($)', taken);
    expect(first).toBe('deal_size');
    taken.add(first!);
    expect(customKeyFor('Deal size', taken)).toBe('deal_size_2');
    expect(customKeyFor('***', taken)).toBe(null);
    expect(customKeyFor('123', taken)).toBe(null);
  });

  it('finds the header row past a title and a blank row', () => {
    const rows = [
      ['Contact export — March'],
      [],
      ['Email', 'First Name', 'Company'],
      ['ann@example.com', 'Ann', 'Acme'],
    ];
    expect(detectHeaderRow(rows)).toBe(2);
  });

  it('does not mistake a data row for a header', () => {
    const rows = [
      ['ann@example.com', 'Ann'],
      ['bob@example.com', 'Bob'],
    ];
    // Neither row is a header; the first is chosen, and the user can correct it.
    expect(detectHeaderRow(rows)).toBe(0);
  });

  it('prefers the header row over a preceding row of addresses', () => {
    const rows = [
      ['ann@example.com', 'x'],
      ['Email', 'First Name'],
    ];
    expect(detectHeaderRow(rows)).toBe(1);
  });
});

describe('mapping proposal', () => {
  it('maps obvious headers exactly', () => {
    const proposal = proposeMapping([
      ['Email', 'First Name', 'Last Name', 'Company', 'Website', 'Phone'],
      ['ann@example.com', 'Ann', 'Smith', 'Acme', 'acme.com', '555'],
    ]);

    expect(proposal.emailUnresolved).toBe(false);
    expect(proposal.columns.map((c) => (c.target.kind === 'field' ? c.target.field : null))).toEqual(
      ['email', 'first_name', 'last_name', 'company', 'website', 'phone'],
    );
    expect(proposal.columns.every((c) => c.confidence === 'exact')).toBe(true);
  });

  it('maps common variants', () => {
    const proposal = proposeMapping([
      ['E-Mail Address', 'Given Name', 'Surname', 'Organisation', 'URL', 'Mobile'],
      ['ann@example.com', 'Ann', 'Smith', 'Acme', 'acme.com', '555'],
    ]);
    expect(proposal.columns.map((c) => (c.target.kind === 'field' ? c.target.field : null))).toEqual(
      ['email', 'first_name', 'last_name', 'company', 'website', 'phone'],
    );
  });

  it('never maps two columns to the same field', () => {
    const proposal = proposeMapping([
      ['Email', 'Email Address', 'Work Email'],
      ['a@b.com', 'c@d.com', 'e@f.com'],
    ]);
    const fields = proposal.columns
      .filter((c) => c.target.kind === 'field')
      .map((c) => (c.target.kind === 'field' ? c.target.field : ''));
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('finds the email column from the data when the header gives nothing', () => {
    const proposal = proposeMapping([
      ['Reference', 'Contact', 'Notes'],
      ['R1', 'ann@example.com', 'x'],
      ['R2', 'bob@example.com', 'y'],
      ['R3', 'carl@example.com', 'z'],
    ]);
    const emailColumn = proposal.columns.find(
      (c) => c.target.kind === 'field' && c.target.field === 'email',
    );
    expect(emailColumn?.index).toBe(1);
    expect(emailColumn?.confidence).toBe('sampled');
  });

  it('does not guess an email column from one lucky cell', () => {
    const proposal = proposeMapping([
      ['Reference', 'Notes'],
      ['R1', 'ann@example.com'],
      ['R2', 'nothing here'],
      ['R3', 'nor here'],
      ['R4', 'nor here either'],
    ]);
    expect(proposal.emailUnresolved).toBe(true);
  });

  it('does not treat a column called "Address" as email on the strength of its name', () => {
    const proposal = proposeMapping([
      ['Address', 'Town'],
      ['12 High Street', 'Leeds'],
    ]);
    expect(proposal.emailUnresolved).toBe(true);
  });

  it('offers unknown columns as custom fields', () => {
    const proposal = proposeMapping([
      ['Email', 'Deal Size', 'Lead Source'],
      ['a@b.com', '1000', 'Referral'],
    ]);
    expect(proposal.columns[1]?.target).toEqual({ kind: 'custom', key: 'deal_size' });
    expect(proposal.columns[2]?.target).toEqual({ kind: 'custom', key: 'lead_source' });
  });

  it('stops offering custom fields at the cap', () => {
    const headers = ['Email', ...Array.from({ length: 40 }, (_unused, i) => `Extra ${i}`)];
    const proposal = proposeMapping([headers, headers.map(() => 'x')]);
    const customCount = proposal.columns.filter((c) => c.target.kind === 'custom').length;
    expect(customCount).toBe(MAX_CUSTOM_FIELDS);
    expect(proposal.columns.filter((c) => c.target.kind === 'ignore').length).toBeGreaterThan(0);
  });

  it('handles blank and duplicate headers together', () => {
    const proposal = proposeMapping([
      ['Email', '', 'Email', 'Company'],
      ['a@b.com', 'x', 'c@d.com', 'Acme'],
    ]);
    expect(proposal.headers).toEqual(['Email', 'Column 2', 'Email (2)', 'Company']);
    const emailColumns = proposal.columns.filter(
      (c) => c.target.kind === 'field' && c.target.field === 'email',
    );
    expect(emailColumns).toHaveLength(1);
  });
});

describe('mapping validation', () => {
  const headers = ['Email', 'First Name', 'Extra'];

  it('accepts a complete mapping', () => {
    const result = validateMapping(
      {
        headerRow: 0,
        columns: [
          { index: 0, header: 'Email', target: { kind: 'field', field: 'email' } },
          { index: 1, header: 'First Name', target: { kind: 'field', field: 'first_name' } },
          { index: 2, header: 'Extra', target: { kind: 'custom', key: 'extra' } },
        ],
      },
      headers,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a mapping with no email column — email is mandatory', () => {
    const result = validateMapping(
      {
        headerRow: 0,
        columns: [
          { index: 0, header: 'Email', target: { kind: 'ignore' } },
          { index: 1, header: 'First Name', target: { kind: 'field', field: 'first_name' } },
        ],
      },
      headers,
    );
    expect(result).toMatchObject({ ok: false, problem: 'missing_email' });
  });

  it('refuses two columns mapped to the same field', () => {
    const result = validateMapping(
      {
        headerRow: 0,
        columns: [
          { index: 0, header: 'Email', target: { kind: 'field', field: 'email' } },
          { index: 1, header: 'First Name', target: { kind: 'field', field: 'email' } },
        ],
      },
      headers,
    );
    expect(result).toMatchObject({ ok: false, problem: 'duplicate_field' });
  });

  it('refuses two columns mapped to the same custom key', () => {
    const result = validateMapping(
      {
        headerRow: 0,
        columns: [
          { index: 0, header: 'Email', target: { kind: 'field', field: 'email' } },
          { index: 1, header: 'a', target: { kind: 'custom', key: 'x' } },
          { index: 2, header: 'b', target: { kind: 'custom', key: 'x' } },
        ],
      },
      headers,
    );
    expect(result).toMatchObject({ ok: false, problem: 'duplicate_custom_key' });
  });

  it('refuses a column index the file does not have', () => {
    const result = validateMapping(
      {
        headerRow: 0,
        columns: [
          { index: 0, header: 'Email', target: { kind: 'field', field: 'email' } },
          { index: 99, header: 'Ghost', target: { kind: 'field', field: 'company' } },
        ],
      },
      headers,
    );
    expect(result).toMatchObject({ ok: false, problem: 'unknown_column' });
  });

  it('refuses a mapping of the wrong shape', () => {
    expect(validateMapping({ nonsense: true }, headers)).toMatchObject({
      ok: false,
      problem: 'invalid_shape',
    });
    expect(validateMapping(null, headers)).toMatchObject({ ok: false });
    expect(validateMapping('email', headers)).toMatchObject({ ok: false });
  });

  it('refuses an unknown field name — no arbitrary column can be written', () => {
    const result = validateMapping(
      {
        headerRow: 0,
        columns: [
          { index: 0, header: 'Email', target: { kind: 'field', field: 'email' } },
          { index: 1, header: 'x', target: { kind: 'field', field: 'status' } },
        ],
      },
      headers,
    );
    expect(result).toMatchObject({ ok: false, problem: 'invalid_shape' });
  });

  it('refuses a dangerous custom key', () => {
    for (const key of ['__proto__', 'constructor.prototype', 'a b', 'Aa', '1x', '']) {
      const result = validateMapping(
        {
          headerRow: 0,
          columns: [
            { index: 0, header: 'Email', target: { kind: 'field', field: 'email' } },
            { index: 1, header: 'x', target: { kind: 'custom', key } },
          ],
        },
        headers,
      );
      expect(result.ok, `key ${JSON.stringify(key)} must be refused`).toBe(false);
    }
  });

  it('accepts a corrected mapping the proposal got wrong', () => {
    const proposal = proposeMapping([
      ['Company', 'Contact'],
      ['Acme', 'ann@example.com'],
    ]);
    // The user swaps the email column onto index 1 explicitly.
    const corrected = {
      headerRow: 0,
      columns: [
        { index: 0, header: 'Company', target: { kind: 'field', field: 'company' } },
        { index: 1, header: 'Contact', target: { kind: 'field', field: 'email' } },
      ],
    };
    const result = validateMapping(corrected, proposal.headers);
    expect(result.ok).toBe(true);
    if (result.ok) expect(emailColumnIndex(result.mapping)).toBe(1);
  });

  it('bounds the mapping shape so an enormous payload cannot be stored', () => {
    const columns = Array.from({ length: MAX_COLUMNS + 10 }, (_unused, i) => ({
      index: i,
      header: `c${i}`,
      target: { kind: 'ignore' as const },
    }));
    expect(columnMappingSchema.safeParse({ headerRow: 0, columns }).success).toBe(false);
  });
});

describe('row classification', () => {
  const mapping = compileMapping({
    headerRow: 0,
    columns: [
      { index: 0, header: 'Email', target: { kind: 'field', field: 'email' } },
      { index: 1, header: 'First Name', target: { kind: 'field', field: 'first_name' } },
      { index: 2, header: 'Company', target: { kind: 'field', field: 'company' } },
      { index: 3, header: 'Deal', target: { kind: 'custom', key: 'deal' } },
    ],
  });

  it('accepts a good row and builds the contact', () => {
    const outcome = classifyRow(['Ann@Example.COM ', 'Ann', 'Acme', '1000'], mapping);
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind !== 'candidate') return;
    expect(outcome.contact.emailNormalized).toBe('ann@example.com');
    expect(outcome.contact.firstName).toBe('Ann');
    expect(outcome.contact.custom).toEqual({ deal: '1000' });
  });

  it('uses the P1 normalizer, exactly', () => {
    // Not "produces something similar" — the same value, from the same function.
    const raw = '  Ann.Smith+news@Example.COM ';
    const outcome = classifyRow([raw, '', '', ''], mapping);
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind !== 'candidate') return;
    const canonical = normalizeEmail(raw);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    expect(outcome.contact.emailNormalized).toBe(canonical.normalized);
    // And specifically: no Gmail dot-stripping, no plus-address stripping.
    expect(outcome.contact.emailNormalized).toBe('ann.smith+news@example.com');
  });

  it('classifies a malformed address as invalid, with the normalizer’s reason', () => {
    const outcome = classifyRow(['not-an-email', 'Ann', '', ''], mapping);
    expect(outcome).toMatchObject({ kind: 'settled', bucket: 'invalid' });
    if (outcome.kind !== 'settled') return;
    expect(outcome.reason).toContain('Invalid email format');
  });

  it.each([
    ['no at sign', 'annexample.com'],
    ['no domain', 'ann@'],
    ['no local part', '@example.com'],
    ['spaces', 'ann smith@example.com'],
    ['double dot', 'ann..smith@example.com'],
    ['no tld', 'ann@localhost'],
    ['trailing dot', 'ann@example.com.'],
    ['too long', `${'a'.repeat(300)}@example.com`],
  ])('classifies %s as invalid', (_label, email) => {
    expect(classifyRow([email, '', '', ''], mapping)).toMatchObject({
      kind: 'settled',
      bucket: 'invalid',
    });
  });

  it('classifies an empty row as rejected', () => {
    expect(classifyRow(['', '', '', ''], mapping)).toMatchObject({
      kind: 'settled',
      bucket: 'rejected',
      reason: 'Row is empty',
    });
  });

  it('classifies a row with data but no address as rejected', () => {
    expect(classifyRow(['', 'Ann', 'Acme', ''], mapping)).toMatchObject({
      kind: 'settled',
      bucket: 'rejected',
      reason: 'No email address in the email column',
    });
  });

  it('rejects rather than truncates an over-long field', () => {
    const outcome = classifyRow(['a@b.com', 'Ann', 'x'.repeat(500), ''], mapping);
    expect(outcome).toMatchObject({ kind: 'settled', bucket: 'rejected' });
    if (outcome.kind !== 'settled') return;
    expect(outcome.reason).toContain('Company is longer than 200 characters');
  });

  it('bounds a custom value rather than rejecting the row for it', () => {
    const outcome = classifyRow(['a@b.com', '', '', 'y'.repeat(500)], mapping);
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind !== 'candidate') return;
    expect(outcome.contact.custom['deal']?.length).toBeLessThanOrEqual(120);
  });

  it('stores custom values as strings only — never structure', () => {
    const outcome = classifyRow(['a@b.com', '', '', '{"a":1}'], mapping);
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind !== 'candidate') return;
    expect(typeof outcome.contact.custom['deal']).toBe('string');
  });

  it('rejects every row when the mapping has no email column', () => {
    const noEmail = compileMapping({
      headerRow: 0,
      columns: [{ index: 0, header: 'Company', target: { kind: 'field', field: 'company' } }],
    });
    expect(classifyRow(['Acme'], noEmail)).toMatchObject({
      kind: 'settled',
      bucket: 'rejected',
      reason: 'Missing mandatory email column',
    });
  });

  it('tolerates a short row without throwing', () => {
    const outcome = classifyRow(['a@b.com'], mapping);
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind !== 'candidate') return;
    expect(outcome.contact.company).toBe(null);
  });

  it('leaves an absent value null rather than writing an empty string', () => {
    const outcome = classifyRow(['a@b.com', '   ', '', ''], mapping);
    expect(outcome.kind).toBe('candidate');
    if (outcome.kind !== 'candidate') return;
    expect(outcome.contact.firstName).toBe(null);
    expect(outcome.contact.custom).toEqual({});
  });

  // ── The reconciliation precondition ─────────────────────────────────────

  it('returns exactly one outcome for every row, never nothing', () => {
    const awkwardRows: string[][] = [
      [],
      [''],
      ['a@b.com'],
      ['a@b.com', 'x', 'y', 'z', 'extra', 'more'],
      ['@', '', '', ''],
      ['a@b', '', '', ''],
      [' ', ' ', ' ', ' '],
      ['A@B.COM', 'Ann', 'Acme', 'deal'],
      ['a@b.com', 'x'.repeat(200), '', ''],
      ['"quoted"@example.com', '', '', ''],
      ['a@ب.com', '', '', ''],
      [String.fromCharCode(0xfeff) + 'a@b.com', '', '', ''],
    ];

    for (const row of awkwardRows) {
      const outcome = classifyRow(row, mapping);
      expect(outcome, JSON.stringify(row)).toBeDefined();
      expect(['candidate', 'settled']).toContain(outcome.kind);
    }
  });
});

describe('safe raw-row representation', () => {
  it('keys cells by header and skips empties', () => {
    expect(safeRawRow(['a@b.com', '', 'Acme'], ['Email', 'First Name', 'Company'])).toEqual({
      Email: 'a@b.com',
      Company: 'Acme',
    });
  });

  it('falls back to a column number when the header is blank', () => {
    expect(safeRawRow(['x'], [''])).toEqual({ column_1: 'x' });
  });

  it('does not lose a cell to a duplicate header', () => {
    const result = safeRawRow(['a', 'b'], ['Email', 'Email']);
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('bounds the number of cells and their length', () => {
    const wide = Array.from({ length: 200 }, (_unused, i) => `v${i}`);
    const headers = Array.from({ length: 200 }, (_unused, i) => `h${i}`);
    const result = safeRawRow(wide, headers);
    expect(Object.keys(result).length).toBeLessThanOrEqual(40);

    const long = safeRawRow(['z'.repeat(1000)], ['Email']);
    expect(long['Email']?.length).toBeLessThanOrEqual(120);
  });
});

describe('blank-row helpers', () => {
  it('recognises a row of empty cells', () => {
    expect(isBlankRow(['', ' ', '\t'])).toBe(true);
    expect(isBlankRow(['', 'x'])).toBe(false);
    expect(isEmptyRow([])).toBe(true);
  });
});
