/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PERSONALIZATION RENDERER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Substitutes whitelisted variables into a template. There is nothing else to
 * it, and that is the design: see `./variables.ts` for why this is a lookup
 * rather than a template language.
 *
 * ── The three properties that matter ─────────────────────────────────────
 *
 *   1. Single pass. A substituted value is never re-scanned, so a contact whose
 *      company is literally `{{email}}` gets the text `{{email}}`, not their
 *      address. Substitution that feeds its own output back is the whole of
 *      template injection.
 *
 *   2. Context-correct escaping. Into HTML, values are HTML-escaped. Into the
 *      subject, control characters are stripped, because a newline in a subject
 *      is header injection when P5 composes the message. Into the text body,
 *      values go in as they are.
 *
 *   3. Re-sanitised output. After substitution the HTML is run through the
 *      sanitiser again. The first pass judged markup that did not yet contain
 *      the value; `<a href="{{website}}">` is a safe relative URL until
 *      `website` turns out to be `javascript:alert(1)`. The second pass judges
 *      what will actually be rendered.
 *
 * An unknown variable is an error, never a silent empty string. A template that
 * quietly drops `{{frist_name}}` sends "Hello ," to the whole list.
 *
 * Deliberately free of `server-only`: pure, so the preview, the editor and — in
 * P5 — the worker all reach the identical output from the identical inputs.
 */

import { sanitizeHtml, escapeText } from './sanitize';
import {
  CUSTOM_PREFIX,
  describeVariableProblem,
  isAllowedVariable,
  scanVariables,
  type VariableProblem,
} from './variables';

/** The values one recipient supplies, keyed by variable name. */
export type VariableValues = Readonly<Record<string, string | null | undefined>>;

export type RenderTarget = 'html' | 'text' | 'subject';

export interface RenderIssue {
  code: 'unknown_variable' | 'malformed_variable' | 'unsupported_syntax';
  message: string;
}

export interface RenderOutcome {
  output: string;
  /** Known variables that resolved to nothing. Not an error — see below. */
  missing: string[];
  issues: RenderIssue[];
}

/**
 * A known variable with no value renders as an empty string and is *reported*.
 *
 * Not an error: a contact with no company is ordinary, and refusing to render
 * would make the campaign undeliverable for one incomplete row. Not silent
 * either: the preview shows which fields are empty, so "Hello ," is discovered
 * before the send rather than after.
 */
export function renderString(
  source: string,
  values: VariableValues,
  target: RenderTarget,
): RenderOutcome {
  const scan = scanVariables(source);
  const issues = scan.problems.map(toIssue);
  const missing: string[] = [];

  const output = source.replace(/\{\{([^{}]*)\}\}/g, (token, raw: string) => {
    const name = raw.trim();
    // Anything the scan flagged is left exactly as written. Substituting a value
    // for a token we could not understand would hide the problem the issues list
    // is reporting.
    if (name.length === 0 || /\s/.test(name) || !isAllowedVariable(name)) return token;

    const value = values[name];
    if (value === null || value === undefined || value === '') {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return encodeFor(value, target);
  });

  return { output, missing, issues };
}

function toIssue(problem: VariableProblem): RenderIssue {
  const message = describeVariableProblem(problem);
  switch (problem.kind) {
    case 'unknown':
      return { code: 'unknown_variable', message };
    case 'malformed':
      return { code: 'malformed_variable', message };
    case 'unsupported_syntax':
      return { code: 'unsupported_syntax', message };
  }
}

/**
 * Encodes one value for the place it is going.
 *
 * The subject case is the one worth reading twice. Control characters are
 * removed rather than escaped, because there is no escaping in a mail header:
 * a CR or LF in a subject *is* a new header. `sender_identities.from_name`
 * refuses them at the column for the same reason (migration 0008).
 */
function encodeFor(value: string, target: RenderTarget): string {
  switch (target) {
    case 'html':
      return escapeText(value);
    case 'subject':
      return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
    case 'text':
      return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  }
}

export interface RenderableTemplate {
  subject: string;
  previewText: string | null;
  html: string;
  text: string;
}

export interface RenderedMessage {
  subject: string;
  previewText: string | null;
  html: string;
  text: string;
  /** Distinct known variables that had no value, across every part. */
  missing: string[];
  /** Empty when the render is sound. Non-empty means do not send this. */
  issues: RenderIssue[];
}

/**
 * Renders a whole template for one recipient.
 *
 * The HTML result is sanitised again after substitution — property 3 above.
 * That second pass is not a formality: it is the only thing standing between a
 * contact field and an attribute that takes a URL.
 */
export function renderTemplate(
  template: RenderableTemplate,
  values: VariableValues,
): RenderedMessage {
  const subject = renderString(template.subject, values, 'subject');
  const previewText =
    template.previewText === null ? null : renderString(template.previewText, values, 'subject');
  const html = renderString(template.html, values, 'html');
  const text = renderString(template.text, values, 'text');

  const parts = [subject, html, text, ...(previewText === null ? [] : [previewText])];

  const missing: string[] = [];
  for (const part of parts) {
    for (const name of part.missing) if (!missing.includes(name)) missing.push(name);
  }

  const issues: RenderIssue[] = [];
  for (const part of parts) {
    for (const issue of part.issues) {
      if (!issues.some((existing) => existing.message === issue.message)) issues.push(issue);
    }
  }

  return {
    subject: subject.output,
    previewText: previewText === null ? null : previewText.output,
    html: sanitizeHtml(html.output).html,
    text: text.output,
    missing,
    issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contacts → values
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of a contact personalization can see. Nothing else is reachable. */
export interface PersonalizationSource {
  email_normalized: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  custom: Record<string, unknown>;
}

/** Bound on one substituted value, so a hostile custom field cannot inflate a message. */
const MAX_VALUE_CHARS = 500;

/**
 * Projects a contact into the variable map.
 *
 * Only the fields named here are reachable from a template. A contact record
 * carries an id, a workspace id, a status and an import id as well; none of them
 * is anyone's business in a message body, and the way to keep it that way is a
 * projection rather than a filter.
 *
 * `custom` values are coerced to strings and truncated. The jsonb column holds
 * whatever the import engine mapped into it, which is bounded but not typed.
 */
export function contactVariableValues(contact: PersonalizationSource): VariableValues {
  const values: Record<string, string | null> = {
    first_name: contact.first_name,
    last_name: contact.last_name,
    full_name: [contact.first_name, contact.last_name].filter((p) => p !== null && p !== '').join(' ') || null,
    email: contact.email_normalized,
    company: contact.company,
    website: contact.website,
    phone: contact.phone,
  };

  for (const [key, raw] of Object.entries(contact.custom ?? {})) {
    const name = `${CUSTOM_PREFIX}${key}`;
    if (!isAllowedVariable(name)) continue;
    values[name] = coerce(raw);
  }

  return values;
}

function coerce(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, MAX_VALUE_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects and arrays are not text. Rendering `[object Object]` into a message
  // is worse than rendering nothing.
  return null;
}

/**
 * The stand-in used when no contact is selected.
 *
 * Deliberately obvious placeholder data: someone reviewing a preview must never
 * mistake sample output for a real recipient's, and a realistic-looking fake
 * name is exactly how that mistake happens.
 */
export const SAMPLE_CONTACT: PersonalizationSource = {
  email_normalized: 'sample.recipient@example.com',
  first_name: 'Sample',
  last_name: 'Recipient',
  company: 'Example Ltd',
  website: 'https://example.com',
  phone: '+1 555 0100',
  custom: {},
};
