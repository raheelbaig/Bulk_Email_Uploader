'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { Code2, Type } from 'lucide-react';
import { FieldShell } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { STARTER_TEMPLATES, fromSimpleHtml, toSimpleHtml } from '@/lib/templates/simple';
import { htmlToText } from '@/lib/templates/text';
import { STANDARD_VARIABLES, VARIABLE_LABEL } from '@/lib/templates/variables';

type Mode = 'simple' | 'html';

/**
 * The body of a template: a plain-text "Simple" editor for most people, and the
 * raw HTML editor under "Advanced HTML".
 *
 * Whichever mode is showing, the form submits exactly one field named `html`
 * (and, in Advanced mode, the optional plain-text version as `text`). In Simple
 * mode `html` is `toSimpleHtml(text)` — escaped paragraphs — and `text` is sent
 * blank so the server derives the plain-text version from the HTML, as it does
 * for any blank `text`. The server sanitises and validates either way; this
 * component adds a way to write, not a way around a check.
 *
 * An existing template opens in Simple mode only when that is lossless
 * (`fromSimpleHtml`), so custom HTML is never silently flattened. Leaving
 * Advanced mode with such HTML asks first.
 */
export function TemplateBodyEditor({
  defaultHtml = '',
  defaultText = '',
  showStarters = false,
}: {
  defaultHtml?: string;
  defaultText?: string;
  /** Offer starting layouts while the body is empty (new templates). */
  showStarters?: boolean;
}) {
  const initialSimple = useMemo(() => fromSimpleHtml(defaultHtml), [defaultHtml]);
  const [mode, setMode] = useState<Mode>(initialSimple === null ? 'html' : 'simple');
  const [simpleText, setSimpleText] = useState(initialSimple ?? '');
  const [html, setHtml] = useState(defaultHtml);
  const [plainText, setPlainText] = useState(defaultText);
  const [confirmFlatten, setConfirmFlatten] = useState(false);
  const simpleRef = useRef<HTMLTextAreaElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const baseId = useId();
  const simpleHint = `${baseId}-simple-hint`;

  const switchTo = (next: Mode) => {
    if (next === mode) return;
    setConfirmFlatten(false);
    if (next === 'html') {
      setHtml(toSimpleHtml(simpleText));
      setPlainText('');
      setMode('html');
      return;
    }
    const text = fromSimpleHtml(html);
    if (text === null) {
      setConfirmFlatten(true);
      return;
    }
    setSimpleText(text);
    setMode('simple');
  };

  const flatten = () => {
    setSimpleText(htmlToText(html));
    setConfirmFlatten(false);
    setMode('simple');
  };

  /** Inserts a personalization field at the cursor of whichever editor is showing. */
  const insert = (token: string) => {
    const area = mode === 'simple' ? simpleRef.current : htmlRef.current;
    const setValue = mode === 'simple' ? setSimpleText : setHtml;
    if (area === null) return;
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? area.value.length;
    const next = `${area.value.slice(0, start)}${token}${area.value.slice(end)}`;
    setValue(next);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const generated = mode === 'simple' ? toSimpleHtml(simpleText) : '';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={`${baseId}-label`} className="text-sm font-medium">
          Email content
        </span>
        <div
          role="radiogroup"
          aria-labelledby={`${baseId}-label`}
          className="inline-flex rounded-lg border bg-(--color-surface-subtle) p-0.5"
        >
          {(
            [
              { value: 'simple', label: 'Simple', icon: Type },
              { value: 'html', label: 'Advanced HTML', icon: Code2 },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={mode === option.value}
              onClick={() => switchTo(option.value)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)',
                mode === option.value
                  ? 'bg-(--color-surface) text-(--color-foreground) shadow-xs'
                  : 'text-(--color-muted-foreground) hover:text-(--color-foreground)',
              )}
            >
              <option.icon className="size-3.5" aria-hidden />
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {confirmFlatten && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-(--color-warning-border) bg-(--color-warning-subtle) p-3 text-sm">
          <p>
            This email uses formatting that Simple mode can’t show (such as styling, images or layout). Switching
            keeps the words but removes that formatting.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirmFlatten(false)}>
              Stay in Advanced HTML
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={flatten}>
              Switch and remove formatting
            </Button>
          </div>
        </div>
      )}

      {mode === 'simple' ? (
        <>
          {showStarters && simpleText.trim().length === 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-(--color-muted-foreground)">Start from a layout, or just start typing.</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {STARTER_TEMPLATES.map((starter) => (
                  <button
                    key={starter.key}
                    type="button"
                    onClick={() => {
                      setSimpleText(starter.text);
                      requestAnimationFrame(() => simpleRef.current?.focus());
                    }}
                    className="flex flex-col items-start gap-0.5 rounded-lg border bg-(--color-surface) px-3 py-2.5 text-left transition-colors hover:bg-(--color-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
                  >
                    <span className="text-sm font-medium">{starter.label}</span>
                    <span className="text-xs text-(--color-muted-foreground)">{starter.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <label htmlFor={`${baseId}-simple`} className="sr-only">
            Email content
          </label>
          <Textarea
            ref={simpleRef}
            id={`${baseId}-simple`}
            required
            rows={14}
            value={simpleText}
            onChange={(event) => setSimpleText(event.target.value)}
            aria-describedby={simpleHint}
            className="font-sans text-sm"
            placeholder={'Hi {{first_name}},\n\nWrite your email here…'}
          />
          <input type="hidden" name="html" value={generated} />
          <input type="hidden" name="text" value="" />
          <div id={simpleHint} className="rounded-lg bg-(--color-surface-subtle) px-3 py-2.5 text-xs leading-relaxed text-(--color-muted-foreground)">
            Leave a blank line between paragraphs. Start a line with <code className="font-mono"># </code> for a
            heading or <code className="font-mono">- </code> for a bullet point. Wrap words in{' '}
            <code className="font-mono">**double asterisks**</code> to make them bold. Web addresses starting with
            https:// become links. A plain-text version is created for you.
          </div>
        </>
      ) : (
        <>
          <FieldShell
            id={`${baseId}-html`}
            label="HTML"
            required
            hint="For your safety, scripts, embedded frames and unsafe links are removed when you save."
          >
            <Textarea
              ref={htmlRef}
              id={`${baseId}-html`}
              name="html"
              required
              rows={16}
              value={html}
              onChange={(event) => setHtml(event.target.value)}
              aria-describedby={`${baseId}-html-hint`}
              className="font-mono text-xs"
              placeholder={'<p>Hello {{first_name}},</p>\n<p>…</p>'}
            />
          </FieldShell>
          <details className="rounded-lg border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Plain-text version (optional)</summary>
            <div className="mt-2">
              <FieldShell
                id={`${baseId}-text`}
                label="Plain-text version"
                hint="Some inboxes show only this version. Leave it empty and it’s created from your HTML when you save."
              >
                <Textarea
                  id={`${baseId}-text`}
                  name="text"
                  rows={6}
                  value={plainText}
                  onChange={(event) => setPlainText(event.target.value)}
                  aria-describedby={`${baseId}-text-hint`}
                />
              </FieldShell>
            </div>
          </details>
        </>
      )}

      <div className="rounded-lg border bg-(--color-surface-subtle) px-3 py-2.5">
        <p className="text-sm font-medium">Personalize</p>
        <p className="mt-0.5 text-xs text-(--color-muted-foreground)">
          Click a field to add it where your cursor is. It’s replaced with each person’s details when the email is
          sent.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STANDARD_VARIABLES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => insert(`{{${name}}}`)}
              className="rounded-md border bg-(--color-surface) px-2 py-1 text-xs font-medium transition-colors hover:bg-(--color-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
              aria-label={`Insert ${VARIABLE_LABEL[name]}`}
            >
              {VARIABLE_LABEL[name]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-(--color-muted-foreground)">
          Extra columns from your imports can be used too, written as{' '}
          <code className="font-mono">{'{{custom.column_name}}'}</code>.
        </p>
      </div>
    </div>
  );
}
