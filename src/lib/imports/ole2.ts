/**
 * OLE2 / Compound File Binary reader — the container legacy .xls files live in.
 *
 * Reads the directory and extracts one named stream. Nothing else: a compound
 * file can hold OLE objects, embedded executables and macro storages, and none
 * of them are read, extracted or executed. The importer asks for `Workbook` and
 * that is all it ever gets.
 *
 * Every sector walk is bounded by a visited set. A malformed or hostile file can
 * point a sector chain at itself, and an unbounded `while (next !== END)` on
 * that input never returns — which is a denial of service reachable by anyone
 * who can upload a file.
 */

export class Ole2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Ole2Error';
  }
}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const SECTOR_END = 0xfffffffe;
const SECTOR_FREE = 0xffffffff;
const SECTOR_FAT = 0xfffffffd;
const SECTOR_DIFAT = 0xfffffffc;

const DIRECTORY_ENTRY_SIZE = 128;
const ENTRY_TYPE_STREAM = 2;
const ENTRY_TYPE_ROOT = 5;

/** Bounds a single extracted stream. A .xls inside a 25 MB upload cannot exceed this. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

export interface Ole2Entry {
  name: string;
  type: number;
  startSector: number;
  size: number;
}

export class Ole2File {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniCutoff: number;
  private readonly fat: number[] = [];
  private readonly miniFat: number[] = [];
  private readonly entries: Ole2Entry[] = [];
  private miniStream: Uint8Array | null = null;

  private constructor(bytes: Uint8Array) {
    if (bytes.length < 512) throw new Ole2Error('This file is too small to be a workbook.');
    for (let i = 0; i < SIGNATURE.length; i += 1) {
      if (bytes[i] !== SIGNATURE[i]) throw new Ole2Error('This file is not a legacy workbook.');
    }

    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const sectorShift = this.view.getUint16(30, true);
    const miniSectorShift = this.view.getUint16(32, true);
    if (sectorShift < 7 || sectorShift > 16 || miniSectorShift < 2 || miniSectorShift > 12) {
      throw new Ole2Error('This workbook has an unreadable structure.');
    }
    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniSectorShift;
    this.miniCutoff = this.view.getUint32(56, true);
  }

  static open(bytes: Uint8Array): Ole2File {
    const file = new Ole2File(bytes);
    file.readFat();
    file.readDirectory();
    file.readMiniFat();
    return file;
  }

  list(): Ole2Entry[] {
    return [...this.entries];
  }

  /** The first stream matching any of the given names, case-sensitively. */
  readStream(...names: string[]): Uint8Array | undefined {
    for (const name of names) {
      const entry = this.entries.find((e) => e.name === name && e.type === ENTRY_TYPE_STREAM);
      if (entry !== undefined) return this.readEntry(entry);
    }
    return undefined;
  }

  private sectorOffset(sector: number): number {
    return 512 + sector * this.sectorSize;
  }

  private sectorBytes(sector: number): Uint8Array {
    const start = this.sectorOffset(sector);
    const end = start + this.sectorSize;
    if (start < 0 || end > this.bytes.length) {
      throw new Ole2Error('This workbook is truncated or corrupt.');
    }
    return this.bytes.subarray(start, end);
  }

  /**
   * Walks a sector chain, refusing to revisit a sector.
   *
   * The visited set is the loop guard. Without it a self-referencing chain — one
   * byte to write in a hostile file — is an infinite loop in the parser.
   */
  private chain(start: number, limit: number): number[] {
    const chain: number[] = [];
    const visited = new Set<number>();
    let sector = start;

    while (sector !== SECTOR_END && sector !== SECTOR_FREE) {
      if (sector < 0 || sector >= limit) throw new Ole2Error('This workbook is corrupt.');
      if (visited.has(sector)) throw new Ole2Error('This workbook contains a circular sector chain.');
      visited.add(sector);
      chain.push(sector);
      if (chain.length > 1_000_000) throw new Ole2Error('This workbook is too fragmented to read.');
      const next = this.fat[sector];
      if (next === undefined) break;
      sector = next;
    }
    return chain;
  }

  private readFat(): void {
    const totalSectors = Math.max(0, Math.floor((this.bytes.length - 512) / this.sectorSize));
    const fatSectorCount = this.view.getUint32(44, true);
    const difatSectorCount = this.view.getUint32(72, true);

    if (fatSectorCount > 65_536 || difatSectorCount > 65_536) {
      throw new Ole2Error('This workbook declares an implausible allocation table.');
    }

    const fatSectors: number[] = [];
    for (let i = 0; i < 109 && i < fatSectorCount; i += 1) {
      const sector = this.view.getUint32(76 + i * 4, true);
      if (sector === SECTOR_FREE || sector === SECTOR_END) break;
      fatSectors.push(sector);
    }

    // The DIFAT continues in its own sector chain when there are more than 109
    // FAT sectors — a file above roughly 7 MB with a 512-byte sector.
    let difatSector = this.view.getUint32(68, true);
    const seenDifat = new Set<number>();
    const perSector = this.sectorSize / 4;

    while (
      difatSector !== SECTOR_END &&
      difatSector !== SECTOR_FREE &&
      fatSectors.length < fatSectorCount
    ) {
      if (seenDifat.has(difatSector)) throw new Ole2Error('This workbook contains a circular DIFAT.');
      seenDifat.add(difatSector);

      const sector = this.sectorBytes(difatSector);
      const sectorView = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
      for (let i = 0; i < perSector - 1; i += 1) {
        const value = sectorView.getUint32(i * 4, true);
        if (value === SECTOR_FREE || value === SECTOR_END) break;
        fatSectors.push(value);
      }
      difatSector = sectorView.getUint32((perSector - 1) * 4, true);
    }

    for (const sector of fatSectors) {
      if (sector >= totalSectors) continue;
      const data = this.sectorBytes(sector);
      const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let i = 0; i < perSector; i += 1) {
        this.fat.push(dataView.getUint32(i * 4, true));
      }
    }

    if (this.fat.length === 0) throw new Ole2Error('This workbook has no allocation table.');
  }

  private readDirectory(): void {
    const first = this.view.getUint32(48, true);
    const sectors = this.chain(first, this.fat.length);
    const perSector = this.sectorSize / DIRECTORY_ENTRY_SIZE;

    for (const sector of sectors) {
      const data = this.sectorBytes(sector);
      const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

      for (let i = 0; i < perSector; i += 1) {
        const base = i * DIRECTORY_ENTRY_SIZE;
        const nameLength = dataView.getUint16(base + 64, true);
        const type = dataView.getUint8(base + 66);
        if (type !== ENTRY_TYPE_STREAM && type !== ENTRY_TYPE_ROOT) continue;
        if (nameLength < 2 || nameLength > 64) continue;

        let name = '';
        for (let c = 0; c < nameLength / 2 - 1; c += 1) {
          name += String.fromCharCode(dataView.getUint16(base + c * 2, true));
        }

        this.entries.push({
          name,
          type,
          startSector: dataView.getUint32(base + 116, true),
          size: dataView.getUint32(base + 120, true),
        });
      }
      if (this.entries.length > 4096) break;
    }

    if (this.entries.length === 0) throw new Ole2Error('This workbook has no directory.');
  }

  private readMiniFat(): void {
    const first = this.view.getUint32(60, true);
    if (first === SECTOR_END || first === SECTOR_FREE) return;

    const sectors = this.chain(first, this.fat.length);
    const perSector = this.sectorSize / 4;
    for (const sector of sectors) {
      const data = this.sectorBytes(sector);
      const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let i = 0; i < perSector; i += 1) this.miniFat.push(dataView.getUint32(i * 4, true));
    }

    const root = this.entries.find((e) => e.type === ENTRY_TYPE_ROOT);
    if (root !== undefined && root.size > 0) {
      this.miniStream = this.readFromFat(root.startSector, root.size);
    }
  }

  private readEntry(entry: Ole2Entry): Uint8Array {
    if (entry.size > MAX_STREAM_BYTES) {
      throw new Ole2Error('This workbook contains a stream too large to read safely.');
    }
    if (entry.size >= this.miniCutoff) return this.readFromFat(entry.startSector, entry.size);
    return this.readFromMiniFat(entry.startSector, entry.size);
  }

  private readFromFat(start: number, size: number): Uint8Array {
    const out = new Uint8Array(Math.min(size, MAX_STREAM_BYTES));
    let written = 0;
    for (const sector of this.chain(start, this.fat.length)) {
      if (written >= out.length) break;
      const data = this.sectorBytes(sector);
      const take = Math.min(data.length, out.length - written);
      out.set(data.subarray(0, take), written);
      written += take;
    }
    return out.subarray(0, written);
  }

  private readFromMiniFat(start: number, size: number): Uint8Array {
    const mini = this.miniStream;
    if (mini === null) throw new Ole2Error('This workbook is missing its mini stream.');

    const out = new Uint8Array(Math.min(size, MAX_STREAM_BYTES));
    let written = 0;
    let sector = start;
    const visited = new Set<number>();

    while (sector !== SECTOR_END && sector !== SECTOR_FREE && written < out.length) {
      if (sector < 0 || sector >= this.miniFat.length) break;
      if (visited.has(sector)) throw new Ole2Error('This workbook contains a circular sector chain.');
      visited.add(sector);

      const start_ = sector * this.miniSectorSize;
      const slice = mini.subarray(start_, start_ + this.miniSectorSize);
      const take = Math.min(slice.length, out.length - written);
      out.set(slice.subarray(0, take), written);
      written += take;

      const next = this.miniFat[sector];
      if (next === undefined) break;
      sector = next;
    }

    return out.subarray(0, written);
  }
}

export { SECTOR_END, SECTOR_FREE, SECTOR_FAT, SECTOR_DIFAT };
