/**
 * Header detection and column mapping — the two-phase safety boundary.
 *
 * ARCHITECTURE §20.2: parsing stops after the header row and returns a
 * *proposal*. Nothing is written to contacts until a person has looked at
 * "Company → company" and agreed. The disaster this prevents is a file whose
 * columns are in an unexpected order silently importing surnames into the
 * company field, which is unrecoverable once it has happened at scale.
 *
 * The proposal is therefore allowed to be confident but never authoritative,
 * and a low-confidence guess is left unmapped rather than being applied
 * optimistically.
 */

import { z } from 'zod';
import {
  CONTACT_FIELDS,
  HEADER_SEARCH_ROWS,
  MAX_COLUMNS,
  MAX_CUSTOM_FIELDS,
  REQUIRED_FIELD,
  type ContactField,
} from './constants';
import { normalizeEmail } from '@/lib/email/normalize';

// ── The mapping shape ───────────────────────────────────────────────────────

export const mappingTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), field: z.enum(CONTACT_FIELDS) }),
  z.object({
    kind: z.literal('custom'),
    // Bounded and character-restricted. `contacts.custom` is jsonb, and an
    // unconstrained key is how arbitrary structure gets into it.
    key: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/, 'Custom field keys use lowercase letters, digits and underscores.'),
  }),
  z.object({ kind: z.literal('ignore') }),
]);

export type MappingTarget = z.infer<typeof mappingTargetSchema>;

export const columnMappingSchema = z.object({
  /** 0-based index of the header row within the parsed rows. */
  headerRow: z.number().int().min(0).max(HEADER_SEARCH_ROWS),
  columns: z
    .array(
      z.object({
        index: z.number().int().min(0).max(MAX_COLUMNS - 1),
        header: z.string().max(300),
        target: mappingTargetSchema,
      }),
    )
    .min(1)
    .max(MAX_COLUMNS),
});

export type ColumnMapping = z.infer<typeof columnMappingSchema>;

export type MappingProblem =
  | 'missing_email'
  | 'duplicate_field'
  | 'duplicate_custom_key'
  | 'too_many_custom'
  | 'unknown_column'
  | 'invalid_shape';

export const MAPPING_PROBLEM_MESSAGE: Record<MappingProblem, string> = {
  missing_email: 'Choose which column holds the email address. Every import needs one.',
  duplicate_field: 'Two columns are mapped to the same contact field. Each field takes one column.',
  duplicate_custom_key: 'Two columns are mapped to the same custom field name.',
  too_many_custom: `An import can add at most ${MAX_CUSTOM_FIELDS} custom fields.`,
  unknown_column: 'The mapping refers to a column that is not in this file.',
  invalid_shape: 'That mapping is not valid.',
};

export type MappingValidation =
  | { ok: true; mapping: ColumnMapping }
  | { ok: false; problem: MappingProblem; message: string };

/**
 * Validates a mapping against the file's actual columns.
 *
 * The mapping arrives from the browser, so every part of it is a claim: the
 * column count, the indices, the custom keys. None is trusted — an index that
 * does not exist in the parsed header is rejected rather than ignored, because
 * silently dropping it would import a different shape than the one confirmed.
 */
export function validateMapping(input: unknown, headers: readonly string[]): MappingValidation {
  const parsed = columnMappingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problem: 'invalid_shape', message: MAPPING_PROBLEM_MESSAGE.invalid_shape };
  }
  const mapping = parsed.data;

  const seenFields = new Set<ContactField>();
  const seenCustom = new Set<string>();
  let customCount = 0;

  for (const column of mapping.columns) {
    if (column.index >= headers.length) {
      return { ok: false, problem: 'unknown_column', message: MAPPING_PROBLEM_MESSAGE.unknown_column };
    }
    if (column.target.kind === 'field') {
      if (seenFields.has(column.target.field)) {
        return {
          ok: false,
          problem: 'duplicate_field',
          message: MAPPING_PROBLEM_MESSAGE.duplicate_field,
        };
      }
      seenFields.add(column.target.field);
    }
    if (column.target.kind === 'custom') {
      if (seenCustom.has(column.target.key)) {
        return {
          ok: false,
          problem: 'duplicate_custom_key',
          message: MAPPING_PROBLEM_MESSAGE.duplicate_custom_key,
        };
      }
      seenCustom.add(column.target.key);
      customCount += 1;
    }
  }

  if (customCount > MAX_CUSTOM_FIELDS) {
    return { ok: false, problem: 'too_many_custom', message: MAPPING_PROBLEM_MESSAGE.too_many_custom };
  }
  if (!seenFields.has(REQUIRED_FIELD)) {
    return { ok: false, problem: 'missing_email', message: MAPPING_PROBLEM_MESSAGE.missing_email };
  }

  return { ok: true, mapping };
}

// ── Header handling ─────────────────────────────────────────────────────────

