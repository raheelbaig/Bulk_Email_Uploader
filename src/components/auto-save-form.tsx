'use client';

import { startTransition, useActionState, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { IDLE, type FormState } from '@/lib/form-state';

/**
 * A form that saves itself when one of its fields changes.
 *
 * Used by the campaign builder, where a person picks a list, a template, a
 * sender and a send time and should not have to find a separate Save button
 * for each. It submits through the same server action and the same validation
 * as a Save button would — there is no client-side write path.
 *
 * The status line reports the server's answer, not an optimistic guess:
 * "Saved" appears only after the action returned ok for the value on screen.
 * A refusal is shown beside the field and the value is left as typed so the
 * person can correct it.
 *
 *   select, date/time   saved on `change`
 *   text                saved on blur (or Enter), and only if it changed
 *
 * Until JavaScript has loaded, an ordinary Save button is shown instead, so
 * the form still works — and never claims to save — without it.
 */
export function AutoSaveForm({
  action,
  children,
  className,
  savedLabel = 'Saved',
  statusId,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  children: React.ReactNode;
  className?: string;
  savedLabel?: string;
  /** id for the status line, so a field can reference it with aria-describedby. */
  statusId?: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  const lastSubmitted = useRef<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const timer = useRef<number | null>(null);

  const cancelTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancelTimer, []);

  useEffect(() => {
    setHydrated(true);
    const form = formRef.current;
    if (form !== null) lastSubmitted.current = serialize(form);
  }, []);

  const save = () => {
    cancelTimer();
    const form = formRef.current;
    if (form === null) return;
    const snapshot = serialize(form);
    if (snapshot === lastSubmitted.current) {
      setDirty(false);
      return;
    }
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    lastSubmitted.current = snapshot;
    setDirty(false);
    const data = new FormData(form);
    startTransition(() => formAction(data));
  };

  const onChange = (event: React.FormEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const isText = target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'search');
    if (isText) {
      setDirty(true);
      return;
    }
    // Typing a date fires a change per segment; wait for a pause (or blur).
    if (target instanceof HTMLInputElement && target.type === 'datetime-local') {
      setDirty(true);
      cancelTimer();
      timer.current = window.setTimeout(save, 900);
      return;
    }
    save();
  };

  const onBlur = (event: React.FocusEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'datetime-local')) save();
  };

  // A failed save is not "saved": let the same value be tried again.
  useEffect(() => {
    if (!pending && !state.ok && state.message !== null) lastSubmitted.current = null;
  }, [pending, state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      onChange={hydrated ? onChange : undefined}
      onBlur={hydrated ? onBlur : undefined}
      onSubmit={
        hydrated
          ? (event) => {
              event.preventDefault();
              save();
            }
          : undefined
      }
      className={className ?? 'flex flex-col gap-2'}
    >
      {children}
      <div className="flex min-h-5 flex-wrap items-center gap-2">
        {!hydrated && (
          <Button type="submit" size="sm" variant="outline">
            Save
          </Button>
        )}
        <p
          id={statusId}
          role="status"
          aria-live="polite"
          className={cn(
            'flex items-center gap-1.5 text-sm',
            !pending && !state.ok && state.message !== null
              ? 'text-(--color-danger)'
              : 'text-(--color-muted-foreground)',
          )}
        >
          {pending ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Saving…
            </>
          ) : dirty ? (
            'Not saved yet — press Enter or leave the field to save.'
          ) : state.message !== null && !state.ok ? (
            <>
              <AlertCircle className="size-3.5 shrink-0" aria-hidden />
              {state.message}
            </>
          ) : state.ok ? (
            <>
              <Check className="size-3.5 text-(--color-success)" aria-hidden />
              {savedLabel}
            </>
          ) : null}
        </p>
      </div>
    </form>
  );
}

function serialize(form: HTMLFormElement): string {
  const pairs: string[] = [];
  new FormData(form).forEach((value, key) => {
    pairs.push(`${key}=${typeof value === 'string' ? value : ''}`);
  });
  return pairs.join('&');
}
