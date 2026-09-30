import * as React from 'react';
import { cn } from '@/lib/utils';
import { controlClass } from './input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(controlClass, 'min-h-24 px-3 py-2 font-mono leading-relaxed', className)}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
