import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl border bg-(--color-surface) text-(--color-muted-foreground) shadow-xs">
          <SearchX className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Page not found</h1>
          <p className="mt-1.5 text-sm text-(--color-muted-foreground)">
            That page doesn’t exist, or you don’t have access to it.
          </p>
        </div>
        <Link href="/dashboard" className={buttonVariants()}>
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
