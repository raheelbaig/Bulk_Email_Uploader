/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SAFE PREVIEW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Shows a person what their message will look like, without the application
 * ever executing what they wrote.
 *
 * ── Why this is not `dangerouslySetInnerHTML` ────────────────────────────
 *
 * Rendering template HTML into the application's own document would give it the
 * application's origin: its cookies, its session, its DOM, its fetch. Even with
 * a sanitiser in front — and there is one — that is a single point of failure
 * where the failure is full account takeover for every colleague who opens the
 * template. Sanitisers have bugs; origins do not.
 *
 * So the preview is rendered into an **iframe with `sandbox=""`** — the empty
 * value, which is every restriction switched on: no scripts, no forms, no
 * navigation, no popups, and a unique opaque origin that shares nothing with the
 * application. The document is supplied through `srcdoc`, so nothing is fetched.
 *
 * Inside that document, a `Content-Security-Policy` meta tag denies everything
 * and then permits the minimum an email preview needs: images and inline styles.
 * `script-src 'none'` is redundant next to the sandbox and is stated anyway,
 * because these two mechanisms fail independently.
 *
 * Three layers, then, and each alone would be sufficient:
 *
 *   1. The content was sanitised before it was stored, and again after
 *      personalization substituted values into it.
 *   2. The sandbox gives it no origin, no scripts and no navigation.
 *   3. The CSP inside the document denies every fetch except images.
 *
 * Deliberately free of `server-only`: pure string building, and the editor uses
 * the identical function for its live preview.
 */

import { escapeAttribute } from './sanitize';
import {
  contactVariableValues,
  renderTemplate,
  SAMPLE_CONTACT,
  type PersonalizationSource,
  type RenderableTemplate,
  type RenderIssue,
} from './render';

export interface PreviewSender {
  from_name: string;
  from_email: string;
  reply_to: string | null;
}

export interface PreviewInput {
  template: RenderableTemplate;
  /** A real contact, or `SAMPLE_CONTACT` when none is selected. */
  contact?: PersonalizationSource;
  sender?: PreviewSender | null;
}

export interface TemplatePreview {
  subject: string;
  previewText: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  /** Sanitised, personalised HTML. Only ever rendered inside the sandbox. */
  html: string;
  text: string;
  /** The complete document for the iframe's `srcdoc`. */
  document: string;
  /** Known variables with no value for this contact. */
  missing: string[];
  /** Non-empty means the template is not sound. Blocks at preflight. */
  issues: RenderIssue[];
  /** True when the preview used the placeholder rather than a real contact. */
  usedSampleContact: boolean;
  /** Which contact the preview was rendered for, for the caption. */
  contactEmail: string;
}

/**
 * The policy the preview document carries.
 *
 * `default-src 'none'` first, then the two things an email genuinely needs.
 * Images are allowed over https and as data URIs because both appear in real
 * mail and neither can execute. Inline styles are allowed because email markup
 * is inline styles; `style-src` cannot exfiltrate anything on its own inside an
 * opaque origin with no network access for anything else.
 */
const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src https: data:",
  "style-src 'unsafe-inline'",
  "font-src https: data:",
  "script-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** The sandbox value the iframe must carry. Empty: every restriction on. */
export const PREVIEW_SANDBOX = '';

const PREVIEW_STYLES = `
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #111;
    background: #fff;
    padding: 16px;
    word-wrap: break-word;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
`;

/**
 * Wraps sanitised HTML in the document the sandboxed iframe renders.
 *
 * The input must already have been through `sanitizeHtml`. This function adds
 * containment; it does not add safety to markup that has none.
 */
export function previewDocument(sanitizedHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(PREVIEW_CSP)}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>${PREVIEW_STYLES}</style>`,
    '</head>',
    '<body>',
    sanitizedHtml,
    '</body>',
    '</html>',
  ].join('');
}

/**
 * Renders a template for one contact and packages it for display.
 *
 * Nothing here contacts a mail provider, and nothing here can: the preview is
 * built entirely from stored content and a contact record. It works identically
 * with no provider credentials configured at all.
 */
export function buildPreview(input: PreviewInput): TemplatePreview {
  const contact = input.contact ?? SAMPLE_CONTACT;
  const usedSampleContact = input.contact === undefined;

  const rendered = renderTemplate(input.template, contactVariableValues(contact));
  const sender = input.sender ?? null;

  return {
    subject: rendered.subject,
    previewText: rendered.previewText,
    fromName: sender?.from_name ?? null,
    fromEmail: sender?.from_email ?? null,
    replyTo: sender?.reply_to ?? null,
    html: rendered.html,
    text: rendered.text,
    document: previewDocument(rendered.html),
    missing: rendered.missing,
    issues: rendered.issues,
    usedSampleContact,
    contactEmail: contact.email_normalized,
  };
}
