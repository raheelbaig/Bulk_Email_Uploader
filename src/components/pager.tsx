import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Keyset pagination controls.
 *
 * Cursors are opaque strings carried in the URL, so a page is linkable and the
 * back button behaves. There are no page numbers because there is no total —
 * counting every row on every page load is the scan this design avoids.
 */
export function Pager({
  basePath,
  params,
  nextCursor,
  prevCursor,
  showing,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  nextCursor: string | null;
  prevCursor: string | null;
  showing: number;
}) {
  const href = (cursor: string, direction: 'forward' | 'backward') => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value.length > 0) search.set(key, value);
    }
    search.set('cursor', cursor);
    search.set('dir', direction);
    return `${basePath}?${search.toString()}`;
  };

  const linkClass = 'inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-sm';
  const disabledClass = 'pointer-events-none opacity-40';

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-xs text-[--color-muted-foreground]">
        Showing {showing} {showing === 1 ? 'row' : 'rows'}
      </p>
      <div className="flex items-center gap-2">
        {prevCursor === null ? (
          <span className={cn(linkClass, disabledClass)} aria-disabled="true">
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Previous
          </span>
        ) : (
          <Link href={href(prevCursor, 'backward')} className={linkClass}>
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Previous
          </Link>
        )}
        {nextCursor === null ? (
          <span className={cn(linkClass, disabledClass)} aria-disabled="true">
            Next <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        ) : (
          <Link href={href(nextCursor, 'forward')} className={linkClass}>
            Next <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </div>
  );
}
