import * as React from 'react';
import { cn } from '@/lib/utils';

/** Shared by every text control, so inputs, selects and textareas match. */
export const controlClass = cn(
  'w-full rounded-md border border-(--color-input) bg-(--color-surface) text-sm shadow-xs transition-[border-color,box-shadow]',
  'placeholder:text-(--color-muted-foreground)/80',
  'hover:border-(--color-border-strong)',
  'focus-visible:outline-none focus-visible:border-(--color-ring) focus-visible:ring-3 focus-visible:ring-(--color-ring)/20',
  'aria-invalid:border-(--color-danger) aria-invalid:ring-(--color-danger)/20',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        controlClass,
        'flex h-9 px-3 py-1',
        'file:mr-3 file:rounded file:border-0 file:bg-(--color-muted) file:px-2 file:py-1 file:text-sm file:font-medium',
        type === 'file' && 'h-auto py-1.5',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
