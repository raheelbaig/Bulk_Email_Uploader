import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Native select. A Radix listbox would add a client component and a dependency
 * for a control that already works, is accessible, and matches the platform.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<'select'>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-9 rounded-md border bg-transparent px-2.5 text-sm shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-ring]',
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = 'Select';
