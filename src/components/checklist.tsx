import Link from 'next/link';
import { ArrowRight, Check, X } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ChecklistItem {
  key: string;
  done: boolean;
  title: string;
  /** Shown when not done: what this step is and why it matters. */
  description?: string;
  /** Shown when done, in place of the description. */
  doneLabel?: string;
  action?: { href: string; label: string };
}

/**
 * A list of requirements with their real state. Used for workspace setup on
 * the dashboard and for "what you need before sending" on a campaign.
 *
 * `variant="steps"` numbers the open items (onboarding); `variant="requirements"`
 * marks them with ✕ (a blocker list).
 */
export function Checklist({
  items,
  variant = 'steps',
  highlightNext = true,
}: {
  items: ChecklistItem[];
  variant?: 'steps' | 'requirements';
  highlightNext?: boolean;
}) {
  const nextKey = highlightNext ? items.find((item) => !item.done)?.key : undefined;
  return (
    <ol className="flex flex-col divide-y">
      {items.map((item, index) => {
        const isNext = item.key === nextKey;
        return (
          <li
            key={item.key}
            className={cn(
              'flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-6',
              isNext && 'bg-(--color-primary-subtle)/40',
            )}
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span
                className={cn(
                  'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                  item.done
                    ? 'border-(--color-success) bg-(--color-success) text-white'
                    : variant === 'requirements'
                      ? 'border-(--color-danger-border) bg-(--color-danger-subtle) text-(--color-danger)'
                      : isNext
                        ? 'border-(--color-primary) text-(--color-primary)'
                        : 'border-(--color-border-strong) text-(--color-muted-foreground)',
                )}
              >
                {item.done ? (
                  <Check className="size-3.5" aria-hidden />
                ) : variant === 'requirements' ? (
                  <X className="size-3.5" aria-hidden />
                ) : (
                  index + 1
                )}
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    'text-sm font-medium',
                    item.done && variant === 'steps' && 'text-(--color-muted-foreground)',
                  )}
                >
                  {item.title}
                  <span className="sr-only">{item.done ? ' — done' : ' — to do'}</span>
                </p>
                {item.done
                  ? item.doneLabel !== undefined && (
                      <p className="text-sm text-(--color-muted-foreground)">{item.doneLabel}</p>
                    )
                  : item.description !== undefined && (
                      <p className="text-sm leading-relaxed text-(--color-muted-foreground)">{item.description}</p>
                    )}
              </div>
            </div>
            {!item.done && item.action !== undefined && (
              <Link
                href={item.action.href}
                className={cn(
                  buttonVariants({ variant: isNext ? 'default' : 'outline', size: 'sm' }),
                  'ml-9 w-fit sm:ml-0',
                )}
              >
                {item.action.label}
                <ArrowRight aria-hidden />
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** "3 of 6 complete" with a bar. */
export function ProgressSummary({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-(--color-muted-foreground) tabular-nums">
          {done} of {total} complete
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-(--color-muted)"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-(--color-success) transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
