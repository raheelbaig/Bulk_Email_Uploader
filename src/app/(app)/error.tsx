'use client';

import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';

/**
 * Error boundary for pages inside the app shell, so the navigation stays usable
 * when one page fails. Next.js strips server error details in production; this
 * shows a plain statement and the digest, the correlation handle for the log.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl border border-(--color-danger-border) bg-(--color-danger-subtle) text-(--color-danger)">
          <AlertTriangle className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-(--color-muted-foreground)">
            We couldn’t load this page. Please try again. If it keeps happening, share the reference below
            with your administrator.
          </p>
        </div>
        {error.digest !== undefined && (
          <code className="rounded-md border bg-(--color-muted) px-2 py-1 text-xs">Reference: {error.digest}</code>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={reset}>
            <RotateCcw aria-hidden />
            Try again
          </Button>
          <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
