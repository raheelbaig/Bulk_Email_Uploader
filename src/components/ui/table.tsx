import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Tables scroll inside their own frame, never the page: a wide table at 320px
 * scrolls sideways within the card while the page itself stays put.
 */
export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full max-w-full overflow-x-auto rounded-xl border bg-(--color-card) shadow-xs">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn('border-b bg-(--color-surface-subtle)', className)} {...props} />;
}

export function TBody(props: React.ComponentProps<'tbody'>) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'border-b transition-colors last:border-0 in-[tbody]:hover:bg-(--color-surface-subtle)',
        className,
      )}
      {...props}
    />
  );
}

export function TH({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn(
        'h-10 px-4 text-left align-middle text-xs font-medium whitespace-nowrap text-(--color-muted-foreground)',
        className,
      )}
      {...props}
    />
  );
}

export function TD({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('px-4 py-3 align-middle', className)} {...props} />;
}

export { EmptyState } from './empty-state';
