import Link from 'next/link';
import { AlertTriangle, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StepState = 'complete' | 'current' | 'attention' | 'upcoming';

export interface StepItem {
  label: string;
  state: StepState;
  /** In-page anchor or route; a step without one is not clickable. */
  href?: string;
}

const STATE_LABEL: Record<StepState, string> = {
  complete: 'complete',
  current: 'current step',
  attention: 'needs attention',
  upcoming: 'not started',
};

/**
 * A horizontal progress indicator. On small screens it becomes a scrollable
 * row whose right edge fades out, so it is visible that more steps follow; the
 * trailing padding lets the last step scroll clear of the fade. Each step's
 * state is spelled out for screen readers.
 */
export function Stepper({ steps, className }: { steps: StepItem[]; className?: string }) {
  return (
    <nav
      aria-label="Progress"
      className={cn(
        'relative w-full overflow-x-auto',
        'max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)]',
        className,
      )}
    >
      <ol className="flex min-w-max items-center gap-1 max-sm:pr-10 sm:min-w-0 sm:flex-wrap">
        {steps.map((step, index) => {
          const inner = (
            <>
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
                  step.state === 'complete' && 'border-(--color-success) bg-(--color-success) text-white',
                  step.state === 'current' &&
                    'border-(--color-primary) bg-(--color-primary) text-(--color-primary-foreground)',
                  step.state === 'attention' &&
                    'border-(--color-warning-border) bg-(--color-warning-subtle) text-(--color-warning-foreground)',
                  step.state === 'upcoming' && 'border-(--color-border-strong) text-(--color-muted-foreground)',
                )}
              >
                {step.state === 'complete' ? (
                  <Check className="size-3.5" aria-hidden />
                ) : step.state === 'attention' ? (
                  <AlertTriangle className="size-3" aria-hidden />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  'text-sm whitespace-nowrap',
                  step.state === 'current' ? 'font-semibold' : 'font-medium',
                  step.state === 'upcoming' && 'text-(--color-muted-foreground)',
                )}
              >
                {step.label}
              </span>
              <span className="sr-only">({STATE_LABEL[step.state]})</span>
            </>
          );
          return (
            <li key={step.label} className="flex items-center gap-1">
              {step.href !== undefined ? (
                <Link
                  href={step.href}
                  aria-current={step.state === 'current' ? 'step' : undefined}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-(--color-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
                >
                  {inner}
                </Link>
              ) : (
                <span
                  aria-current={step.state === 'current' ? 'step' : undefined}
                  className="flex items-center gap-2 px-2 py-1.5"
                >
                  {inner}
                </span>
              )}
              {index < steps.length - 1 && (
                <span
                  aria-hidden
                  className={cn(
                    'h-px w-4 sm:w-6 lg:w-10',
                    step.state === 'complete' ? 'bg-(--color-success)' : 'bg-(--color-border-strong)',
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
