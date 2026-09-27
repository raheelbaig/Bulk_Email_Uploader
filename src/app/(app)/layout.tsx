import { redirect } from 'next/navigation';
import Link from 'next/link';
import { FileText, Globe, LayoutDashboard, ListChecks, LogOut, Mail, Send, Settings, ShieldBan, Upload, Users } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/session';
import { signOut } from '../(auth)/actions';
import { Button } from '@/components/ui/button';
import { EnvironmentBanner } from '@/components/environment-banner';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/lists', label: 'Lists', icon: ListChecks },
  { href: '/imports', label: 'Import', icon: Upload },
  { href: '/suppressions', label: 'Suppressions', icon: ShieldBan },
  { href: '/senders', label: 'Senders', icon: Globe },
  { href: '/templates', label: 'Templates', icon: FileText },
  { href: '/campaigns', label: 'Campaigns', icon: Send },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

/**
 * The protected shell.
 *
 * Authorization is enforced here, in the layout, not in middleware — a route
 * accidentally excluded from a middleware matcher would be unprotected, whereas
 * a route placed under this layout cannot render without a session.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (user === null) redirect('/login');

  return (
    <div className="min-h-screen">
      <EnvironmentBanner />
      {/*
        Two rows: brand and account on top, navigation below. Nine links, the
        address and Sign out do not fit one row of the max-w-5xl container at
        any width, so the nav wraps on its own row and the account controls can
        never be pushed off-screen. The address truncates; Sign out never shrinks.
      */}
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/dashboard" className="flex shrink-0 items-center gap-2 font-semibold">
              <Mail className="h-4 w-4" aria-hidden />
              Email Uploader
            </Link>
            <div className="ml-auto flex min-w-0 items-center gap-3">
              <span
                className="hidden min-w-0 truncate text-sm text-(--color-muted-foreground) sm:block"
                title={user.email}
              >
                {user.email}
              </span>
              <form action={signOut} className="shrink-0">
                <Button type="submit" variant="ghost" size="sm">
                  <LogOut className="h-3.5 w-3.5" aria-hidden />
                  Sign out
                </Button>
              </form>
            </div>
          </div>
          <nav aria-label="Main" className="-mx-2.5 flex flex-wrap items-center gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 whitespace-nowrap hover:bg-(--color-muted)"
              >
                <item.icon className="h-3.5 w-3.5" aria-hidden />
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
