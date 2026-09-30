import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Every page opens the same way: where you are, what this page is for, and the
 * one primary action. `back` is for detail pages, so the way out is always in
 * the same place.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  /** Small items beside the title — a status badge, for instance. */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-col gap-4', className)}>
      {back !== undefined && (
        <Link
          href={back.href}
          className="-ml-1 inline-flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-sm text-(--color-muted-foreground) transition-colors hover:text-(--color-foreground) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words">{title}</h1>
            {meta}
          </div>
          {description !== undefined && (
            <p className="mt-1.5 max-w-2xl text-[0.9375rem] leading-relaxed text-(--color-muted-foreground)">
              {description}
            </p>
          )}
        </div>
        {actions !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
