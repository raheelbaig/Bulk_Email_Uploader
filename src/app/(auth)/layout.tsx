import { EnvironmentBanner } from '@/components/environment-banner';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <EnvironmentBanner />
      <main className="flex min-h-screen items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </>
  );
}
