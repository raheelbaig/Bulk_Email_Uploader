import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * Spreadsheet fixture builders.
 *
 * The import engine reads XLSX and XLS with readers written in this repository
 * (see src/lib/imports/), so the tests need real files to read. Building them
 * here rather than committing binaries keeps every byte visible and reviewable —
 * and it is the only way to construct the hostile cases: a zip bomb, a workbook
 * with a DOCTYPE, a truncated container.
 */

// ── ZIP ─────────────────────────────────────────────────────────────────────

export interface ZipInput {
  name: string;
  content: Uint8Array | string;
  /** Store (0) or deflate (8). Bombs need deflate. */
  method?: 0 | 8;
}

function crc(data: Uint8Array): number {
  // node:zlib exposes crc32 from Node 20.12. Fall back to a local table when the
  // runtime predates it, so the fixture builder does not pin a Node patch level.
  if (typeof crc32 === 'function') return crc32(Buffer.from(data)) >>> 0;
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let i = 0; i < 8; i += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Builds a ZIP archive. Deliberately minimal: no ZIP64, no comment, no extras. */
export function buildZip(entries: readonly ZipInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw =
      typeof entry.content === 'string' ? new TextEncoder().encode(entry.content) : entry.content;
    const method = entry.method ?? 8;
    const body = method === 0 ? raw : new Uint8Array(deflateRawSync(Buffer.from(raw), { level: 9 }));
    const nameBytes = new TextEncoder().encode(entry.name);
    const checksum = crc(raw);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, body.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    chunks.push(local, body);

    const entryHeader = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entryHeader.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(10, method, true);
    entryView.setUint32(16, checksum, true);
    entryView.setUint32(20, body.length, true);
    entryView.setUint32(24, raw.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint32(42, offset, true);
    entryHeader.set(nameBytes, 46);
    central.push(entryHeader);

    offset += local.length + body.length;
  }

  const directory = concat(central);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, directory.length, true);
  eocdView.setUint32(16, offset, true);

  return concat([...chunks, directory, eocd]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ── XLSX ────────────────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnRef(index: number): string {
  let ref = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    ref = String.fromCharCode(65 + remainder) + ref;
    n = Math.floor((n - 1) / 26);
  }
  return ref;
}

export interface XlsxOptions {
  /** Emit inline strings instead of a shared string table. */
  inlineStrings?: boolean;
  /** Extra parts to add — used to prove macros and external links are ignored. */
  extraParts?: readonly ZipInput[];
  /** Replace the worksheet XML wholesale, for malformed and hostile cases. */
  sheetXmlOverride?: string;
  sheetName?: string;
}

/**
 * Builds a valid .xlsx from a grid of strings.
 *
 * Numbers written as `{ number: n }` become numeric cells, and
 * `{ date: 'serial' }` a date-styled one, so the reader's value handling can be
 * tested against something other than text.
 */
export type XlsxCell = string | { number: number } | { dateSerial: number } | { formula: string; cached: string };

export function buildXlsx(rows: readonly (readonly XlsxCell[])[], options: XlsxOptions = {}): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();

  const cellXml = (cell: XlsxCell, rowIndex: number, columnIndex: number): string => {
    const ref = `${columnRef(columnIndex)}${rowIndex + 1}`;

    if (typeof cell === 'object' && 'number' in cell) {
      return `<c r="${ref}"><v>${cell.number}</v></c>`;
    }
    if (typeof cell === 'object' && 'dateSerial' in cell) {
      return `<c r="${ref}" s="1"><v>${cell.dateSerial}</v></c>`;
    }
    if (typeof cell === 'object' && 'formula' in cell) {
      // A formula cell with a cached result. The reader must take the cached
      // value and never look at the expression.
      return `<c r="${ref}" t="str"><f>${escapeXml(cell.formula)}</f><v>${escapeXml(cell.cached)}</v></c>`;
    }
    if (cell.length === 0) return `<c r="${ref}"/>`;

    if (options.inlineStrings === true) {
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
    }
    let index = sharedIndex.get(cell);
    if (index === undefined) {
      index = shared.length;
      shared.push(cell);
      sharedIndex.set(cell, index);
    }
    return `<c r="${ref}" t="s"><v>${index}</v></c>`;
  };

  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row.map((cell, columnIndex) => cellXml(cell, rowIndex, columnIndex)).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  const sheetXml =
    options.sheetXmlOverride ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>${rowXml}</sheetData></worksheet>`;

  const sharedXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join('') +
    `</sst>`;

  const parts: ZipInput[] = [
    {
      name: '[Content_Types].xml',
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `</Types>`,
    },
    {
      name: '_rels/.rels',
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${escapeXml(options.sheetName ?? 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
    { name: 'xl/sharedStrings.xml', content: sharedXml },
    ...(options.extraParts ?? []),
  ];

  return buildZip(parts);
}

/**
 * A decompression bomb: a small archive whose declared and actual expansion are
 * both enormous. Real, not simulated — the bytes really do inflate.
 */
export function buildZipBomb(uncompressedBytes = 400 * 1024 * 1024): Uint8Array {
  const zeros = new Uint8Array(uncompressedBytes);
  return buildZip([
    { name: 'xl/worksheets/sheet1.xml', content: zeros, method: 8 },
    { name: 'xl/workbook.xml', content: '<workbook/>' },
  ]);
}

// ── XLS (BIFF8 in an OLE2 container) ────────────────────────────────────────

const SECTOR_SIZE = 512;

class BiffWriter {
  private readonly parts: Uint8Array[] = [];

  record(id: number, payload: Uint8Array): void {
    const header = new Uint8Array(4);
    const view = new DataView(header.buffer);
    view.setUint16(0, id, true);
    view.setUint16(2, payload.length, true);
    this.parts.push(header, payload);
  }

  bytes(): Uint8Array {
    return concat(this.parts);
  }
}

function shortUnicode(value: string): Uint8Array {
  // 16-bit characters, so any Unicode in a fixture round-trips.
  const out = new Uint8Array(3 + value.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, value.length, true);
  out[2] = 0x01;
  for (let i = 0; i < value.length; i += 1) view.setUint16(3 + i * 2, value.charCodeAt(i), true);
  return out;
}

/** Builds a legacy .xls with a shared string table and LABELSST cells. */
export function buildXls(rows: readonly (readonly (string | number)[])[]): Uint8Array {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  for (const row of rows) {
    for (const cell of row) {
      if (typeof cell !== 'string' || cell.length === 0) continue;
      if (!stringIndex.has(cell)) {
        stringIndex.set(cell, strings.length);
        strings.push(cell);
      }
    }
  }

  const globals = new BiffWriter();
  const bof = new Uint8Array(16);
  const bofView = new DataView(bof.buffer);
  bofView.setUint16(0, 0x0600, true); // BIFF8
  bofView.setUint16(2, 0x0005, true); // workbook globals
  globals.record(0x0809, bof);

  // SST
  const sstParts: Uint8Array[] = [];
  const sstHeader = new Uint8Array(8);
  const sstHeaderView = new DataView(sstHeader.buffer);
  sstHeaderView.setUint32(0, strings.length, true);
  sstHeaderView.setUint32(4, strings.length, true);
  sstParts.push(sstHeader);
  for (const value of strings) sstParts.push(shortUnicode(value));
  globals.record(0x00fc, concat(sstParts));
  globals.record(0x000a, new Uint8Array(0)); // EOF

  const sheet = new BiffWriter();
  const sheetBof = new Uint8Array(16);
  const sheetBofView = new DataView(sheetBof.buffer);
  sheetBofView.setUint16(0, 0x0600, true);
  sheetBofView.setUint16(2, 0x0010, true); // worksheet
  sheet.record(0x0809, sheetBof);

  rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (typeof cell === 'number') {
        const payload = new Uint8Array(14);
        const view = new DataView(payload.buffer);
        view.setUint16(0, rowIndex, true);
        view.setUint16(2, columnIndex, true);
        view.setUint16(4, 0, true);
        view.setFloat64(6, cell, true);
        sheet.record(0x0203, payload); // NUMBER
        return;
      }
      if (cell.length === 0) return;
      const payload = new Uint8Array(10);
      const view = new DataView(payload.buffer);
      view.setUint16(0, rowIndex, true);
      view.setUint16(2, columnIndex, true);
      view.setUint16(4, 0, true);
      view.setUint32(6, stringIndex.get(cell) ?? 0, true);
      sheet.record(0x00fd, payload); // LABELSST
    });
  });
  sheet.record(0x000a, new Uint8Array(0));

  return wrapInOle2(concat([globals.bytes(), sheet.bytes()]));
}

/**
 * Wraps a byte stream in a single-stream OLE2 compound file named `Workbook`.
 *
 * Laid out so the stream is always above the mini-stream cutoff and therefore
 * lives in the FAT chain, which keeps the fixture builder to one code path.
 */
export function wrapInOle2(stream: Uint8Array, streamName = 'Workbook'): Uint8Array {
  // Pad the stream past the 4096-byte mini-stream cutoff.
  const padded =
    stream.length >= 4096
      ? stream
      : concat([stream, new Uint8Array(4096 - stream.length)]);
  const declaredSize = stream.length >= 4096 ? stream.length : 4096;

  const streamSectors = Math.ceil(padded.length / SECTOR_SIZE);

  // Layout: [0] FAT, [1] directory, [2..] stream data.
  const directorySector = 1;
  const firstStreamSector = 2;
  const totalSectors = firstStreamSector + streamSectors;

  const fat = new Uint32Array(SECTOR_SIZE / 4).fill(0xffffffff);
  fat[0] = 0xfffffffd; // this sector holds the FAT
  fat[1] = 0xfffffffe; // directory: single sector, end of chain
  for (let i = 0; i < streamSectors; i += 1) {
    fat[firstStreamSector + i] =
      i === streamSectors - 1 ? 0xfffffffe : firstStreamSector + i + 1;
  }

  const header = new Uint8Array(SECTOR_SIZE);
  const headerView = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  headerView.setUint16(24, 0x003e, true); // minor version
  headerView.setUint16(26, 0x0003, true); // major version
  headerView.setUint16(28, 0xfffe, true); // little-endian marker
  headerView.setUint16(30, 9, true); // sector shift → 512
  headerView.setUint16(32, 6, true); // mini sector shift → 64
  headerView.setUint32(44, 1, true); // one FAT sector
  headerView.setUint32(48, directorySector, true);
  headerView.setUint32(56, 4096, true); // mini stream cutoff
  headerView.setUint32(60, 0xfffffffe, true); // no mini FAT
  headerView.setUint32(64, 0, true);
  headerView.setUint32(68, 0xfffffffe, true); // no DIFAT chain
  headerView.setUint32(72, 0, true);
  headerView.setUint32(76, 0, true); // DIFAT[0] → FAT sector 0
  for (let i = 1; i < 109; i += 1) headerView.setUint32(76 + i * 4, 0xffffffff, true);

  const fatSector = new Uint8Array(fat.buffer.slice(0));

  const directory = new Uint8Array(SECTOR_SIZE);
  const directoryView = new DataView(directory.buffer);
  const writeEntry = (
    slot: number,
    name: string,
    type: number,
    start: number,
    size: number,
  ): void => {
    const base = slot * 128;
    for (let i = 0; i < name.length; i += 1) {
      directoryView.setUint16(base + i * 2, name.charCodeAt(i), true);
    }
    directoryView.setUint16(base + 64, (name.length + 1) * 2, true);
    directory[base + 66] = type;
    directory[base + 67] = 1; // black
    directoryView.setUint32(base + 68, 0xffffffff, true); // left sibling
    directoryView.setUint32(base + 72, 0xffffffff, true); // right sibling
    directoryView.setUint32(base + 76, type === 5 ? 1 : 0xffffffff, true); // child
    directoryView.setUint32(base + 116, start, true);
    directoryView.setUint32(base + 120, size, true);
  };
  writeEntry(0, 'Root Entry', 5, 0xfffffffe, 0);
  writeEntry(1, streamName, 2, firstStreamSector, declaredSize);

  const data = new Uint8Array(streamSectors * SECTOR_SIZE);
  data.set(padded.subarray(0, data.length), 0);

  const out = new Uint8Array(SECTOR_SIZE + totalSectors * SECTOR_SIZE);
  out.set(header, 0);
  out.set(fatSector, SECTOR_SIZE);
  out.set(directory, SECTOR_SIZE * (1 + directorySector));
  out.set(data, SECTOR_SIZE * (1 + firstStreamSector));
  return out;
}
