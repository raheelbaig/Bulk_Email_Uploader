/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HTML SANITISER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Template HTML is untrusted input. It is written by a workspace member, stored,
 * shown back to other members in a preview, and — from P5 — sent to third
 * parties. Every one of those is a place where a script tag would matter.
 *
 * ── What this is, and what it is not ──────────────────────────────────────
 *
 * This is an *allowlist* sanitiser: it parses the input into tokens and rebuilds
 * the output from what it recognises. Nothing is passed through. A tag that is
 * not in `ALLOWED_TAGS` cannot appear in the output because there is no code
 * path that writes it; an attribute that is not in the allowlist for its element
 * is not written either. That is the opposite of a denylist, which has to
 * enumerate every attack and is wrong the moment a new one is found.
 *
 * Rebuilding is also what defends against mutation XSS. The output is serialised
 * from parsed tokens with its own escaping, so a value that would re-parse
 * differently in a different context — the classic `<img src="x" title="</style>
 * <script>">` shape — cannot survive: the quote and the angle bracket are
 * escaped on the way out.
 *
 * ── Defence in depth ──────────────────────────────────────────────────────
 *
 * This is the first of three layers, not the only one:
 *
 *   1. This sanitiser, on save and again after personalization substitutes
 *      values (`lib/templates/render.ts`), because a substituted value lands
 *      inside markup that was sanitised before the value existed.
 *   2. A sandboxed iframe with no `allow-scripts` and a restrictive CSP, which
 *      is what the preview actually renders into (`lib/templates/preview.ts`).
 *      Even a total failure here executes nothing.
 *   3. React, which escapes everything the surrounding page renders.
 *
 * Deliberately free of `server-only`: pure, dependency-free, and the editor runs
 * the identical function so what a person sees is what is stored.
 */

import { MAX_HTML_DEPTH, MAX_SANITIZE_INPUT_CHARS } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
// The allowlists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Elements that may appear in the output.
 *
 * An email-shaped set: structure, text, lists, tables and images. No form
 * controls, no media, no embedding, no metadata.
 */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'i', 'img', 'li', 'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'section',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'wbr',
]);

/** Elements with no closing tag. Never pushed onto the open-element stack. */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr', 'col']);

/**
 * Elements removed together with everything inside them.
 *
 * The distinction from "unwrap" matters: unwrapping `<script>` would keep its
 * body as text, which is inert in the DOM but noise in the plain-text version
 * and confusing in the editor. These carry no content worth keeping.
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'noscript', 'iframe', 'frame', 'frameset', 'object',
  'embed', 'applet', 'link', 'meta', 'base', 'head', 'title', 'template',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'fieldset',
  'legend', 'label', 'svg', 'math', 'audio', 'video', 'source', 'track',
  'canvas', 'map', 'portal', 'dialog', 'slot', 'xmp', 'plaintext', 'listing',
]);

/**
 * Elements whose content the HTML spec parses as raw text.
 *
 * These need their own scan to the matching close tag: inside `<script>`, the
 * string `</p>` is text, not a tag, so the ordinary tokenizer would resynchronise
 * in the wrong place — which is exactly how a payload escapes a naive filter.
 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'xmp', 'plaintext', 'listing', 'noscript', 'title', 'textarea']);

/** Attributes permitted on any allowed element. */
const GLOBAL_ATTRIBUTES = new Set(['class', 'title', 'dir', 'lang', 'align', 'style']);

