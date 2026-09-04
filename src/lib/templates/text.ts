/**
 * The plain-text alternative.
 *
 * Every message needs one: a multipart message without `text/plain` scores worse
 * with every major spam filter, and some clients show nothing at all. Asking a
 * person to maintain two unrelated bodies guarantees they drift, and the version
 * nobody looks at is the one that ends up wrong.
 *
 * So the text is *derived* by default, and may be overridden explicitly. That is
 * the same trade-off `contacts.search_text` makes in migration 0005: derive it,
 * so the two cannot disagree, unless someone deliberately says otherwise.
 *
 * ── What must not survive the conversion ─────────────────────────────────
 *
 * The input is the *sanitised* HTML, never the raw input, so scripts, handlers
 * and unsafe schemes are already gone before this function sees them. This
 * function keeps that true: a link is written as `text (url)` only when the URL
 * passed `isSafeUrl`, and hidden content — an element styled to be invisible, a
 * zero-size image, a preheader `<div>` — contributes nothing, because a
 * plain-text body is where hidden tracking markup would otherwise become
 * visible, unexplained noise.
 *
 * Deliberately free of `server-only`: pure, and the editor previews it live.
 */

import { decodeEntities, isSafeUrl } from './sanitize';
import { MAX_TEXT_CHARS } from './constants';

/** Elements that end a line. */
const LINE_BREAK_TAGS = new Set(['br']);

/** Elements that end a paragraph. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'div', 'dd',
  'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);

/** Elements whose text is not part of the message. */
const SKIP_CONTENT_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);

/** A style declaration that hides the element it is on. */
const HIDDEN_STYLE = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0*)?\s*(;|$)|max-height\s*:\s*0|font-size\s*:\s*0)/i;

interface TagInfo {
  name: string;
  closing: boolean;
  attributes: Record<string, string>;
}

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

function parseTag(match: RegExpExecArray): TagInfo {
  const name = (match[1] ?? '').toLowerCase();
  const closing = match[0].startsWith('</');
  const attributes: Record<string, string> = {};

  ATTRIBUTE.lastIndex = 0;
  let attribute: RegExpExecArray | null;
  while ((attribute = ATTRIBUTE.exec(match[2] ?? '')) !== null) {
    const key = (attribute[1] ?? '').toLowerCase();
    attributes[key] = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
  }
  return { name, closing, attributes };
}

/**
 * Converts sanitised HTML into a plain-text body.
 *
 * Deterministic: the same HTML always produces the same text, which is what
 * makes `tests/template-preview.test.ts` able to assert the two versions carry
 * the same message.
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  /** Tags whose content is being skipped, innermost last. */
  const skipping: string[] = [];
  /** Pending link href, so the URL is written after its own text. */
  let pendingHref: string | null = null;
  let linkText = '';

  let i = 0;
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;

  const emit = (value: string): void => {
    if (skipping.length > 0) return;
    if (pendingHref !== null) linkText += value;
    else out.push(value);
  };

  while ((match = TAG.exec(html)) !== null) {
    if (match.index > i) emit(decodeEntities(html.slice(i, match.index)));
    i = match.index + match[0].length;

    const tag = parseTag(match);

    if (skipping.length > 0) {
      if (tag.closing && skipping[skipping.length - 1] === tag.name) skipping.pop();
      else if (!tag.closing && SKIP_CONTENT_TAGS.has(tag.name)) skipping.push(tag.name);
      continue;
    }

    if (!tag.closing && SKIP_CONTENT_TAGS.has(tag.name)) {
      skipping.push(tag.name);
      continue;
    }

    // Hidden content is not part of the message a person wrote, and reproducing
    // it in the text body is how preheader hacks and tracking markup end up
    // visible to the reader.
    if (!tag.closing && HIDDEN_STYLE.test(tag.attributes['style'] ?? '')) {
      skipping.push(tag.name);
      continue;
    }

    if (LINE_BREAK_TAGS.has(tag.name)) {
      emit('\n');
      continue;
    }

    if (tag.name === 'a') {
      if (!tag.closing) {
        const href = tag.attributes['href'] ?? '';
        pendingHref = isSafeUrl(href) && href.length > 0 ? href : null;
        linkText = '';
      } else if (pendingHref !== null) {
        const href = pendingHref;
        pendingHref = null;
        const label = linkText.trim();
        out.push(label.length === 0 || label === href ? href : `${label} (${href})`);
        linkText = '';
      }
      continue;
    }

    if (tag.name === 'li') {
      // Only the opening tag contributes. Letting `</li>` fall through to the
      // block rule below would put a blank line between every bullet.
      if (!tag.closing) emit('\n- ');
      continue;
    }

    if (tag.name === 'td' || tag.name === 'th') {
      if (tag.closing) emit('\t');
      continue;
    }

    if (BLOCK_TAGS.has(tag.name)) {
      emit('\n\n');
      continue;
    }
  }

  if (i < html.length) emit(decodeEntities(html.slice(i)));
  // An unterminated link still contributes its text.
  if (pendingHref !== null) out.push(linkText);

  return normalizeText(out.join(''));
}

/**
 * Collapses whitespace into something a mail client will render sensibly.
 *
 * Non-breaking spaces become ordinary ones: they survive the HTML conversion but
 * mean nothing in plain text, and a run of them is indistinguishable from
 * padding meant to push content out of a preview pane.
 */
export function normalizeText(value: string): string {
  const collapsed = value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\u202f\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return collapsed.length > MAX_TEXT_CHARS ? collapsed.slice(0, MAX_TEXT_CHARS).trimEnd() : collapsed;
}
