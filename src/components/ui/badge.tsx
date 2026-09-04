import * as React from 'react';
import { cn } from '@/lib/utils';

const TONES = {
  neutral: 'bg-[--color-muted] text-[--color-muted-foreground]',
  positive: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  danger: 'bg-red-500/10 text-red-700 dark:text-red-400',
} as const;

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: React.ComponentProps<'span'> & { tone?: keyof typeof TONES }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