/** Additional attributes, per element. */
const TAG_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height', 'border']),
  table: new Set(['width', 'height', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'role', 'summary']),
  td: new Set(['colspan', 'rowspan', 'valign', 'width', 'height', 'bgcolor', 'nowrap']),
  th: new Set(['colspan', 'rowspan', 'valign', 'width', 'height', 'bgcolor', 'scope']),
  tr: new Set(['valign', 'bgcolor', 'height']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  ol: new Set(['start', 'type', 'reversed']),
  ul: new Set(['type']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
};

/** Attributes whose value is a URL and must therefore be scheme-checked. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'cite']);

/** The only schemes a link may use. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Inline CSS properties that may survive. Layout and colour, nothing behavioural. */
const ALLOWED_CSS_PROPERTIES = new Set([
  'background', 'background-color', 'background-image', 'border', 'border-bottom',
  'border-bottom-color', 'border-collapse', 'border-color', 'border-left',
  'border-radius', 'border-right', 'border-spacing', 'border-style', 'border-top',
  'border-width', 'color', 'display', 'font', 'font-family', 'font-size',
  'font-style', 'font-variant', 'font-weight', 'height', 'letter-spacing',
  'line-height', 'list-style', 'list-style-type', 'margin', 'margin-bottom',
  'margin-left', 'margin-right', 'margin-top', 'max-height', 'max-width',
  'min-height', 'min-width', 'opacity', 'overflow', 'padding', 'padding-bottom',
  'padding-left', 'padding-right', 'padding-top', 'table-layout', 'text-align',
  'text-decoration', 'text-transform', 'vertical-align', 'white-space', 'width',
  'word-break', 'word-wrap',
]);

/** CSS that is a capability rather than a style, whatever property carries it. */
const CSS_DANGER = /expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behaviou?r\s*:|@import|<\/|url\s*\(\s*['"]?\s*(?!https?:|data:image\/)/i;

/** Bound on one URL. Beyond this it is not a link anyone typed. */
const MAX_URL_CHARS = 2048;

// ─────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '\x22', apos: '\x27', nbsp: '\u00a0',
  colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')',
  semi: ';', excl: '!', num: '#', percnt: '%', dollar: '$', commat: '@',
};

/**
 * Decodes entities the way a browser would when reading an attribute value.
 *
 * This runs *before* a URL is judged, never on the way out. `&#106;avascript:`
 * and `java&Tab;script:` are both `javascript:` to a browser, so both must be
 * `javascript:` to the check that rejects them. The trailing semicolon is
 * optional for the same reason: browsers accept `&colon` without one.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#[xX]([0-9a-fA-F]+);?/g, (_m, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);?/g, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return '';
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

/**
 * Text-node escaping. Quotes are left alone; they are not special in text.
 *
 * An ampersand that already begins a well-formed entity is left as it is. That
 * is what makes the sanitiser idempotent: `render.ts` sanitises a second time
 * after substituting values, and without this an already-escaped `&lt;` would
 * become `&amp;lt;` and the reader would see the escaping instead of the text.
 * A bare `&` is still escaped, and an entity cannot introduce a tag, so nothing
 * is given up for it.
 */
export function escapeText(value: string): string {
  return value
    .replace(/&(?!#\d+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Attribute-value escaping. Both quote styles, so the output quoting is safe. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// URLs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decides whether a URL may be written into the output.
 *
 * The judgement is made on a *probe*: the value with entities decoded and every
 * character a browser ignores when parsing a scheme removed. `jav&#x09;ascript:`
 * probes as `javascript:` and is refused. What is written to the output is the
 * original value, because the browser will do its own normalisation and a
 * rewritten URL is a URL the author did not type.
 */
export function isSafeUrl(value: string, options: { allowDataImage?: boolean } = {}): boolean {
  if (value.length > MAX_URL_CHARS) return false;

  const probe = decodeEntities(value)
    // Every C0 control, space, and the characters browsers strip while parsing a
    // scheme. Removed everywhere, not only at the front: `java\nscript:` is a
    // scheme to a browser.
    .replace(/[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g, '')
    .toLowerCase();

  if (probe.length === 0) return true;

  if (options.allowDataImage === true && /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=]+$/.test(probe)) {
    return true;
  }

  const scheme = /^([a-z][a-z0-9+.\-]*:)/.exec(probe);
  // No scheme at all: a relative URL, a fragment, or protocol-relative. None of
  // those can name a scheme, so none of them can be `javascript:`.
  if (scheme === null) return !probe.startsWith('data:') && !probe.includes('\\');

  return SAFE_SCHEMES.has(scheme[1] ?? '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline CSS
// ─────────────────────────────────────────────────────────────────────────────

/** Filters a `style` attribute to the property allowlist. Returns '' if nothing survives. */
export function sanitizeStyle(value: string): string {
  const decoded = decodeEntities(value);
  if (CSS_DANGER.test(decoded)) {
    // One dangerous declaration discards the whole attribute rather than the
    // one property: partial repair of hostile input is how filters get bypassed.
    return '';
  }

  const kept: string[] = [];
  for (const declaration of decoded.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;

    const property = declaration.slice(0, colon).trim().toLowerCase();
    const propertyValue = declaration.slice(colon + 1).trim();

    if (!ALLOWED_CSS_PROPERTIES.has(property)) continue;
    if (propertyValue.length === 0 || propertyValue.length > 300) continue;
    if (/[<>{}\\]/.test(propertyValue)) continue;

    kept.push(`${property}: ${propertyValue}`);
  }

  return kept.join('; ');
}

// ─────────────────────────────────────────────────────────────────────────────
// The sanitiser
// ─────────────────────────────────────────────────────────────────────────────

export interface SanitizeReport {
  /** Element names that were dropped or unwrapped, distinct, in encounter order. */
  removedTags: string[];
  /** `tag.attribute` pairs that were dropped. */
  removedAttributes: string[];
  /** URLs refused for their scheme. Counted, never recorded — see §24.4. */
  removedUrls: number;
}

export interface SanitizeResult {
  html: string;
  report: SanitizeReport;
  /** True when the input exceeded `MAX_SANITIZE_INPUT_CHARS` and was cut. */
  truncated: boolean;
}

/** True when the sanitiser had to remove something. */
export function sanitizerRemovedSomething(report: SanitizeReport): boolean {
  return report.removedTags.length > 0 || report.removedAttributes.length > 0 || report.removedUrls > 0;
}

const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9]*/;

export function sanitizeHtml(input: string): SanitizeResult {
  const truncated = input.length > MAX_SANITIZE_INPUT_CHARS;
  // NUL is removed first: browsers treat it as invisible inside a tag name, so
  // `<scr\0ipt>` would otherwise reach the allowlist as an unknown element.
  const source = (truncated ? input.slice(0, MAX_SANITIZE_INPUT_CHARS) : input).replace(/\u0000/g, '');

  const out: string[] = [];
  const open: string[] = [];
  const removedTags: string[] = [];
  const removedAttributes: string[] = [];
  const seenTag = new Set<string>();
  const seenAttribute = new Set<string>();
  let removedUrls = 0;

  const noteTag = (name: string): void => {
    if (!seenTag.has(name)) {
      seenTag.add(name);
      removedTags.push(name);
    }
  };
  const noteAttribute = (key: string): void => {
    if (!seenAttribute.has(key)) {
      seenAttribute.add(key);
      removedAttributes.push(key);
    }
  };

  let i = 0;
  const length = source.length;

  while (i < length) {
    const lt = source.indexOf('<', i);

    if (lt === -1) {
      out.push(escapeText(source.slice(i)));
      break;
    }
    if (lt > i) out.push(escapeText(source.slice(i, lt)));

    // Comments. Dropped whole — including the conditional-comment form, which is
    // markup that only some renderers see and is therefore markup nobody reviews.
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? length : end + 3;
      continue;
    }
    // Doctype, CDATA, processing instructions.
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt + 2);
      i = end === -1 ? length : end + 1;
      continue;
    }

    if (source.startsWith('</', lt)) {
      const rest = source.slice(lt + 2);
      const match = TAG_NAME.exec(rest);
      const end = source.indexOf('>', lt + 2);
      i = end === -1 ? length : end + 1;

      if (match === null) continue;
      const name = match[0].toLowerCase();

      const at = open.lastIndexOf(name);
      if (at === -1) continue; // a stray close tag closes nothing
      // Close everything opened inside it, so the output is always balanced.
      for (let depth = open.length - 1; depth >= at; depth -= 1) {
        out.push(`</${open[depth]}>`);
      }
      open.length = at;
      continue;
    }

    const nameMatch = TAG_NAME.exec(source.slice(lt + 1));
    if (nameMatch === null) {
      // A `<` that does not begin a tag is text.
      out.push('&lt;');
      i = lt + 1;
      continue;
    }

    const name = nameMatch[0].toLowerCase();
    const parsed = parseAttributes(source, lt + 1 + nameMatch[0].length);
    i = parsed.next;

    if (DROP_WITH_CONTENT.has(name)) {
      noteTag(name);
      i = RAW_TEXT_TAGS.has(name) ? skipRawText(source, i, name) : skipElement(source, i, name);
      continue;
    }

    if (!ALLOWED_TAGS.has(name) || open.length >= MAX_HTML_DEPTH) {
      // Unwrapped: the element goes, its children stay. Nothing is skipped, so
      // the text inside an unknown wrapper is preserved.
      noteTag(name);
      continue;
    }

    const attributes: string[] = [];
    for (const attribute of parsed.attributes) {
      const key = attribute.name.toLowerCase();

      // Event handlers, first and explicitly. They are excluded by the
      // allowlist too; stating it here means the reason is greppable.
      if (key.startsWith('on') || key.startsWith('data-') || key.startsWith('xmlns') || key.includes(':')) {
        noteAttribute(`${name}.${key}`);
        continue;
      }

      const permitted = GLOBAL_ATTRIBUTES.has(key) || TAG_ATTRIBUTES[name]?.has(key) === true;
      if (!permitted) {
        noteAttribute(`${name}.${key}`);
        continue;
      }

      if (attribute.value === null) {
        // A bare attribute (`nowrap`). Only meaningful for the non-URL, non-style
        // ones, and harmless because the name is already allowlisted.
        if (URL_ATTRIBUTES.has(key) || key === 'style') continue;
        attributes.push(key);
        continue;
      }

      let value = attribute.value;

      if (URL_ATTRIBUTES.has(key)) {
        if (!isSafeUrl(value, { allowDataImage: name === 'img' && key === 'src' })) {
          removedUrls += 1;
          continue;
        }
      } else if (key === 'style') {
        value = sanitizeStyle(value);
        if (value.length === 0) {
          noteAttribute(`${name}.style`);
          continue;
        }
      } else if (key === 'target') {
        // A named window is a handle another document can reach. Only `_blank`.
        if (value.toLowerCase() !== '_blank') continue;
      } else if (value.length > 1000) {
        noteAttribute(`${name}.${key}`);
        continue;
      }

      attributes.push(`${key}="${escapeAttribute(value)}"`);
    }

    // Reverse tabnabbing: a `_blank` link without this gives the opened document
    // a handle to the opener. Forced rather than validated, so it cannot be
    // omitted by writing `rel="opener"`.
    if (name === 'a' && attributes.some((a) => a.startsWith('target='))) {
      const withoutRel = attributes.filter((a) => !a.startsWith('rel='));
      withoutRel.push('rel="noopener noreferrer"');
      attributes.length = 0;
      attributes.push(...withoutRel);
    }

    const serialized = attributes.length === 0 ? name : `${name} ${attributes.join(' ')}`;

    if (VOID_TAGS.has(name)) {
      out.push(`<${serialized} />`);
      continue;
    }

    out.push(`<${serialized}>`);
    open.push(name);
  }

  // Anything still open is closed here, so the sanitiser never emits markup that
  // depends on the surrounding document to be well formed.
  for (let depth = open.length - 1; depth >= 0; depth -= 1) {
    out.push(`</${open[depth]}>`);
  }

  return {
    html: out.join(''),
    report: { removedTags, removedAttributes, removedUrls },
    truncated,
  };
}

interface ParsedAttribute {
  name: string;
  /** null for a valueless attribute. */
  value: string | null;
}

/**
 * Reads a start tag's attributes, from just after the element name to just
 * after the closing `>`.
 *
 * Handles double-quoted, single-quoted and unquoted values, because a browser
 * does, and an attacker will use whichever form a filter handles worst.
 */
function parseAttributes(source: string, from: number): { attributes: ParsedAttribute[]; next: number } {
  const attributes: ParsedAttribute[] = [];
  let i = from;
  const length = source.length;

  while (i < length) {
    while (i < length && /[\s\/]/.test(source[i] ?? '')) i += 1;
    if (i >= length) break;
    if (source[i] === '>') return { attributes, next: i + 1 };

    const start = i;
    while (i < length && !/[\s=>\/]/.test(source[i] ?? '')) i += 1;
    const name = source.slice(start, i);
    if (name.length === 0) {
      i += 1;
      continue;
    }

    while (i < length && /\s/.test(source[i] ?? '')) i += 1;

    if (source[i] !== '=') {
      attributes.push({ name, value: null });
      continue;
    }

    i += 1;
    while (i < length && /\s/.test(source[i] ?? '')) i += 1;

    const quote = source[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      const end = source.indexOf(quote, i);
      const stop = end === -1 ? length : end;
      attributes.push({ name, value: decodeEntities(source.slice(i, stop)) });
      i = stop + 1;
      continue;
    }

    const valueStart = i;
    while (i < length && !/[\s>]/.test(source[i] ?? '')) i += 1;
    attributes.push({ name, value: decodeEntities(source.slice(valueStart, i)) });
  }

  return { attributes, next: length };
}

/**
 * Skips a raw-text element's body.
 *
 * `<script>` content is not markup, so the ordinary tokenizer must not look at
 * it. Scanning for the literal close tag is what the HTML spec does too.
 */
function skipRawText(source: string, from: number, name: string): number {
  const close = new RegExp(`</${name}[\\s>]`, 'i');
  const rest = source.slice(from);
  const match = close.exec(rest);
  if (match === null) return source.length;
  const end = source.indexOf('>', from + match.index);
  return end === -1 ? source.length : end + 1;
}

/**
 * Skips a normal element and everything inside it, counting nesting.
 *
 * Nesting matters: `<form><form></form></form>` must not leave a stray close tag
 * behind for the tokenizer to resynchronise on.
 */
function skipElement(source: string, from: number, name: string): number {
  const scanner = new RegExp(`<(/?)(${name})(?=[\\s/>])`, 'gi');
  scanner.lastIndex = from;

  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(source)) !== null) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) {
      const end = source.indexOf('>', match.index);
      return end === -1 ? source.length : end + 1;
    }
  }
  return source.length;
}
