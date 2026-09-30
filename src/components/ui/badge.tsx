import * as React from 'react';
import { cn } from '@/lib/utils';

const TONES = {
  neutral: 'border-(--color-border) bg-(--color-muted) text-(--color-muted-foreground)',
  positive: 'border-(--color-success-border) bg-(--color-success-subtle) text-(--color-success-foreground)',
  warning: 'border-(--color-warning-border) bg-(--color-warning-subtle) text-(--color-warning-foreground)',
  danger: 'border-(--color-danger-border) bg-(--color-danger-subtle) text-(--color-danger-foreground)',
  info: 'border-(--color-info-border) bg-(--color-info-subtle) text-(--color-info-foreground)',
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: React.ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        '[&_svg]:size-3 [&_svg]:shrink-0',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
