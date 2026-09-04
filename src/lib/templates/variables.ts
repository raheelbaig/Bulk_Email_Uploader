/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PERSONALIZATION VOCABULARY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The complete, closed set of things a template may substitute. Nothing else in
 * the codebase decides what `{{first_name}}` means or whether it is allowed.
 *
 * ── Why a whitelist rather than a template language ───────────────────────
 *
 * A general template engine — Handlebars, Liquid, anything with expressions —
 * evaluates code that a workspace member wrote, on the server, with whatever
 * that process can reach. Server-side template injection is one of the shortest
 * paths from "a user typed something in a textarea" to "a user read the service
 * role key" that exists in this class of product.
 *
 * So there is no expression evaluator here, and no way to add one without
 * deleting this file. A variable is a *name* looked up in a flat map of strings.
 * `{{#if}}`, `{{{raw}}}`, `{% for %}` and `${...}` are not features that are
 * disabled; they are syntax the parser rejects as malformed.
 *
 * ── The shape of a variable ───────────────────────────────────────────────
 *
 *   {{first_name}}       a standard field, from the contact record
 *   {{custom.plan}}      one key of `contacts.custom`, the jsonb the import
 *                        engine fills from unmapped spreadsheet columns
 *
 * Whitespace inside the braces is allowed and ignored. Anything else is not a
 * variable at all.
 *
 * Deliberately free of `server-only`: the editor validates as you type against
 * the identical list, and two lists would eventually disagree.
 */

/** The standard fields, each backed by a real column on `contacts`. */
export const STANDARD_VARIABLES = [
  'first_name',
  'last_name',
  'full_name',
  'email',
  'company',
  'website',
  'phone',
] as const;

export type StandardVariable = (typeof STANDARD_VARIABLES)[number];

/** The prefix under which one key of `contacts.custom` is addressed. */
export const CUSTOM_PREFIX = 'custom.';

/**
 * Custom keys, as the import engine constrains them
 * (`lib/imports/mapping.ts`). Repeating the shape rather than importing it keeps
 * the template engine free of a dependency on the import engine, and
 * tests/personalization.test.ts asserts the two agree.
 */
const CUSTOM_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The token, and only this token.
 *
 * `[^{}]*` inside is deliberate: it cannot span a brace, so a nested or
 * unbalanced construct never parses as a valid variable — it is reported as
 * malformed instead of being silently accepted with a surprising boundary.
 */
const TOKEN = /\{\{([^{}]*)\}\}/g;

/**
 * Constructs that resemble a variable but are not one.
 *
 * Matched separately so the reported error can say "this is not supported"
 * rather than leaving an expression sitting in the output, where a future
 * renderer might one day evaluate it.
 */
const SUSPICIOUS = [
  /\{\{\{/, // triple-brace "unescaped" output
  /\{\{\s*[#^/]/, // block helpers: {{#if}}, {{/each}}, {{^unless}}
  /\{%/, // Liquid / Jinja statements
  /\$\{/, // JavaScript template literals
  /<%/, // ERB / EJS
];

export type VariableProblem =
  | { kind: 'unknown'; name: string }
  | { kind: 'malformed'; token: string }
  | { kind: 'unsupported_syntax'; token: string };

export interface VariableScan {
  /** Distinct, valid, whitelisted names, in first-appearance order. */
  names: string[];
  problems: VariableProblem[];
}

export function isStandardVariable(name: string): name is StandardVariable {
  return (STANDARD_VARIABLES as readonly string[]).includes(name);
}

export function isCustomVariable(name: string): boolean {
  return name.startsWith(CUSTOM_PREFIX) && CUSTOM_KEY.test(name.slice(CUSTOM_PREFIX.length));
}

/** The single definition of "this variable may be used". */
export function isAllowedVariable(name: string): boolean {
  return isStandardVariable(name) || isCustomVariable(name);
}

/**
 * Finds every variable-shaped token in a string and classifies it.
 *
 * Never throws and never rewrites: callers decide what to do with the problems.
 * `scanVariables` is the only place that reads template syntax, so the subject,
 * the preview text, the HTML body and the plain-text body are all understood
 * identically.
 */
export function scanVariables(source: string): VariableScan {
  const names: string[] = [];
  const seen = new Set<string>();
  const problems: VariableProblem[] = [];
  const reported = new Set<string>();

  for (const pattern of SUSPICIOUS) {
    const match = pattern.exec(source);
    if (match !== null) {
      problems.push({ kind: 'unsupported_syntax', token: match[0] });
    }
  }

  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(source)) !== null) {
    const raw = match[1] ?? '';
    const name = raw.trim();

    if (name.length === 0 || /\s/.test(name)) {
      if (!reported.has(match[0])) {
        reported.add(match[0]);
        problems.push({ kind: 'malformed', token: match[0] });
      }
      continue;
    }

    if (!isAllowedVariable(name)) {
      if (!reported.has(name)) {
        reported.add(name);
        problems.push(
          /^[a-z][a-z0-9_.]*$/.test(name)
            ? { kind: 'unknown', name }
            : { kind: 'malformed', token: match[0] },
        );
      }
      continue;
    }

    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  return { names, problems };
}

/** Scans several strings as one template. Order of `names` follows the inputs. */
export function scanTemplateVariables(parts: {
  subject: string;
  previewText?: string | null;
  html: string;
  text: string;
}): VariableScan {
  const sources = [parts.subject, parts.previewText ?? '', parts.html, parts.text];

  const names: string[] = [];
  const seen = new Set<string>();
  const problems: VariableProblem[] = [];
  const reported = new Set<string>();

  for (const source of sources) {
    const scan = scanVariables(source);
    for (const name of scan.names) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    for (const problem of scan.problems) {
      const key = problem.kind === 'unknown' ? `unknown:${problem.name}` : `${problem.kind}:${problem.token}`;
      if (!reported.has(key)) {
        reported.add(key);
        problems.push(problem);
      }
    }
  }

  return { names, problems };
}

/** User-safe explanations. One sentence, and it says what to do. */
export function describeVariableProblem(problem: VariableProblem): string {
  switch (problem.kind) {
    case 'unknown':
      return `{{${problem.name}}} is not an available field. Use one of: ${STANDARD_VARIABLES.join(', ')}, or custom.<field>.`;
    case 'malformed':
      return `${problem.token} is not a valid personalization tag. Tags look like {{first_name}}.`;
    case 'unsupported_syntax':
      return `${problem.token} is not supported. Templates substitute field names only — they cannot contain logic or expressions.`;
  }
}

/** A short label for each standard variable, for the editor's field picker. */
export const VARIABLE_LABEL: Record<StandardVariable, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  full_name: 'Full name',
  email: 'Email address',
  company: 'Company',
  website: 'Website',
  phone: 'Phone',
};
