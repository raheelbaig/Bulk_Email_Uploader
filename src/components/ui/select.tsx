import * as React from 'react';
import { cn } from '@/lib/utils';
import { controlClass } from './input';

/**
 * Native select. A Radix listbox would add a client component and a dependency
 * for a control that already works, is accessible, and matches the platform.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<'select'>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn(controlClass, 'h-9 w-auto max-w-full px-2.5', className)} {...props} />
  ),
);
Select.displayName = 'Select';
