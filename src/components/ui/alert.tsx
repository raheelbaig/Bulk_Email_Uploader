import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Inline feedback. `destructive` is announced assertively (role="alert"); every
 * other tone is a polite status, so a page full of notices does not interrupt a
 * screen reader on load.
 */
const TONES = {
  default: {
    box: 'border-(--color-border) bg-(--color-surface-subtle) text-(--color-foreground)',
    icon: Info,
    iconClass: 'text-(--color-muted-foreground)',
  },
  info: {
    box: 'border-(--color-info-border) bg-(--color-info-subtle) text-(--color-info-foreground)',
    icon: Info,
    iconClass: 'text-(--color-info)',
  },
  success: {
    box: 'border-(--color-success-border) bg-(--color-success-subtle) text-(--color-success-foreground)',
    icon: CheckCircle2,
    iconClass: 'text-(--color-success)',
  },
  warning: {
    box: 'border-(--color-warning-border) bg-(--color-warning-subtle) text-(--color-warning-foreground)',
    icon: AlertTriangle,
    iconClass: 'text-(--color-warning)',
  },
  destructive: {
    box: 'border-(--color-danger-border) bg-(--color-danger-subtle) text-(--color-danger-foreground)',
    icon: XCircle,
    iconClass: 'text-(--color-danger)',
  },
} as const;

export type AlertTone = keyof typeof TONES;

export function Alert({
  className,
  tone = 'default',
  title,
  icon = true,
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  tone?: AlertTone;
  title?: React.ReactNode;
  icon?: boolean;
}) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <div
      role={tone === 'destructive' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed', t.box, className)}
      {...props}
    >
      {icon && <Icon className={cn('mt-0.5 size-4 shrink-0', t.iconClass)} aria-hidden />}
      <div className="min-w-0 flex-1">
        {title !== undefined && <p className="font-medium">{title}</p>}
        {children !== undefined && children !== null && (
          <div className={cn(title !== undefined && 'mt-0.5 opacity-90')}>{children}</div>
        )}
      </div>
    </div>
  );
}
