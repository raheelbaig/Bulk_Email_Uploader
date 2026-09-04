/**
 * A minimal, defensive ZIP reader for XLSX containers.
 *
 * XLSX is a zip archive, which makes every XLSX upload a decompression bomb
 * candidate (ARCHITECTURE §20.3). This reader exists rather than a dependency
 * because the guard has to be *inside* the extraction, not wrapped around it:
 *
 *   - The declared uncompressed size is checked before inflating.
 *   - `maxOutputLength` bounds the inflate itself, so a header that lies about
 *     its size still cannot allocate more than the cap. This is the check that
 *     matters — the other two are cheap early exits.
 *   - The total across all entries is bounded, so a thousand small bombs are
 *     caught as well as one large one.
 *   - The compression ratio is bounded, which catches the classic
 *     42.zip shape that satisfies every individual limit.
 *
 * Only the entries the reader asks for are ever inflated. A workbook's images,
 * macros (`vbaProject.bin`), embedded objects and external-link parts are listed
 * and ignored: nothing outside the four parts XLSX reading needs is decompressed
 * at all, let alone executed.
 */

import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  readonly kind: 'malformed' | 'bomb' | 'unsupported';
  constructor(kind: 'malformed' | 'bomb' | 'unsupported', message: string) {
    super(message);
    this.name = 'ZipError';
    this.kind = kind;
  }
}

export interface ZipLimits {
  /** Bytes any single entry may inflate to. */
  maxEntryBytes: number;
  /** Bytes the whole archive may inflate to. */
  maxTotalBytes: number;
  /** Uncompressed ÷ compressed, above which the archive is treated as a bomb. */
  maxRatio: number;
  /** Entries the central directory may declare. */
  maxEntries: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  // A worksheet's XML is far larger than the file it came from; 100,000 rows of
  // sheet XML runs to tens of megabytes. These are generous but finite.
  maxEntryBytes: 120 * 1024 * 1024,
  maxTotalBytes: 240 * 1024 * 1024,
  maxRatio: 300,
  maxEntries: 1024,
};

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

const SIGNATURE_EOCD = 0x06054b50;
const SIGNATURE_EOCD64_LOCATOR = 0x07064b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * The reader.
 *
 * Parses only the central directory up front — a few hundred bytes per entry —
 * and inflates lazily, so opening an archive costs nothing proportional to its
 * contents.
 */
export class ZipArchive {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly limits: ZipLimits;
  private readonly entries = new Map<string, ZipEntry>();
  private inflatedTotal = 0;

