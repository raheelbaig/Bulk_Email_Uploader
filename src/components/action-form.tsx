'use client';

import { useActionState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { IDLE, type FormState } from '@/lib/form-state';

/**
 * A form bound to a server action, with pending state and a single place where
 * the result message is rendered.
 *
 * The action returns a user-safe message; this never sees an error object, so
 * there is no path by which a stack trace or a constraint name reaches the DOM.
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  children,
  className,
  variant,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  submitLabel: string;
  pendingLabel?: string;
  children?: React.ReactNode;
  className?: string;
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className={className ?? 'flex flex-col gap-3'}>
      {state.message !== null && (
        <Alert tone={state.ok ? 'default' : 'destructive'}>{state.message}</Alert>
      )}
      {children}
      <div>
        <Button type="submit" disabled={pending} size="sm" {...(variant ? { variant } : {})}>
          {pending ? (pendingLabel ?? 'Working…') : submitLabel}
        </Button>
      </div>
    </form>
  );
}
