/**
 * A deliberately small XML scanner for OOXML parts.
 *
 * This is not a general XML parser and must not become one. It reads the handful
 * of element shapes a worksheet uses, and it refuses everything that makes XML
 * dangerous:
 *
 *   - No DOCTYPE. That is the billion-laughs entity-expansion vector.
 *   - No custom entity declarations, and no entity resolution beyond the five
 *     predefined names plus bounded numeric references. An external entity is
 *     how a parser is talked into reading /etc/passwd or making a network
 *     request (XXE).
 *   - No processing instructions beyond the XML declaration.
 *   - No DTD, no external references, no schema fetching, no evaluation of
 *     anything. Formula elements are not even tokenised into a value.
 *
 * A spreadsheet is untrusted input (ARCHITECTURE §20.3), and an OOXML file is
 * XML written by whoever uploaded it.
 */

export class XmlSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlSecurityError';
  }
}

export interface XmlTag {
  /** Local name, namespace prefix stripped: `x:row` reads as `row`. */
  name: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
  closing: boolean;
}

const FORBIDDEN = [/<!DOCTYPE/i, /<!ENTITY/i];

export function assertSafeXml(xml: string): void {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(xml)) {
      throw new XmlSecurityError('This spreadsheet contains XML declarations that are not allowed.');
    }
  }
}

/** Numeric references above this are rejected rather than expanded. */
const MAX_CODE_POINT = 0x10ffff;

/**
 * Decodes the five predefined entities and bounded numeric character
 * references. Anything else is left as literal text — an undeclared entity is
 * never resolved, which is the whole point.
 */
export function decodeXmlText(text: string): string {
  if (!text.includes('&')) return text;

  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        break;
    }
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      // Bounded: a reference with 5,000 digits is a denial-of-service attempt,
      // not a character.
      if (digits.length === 0 || digits.length > 7) return match;
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0x9 || code > MAX_CODE_POINT) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return match;
  });
}

function stripNamespace(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_:][-\w.:]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? '';
    if (key === undefined) continue;
    // Attributes are stored under their local name for the same reason
    // elements are: `r:id` and `id` are the same thing to this reader.
    attributes[stripNamespace(key)] = decodeXmlText(value);
  }
  return attributes;
}

export type XmlEvent =
  | { type: 'tag'; tag: XmlTag }
  | { type: 'text'; text: string };

/**
 * Walks the document, invoking `onEvent` for each tag and text run.
 *
 * A callback rather than an array: a worksheet with 100,000 rows produces
 * millions of events, and materialising them would defeat the row cap that
 * exists precisely because workbook parsing is memory-bound.
 *
 * Return `false` from the callback to stop the scan.
 */
export function scanXml(xml: string, onEvent: (event: XmlEvent) => boolean | void): void {
  assertSafeXml(xml);

  let index = 0;
  const length = xml.length;

  while (index < length) {
    const open = xml.indexOf('<', index);
    if (open === -1) {
      const trailing = xml.slice(index);
      if (trailing.length > 0 && onEvent({ type: 'text', text: decodeXmlText(trailing) }) === false) {
        return;
      }
      return;
    }

    if (open > index) {
      const text = xml.slice(index, open);
      if (onEvent({ type: 'text', text: decodeXmlText(text) }) === false) return;
    }

    // Comments and CDATA are skipped wholesale; neither carries cell data.
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open + 9);
      const body = xml.slice(open + 9, end === -1 ? length : end);
      if (onEvent({ type: 'text', text: body }) === false) return;
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }

    const close = xml.indexOf('>', open);
    if (close === -1) return;

    let inner = xml.slice(open + 1, close);
    const closing = inner.startsWith('/');
    if (closing) inner = inner.slice(1);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);

    const space = inner.search(/[\s]/);
    const rawName = space === -1 ? inner : inner.slice(0, space);
    const attributeSource = space === -1 ? '' : inner.slice(space);

    const tag: XmlTag = {
      name: stripNamespace(rawName.trim()),
      attributes: attributeSource.length === 0 ? {} : parseAttributes(attributeSource),
      selfClosing,
      closing,
    };

    if (onEvent({ type: 'tag', tag }) === false) return;
    index = close + 1;
  }
}
