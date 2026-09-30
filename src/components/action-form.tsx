'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { IDLE, type FormState } from '@/lib/form-state';

/** Text for one confirmation dialog. */
export interface ConfirmCopy {
  title: string;
  /** What will happen. One or two plain sentences. */
  description: string;
  /** Shown as its own line when the action cannot be reversed. */
  irreversible?: boolean;
  /** Label of the button that carries out the action. Defaults to the submit label. */
  confirmLabel?: string;
}

/**
 * Asks before an action that destroys or permanently changes something.
 *
 * `byField` picks different copy from the value of one of the form's own fields
 * at the moment the person submits — the "block an address" form uses it so an
 * unsubscribe, which is permanent, says so while a reversible block does not.
 */
export interface ConfirmSpec extends ConfirmCopy {
  byField?: { name: string; values: Record<string, ConfirmCopy> };
}

/**
 * A form bound to a server action, with pending state and a single place where
 * the result message is rendered.
 *
 * The action returns a user-safe message; this never sees an error object, so
 * there is no path by which a stack trace or a constraint name reaches the DOM.
 *
 * With `confirm`, the visible button only opens a native modal <dialog> (focus
 * moves into it and is trapped there, Escape closes it, the page behind is
 * inert). The dialog sits inside the form, so its Confirm button submits exactly
 * the same fields to exactly the same action — confirmation adds a step, never a
 * second code path. If the action refuses, the reason is shown in the dialog.
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  children,
  className,
  variant,
  size = 'sm',
  submitIcon,
  extraActions,
  actionsClassName,
  confirm,
  successMessageMs,
  submitDisabled = false,
  submitDescribedBy,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  submitLabel: string;
  pendingLabel?: string;
  children?: React.ReactNode;
  className?: string;
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'sm' | 'default';
  submitIcon?: React.ReactNode;
  /** Rendered beside the submit button, e.g. a Cancel link. */
  extraActions?: React.ReactNode;
  actionsClassName?: string;
  confirm?: ConfirmSpec;
  /** Hide a success message after this many milliseconds. */
  successMessageMs?: number;
  /** Disable the submit button; say why in an element named by `submitDescribedBy`. */
  submitDisabled?: boolean;
  submitDescribedBy?: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copy, setCopy] = useState<ConfirmCopy | null>(null);
  const [hiddenState, setHiddenState] = useState<FormState | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // A successful confirmed action closes its dialog; a refusal keeps it open
  // with the reason, so the person sees why nothing happened.
  useEffect(() => {
    if (confirm === undefined || pending) return;
    if (state.ok && dialogRef.current?.open === true) dialogRef.current.close();
  }, [state, pending, confirm]);

  useEffect(() => {
    if (successMessageMs === undefined || !state.ok || state.message === null) return;
    const timer = window.setTimeout(() => setHiddenState(state), successMessageMs);
    return () => window.clearTimeout(timer);
  }, [state, successMessageMs]);

  const openConfirm = () => {
    const form = formRef.current;
    const dialog = dialogRef.current;
    if (form === null || dialog === null || confirm === undefined) return;
    // Let the browser report a missing required field before asking to confirm.
    if (!form.reportValidity()) return;
    let chosen: ConfirmCopy = confirm;
    if (confirm.byField !== undefined) {
      const value = new FormData(form).get(confirm.byField.name);
      const specific = typeof value === 'string' ? confirm.byField.values[value] : undefined;
      if (specific !== undefined) chosen = specific;
    }
    setCopy(chosen);
    setHiddenState(state);
    setDialogOpen(true);
    dialog.showModal();
    // Start on the safe choice, so an accidental Enter does not confirm.
    cancelRef.current?.focus();
  };

  const showMessage = state.message !== null && hiddenState !== state;
  const message = showMessage
    ? state.ok
      ? <Alert tone="success">{state.message}</Alert>
      : (
          <Alert tone="destructive" title="Something needs your attention">
            {state.message}
          </Alert>
        )
    : null;
  const shown = copy ?? confirm ?? null;

  return (
    <form ref={formRef} action={formAction} className={className ?? 'flex flex-col gap-4'}>
      {!dialogOpen && message}
      {children}
      <div className={cn('flex flex-wrap items-center gap-2', actionsClassName)}>
        {confirm === undefined ? (
          <Button
            type="submit"
            disabled={pending || submitDisabled}
            size={size}
            aria-describedby={submitDescribedBy}
            {...(variant ? { variant } : {})}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : submitIcon}
            {pending ? (pendingLabel ?? 'Working…') : submitLabel}
          </Button>
        ) : (
          <Button
            ref={triggerRef}
            type="button"
            onClick={openConfirm}
            disabled={pending || submitDisabled}
            aria-describedby={submitDescribedBy}
            size={size}
            aria-haspopup="dialog"
            {...(variant ? { variant } : {})}
          >
            {submitIcon}
            {submitLabel}
          </Button>
        )}
        {extraActions}
      </div>

      {confirm !== undefined && shown !== null && (
        <dialog
          ref={dialogRef}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="confirm-dialog m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border bg-(--color-card) p-0 text-left text-(--color-foreground) shadow-lg"
          onClose={() => {
            setDialogOpen(false);
            triggerRef.current?.focus();
          }}
          onClick={(event) => {
            // A click on the backdrop lands on the dialog element itself.
            if (event.target === event.currentTarget && !pending) event.currentTarget.close();
          }}
          onCancel={(event) => {
            // Escape must not abandon an action that is already running.
            if (pending) event.preventDefault();
          }}
        >
          <div className="flex flex-col gap-4 p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-(--color-danger-subtle) text-(--color-danger)">
                <AlertTriangle className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 whitespace-normal">
                <h2 id={titleId} className="text-base font-semibold tracking-tight">
                  {shown.title}
                </h2>
                <div id={descriptionId} className="mt-1 flex flex-col gap-1.5 text-sm leading-relaxed text-(--color-muted-foreground)">
                  <p>{shown.description}</p>
                  {shown.irreversible === true && (
                    <p className="font-medium text-(--color-foreground)">This can’t be undone.</p>
                  )}
                </div>
              </div>
            </div>
            {dialogOpen && message}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => dialogRef.current?.close()}
                ref={cancelRef}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending && <Loader2 className="animate-spin" aria-hidden />}
                {pending ? (pendingLabel ?? 'Working…') : (shown.confirmLabel ?? submitLabel)}
              </Button>
            </div>
          </div>
        </dialog>
      )}
    </form>
  );
}
