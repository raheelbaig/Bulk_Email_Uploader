import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A titled block of a page: a heading that says what the block is for, an
 * optional explanation, then the content. Used for forms and grouped details
 * alike, so every page has the same rhythm.
 */
export function SectionCard({
  title,
  description,
  icon: Icon,
  actions,
  footer,
  children,
  className,
  bodyClassName,
  id,
  headingLevel = 2,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section id={id} className={cn('scroll-mt-24 rounded-xl border bg-(--color-card) shadow-xs', className)}>
      <div className="flex flex-col gap-3 px-5 pt-5 sm:flex-row sm:items-start sm:justify-between sm:px-6 sm:pt-6">
        <div className="flex min-w-0 gap-3">
          {Icon !== undefined && (
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-(--color-surface-subtle) text-(--color-muted-foreground)">
              <Icon className="size-4" aria-hidden />
            </div>
          )}
          <div className="min-w-0">
            <Heading className="text-base font-semibold tracking-tight">{title}</Heading>
            {description !== undefined && (
              <p className="mt-0.5 text-sm leading-relaxed text-(--color-muted-foreground)">{description}</p>
            )}
          </div>
        </div>
        {actions !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children !== undefined && <div className={cn('px-5 pt-4 pb-5 sm:px-6 sm:pb-6', bodyClassName)}>{children}</div>}
      {children === undefined && <div className="pb-5 sm:pb-6" />}
      {footer !== undefined && (
        <div className="flex flex-wrap items-center gap-3 rounded-b-xl border-t bg-(--color-surface-subtle) px-5 py-3 sm:px-6">
          {footer}
        </div>
      )}
    </section>
  );
}