/** Collapses a header for comparison: case, punctuation and spacing all folded. */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Makes a set of headers usable as identifiers.
 *
 * Blank headers become `column_3` (1-based, as a person counts columns) and
 * duplicates are suffixed. Both cases are common in exports and both would
 * otherwise collapse two different columns into one mapping target.
 */
export function dedupeHeaders(raw: readonly string[]): string[] {
  const used = new Map<string, number>();
  return raw.map((header, index) => {
    const trimmed = header.trim().replace(/\s+/g, ' ');
    const base = trimmed.length === 0 ? `Column ${index + 1}` : trimmed;
    const key = base.toLowerCase();
    const seen = used.get(key) ?? 0;
    used.set(key, seen + 1);
    return seen === 0 ? base : `${base} (${seen + 1})`;
  });
}

/** Derives a safe custom-field key from a header, or null when nothing survives. */
export function customKeyFor(header: string, taken: ReadonlySet<string>): string | null {
  const base = normalizeHeader(header).slice(0, 40).replace(/^[^a-z]+/, '');
  if (base.length === 0) return null;

  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const candidate = `${base}_${suffix}`.slice(0, 40);
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Synonyms, in priority order.
 *
 * An exact match on a normalized header wins; a substring match is a weaker
 * signal and is only used when nothing matched exactly. Ordering matters:
 * `first_name` must be tried before `name`, or "First Name" maps to a generic
 * name column.
 */
const FIELD_SYNONYMS: Record<ContactField, readonly string[]> = {
  email: [
    'email',
    'email_address',
    'e_mail',
    'e_mail_address',
    'mail',
    'emailaddress',
    'contact_email',
    'work_email',
    'primary_email',
    'address',
  ],
  first_name: ['first_name', 'firstname', 'first', 'given_name', 'givenname', 'forename', 'fname'],
  last_name: [
    'last_name',
    'lastname',
    'last',
    'surname',
    'family_name',
    'familyname',
    'lname',
    'second_name',
  ],
  company: [
    'company',
    'company_name',
    'organisation',
    'organization',
    'org',
    'employer',
    'business',
    'account',
    'account_name',
  ],
  website: ['website', 'web_site', 'url', 'web', 'homepage', 'site', 'domain', 'company_website'],
  phone: [
    'phone',
    'phone_number',
    'telephone',
    'tel',
    'mobile',
    'mobile_number',
    'cell',
    'cell_phone',
    'contact_number',
  ],
};

/**
 * Ambiguous names, matched only as a weak signal.
 *
 * A column called "Address" is far more often postal than electronic, and
 * "Account" is as likely an account number as a company. These are never used
 * for an exact match.
 */
const WEAK_SYNONYMS = new Set(['address', 'account', 'site', 'domain', 'web', 'first', 'last']);

/**
 * Fields whose synonyms must never include a weak name.
 *
 * Email only. Getting the email column wrong is the one mapping mistake that is
 * both silent and unrecoverable — every row is then keyed on the wrong value —
 * so it is resolved from an unambiguous header or from the data itself
 * (pass 3), never from a name that merely *might* mean an address. Every other
 * field is a display attribute the user can see is wrong and correct.
 */
const NO_WEAK_MATCH = new Set<ContactField>(['email']);

export interface ProposedColumn {
  index: number;
  header: string;
  target: MappingTarget;
  /** How the proposal was reached, so the UI can flag the guesses. */
  confidence: 'exact' | 'fuzzy' | 'sampled' | 'none';
}

export interface MappingProposal {
  headerRow: number;
  headers: string[];
  columns: ProposedColumn[];
  /** True when no column could be proposed for email; the user must choose one. */
  emailUnresolved: boolean;
}

/**
 * Chooses the header row.
 *
 * The first non-empty row is right almost always, and wrong exactly when a file
 * opens with a title or a blank spacer row — which is common in exports from
 * reporting tools. The heuristic prefers the first row within the search window
 * whose cells look like labels rather than data: mostly non-empty, mostly short,
 * and not itself full of email addresses.
 */
export function detectHeaderRow(rows: readonly (readonly string[])[]): number {
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  let bestIndex = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < limit; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const cells = row.map((cell) => cell.trim());
    const filled = cells.filter((cell) => cell.length > 0);
    if (filled.length === 0) continue;

    let score = filled.length * 2;
    // A header row fills most of its columns.
    if (filled.length === cells.length) score += 3;
    // Labels are short.
    if (filled.every((cell) => cell.length <= 40)) score += 2;
    // A row containing an actual address is data, not a header.
    if (filled.some((cell) => normalizeEmail(cell).ok)) score -= 12;
    // Labels are rarely pure numbers.
    if (filled.some((cell) => /^-?\d+([.,]\d+)?$/.test(cell))) score -= 3;
    // A row of unique values is more header-like than one with repeats.
    if (new Set(filled.map((c) => c.toLowerCase())).size === filled.length) score += 1;
    // Earlier rows win ties.
    score -= i * 0.5;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex === -1 ? 0 : bestIndex;
}

/**
 * Builds the proposal shown in Phase B.
 *
 * Unknown columns are offered as custom fields rather than discarded, but only
 * up to the cap and only with a derived, character-restricted key. Beyond the
 * cap they are proposed as `ignore`, which the user can override per column.
 */
export function proposeMapping(rows: readonly (readonly string[])[]): MappingProposal {
  const headerRow = detectHeaderRow(rows);
  const rawHeaders = [...(rows[headerRow] ?? [])].slice(0, MAX_COLUMNS);
  const headers = dedupeHeaders(rawHeaders);
  const dataRows = rows.slice(headerRow + 1);

  const claimed = new Set<ContactField>();
  const columns: ProposedColumn[] = headers.map((header, index) => ({
    index,
    header,
    target: { kind: 'ignore' } as MappingTarget,
    confidence: 'none' as const,
  }));

  const normalized = headers.map(normalizeHeader);

  // Pass 1 — exact synonym matches, strong synonyms only.
  for (const field of CONTACT_FIELDS) {
    if (claimed.has(field)) continue;
    const synonyms = FIELD_SYNONYMS[field].filter((s) => !WEAK_SYNONYMS.has(s));
    const index = normalized.findIndex(
      (header, i) => columns[i]?.confidence === 'none' && synonyms.includes(header),
    );
    if (index === -1) continue;
    const column = columns[index];
    if (column === undefined) continue;
    column.target = { kind: 'field', field };
    column.confidence = 'exact';
    claimed.add(field);
  }

  // Pass 2 — weak synonyms and substring matches.
  for (const field of CONTACT_FIELDS) {
    if (claimed.has(field)) continue;
    const synonyms = NO_WEAK_MATCH.has(field)
      ? FIELD_SYNONYMS[field].filter((s) => !WEAK_SYNONYMS.has(s))
      : FIELD_SYNONYMS[field];
    const index = normalized.findIndex((header, i) => {
      if (columns[i]?.confidence !== 'none') return false;
      if (synonyms.includes(header)) return true;
      return synonyms.some((s) => !WEAK_SYNONYMS.has(s) && s.length >= 5 && header.includes(s));
    });
    if (index === -1) continue;
    const column = columns[index];
    if (column === undefined) continue;
    column.target = { kind: 'field', field };
    column.confidence = 'fuzzy';
    claimed.add(field);
  }

  // Pass 3 — the email column by content.
  //
  // A file whose email column is headed "Contact" or "E-Mail-Adresse" is common
  // enough to be worth handling, and email is the one field where the data
  // itself is unambiguous. Only applied when the header gave nothing.
  if (!claimed.has('email')) {
    const scores = headers.map((_header, index) => {
      let hits = 0;
      let seen = 0;
      for (const row of dataRows.slice(0, 20)) {
        const cell = row[index]?.trim() ?? '';
        if (cell.length === 0) continue;
        seen += 1;
        if (normalizeEmail(cell).ok) hits += 1;
      }
      return seen === 0 ? 0 : hits / seen;
    });

    let best = -1;
    let bestScore = 0.6; // a clear majority, not a single lucky cell
    scores.forEach((score, index) => {
      if (score > bestScore && columns[index]?.confidence === 'none') {
        best = index;
        bestScore = score;
      }
    });

    if (best >= 0) {
      const column = columns[best];
      if (column !== undefined) {
        column.target = { kind: 'field', field: 'email' };
        column.confidence = 'sampled';
        claimed.add('email');
      }
    }
  }

  // Pass 4 — everything left becomes a custom field, within the cap.
  const takenKeys = new Set<string>();
  let customCount = 0;
  for (const column of columns) {
    if (column.confidence !== 'none') continue;
    if (customCount >= MAX_CUSTOM_FIELDS) break;
    const key = customKeyFor(column.header, takenKeys);
    if (key === null) continue;
    takenKeys.add(key);
    column.target = { kind: 'custom', key };
    customCount += 1;
  }

  return {
    headerRow,
    headers,
    columns,
    emailUnresolved: !claimed.has('email'),
  };
}

/** The mapping a proposal implies, ready to be confirmed or corrected. */
export function proposalToMapping(proposal: MappingProposal): ColumnMapping {
  return {
    headerRow: proposal.headerRow,
    columns: proposal.columns.map((column) => ({
      index: column.index,
      header: column.header,
      target: column.target,
    })),
  };
}

/** Index of the email column, or -1. Hot path: resolved once, not per row. */
export function emailColumnIndex(mapping: ColumnMapping): number {
  const column = mapping.columns.find(
    (c) => c.target.kind === 'field' && c.target.field === 'email',
  );
  return column?.index ?? -1;
}
