/**
 * Row classification — the pure half of the import engine.
 *
 * Given a raw row and a mapping, decides which of the five buckets the row
 * belongs to and what a contact built from it would look like. No database, no
 * I/O, no clock: every decision here is a function of its inputs, which is what
 * makes the reconciliation property testable exhaustively rather than by
 * running an import and hoping.
 *
 * Two of the five buckets cannot be decided here because they need the
 * database — `duplicate` against existing contacts, and `suppressed` — so this
 * module answers everything else and hands the rest to the runner with a
 * normalized address to look them up by.
 */

import { normalizeEmail, NORMALIZE_FAILURE_MESSAGE } from '@/lib/email/normalize';
import {
  FIELD_MAX_LENGTH,
  FIELD_LABEL,
  MAX_CUSTOM_VALUE_CHARS,
  type ContactField,
  type RowBucket,
} from './constants';
import { emailColumnIndex, type ColumnMapping } from './mapping';

export interface PreparedContact {
  emailNormalized: string;
  emailRaw: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  custom: Record<string, string>;
}

export type RowOutcome =
  | { kind: 'candidate'; contact: PreparedContact }
  | { kind: 'settled'; bucket: Exclude<RowBucket, 'valid' | 'duplicate' | 'suppressed'>; reason: string };

/**
 * A compiled mapping.
 *
 * Resolved once per import rather than per row: an import of 50,000 rows would
 * otherwise re-walk the column list 50,000 times to answer the same question.
 */
export interface CompiledMapping {
  emailIndex: number;
  fields: ReadonlyArray<{ index: number; field: Exclude<ContactField, 'email'> }>;
  custom: ReadonlyArray<{ index: number; key: string }>;
  headerRow: number;
}

export function compileMapping(mapping: ColumnMapping): CompiledMapping {
  const fields: Array<{ index: number; field: Exclude<ContactField, 'email'> }> = [];
  const custom: Array<{ index: number; key: string }> = [];

  for (const column of mapping.columns) {
    if (column.target.kind === 'field' && column.target.field !== 'email') {
      fields.push({ index: column.index, field: column.target.field });
    }
    if (column.target.kind === 'custom') {
      custom.push({ index: column.index, key: column.target.key });
    }
  }

  return {
    emailIndex: emailColumnIndex(mapping),
    fields,
    custom,
    headerRow: mapping.headerRow,
  };
}

function cell(row: readonly string[], index: number): string {
  return (row[index] ?? '').trim();
}

/** True when the row carries nothing at all — a spacer line in the file. */
export function isEmptyRow(row: readonly string[]): boolean {
  return row.every((value) => value.trim().length === 0);
}

/**
 * Classifies one row.
 *
 * The order of checks is the order of the buckets' precedence, and it is
 * deliberate: a structurally unusable row is `rejected` before its email is
 * examined, because "there is no email column value here" and "the email here
 * is malformed" are different problems with different fixes.
 */
export function classifyRow(row: readonly string[], mapping: CompiledMapping): RowOutcome {
  if (mapping.emailIndex < 0) {
    return { kind: 'settled', bucket: 'rejected', reason: 'Missing mandatory email column' };
  }
  if (isEmptyRow(row)) {
    return { kind: 'settled', bucket: 'rejected', reason: 'Row is empty' };
  }

  const rawEmail = cell(row, mapping.emailIndex);
  if (rawEmail.length === 0) {
    return { kind: 'settled', bucket: 'rejected', reason: 'No email address in the email column' };
  }

  const normalized = normalizeEmail(rawEmail);
  if (!normalized.ok) {
    // The shared P1 normalizer's own reason, so the message a user sees for a
    // bad address is identical whether it arrived through a form or a file.
    return {
      kind: 'settled',
      bucket: 'invalid',
      reason: `Invalid email format — ${NORMALIZE_FAILURE_MESSAGE[normalized.reason]}`,
    };
  }

  const contact: PreparedContact = {
    emailNormalized: normalized.normalized,
    emailRaw: normalized.raw.slice(0, FIELD_MAX_LENGTH.email),
    firstName: null,
    lastName: null,
    company: null,
    website: null,
    phone: null,
    custom: {},
  };

  for (const { index, field } of mapping.fields) {
    const value = cell(row, index);
    if (value.length === 0) continue;
    if (value.length > FIELD_MAX_LENGTH[field]) {
      // Truncating would be silent data corruption and rejecting the whole
      // import would be worse; rejecting this row names the exact problem.
      return {
        kind: 'settled',
        bucket: 'rejected',
        reason: `${FIELD_LABEL[field]} is longer than ${FIELD_MAX_LENGTH[field]} characters`,
      };
    }
    contact[FIELD_TO_PROPERTY[field]] = value;
  }

  for (const { index, key } of mapping.custom) {
    const value = cell(row, index);
    if (value.length === 0) continue;
    // Values are strings, always. Nothing structured, nothing executable, and
    // nothing long enough for 24 of them to breach the 4 KB column check.
    contact.custom[key] = value.slice(0, MAX_CUSTOM_VALUE_CHARS);
  }

  return { kind: 'candidate', contact };
}

const FIELD_TO_PROPERTY: Record<
  Exclude<ContactField, 'email'>,
  'firstName' | 'lastName' | 'company' | 'website' | 'phone'
> = {
  first_name: 'firstName',
  last_name: 'lastName',
  company: 'company',
  website: 'website',
  phone: 'phone',
};

/** The wording §8 of the P2 brief fixes for each bucket. */
export const REASON = {
  duplicateInFile: (firstRow: number): string =>
    `Duplicate email inside uploaded file; first occurrence was row ${firstRow}`,
  duplicateInDatabase: 'Already a contact in this workspace; existing details were enriched',
  suppressed: 'Address exists in the workspace suppression list',
  missingEmailColumn: 'Missing mandatory email column',
} as const;

/**
 * A safe, bounded representation of the original row for the rejection record.
 *
 * Keyed by header where one exists so the CSV export is readable, truncated per
 * cell and per row so a hostile file cannot store megabytes per rejection.
 */
export function safeRawRow(
  row: readonly string[],
  headers: readonly string[],
  maxCells = 40,
  maxCellChars = 120,
): Record<string, string> {
  const out: Record<string, string> = {};
  const limit = Math.min(row.length, maxCells);
  for (let i = 0; i < limit; i += 1) {
    const value = (row[i] ?? '').slice(0, maxCellChars);
    if (value.trim().length === 0) continue;
    const header = headers[i]?.trim();
    const key = header === undefined || header.length === 0 ? `column_${i + 1}` : header.slice(0, 60);
    // Duplicate headers would collapse; suffix rather than lose a cell.
    out[key in out ? `${key} (${i + 1})` : key] = value;
  }
  return out;
}
