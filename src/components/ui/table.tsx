import * as React from 'react';
import { cn } from '@/lib/utils';

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn('border-b bg-[--color-muted]', className)} {...props} />;
}

export function TBody(props: React.ComponentProps<'tbody'>) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr className={cn('border-b last:border-0', className)} {...props} />;
}

export function TH({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[--color-muted-foreground]',
        className,
      )}
      {...props}
    />
  );
}

export function TD({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2 align-middle', className)} {...props} />;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-6 py-12 text-center text-sm text-[--color-muted-foreground]">
      {children}
    </div>
  );
}
