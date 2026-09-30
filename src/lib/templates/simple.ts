/**
 * "Simple" email content: plain text in, a small fixed subset of HTML out.
 *
 * For people who should not have to know what `<p>` is. They write paragraphs;
 * this turns them into the HTML the template engine already stores. It is not a
 * second content format — the result is ordinary template HTML and goes through
 * the same server-side sanitiser, variable scan and plain-text derivation as
 * anything typed in the Advanced HTML editor. Nothing here is trusted.
 *
 * The rules, in the words the editor shows:
 *
 *   - a blank line starts a new paragraph; a single line break stays a line break
 *   - a line starting with "# " is a heading
 *   - lines starting with "- " (or "* ") are a bulleted list
 *   - **double asterisks** make text bold
 *   - addresses starting with http:// or https:// become links
 *   - {{first_name}} and other personalization fields pass through unchanged
 *
 * Every character of the person's text is escaped before any markup is added,
 * so text can never become a tag or an attribute. The only attribute written is
 * a link's `href`, and only for an http(s) URL matched by a pattern that cannot
 * contain a quote, a space or an angle bracket — and the value is escaped too.
 *
 * `fromSimpleHtml` goes the other way, and only when that is lossless: it
 * returns text only if converting that text back reproduces the stored HTML
 * exactly. Anything else (custom HTML, styling, images) opens in the Advanced
 * editor, so switching modes can never silently discard formatting.
 *
 * Deliberately free of `server-only`: the editor runs it in the browser.
 */

import { decodeEntities, escapeAttribute } from './sanitize';

function escapeAll(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** http(s) URLs. No quotes, spaces or angle brackets can be part of a match. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;
const BOLD_PATTERN = /\*\*([^*\n]+?)\*\*/g;

function inline(raw: string): string {
  // Links are found in the raw text, then each piece is escaped on its own, so
  // a URL is never re-scanned after escaping and text is never left unescaped.
  let out = '';
  let last = 0;
  for (const match of raw.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    out += bold(escapeAll(raw.slice(last, start)));
    const url = match[0];
    out += `<a href="${escapeAttribute(url)}">${escapeAll(url)}</a>`;
    last = start + url.length;
  }
  out += bold(escapeAll(raw.slice(last)));
  return out;
}

function bold(escaped: string): string {
  return escaped.replace(BOLD_PATTERN, '<strong>$1</strong>');
}

const BULLET = /^[-*]\s+/;
const HEADING = /^#\s+/;

/** Plain text → template HTML. */
export function toSimpleHtml(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return '';

  const blocks = normalized.split(/\n\s*\n/);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) continue;

    if (lines.every((line) => BULLET.test(line))) {
      out.push(`<ul>${lines.map((line) => `<li>${inline(line.replace(BULLET, ''))}</li>`).join('')}</ul>`);
      continue;
    }
    // A heading is its own line; anything after it in the block is a paragraph.
    let rest = lines;
    while (rest.length > 0 && HEADING.test(rest[0]!)) {
      out.push(`<h2>${inline(rest[0]!.replace(HEADING, ''))}</h2>`);
      rest = rest.slice(1);
    }
    if (rest.length > 0) out.push(`<p>${rest.map(inline).join('<br />')}</p>`);
  }
  return out.join('\n');
}

const BLOCK = /^(?:<h2>(.*?)<\/h2>|<p>(.*?)<\/p>|<ul>((?:<li>.*?<\/li>)+)<\/ul>)$/;

function inlineBack(html: string): string | null {
  const text = html
    .replace(/<br \/>/g, '\n')
    .replace(/<strong>(.*?)<\/strong>/g, '**$1**')
    .replace(/<a href="[^"]*">(.*?)<\/a>/g, '$1');
  if (/[<>]/.test(text)) return null;
  return decodeEntities(text);
}

/**
 * Template HTML → plain text, or `null` when the HTML is not exactly what
 * `toSimpleHtml` would have produced (so opening it in Simple mode would lose
 * something).
 */
export function fromSimpleHtml(html: string): string | null {
  // Form submission turns every "\n" into "\r\n", so stored HTML has CRLFs.
  const trimmed = html.replace(/\r\n?/g, '\n').trim();
  if (trimmed.length === 0) return '';

  const parts: string[] = [];
  for (const line of trimmed.split('\n')) {
    const match = BLOCK.exec(line);
    if (match === null) return null;
    const [, heading, paragraph, items] = match;
    if (heading !== undefined) {
      const text = inlineBack(heading);
      if (text === null) return null;
      parts.push(`# ${text}`);
    } else if (paragraph !== undefined) {
      const text = inlineBack(paragraph);
      if (text === null) return null;
      parts.push(text);
    } else if (items !== undefined) {
      const lines: string[] = [];
      for (const item of items.matchAll(/<li>(.*?)<\/li>/g)) {
        const text = inlineBack(item[1] ?? '');
        if (text === null) return null;
        lines.push(`- ${text}`);
      }
      parts.push(lines.join('\n'));
    }
  }
  const text = parts.join('\n\n');
  // Lossless or nothing.
  return toSimpleHtml(text) === trimmed ? text : null;
}

/** Starting points for a new email, in Simple format. */
export const STARTER_TEMPLATES: ReadonlyArray<{ key: string; label: string; description: string; text: string }> = [
  {
    key: 'note',
    label: 'Short note',
    description: 'A friendly message of a few lines.',
    text: [
      'Hi {{first_name}},',
      '',
      'I wanted to let you know about something we think you’ll find useful.',
      '',
      'Write your message here. Keep it short and to the point.',
      '',
      'Best wishes,',
      'Your name',
    ].join('\n'),
  },
  {
    key: 'newsletter',
    label: 'Newsletter',
    description: 'A heading, an intro and a list of updates.',
    text: [
      '# What’s new this month',
      '',
      'Hi {{first_name}},',
      '',
      'Here’s a quick round-up of what we’ve been working on.',
      '',
      '- **First update:** a sentence or two about it.',
      '- **Second update:** a sentence or two about it.',
      '- **Third update:** a sentence or two about it.',
      '',
      'Read more on our website: https://example.com',
      '',
      'Thanks for reading,',
      'The team',
    ].join('\n'),
  },
  {
    key: 'announcement',
    label: 'Announcement',
    description: 'One piece of news and what to do next.',
    text: [
      '# Big news',
      '',
      'Hi {{first_name}},',
      '',
      'We’re excited to share some news with you. Describe what’s happening and why it matters.',
      '',
      '**What happens next:** explain the one thing you’d like the reader to do.',
      '',
      'Find out more: https://example.com',
      '',
      'Thank you,',
      'The team',
    ].join('\n'),
  },
];