  private constructor(bytes: Uint8Array, limits: ZipLimits) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.limits = limits;
  }

  static open(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
    const archive = new ZipArchive(bytes, limits);
    archive.readCentralDirectory();
    return archive;
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  entry(name: string): ZipEntry | undefined {
    return this.entries.get(name);
  }

  /** Declared totals, checked before anything is inflated. */
  declaredTotals(): { compressed: number; uncompressed: number; ratio: number } {
    let compressed = 0;
    let uncompressed = 0;
    for (const entry of this.entries.values()) {
      compressed += entry.compressedSize;
      uncompressed += entry.uncompressedSize;
    }
    const ratio = compressed === 0 ? (uncompressed === 0 ? 1 : Infinity) : uncompressed / compressed;
    return { compressed, uncompressed, ratio };
  }

  /** Reads one entry as UTF-8 text, or undefined when it is absent. */
  readText(name: string): string | undefined {
    const raw = this.read(name);
    if (raw === undefined) return undefined;
    return new TextDecoder('utf-8').decode(raw);
  }

  read(name: string): Uint8Array | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;

    if (entry.uncompressedSize > this.limits.maxEntryBytes) {
      throw new ZipError('bomb', 'A part of this spreadsheet is too large to read safely.');
    }
    if (this.inflatedTotal + entry.uncompressedSize > this.limits.maxTotalBytes) {
      throw new ZipError('bomb', 'This spreadsheet expands to more data than can be read safely.');
    }

    const data = this.rawDataFor(entry);

    if (entry.compressionMethod === METHOD_STORE) {
      this.inflatedTotal += data.length;
      return data;
    }
    if (entry.compressionMethod !== METHOD_DEFLATE) {
      throw new ZipError('unsupported', 'This spreadsheet uses a compression method we cannot read.');
    }

    let inflated: Buffer;
    try {
      // The real guard. A local header claiming 1 KB that expands to 10 GB is
      // stopped here, by the decompressor, rather than by trusting the header.
      inflated = inflateRawSync(data, { maxOutputLength: this.limits.maxEntryBytes });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      if (/maxOutputLength|buffer/i.test(message)) {
        throw new ZipError('bomb', 'This spreadsheet expands to more data than can be read safely.');
      }
      throw new ZipError('malformed', 'This spreadsheet could not be read — the file may be corrupt.');
    }

    this.inflatedTotal += inflated.length;
    if (this.inflatedTotal > this.limits.maxTotalBytes) {
      throw new ZipError('bomb', 'This spreadsheet expands to more data than can be read safely.');
    }

    return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  }

  /**
   * Locates the entry's payload through its *local* header.
   *
   * The central directory and the local header can disagree about the extra
   * field's length; the local header is authoritative for where data begins, and
   * reading the central directory's idea of it is a classic source of off-by-N
   * corruption.
   */
  private rawDataFor(entry: ZipEntry): Uint8Array {
    const offset = entry.localHeaderOffset;
    if (offset + 30 > this.bytes.length) {
      throw new ZipError('malformed', 'This spreadsheet is truncated or corrupt.');
    }
    if (u32(this.view, offset) !== SIGNATURE_LOCAL) {
      throw new ZipError('malformed', 'This spreadsheet is not a valid workbook file.');
    }
    const nameLength = u16(this.view, offset + 26);
    const extraLength = u16(this.view, offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;

    if (end > this.bytes.length || start > end) {
      throw new ZipError('malformed', 'This spreadsheet is truncated or corrupt.');
    }
    return this.bytes.subarray(start, end);
  }

  private readCentralDirectory(): void {
    const eocd = this.findEocd();

    const entryCount = u16(this.view, eocd + 10);
    const directorySize = u32(this.view, eocd + 12);
    const directoryOffset = u32(this.view, eocd + 16);

    // ZIP64 archives are rejected rather than half-supported. A 25 MB upload
    // cannot legitimately need them, so one is a signal, not a spreadsheet.
    if (directoryOffset === 0xffffffff || entryCount === 0xffff) {
      throw new ZipError('unsupported', 'This spreadsheet uses a ZIP64 container we do not read.');
    }
    if (entryCount > this.limits.maxEntries) {
      throw new ZipError('bomb', 'This spreadsheet contains too many internal parts.');
    }
    if (directoryOffset + directorySize > this.bytes.length) {
      throw new ZipError('malformed', 'This spreadsheet is truncated or corrupt.');
    }

    let offset = directoryOffset;
    for (let i = 0; i < entryCount; i += 1) {
      if (offset + 46 > this.bytes.length) {
        throw new ZipError('malformed', 'This spreadsheet is truncated or corrupt.');
      }
      if (u32(this.view, offset) !== SIGNATURE_CENTRAL) {
        throw new ZipError('malformed', 'This spreadsheet is not a valid workbook file.');
      }

      const compressionMethod = u16(this.view, offset + 10);
      const compressedSize = u32(this.view, offset + 20);
      const uncompressedSize = u32(this.view, offset + 24);
      const nameLength = u16(this.view, offset + 28);
      const extraLength = u16(this.view, offset + 30);
      const commentLength = u16(this.view, offset + 32);
      const localHeaderOffset = u32(this.view, offset + 42);

      const nameBytes = this.bytes.subarray(offset + 46, offset + 46 + nameLength);
      const name = new TextDecoder('utf-8').decode(nameBytes);

      // Absolute paths and traversal never appear in a real OOXML package, and
      // nothing here writes to disk — but a part named `../../x` would still be
      // matched against expected part names, so it is refused outright.
      if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
        throw new ZipError('malformed', 'This spreadsheet contains an unsafe internal path.');
      }

      this.entries.set(name, {
        name,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        localHeaderOffset,
      });

      offset += 46 + nameLength + extraLength + commentLength;
    }

    const totals = this.declaredTotals();
    if (totals.uncompressed > this.limits.maxTotalBytes) {
      throw new ZipError('bomb', 'This spreadsheet expands to more data than can be read safely.');
    }
    // The ratio check catches the shape every individual limit permits: many
    // entries, each modest, each compressing a run of identical bytes.
    if (totals.compressed > 0 && totals.ratio > this.limits.maxRatio) {
      throw new ZipError('bomb', 'This spreadsheet is compressed in a way we refuse to expand.');
    }
  }

  private findEocd(): number {
    // The EOCD is at the end unless there is an archive comment, which may be up
    // to 64 KB. Scanning backwards over that window is the only way to find it.
    const minimum = 22;
    if (this.bytes.length < minimum) {
      throw new ZipError('malformed', 'This file is too small to be a workbook.');
    }
    const earliest = Math.max(0, this.bytes.length - (0xffff + minimum));
    for (let offset = this.bytes.length - minimum; offset >= earliest; offset -= 1) {
      if (u32(this.view, offset) === SIGNATURE_EOCD) {
        if (offset >= 20 && u32(this.view, offset - 20) === SIGNATURE_EOCD64_LOCATOR) {
          throw new ZipError('unsupported', 'This spreadsheet uses a ZIP64 container we do not read.');
        }
        return offset;
      }
    }
    throw new ZipError('malformed', 'This file is not a valid workbook.');
  }
}
