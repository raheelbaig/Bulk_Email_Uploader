import * as React from 'react';
import { cn } from '@/lib/utils';

export function Alert({
  className,
  tone = 'default',
  ...props
}: React.ComponentProps<'div'> & { tone?: 'default' | 'destructive' }) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border px-4 py-3 text-sm',
        tone === 'destructive'
          ? 'border-[--color-destructive] text-[--color-destructive]'
          : 'bg-[--color-muted]',
        className,
      )}
      {...props}
    />
  );
}
