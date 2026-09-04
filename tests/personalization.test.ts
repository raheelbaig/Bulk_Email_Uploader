import { describe, it, expect } from 'vitest';
import {
  contactVariableValues,
  renderString,
  renderTemplate,
  SAMPLE_CONTACT,
  type PersonalizationSource,
} from '@/lib/templates/render';
import { CUSTOM_PREFIX } from '@/lib/templates/variables';
import { columnMappingSchema } from '@/lib/imports/mapping';

/**
 * The personalization renderer.
 *
 * Three properties are load-bearing and each has its own section below: single
 * pass (no template injection), context-correct escaping (no XSS, no header
 * injection), and unknown variables as errors rather than silent gaps.
 */

const contact = (overrides: Partial<PersonalizationSource> = {}): PersonalizationSource => ({
  email_normalized: 'john@abc.test',
  first_name: 'John',
  last_name: 'Smith',
  company: 'ABC Ltd',
  website: 'https://abc.test',
  phone: null,
  custom: {},
  ...overrides,
});

describe('substitution', () => {
  it('replaces a single variable', () => {
    const result = renderString('Hello {{first_name}}', contactVariableValues(contact()), 'text');
    expect(result.output).toBe('Hello John');
  });

  it('replaces several variables in one string', () => {
    const result = renderString(
      'Hello {{first_name}} {{last_name}} of {{company}} — {{website}}',
      contactVariableValues(contact()),
      'text',
    );
    expect(result.output).toBe('Hello John Smith of ABC Ltd — https://abc.test');
  });

  it('derives full_name from the two name fields', () => {
    const values = contactVariableValues(contact());
    expect(renderString('{{full_name}}', values, 'text').output).toBe('John Smith');
  });

  it('ignores whitespace inside the braces', () => {
    expect(renderString('{{ first_name }}', contactVariableValues(contact()), 'text').output).toBe(
      'John',
    );
  });

  it('substitutes the same variable everywhere it appears', () => {
    const result = renderString(
      '{{first_name}}, {{first_name}}, {{first_name}}',
      contactVariableValues(contact()),
      'text',
    );
    expect(result.output).toBe('John, John, John');
  });
});

describe('missing values', () => {
  it('renders an empty string and reports the field', () => {
    const result = renderString(
      'Hello {{first_name}} at {{company}}',
      contactVariableValues(contact({ company: null })),
      'text',
    );
    expect(result.output).toBe('Hello John at ');
    expect(result.missing).toEqual(['company']);
  });

  it('treats an empty string as missing', () => {
    const result = renderString('{{company}}', contactVariableValues(contact({ company: '' })), 'text');
    expect(result.missing).toEqual(['company']);
  });

  it('does not report a field twice', () => {
    const result = renderString(
      '{{phone}} {{phone}}',
      contactVariableValues(contact({ phone: null })),
      'text',
    );
    expect(result.missing).toEqual(['phone']);
  });

  it('a missing value is not an error', () => {
    const result = renderString('{{phone}}', contactVariableValues(contact()), 'text');
    expect(result.issues).toEqual([]);
  });
});

