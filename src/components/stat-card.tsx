import Link from 'next/link';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A real count, what it counts, and — when it is zero — where to start. */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  href,
  emptyCta,
}: {
  label: string;
  value: number | string | null;
  hint: string;
  icon: LucideIcon;
  href: string;
  /** Shown instead of the hint when the value is 0. */
  emptyCta?: string;
}) {
  const empty = value === 0;
  return (
    <Link
      href={href}
      className={cn(
        'group flex min-w-0 flex-col gap-2 rounded-xl border bg-(--color-card) p-4 shadow-xs transition-[border-color,box-shadow] sm:gap-3 sm:p-5',
        'hover:border-(--color-border-strong) hover:shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-(--color-muted-foreground)">{label}</span>
        <Icon className="size-4 text-(--color-muted-foreground)" aria-hidden />
      </div>
      <span className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
        {value === null ? '—' : typeof value === 'number' ? value.toLocaleString() : value}
      </span>
      <span
        className={cn(
          'flex items-center gap-1 text-sm',
          empty && emptyCta !== undefined
            ? 'font-medium text-(--color-primary)'
            : 'text-(--color-muted-foreground)',
        )}
      >
        {empty && emptyCta !== undefined ? emptyCta : hint}
        <ArrowRight
          className="size-3.5 opacity-0 transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100"
          aria-hidden
        />
      </span>
    </Link>
  );
}
