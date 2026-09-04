import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPreview, previewDocument, PREVIEW_SANDBOX } from '@/lib/templates/preview';
import { SAMPLE_CONTACT } from '@/lib/templates/render';
import { htmlToText } from '@/lib/templates/text';

/**
 * The preview.
 *
 * Two things are being proven here. First, that the preview shows what it should
 * — subject, preheader, sender, both bodies, personalised. Second, and more
 * importantly, that the containment is actually in place: an empty sandbox, a
 * deny-by-default CSP, and no path by which template HTML reaches the
 * application's own document.
 */

const template = {
  subject: 'Hello {{first_name}}',
  previewText: 'A note from {{company}}',
  html: '<p>Hi {{first_name}}, welcome to {{company}}.</p><p><a href="https://example.com">Read more</a></p>',
  text: 'Hi {{first_name}}, welcome to {{company}}.',
};

const sender = {
  from_name: 'Acme Mail',
  from_email: 'hello@acme.test',
  reply_to: 'support@acme.test',
};

describe('preview content', () => {
  it('shows the personalised subject, preheader and both bodies', () => {
    const preview = buildPreview({ template, sender });

    expect(preview.subject).toBe('Hello Sample');
    expect(preview.previewText).toBe('A note from Example Ltd');
    expect(preview.html).toContain('Hi Sample, welcome to Example Ltd.');
    expect(preview.text).toContain('Hi Sample, welcome to Example Ltd.');
  });

  it('shows the sender when there is one, and says so when there is not', () => {
    expect(buildPreview({ template, sender }).fromEmail).toBe('hello@acme.test');
    expect(buildPreview({ template, sender }).replyTo).toBe('support@acme.test');
    expect(buildPreview({ template }).fromEmail).toBeNull();
  });

  it('uses the sample contact when none is given, and says which was used', () => {
    const sample = buildPreview({ template });
    expect(sample.usedSampleContact).toBe(true);
    expect(sample.contactEmail).toBe(SAMPLE_CONTACT.email_normalized);
  });

  it('renders against a real contact when one is given', () => {
    const preview = buildPreview({
      template,
      contact: {
        email_normalized: 'jane@real.test',
        first_name: 'Jane',
        last_name: 'Doe',
        company: 'Real Co',
        website: null,
        phone: null,
        custom: {},
      },
    });

    expect(preview.usedSampleContact).toBe(false);
    expect(preview.subject).toBe('Hello Jane');
    expect(preview.html).toContain('Real Co');
    expect(preview.contactEmail).toBe('jane@real.test');
  });

  it('the HTML and text versions carry the same message', () => {
    const preview = buildPreview({ template });
    expect(htmlToText(preview.html)).toContain('Hi Sample, welcome to Example Ltd.');
    expect(preview.text).toContain('Hi Sample, welcome to Example Ltd.');
  });

  it('reports missing fields rather than hiding them', () => {
    const preview = buildPreview({
      template,
      contact: { ...SAMPLE_CONTACT, company: null },
    });
    expect(preview.missing).toContain('company');
  });

  it('reports a template problem rather than rendering it', () => {
    const preview = buildPreview({
      template: { ...template, html: '<p>{{nope}}</p>' },
    });
    expect(preview.issues.length).toBeGreaterThan(0);
  });
});

describe('containment', () => {
  it('the sandbox is empty — every restriction on', () => {
    expect(PREVIEW_SANDBOX).toBe('');
  });

  it('the document denies everything by default', () => {
    const doc = previewDocument('<p>hi</p>');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("default-src &#39;none&#39;");
    expect(doc).toContain("script-src &#39;none&#39;");
    expect(doc).toContain("object-src &#39;none&#39;");
    expect(doc).toContain("form-action &#39;none&#39;");
    expect(doc).toContain("base-uri &#39;none&#39;");
  });

  it('the document permits only images, fonts and inline styles', () => {
    const doc = previewDocument('<p>hi</p>');
    expect(doc).toContain('img-src https: data:');
    expect(doc).toContain("style-src &#39;unsafe-inline&#39;");
    // No `connect-src`, no `frame-src` beyond none: nothing can call out.
    expect(doc).not.toMatch(/connect-src\s+(?!'none')/);
  });

  it.each([
    ['a script element', '<p>hi</p><script>alert(1)</script>'],
    ['an inline handler', '<img src="x" onerror="alert(1)">'],
    ['a javascript link', '<a href="javascript:alert(1)">x</a>'],
    ['an iframe', '<iframe src="https://evil.test"></iframe>'],
    ['a form post', '<form action="https://evil.test"><input name="p"></form>'],
    ['an svg handler', '<svg onload="alert(1)"></svg>'],
    ['a style expression', '<div style="width:expression(alert(1))">x</div>'],
  ])('%s never reaches the preview document', (_label, payload) => {
    const preview = buildPreview({ template: { ...template, html: payload } });

    expect(preview.html).not.toMatch(/<script|<iframe|<form|<svg/i);
    expect(preview.html.toLowerCase()).not.toContain('onerror');
    expect(preview.html.toLowerCase()).not.toContain('onload');
    expect(preview.html).not.toContain('javascript:');
    expect(preview.html).not.toContain('expression(');

    expect(preview.document).not.toMatch(/<script[\s>]/i);
  });

  it('a payload arriving through a contact field is caught too', () => {
    // The template was sanitised when it was saved; the value was not yet in it.
    const preview = buildPreview({
      template: { ...template, html: '<p>{{company}}</p>' },
      contact: { ...SAMPLE_CONTACT, company: '<img src=x onerror=alert(1)>' },
    });
    // The payload survives as *text* — escaped, inert, and visibly not markup.
    expect(preview.html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(preview.html).not.toMatch(/<img/i);
  });

  it('the document is well formed and the body is the last thing in it', () => {
    const doc = previewDocument('<p>content</p>');
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc.endsWith('</body></html>')).toBe(true);
    expect(doc.indexOf('<p>content</p>')).toBeGreaterThan(doc.indexOf('<body>'));
  });

  it('sanitised content cannot close the body element early', () => {
    const preview = buildPreview({
      template: { ...template, html: '</body></html><script>alert(1)</script>' },
    });
    // `</body>` closes nothing that was opened, so it is dropped; the script is
    // removed with its content. What remains cannot escape the wrapper.
    expect(preview.document.match(/<\/body>/g)).toHaveLength(1);
  });
});

describe('the component that renders it', () => {
  const raw = readFileSync(join(process.cwd(), 'src/components/template-preview.tsx'), 'utf8');
  // Comments removed: the file explains at length why `allow-scripts` is absent,
  // and the check below is about the code, not the explanation.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('uses an iframe with srcDoc, never dangerouslySetInnerHTML', () => {
    expect(source).toContain('<iframe');
    expect(source).toContain('srcDoc');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });

  it('never grants the frame scripts or the application origin', () => {
    expect(source).not.toContain('allow-scripts');
    expect(source).not.toContain('allow-same-origin');
    expect(source).toContain('sandbox={PREVIEW_SANDBOX}');
  });

  it('is a Server Component — no client bundle carries template HTML', () => {
    expect(source).not.toMatch(/^\s*(['"])use client\1/m);
  });
});
