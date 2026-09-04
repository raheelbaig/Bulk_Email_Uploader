import { redirect } from 'next/navigation';
import Link from 'next/link';
import { FileText, Globe, LayoutDashboard, ListChecks, LogOut, Mail, Send, ShieldBan, Upload, Users } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/session';
import { signOut } from '../(auth)/actions';
import { Button } from '@/components/ui/button';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/lists', label: 'Lists', icon: ListChecks },
  { href: '/imports', label: 'Import', icon: Upload },
  { href: '/suppressions', label: 'Suppressions', icon: ShieldBan },
  { href: '/senders', label: 'Senders', icon: Globe },
  { href: '/templates', label: 'Templates', icon: FileText },
  { href: '/campaigns', label: 'Campaigns', icon: Send },
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
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <Mail className="h-4 w-4" aria-hidden />
            Email Uploader
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 hover:bg-[--color-muted]"
              >
                <item.icon className="h-3.5 w-3.5" aria-hidden />
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-[--color-muted-foreground]">{user.email}</span>
            <form action={signOut}>
              <Button type="submit" variant="ghost" size="sm">
                <LogOut className="h-3.5 w-3.5" aria-hidden />
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
