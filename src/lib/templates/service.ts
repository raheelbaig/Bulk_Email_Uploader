import 'server-only';
import { requireWorkspace } from '@/lib/auth/workspace';
import { writeAuditLog } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/errors';
import type { Cursor, Page, PageDirection } from '@/lib/pagination';
import {
  MAX_HTML_CHARS,
  MAX_PREVIEW_TEXT_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_TEMPLATE_NAME_CHARS,
  MAX_TEMPLATE_VARIABLES,
  MAX_TEXT_CHARS,
} from './constants';
import { templateRepository } from './repository';
import { sanitizeHtml, sanitizerRemovedSomething, type SanitizeReport } from './sanitize';
import { htmlToText, normalizeText } from './text';
import { describeVariableProblem, scanTemplateVariables } from './variables';
import type { TemplateRecord, TemplateRepository, TemplateWrite } from './ports';

/**
 * Templates.
 *
 * The rule this module enforces — what is stored is already safe — is enforced
 * in one direction only, deliberately: HTML is sanitised on the way *in*, never
 * on the way out. Sanitising on read means the stored value is still hostile and
 * every future reader has to remember; sanitising on write means the column
 * holds only what the allowlist produced, and a reader that forgets is still
 * safe. The preview sanitises again after personalization, because that
 * substitutes values the first pass never saw.
 *
 * Everything else here is the ordinary shape: authorise, validate, write, audit.
 */

export interface TemplateInput {
  name: unknown;
  subject: unknown;
  previewText?: unknown;
  html: unknown;
  /** Omit, or leave blank, to derive the plain-text body from the HTML. */
  text?: unknown;
}

/** A template plus what the save had to change about it. */
export interface TemplateSaveResult {
  record: TemplateRecord;
  /** True when the sanitiser removed markup the author supplied. */
  sanitized: boolean;
  report: SanitizeReport;
  /** True when the plain-text body was derived rather than supplied. */
  textGenerated: boolean;
}

const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]');

function requiredText(input: unknown, field: string, max: number): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (value.length === 0) throw new ValidationError(`Enter a ${field}.`);
  if (value.length > max) {
    throw new ValidationError(`The ${field} is limited to ${max} characters.`);
  }
  return value;
}

/**
 * A header-bound field: no control characters, at all.
 *
 * The subject and preheader end up in mail headers when P5 composes a message,
 * and a newline in a header is a new header. Refused here with a message, and
 * again by the column check in migration 0009 unconditionally.
 */
function headerText(input: unknown, field: string, max: number): string {
  const value = requiredText(input, field, max);
  if (CONTROL.test(value)) {
    throw new ValidationError(`The ${field} contains characters that are not allowed.`);
  }
  return value;
}

function optionalHeaderText(input: unknown, field: string, max: number): string | null {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw.length === 0) return null;
  return headerText(raw, field, max);
}

/**
 * Validates and normalises a template.
 *
 * Pure apart from having no I/O: the same input always yields the same stored
 * value, which is what makes `tests/templates.test.ts` able to assert what a
 * given payload becomes without a database.
 */
