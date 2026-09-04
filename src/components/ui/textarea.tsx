import * as React from 'react';
import { cn } from '@/lib/utils';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm',
        'font-mono leading-relaxed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-ring]',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
