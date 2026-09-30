import { Mail } from 'lucide-react';
import { EnvironmentBanner } from '@/components/environment-banner';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <EnvironmentBanner />
      <main className="flex min-h-[calc(100dvh-2rem)] flex-col items-center justify-center px-4 py-12">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-(--color-primary) text-(--color-primary-foreground) shadow-sm">
              <Mail className="size-5" aria-hidden />
            </span>
            <div>
              <p className="text-lg font-semibold tracking-tight">Email Uploader</p>
              <p className="text-sm text-(--color-muted-foreground)">
                Import your contacts, write your emails and send campaigns — all in one place.
              </p>
            </div>
          </div>
          {children}
        </div>
      </main>
    </>
  );
}
