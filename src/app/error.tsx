'use client';

import { Button } from '@/components/ui/button';

/**
 * Production error boundary. Next.js already strips server error details in
 * production builds; this renders the user-facing half of the contract in
 * lib/errors.ts — a plain statement plus the digest, which is the correlation
 * handle for the server log.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-start gap-4">
        <h1 className="text-lg font-semibold">Something went wrong on our side.</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          Try again shortly. If it keeps happening, quote this reference when you get in touch.
        </p>
        {error.digest !== undefined && (
          <code className="rounded bg-[--color-muted] px-2 py-1 text-xs">{error.digest}</code>
        )}
        <Button onClick={reset} size="sm">
          Try again
        </Button>
      </div>
    </main>
  );
}
