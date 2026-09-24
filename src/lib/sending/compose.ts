/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MESSAGE COMPOSITION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One job in, one `OutboundMessage` out. Pure: the worker, the dry run and the
 * test suite produce byte-identical messages from identical inputs.
 *
 * ── What it composes from ────────────────────────────────────────────────
 *
 * The campaign's *frozen snapshot*, never the live template (ARCHITECTURE §3.7),
 * and the job's *frozen merge data*, never the live contact (§7.2). The renderer
 * is P4's `renderTemplate` — the one the preview uses — so what a person
 * approved in the preview is what is sent.
 *
 * ── Unsubscribe is enforced here, not only in preflight ──────────────────
 *
 * A campaign that requires unsubscribe gets, on every message:
 *
 *   - `List-Unsubscribe: <https://…/u/{token}>`
 *   - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`  (RFC 8058)
 *   - a visible unsubscribe link at the foot of the HTML and the text body
 *
 * and if no link can be made, composition *fails* — the message is not sent
 * without one. Preflight blocks the campaign before launch; this is the second
 * lock on the same door, for the case where the key disappears mid-campaign.
 *
 * ── Header injection ─────────────────────────────────────────────────────
 *
 * The subject is already stripped of control characters by the renderer, and
 * the database refuses them in the template and the sender name. Every header
 * this module adds is re-validated below regardless: printable ASCII only,
 * nothing that could end a header line.
 */

import { escapeAttribute, escapeText } from '@/lib/templates/sanitize';
import {
  contactVariableValues,
  renderTemplate,
  type PersonalizationSource,
} from '@/lib/templates/render';
import { renderableFromSnapshot, type TemplateSnapshot } from '@/lib/campaigns/snapshot';
import type { OutboundMessage } from './provider/types';

export interface ComposeInput {
  snapshot: TemplateSnapshot;
  /** The job's frozen merge data, as stored in `email_jobs.merge_data`. */
  mergeData: unknown;
  toEmail: string;
  sender: { fromEmail: string; fromName: string; replyTo: string | null };
  requiresUnsubscribe: boolean;
  /** Null when no unsubscribe key is configured. */
  unsubscribeUrl: string | null;
  tags: Readonly<Record<string, string>>;
}

export type ComposeFailure =
  | 'render_failed'
  | 'unsubscribe_unavailable'
  | 'invalid_recipient'
  | 'invalid_header';

export type ComposeResult =
  | { ok: true; message: OutboundMessage }
  | { ok: false; reason: ComposeFailure; detail: string };

const HEADER_NAME = /^[A-Za-z0-9-]{1,76}$/;
const HEADER_VALUE = /^[\x20-\x7e]{1,998}$/;
const SIMPLE_ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The job's merge data back into the shape the renderer's projection accepts. */
export function personalizationFromJob(toEmail: string, mergeData: unknown): PersonalizationSource {
  const data = asRecord(mergeData);
  return {
    email_normalized: toEmail,
    first_name: stringOrNull(data['first_name']),
    last_name: stringOrNull(data['last_name']),
    company: stringOrNull(data['company']),
    website: stringOrNull(data['website']),
    phone: stringOrNull(data['phone']),
    custom: asRecord(data['custom']),
  };
}

function wrapHtml(bodyHtml: string, preheader: string | null, unsubscribeUrl: string | null): string {
  const parts = ['<!doctype html><html><head><meta charset="utf-8"></head><body>'];
  if (preheader !== null && preheader.length > 0) {
    // The conventional hidden preheader: inboxes show it beside the subject; the
    // message body does not.
    parts.push(
      `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeText(preheader)}</div>`,
    );
  }
  parts.push(bodyHtml);
  if (unsubscribeUrl !== null) {
    parts.push(
      '<p style="margin-top:32px;font-size:12px;color:#666">' +
        'You are receiving this email because you are on our mailing list. ' +
        `<a href="${escapeAttribute(unsubscribeUrl)}">Unsubscribe</a>.` +
        '</p>',
    );
  }
  parts.push('</body></html>');
  return parts.join('');
}

function wrapText(bodyText: string, unsubscribeUrl: string | null): string {
  if (unsubscribeUrl === null) return bodyText;
  return `${bodyText.trimEnd()}\n\n--\nUnsubscribe: ${unsubscribeUrl}\n`;
}

export function composeMessage(input: ComposeInput): ComposeResult {
  if (!SIMPLE_ADDRESS.test(input.toEmail) || input.toEmail.length > 254) {
    return { ok: false, reason: 'invalid_recipient', detail: 'the recipient address is not deliverable' };
  }

  const rendered = renderTemplate(
    renderableFromSnapshot(input.snapshot),
    contactVariableValues(personalizationFromJob(input.toEmail, input.mergeData)),
  );
  if (rendered.issues.length > 0) {
    return {
      ok: false,
      reason: 'render_failed',
      detail: rendered.issues.map((issue) => issue.code).join(','),
    };
  }
  if (rendered.subject.trim().length === 0) {
    return { ok: false, reason: 'render_failed', detail: 'empty_subject' };
  }

  let unsubscribeUrl: string | null = null;
  if (input.requiresUnsubscribe) {
    if (input.unsubscribeUrl === null || !/^https?:\/\//.test(input.unsubscribeUrl)) {
      return {
        ok: false,
        reason: 'unsubscribe_unavailable',
        detail: 'this campaign requires an unsubscribe link and none could be made',
      };
    }
    unsubscribeUrl = input.unsubscribeUrl;
  }

  const headers: Record<string, string> = {};
  if (unsubscribeUrl !== null) {
    headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) {
      return { ok: false, reason: 'invalid_header', detail: name };
    }
  }

  return {
    ok: true,
    message: {
      from: { email: input.sender.fromEmail, name: input.sender.fromName },
      replyTo: input.sender.replyTo,
      to: input.toEmail,
      subject: rendered.subject,
      html: wrapHtml(rendered.html, rendered.previewText, unsubscribeUrl),
      text: wrapText(rendered.text, unsubscribeUrl),
      headers,
      tags: input.tags,
    },
  };
}
