/**
 * Upload validation and format routing.
 *
 * Every uploaded file is hostile input (ARCHITECTURE §20.3). Three things are
 * attacker-controlled and none of them decides anything: the filename, the
 * declared content type, and the extension. What routes the parser is the magic
 * bytes, and where those are absent (CSV has none) the file must decode as text
 * before it is accepted.
 */

import {
  ACCEPTED_CONTENT_TYPES,
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  type ImportFormat,
} from './constants';

export type FileRejection =
  | 'empty'
  | 'too_large'
  | 'unsupported_extension'
  | 'unsupported_content_type'
  | 'unsupported_content'
  | 'content_mismatch'
  | 'binary_content';

export type FileCheck =
  | { ok: true; format: ImportFormat }
  | { ok: false; reason: FileRejection; message: string };

export const FILE_REJECTION_MESSAGE: Record<FileRejection, string> = {
  empty: 'That file is empty.',
  too_large: `Files must be ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`,
  unsupported_extension: 'Upload a .csv, .tsv, .xlsx or .xls file.',
  unsupported_content_type: 'That file type is not supported.',
  unsupported_content: 'That file is not a spreadsheet or CSV we can read.',
  content_mismatch: 'That file’s contents do not match its extension.',
  binary_content: 'That file looks like binary data, not a spreadsheet.',
};

function reject(reason: FileRejection): FileCheck {
  return { ok: false, reason, message: FILE_REJECTION_MESSAGE[reason] };
}

/**
 * Magic byte signatures (§20.3).
 *
 * ZIP means "an OOXML container, probably xlsx"; OLE2 means "a compound file,
 * probably legacy xls". Both are containers shared with other formats, so
 * matching one is a routing decision, not a guarantee — the reader validates the
 * internal structure and fails cleanly if the container holds something else.
 */
const SIGNATURES: ReadonlyArray<{ magic: readonly number[]; format: ImportFormat }> = [
  { magic: [0x50, 0x4b, 0x03, 0x04], format: 'xlsx' }, // ZIP local file header
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], format: 'xls' }, // OLE2 / CFBF
];

/** Signatures that are definitely NOT a spreadsheet, matched to fail early and clearly. */
const HOSTILE_SIGNATURES: ReadonlyArray<{ magic: readonly number[]; label: string }> = [
  { magic: [0x4d, 0x5a], label: 'windows executable' },
  { magic: [0x7f, 0x45, 0x4c, 0x46], label: 'elf executable' },
  { magic: [0x25, 0x50, 0x44, 0x46], label: 'pdf' },
  { magic: [0x1f, 0x8b], label: 'gzip' },
  { magic: [0x89, 0x50, 0x4e, 0x47], label: 'png' },
  { magic: [0xff, 0xd8, 0xff], label: 'jpeg' },
  { magic: [0x37, 0x7a, 0xbc, 0xaf], label: '7z' },
  { magic: [0x52, 0x61, 0x72, 0x21], label: 'rar' },
];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/** Lowercased extension including the dot, or '' when there is none. */
export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Strips a filename down to something safe to store and display.
 *
 * The result is never used to build a storage key — keys are derived from
 * server-generated ids — but it is echoed back to the user and written to the
 * database, so path separators, control characters and traversal sequences come
 * out here rather than being trusted anywhere downstream.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(CONTROL_CHARACTERS, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const bounded = cleaned.slice(0, 120);
  return bounded.length === 0 ? 'upload' : bounded;
}

/** Written as an escaped RegExp so no literal control byte appears in source. */
const CONTROL_CHARACTERS = new RegExp('[\u0000-\u001F\u007F]', 'g');

/**
 * Phase 1 — the claim, before a byte has been uploaded.
 *
 * Checks only what the browser asserts, so an oversized or obviously wrong file
 * is refused before it occupies a signed URL or a byte of storage (§20.3:
 * "reject oversized files before parsing").
 */
export function checkDeclaredFile(input: {
  filename: string;
  byteSize: number;
  contentType: string;
}): FileCheck {
  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0) return reject('empty');
  if (input.byteSize > MAX_UPLOAD_BYTES) return reject('too_large');

  const extension = extensionOf(input.filename);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return reject('unsupported_extension');
  }

  const declared = input.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ACCEPTED_CONTENT_TYPES.includes(declared)) {
    return reject('unsupported_content_type');
  }

  return { ok: true, format: formatForExtension(extension) };
}

function formatForExtension(extension: string): ImportFormat {
  switch (extension) {
    case '.xlsx':
      return 'xlsx';
    case '.xls':
      return 'xls';
    case '.tsv':
      return 'tsv';
    default:
      return 'csv';
  }
}

/**
 * Phase 2 — the bytes, after upload and before parsing.
 *
 * This is the check that matters. The extension is consulted only to detect the
 * *disagreement* between what the file claims to be and what it is: a .csv whose
 * first bytes are a ZIP header is not a CSV, and treating it as one hands a
 * spreadsheet container to a text parser.
 */
export function checkFileContent(input: {
  filename: string;
  bytes: Uint8Array;
  byteSize?: number;
}): FileCheck {
  const { bytes } = input;
  const size = input.byteSize ?? bytes.length;

  if (size <= 0 || bytes.length === 0) return reject('empty');
  if (size > MAX_UPLOAD_BYTES) return reject('too_large');

  const extension = extensionOf(input.filename);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return reject('unsupported_extension');
  }
  const claimed = formatForExtension(extension);

  for (const signature of SIGNATURES) {
    if (!startsWith(bytes, signature.magic)) continue;
    // A binary container whose extension says text, or vice versa, is refused
    // rather than silently re-routed: the mismatch itself is the signal.
    if (signature.format !== claimed) return reject('content_mismatch');
    return { ok: true, format: signature.format };
  }

  // No spreadsheet signature. A binary container extension therefore lied.
  if (claimed === 'xlsx' || claimed === 'xls') return reject('content_mismatch');

  for (const hostile of HOSTILE_SIGNATURES) {
    if (startsWith(bytes, hostile.magic)) return reject('unsupported_content');
  }

  if (!looksLikeText(bytes)) return reject('binary_content');

  return { ok: true, format: claimed };
}

/**
 * Heuristic text test over the leading bytes.
 *
 * NUL is the reliable tell — no text encoding this importer accepts emits one —
 * and a high proportion of other control bytes means the file is not delimited
 * text whatever its extension says.
 */
export function looksLikeText(bytes: Uint8Array, sampleSize = 8192): boolean {
  const limit = Math.min(bytes.length, sampleSize);
  let suspicious = 0;

  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i];
    if (byte === undefined) break;
    if (byte === 0x00) return false;
    // Tab, LF, CR and FF are legitimate in delimited text.
    const isAllowedControl = byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d;
    if (byte < 0x20 && !isAllowedControl) suspicious += 1;
  }

  return suspicious * 100 <= limit;
}
