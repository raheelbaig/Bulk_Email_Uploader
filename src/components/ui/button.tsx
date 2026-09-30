import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * One button system for the whole app.
 *
 * `default` is the page's primary action — there should be one per view.
 * `secondary` and `outline` support it, `ghost` is for low-priority actions,
 * `destructive` is reserved for deleting or cancelling something.
 */
const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium',
    'transition-[background-color,border-color,color,box-shadow] duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) focus-visible:ring-offset-2 focus-visible:ring-offset-(--color-background)',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        default:
          'bg-(--color-primary) text-(--color-primary-foreground) shadow-xs hover:bg-(--color-primary-hover)',
        secondary:
          'bg-(--color-primary-subtle) text-(--color-primary-subtle-foreground) hover:bg-(--color-primary-subtle)/70',
        outline:
          'border border-(--color-border-strong) bg-(--color-surface) text-(--color-foreground) shadow-xs hover:bg-(--color-muted)',
        ghost: 'text-(--color-foreground) hover:bg-(--color-muted)',
        destructive: 'bg-(--color-danger) text-white shadow-xs hover:opacity-90',
        link: 'h-auto px-0 text-(--color-primary) underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 text-sm',
        sm: 'h-8 px-3 text-sm [&_svg]:size-3.5',
        lg: 'h-10 px-5 text-sm',
        icon: 'size-9',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