export function prepareTemplate(input: TemplateInput): {
  write: TemplateWrite;
  report: SanitizeReport;
  sanitized: boolean;
  textGenerated: boolean;
} {
  const name = requiredText(input.name, 'template name', MAX_TEMPLATE_NAME_CHARS);
  const subject = headerText(input.subject, 'subject line', MAX_SUBJECT_CHARS);
  const previewText = optionalHeaderText(input.previewText, 'preview text', MAX_PREVIEW_TEXT_CHARS);

  const rawHtml = typeof input.html === 'string' ? input.html : '';
  if (rawHtml.trim().length === 0) throw new ValidationError('The message body cannot be empty.');
  if (rawHtml.length > MAX_HTML_CHARS) {
    throw new ValidationError(
      `The HTML body is larger than the ${Math.round(MAX_HTML_CHARS / 1000)} KB limit.`,
    );
  }

  const sanitizedHtml = sanitizeHtml(rawHtml);
  if (sanitizedHtml.html.trim().length === 0) {
    throw new ValidationError(
      'Nothing in that message body could be kept. Scripts, embedded frames and event handlers are not allowed in a template.',
    );
  }

  const suppliedText = typeof input.text === 'string' ? input.text.trim() : '';
  const textGenerated = suppliedText.length === 0;
  const text = textGenerated ? htmlToText(sanitizedHtml.html) : normalizeText(suppliedText);

  if (text.length === 0) {
    throw new ValidationError('The plain-text version cannot be empty.');
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new ValidationError(
      `The plain-text body is larger than the ${Math.round(MAX_TEXT_CHARS / 1000)} KB limit.`,
    );
  }

  // The variables are extracted from what will be *stored*, not from what was
  // submitted: a tag inside markup the sanitiser removed is not a variable this
  // template uses, and recording it would make the preflight ask for a field the
  // message never mentions.
  const scan = scanTemplateVariables({ subject, previewText, html: sanitizedHtml.html, text });
  const firstProblem = scan.problems[0];
  if (firstProblem !== undefined) {
    throw new ValidationError(describeVariableProblem(firstProblem));
  }
  if (scan.names.length > MAX_TEMPLATE_VARIABLES) {
    throw new ValidationError(
      `A template may use at most ${MAX_TEMPLATE_VARIABLES} personalization fields.`,
    );
  }

  return {
    write: { name, subject, previewText, html: sanitizedHtml.html, text, variables: scan.names },
    report: sanitizedHtml.report,
    sanitized: sanitizerRemovedSomething(sanitizedHtml.report) || sanitizedHtml.truncated,
    textGenerated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

export async function listTemplates(
  workspaceId: string,
  options: { limit?: number; cursor?: Cursor | undefined; direction?: PageDirection } = {},
): Promise<Page<TemplateRecord>> {
  await requireWorkspace(workspaceId);
  const repository = await templateRepository(workspaceId);
  return repository.list(options);
}

/** Every template, for a picker. Bounded, never the whole table. */
export async function listTemplateOptions(workspaceId: string): Promise<TemplateRecord[]> {
  await requireWorkspace(workspaceId);
  const repository = await templateRepository(workspaceId);
  return repository.listAll();
}

export async function getTemplate(workspaceId: string, templateId: string): Promise<TemplateRecord> {
  await requireWorkspace(workspaceId);
  const repository = await templateRepository(workspaceId);

  const record = await repository.get(templateId);
  // Absent and not-yours answer identically, so a caller cannot enumerate ids.
  if (record === null) throw new ForbiddenError();
  return record;
}

export async function createTemplate(
  workspaceId: string,
  input: TemplateInput,
): Promise<TemplateSaveResult> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('template.write', access.userId, access.workspaceId);

  const prepared = prepareTemplate(input);
  const repository = await templateRepository(access.workspaceId);
  const record = await repository.insert(prepared.write);

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'template.created',
    entityType: 'template',
    entityId: record.id,
    // Never the body. ARCHITECTURE §24.4 names raw template HTML explicitly, and
    // an audit record is kept forever.
    metadata: auditShape(record, prepared.report),
  });

  return {
    record,
    sanitized: prepared.sanitized,
    report: prepared.report,
    textGenerated: prepared.textGenerated,
  };
}

/**
 * Updates a template.
 *
 * `version` is not written here. The trigger in migration 0009 increments it
 * when — and only when — the content actually changed, so a rename does not
 * inflate the version and two clients cannot disagree about what the number
 * means. A campaign already scheduled from this template is unaffected: it holds
 * a frozen snapshot, and the database refuses to let this path touch it.
 */
export async function updateTemplate(
  workspaceId: string,
  templateId: string,
  input: TemplateInput,
): Promise<TemplateSaveResult> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('template.write', access.userId, access.workspaceId);

  const prepared = prepareTemplate(input);
  const repository = await templateRepository(access.workspaceId);

  const record = await repository.update(templateId, prepared.write);
  if (record === null) throw new ForbiddenError();

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'template.updated',
    entityType: 'template',
    entityId: record.id,
    metadata: auditShape(record, prepared.report),
  });

  return {
    record,
    sanitized: prepared.sanitized,
    report: prepared.report,
    textGenerated: prepared.textGenerated,
  };
}

export async function deleteTemplate(workspaceId: string, templateId: string): Promise<void> {
  const access = await requireWorkspace(workspaceId);
  const repository = await templateRepository(access.workspaceId);

  const record = await repository.get(templateId);
  if (record === null) throw new ForbiddenError();

  const outcome = await repository.remove(templateId);

  if (outcome === 'in_use') {
    const count = await repository.countCampaignsUsing(templateId);
    throw new ConflictError(
      count === 1
        ? 'A campaign still uses this template. Remove or cancel that campaign first.'
        : `${count} campaigns still use this template. Remove or cancel them first.`,
    );
  }
  if (outcome === 'missing') throw new ForbiddenError();

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'template.deleted',
    entityType: 'template',
    entityId: templateId,
    metadata: { name: record.name, version: record.version },
  });
}

/**
 * The audit metadata for a template write.
 *
 * Shape and size, never content. What was removed is recorded as *names* —
 * `script`, `a.onclick` — which is the fact worth keeping; the payload itself is
 * not, and an audit table that accumulates hostile HTML is a liability.
 */
function auditShape(record: TemplateRecord, report: SanitizeReport): Record<string, unknown> {
  return {
    name: record.name,
    version: record.version,
    subjectLength: record.subject.length,
    htmlLength: record.html.length,
    textLength: record.text.length,
    variables: record.variables,
    removedTags: report.removedTags,
    removedAttributes: report.removedAttributes,
    removedUrls: report.removedUrls,
  };
}

/** Re-exported so callers need one import for the whole template surface. */
export type { TemplateRecord, TemplateRepository };