describe('unknown and malformed variables', () => {
  it('an unknown variable is an error, and is left visible rather than dropped', () => {
    const result = renderString('Hello {{frist_name}}', contactVariableValues(contact()), 'text');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe('unknown_variable');
    // Left as written: a silently vanished tag is how "Hello ," reaches a list.
    expect(result.output).toBe('Hello {{frist_name}}');
  });

  it.each([
    ['an empty tag', '{{}}'],
    ['a tag with spaces in the name', '{{first name}}'],
    ['a field that is not exposed', '{{workspace_id}}'],
    ['a prototype key', '{{__proto__}}'],
  ])('%s is reported', (_label, source) => {
    const result = renderString(source, contactVariableValues(contact()), 'text');
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it.each([
    ['{{{first_name}}}'],
    ['{{#if admin}}secret{{/if}}'],
    ['{% for x in y %}{{ x }}{% endfor %}'],
    ['${process.env.SUPABASE_SERVICE_ROLE_KEY}'],
  ])('%s is refused as unsupported syntax', (source) => {
    const result = renderString(source, contactVariableValues(contact()), 'text');
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('template injection', () => {
  it('does not re-scan a substituted value', () => {
    // A contact whose company is literally a tag must get the text, not a second
    // substitution. Feeding output back into the parser is the whole attack.
    const result = renderString(
      'Company: {{company}}',
      contactVariableValues(contact({ company: '{{email}}' })),
      'text',
    );
    expect(result.output).toBe('Company: {{email}}');
    expect(result.output).not.toContain('john@abc.test');
  });

  it('does not evaluate anything a value contains', () => {
    const result = renderString(
      '{{company}}',
      contactVariableValues(contact({ company: '{{#if true}}pwned{{/if}}' })),
      'text',
    );
    expect(result.output).toBe('{{#if true}}pwned{{/if}}');
  });

  it('exposes only the projected fields, never the whole contact record', () => {
    const values = contactVariableValues({
      ...contact(),
      // Extra keys that a raw record would carry. The projection drops them.
      ...({ id: 'secret-id', workspace_id: 'secret-ws', status: 'active' } as object),
    } as PersonalizationSource);

    expect(Object.keys(values).sort()).toEqual([
      'company',
      'email',
      'first_name',
      'full_name',
      'last_name',
      'phone',
      'website',
    ]);
  });
});

describe('escaping', () => {
  it('HTML-escapes a value going into an HTML body', () => {
    const result = renderString(
      '<p>Hello {{first_name}}</p>',
      contactVariableValues(contact({ first_name: '<script>alert(1)</script>' })),
      'html',
    );
    expect(result.output).not.toContain('<script>');
    expect(result.output).toContain('&lt;script&gt;');
  });

  it('strips control characters from a value going into a subject', () => {
    const result = renderString(
      'Hi {{first_name}}',
      contactVariableValues(contact({ first_name: 'John\r\nBcc: victim@example.com' })),
      'subject',
    );
    expect(result.output).not.toMatch(/[\r\n]/);
  });

  it('leaves ordinary punctuation alone in the text body', () => {
    const result = renderString(
      '{{company}}',
      contactVariableValues(contact({ company: 'Smith & Sons <Ltd>' })),
      'text',
    );
    expect(result.output).toBe('Smith & Sons <Ltd>');
  });

  it('re-sanitises the HTML after substitution', () => {
    // The first sanitise pass saw `href="{{website}}"`, which is a safe relative
    // URL. The value is not safe. The second pass is what catches it.
    const rendered = renderTemplate(
      {
        subject: 'Hi',
        previewText: null,
        html: '<p><a href="{{website}}">visit</a></p>',
        text: 'visit',
      },
      contactVariableValues(contact({ website: 'javascript:alert(1)' })),
    );
    expect(rendered.html).not.toContain('javascript');
    expect(rendered.html).not.toContain('href=');
    expect(rendered.html).toContain('visit');
  });

  it('keeps a safe URL supplied by a variable', () => {
    const rendered = renderTemplate(
      { subject: 'Hi', previewText: null, html: '<p><a href="{{website}}">visit</a></p>', text: 'x' },
      contactVariableValues(contact()),
    );
    expect(rendered.html).toContain('href="https://abc.test"');
  });
});

describe('custom fields', () => {
  it('resolves a custom key', () => {
    const values = contactVariableValues(contact({ custom: { plan: 'Pro', seats: 12 } }));
    expect(renderString('{{custom.plan}} / {{custom.seats}}', values, 'text').output).toBe('Pro / 12');
  });

  it('coerces a boolean and refuses an object', () => {
    const values = contactVariableValues(contact({ custom: { active: true, meta: { a: 1 } } }));
    expect(renderString('{{custom.active}}', values, 'text').output).toBe('true');
    expect(renderString('{{custom.meta}}', values, 'text').missing).toEqual(['custom.meta']);
  });

  it('ignores a custom key that is not a legal variable name', () => {
    const values = contactVariableValues(contact({ custom: { 'Bad Key': 'x', __proto__: 'y' } }));
    expect(values[`${CUSTOM_PREFIX}Bad Key`]).toBeUndefined();
  });

  it('truncates a very long custom value', () => {
    const values = contactVariableValues(contact({ custom: { note: 'x'.repeat(5_000) } }));
    expect((values['custom.note'] ?? '').length).toBe(500);
  });

  it('accepts exactly the key shape the import engine can produce', () => {
    // The import mapping constrains custom keys to `^[a-z][a-z0-9_]*$`. A key
    // the importer can create but a template cannot address would be a field
    // nobody can use.
    const mapping = columnMappingSchema.parse({
      headerRow: 0,
      columns: [{ index: 0, header: 'Plan', target: { kind: 'custom', key: 'plan_name' } }],
    });
    const key = mapping.columns[0]?.target;
    expect(key?.kind).toBe('custom');

    const values = contactVariableValues(contact({ custom: { plan_name: 'Pro' } }));
    expect(renderString('{{custom.plan_name}}', values, 'text').output).toBe('Pro');
  });
});

describe('renderTemplate', () => {
  it('renders every part and gathers the problems once', () => {
    const rendered = renderTemplate(
      {
        subject: 'Hi {{first_name}}',
        previewText: '{{company}} update',
        html: '<p>Hello {{first_name}} at {{company}}</p>',
        text: 'Hello {{first_name}} at {{company}}',
      },
      contactVariableValues(contact()),
    );

    expect(rendered.subject).toBe('Hi John');
    expect(rendered.previewText).toBe('ABC Ltd update');
    expect(rendered.html).toContain('Hello John at ABC Ltd');
    expect(rendered.text).toBe('Hello John at ABC Ltd');
    expect(rendered.issues).toEqual([]);
    expect(rendered.missing).toEqual([]);
  });

  it('collects a problem once even when it appears in several parts', () => {
    const rendered = renderTemplate(
      {
        subject: '{{nope}}',
        previewText: null,
        html: '<p>{{nope}}</p>',
        text: '{{nope}}',
      },
      contactVariableValues(contact()),
    );
    expect(rendered.issues).toHaveLength(1);
  });

  it('is deterministic', () => {
    const template = {
      subject: 'Hi {{first_name}}',
      previewText: null,
      html: '<p>{{company}}</p>',
      text: '{{company}}',
    };
    const values = contactVariableValues(contact());
    expect(renderTemplate(template, values)).toEqual(renderTemplate(template, values));
  });
});

describe('the sample contact', () => {
  it('is obviously placeholder data', () => {
    // Someone reviewing a preview must never mistake sample output for a real
    // recipient's, and a realistic name is exactly how that happens.
    expect(SAMPLE_CONTACT.email_normalized).toContain('example.com');
    expect(SAMPLE_CONTACT.first_name).toBe('Sample');
  });

  it('fills every standard field, so a preview never shows a spurious gap', () => {
    const values = contactVariableValues(SAMPLE_CONTACT);
    for (const [name, value] of Object.entries(values)) {
      expect(value, `${name} should have a sample value`).toBeTruthy();
    }
  });
});
