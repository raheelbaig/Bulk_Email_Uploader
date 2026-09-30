import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
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
  noun = 'row',
  plural = `${noun}s`,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  nextCursor: string | null;
  prevCursor: string | null;
  showing: number;
  noun?: string;
  plural?: string;
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

  if (prevCursor === null && nextCursor === null) {
    return (
      <p className="text-sm text-(--color-muted-foreground)">
        {showing.toLocaleString()} {showing === 1 ? noun : plural}
      </p>
    );
  }

  const linkClass = cn(buttonVariants({ variant: 'outline', size: 'sm' }));

  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-4">
      <p className="text-sm text-(--color-muted-foreground)">
        Showing {showing.toLocaleString()} {showing === 1 ? noun : plural}
      </p>
      <div className="flex items-center gap-2">
        {prevCursor === null ? (
          <span className={linkClass} aria-disabled="true">
            <ChevronLeft aria-hidden /> Previous
          </span>
        ) : (
          <Link href={href(prevCursor, 'backward')} className={linkClass}>
            <ChevronLeft aria-hidden /> Previous
          </Link>
        )}
        {nextCursor === null ? (
          <span className={linkClass} aria-disabled="true">
            Next <ChevronRight aria-hidden />
          </span>
        ) : (
          <Link href={href(nextCursor, 'forward')} className={linkClass}>
            Next <ChevronRight aria-hidden />
          </Link>
        )}
      </div>
    </nav>
  );
}
