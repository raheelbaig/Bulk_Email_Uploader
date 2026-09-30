import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, fromSimpleHtml, toSimpleHtml } from '@/lib/templates/simple';
import { sanitizeHtml, sanitizerRemovedSomething } from '@/lib/templates/sanitize';
import { scanVariables } from '@/lib/templates/variables';

/**
 * The Simple editor turns plain text into template HTML in the browser. It adds
 * a way to write, not a way around the sanitiser: its output must already be
 * exactly what the sanitiser would store, text must never become markup, and
 * converting back must be lossless or refused.
 */
describe('toSimpleHtml', () => {
  it('turns paragraphs, line breaks, headings, bullets, bold and links into a small HTML subset', () => {
    const html = toSimpleHtml(
      ['# Hello', '', 'Line one', 'line two', '', '- a', '- **b**', '', 'See https://example.com/x?y=1.'].join('\n'),
    );
    expect(html).toBe(
      [
        '<h2>Hello</h2>',
        '<p>Line one<br />line two</p>',
        '<ul><li>a</li><li><strong>b</strong></li></ul>',
        '<p>See <a href="https://example.com/x?y=1">https://example.com/x?y=1</a>.</p>',
      ].join('\n'),
    );
  });

  it('escapes every character of the text, so it can never become a tag or attribute', () => {
    const html = toSimpleHtml('<script>alert(1)</script> & <img src=x onerror=alert(1)> "quoted"');
    // The only markup is the paragraph the converter added; the rest is text.
    expect(html.replace(/^<p>|<\/p>$/g, '')).not.toMatch(/[<>]/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('links only http(s) addresses, and a link cannot break out of its attribute', () => {
    expect(toSimpleHtml('javascript:alert(1)')).not.toContain('<a');
    expect(toSimpleHtml('data:text/html,hi')).not.toContain('<a');
    const tricky = toSimpleHtml('https://example.com/"onmouseover="alert(1)');
    // Every tag is exactly <p>, </p>, <a href="…"> or </a>: no second attribute.
    const tags = tricky.match(/<[^>]*>/g) ?? [];
    for (const tag of tags) expect(tag).toMatch(/^<(\/?p|\/a|a href="[^"<>]*")>$/);
  });

  it('produces output the sanitiser keeps exactly as it is', () => {
    const samples = [
      'Hi {{first_name}},\n\nThanks & welcome <3\n\n- one\n- two',
      '# Title\nBody straight after the heading',
      'Visit https://example.com/path?a=1&b=2 today',
      ...STARTER_TEMPLATES.map((starter) => starter.text),
    ];
    for (const text of samples) {
      const html = toSimpleHtml(text);
      const result = sanitizeHtml(html);
      expect(result.html).toBe(html);
      expect(sanitizerRemovedSomething(result.report)).toBe(false);
    }
  });

  it('leaves personalization fields for the variable scan to validate', () => {
    const html = toSimpleHtml('Hi {{first_name}} from {{custom.team}}');
    expect(html).toContain('{{first_name}}');
    const scan = scanVariables(html);
    expect(scan.names).toEqual(expect.arrayContaining(['first_name', 'custom.team']));
    expect(scan.problems).toEqual([]);
  });

  it('returns nothing for blank input, so the required check still applies', () => {
    expect(toSimpleHtml('   \n\n  ')).toBe('');
  });
});

describe('fromSimpleHtml', () => {
  it('round-trips anything toSimpleHtml produced', () => {
    for (const starter of STARTER_TEMPLATES) {
      const html = toSimpleHtml(starter.text);
      const back = fromSimpleHtml(html);
      expect(back).not.toBeNull();
      expect(toSimpleHtml(back!)).toBe(html);
    }
    expect(fromSimpleHtml(toSimpleHtml('A & B <c>'))).toBe('A & B <c>');
  });

  it('refuses HTML Simple mode could not show without losing something', () => {
    expect(fromSimpleHtml('<p style="color:red">Hi</p>')).toBeNull();
    expect(fromSimpleHtml('<p>Hi <img src="https://example.com/a.png" /></p>')).toBeNull();
    expect(fromSimpleHtml('<div><p>Hi</p></div>')).toBeNull();
    expect(fromSimpleHtml('<p><a href="https://example.com">Click here</a></p>')).toBeNull();
    expect(fromSimpleHtml('<h1>Big</h1>')).toBeNull();
  });

  it('accepts the CRLF line endings a form submission produces', () => {
    const html = toSimpleHtml(STARTER_TEMPLATES[0]!.text);
    const crlf = html.replace(/\n/g, '\r\n');
    expect(crlf).toContain('\r\n');
    expect(fromSimpleHtml(crlf)).not.toBeNull();
    expect(fromSimpleHtml(crlf)).toBe(fromSimpleHtml(html));
  });

  it('treats an empty body as empty text', () => {
    expect(fromSimpleHtml('')).toBe('');
  });
});
