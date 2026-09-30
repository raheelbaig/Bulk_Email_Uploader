import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * What a section is, why it matters, and the one thing to do next.
 *
 * `title` + `description` + `action` is the full form. Passing only children is
 * the compact form, for a sub-section that is empty (a filter with no matches).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  children,
  className,
  compact = false,
}: {
  icon?: LucideIcon;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center rounded-xl border border-dashed border-(--color-border-strong) bg-(--color-surface) text-center',
        compact ? 'px-6 py-8' : 'px-6 py-12 sm:py-16',
        className,
      )}
    >
      {Icon !== undefined && (
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl border bg-(--color-surface-subtle) text-(--color-muted-foreground) shadow-xs">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      {title !== undefined && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
      {description !== undefined && (
        <p className="mt-1.5 max-w-md text-sm leading-relaxed text-(--color-muted-foreground)">{description}</p>
      )}
      {children !== undefined && (
        <div className="max-w-md text-sm leading-relaxed text-(--color-muted-foreground)">{children}</div>
      )}
      {(action !== undefined || secondaryAction !== undefined) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
