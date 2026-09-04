import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-start gap-3">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          That page does not exist, or you do not have access to it.
        </p>
        <Link href="/dashboard" className="text-sm underline underline-offset-4">
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
