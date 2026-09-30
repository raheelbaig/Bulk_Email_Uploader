import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { signOut } from '../(auth)/actions';
import { EnvironmentBanner, environmentBannerVisible } from '@/components/environment-banner';
import { Sidebar } from '@/components/app-shell/sidebar';
import { SIDEBAR_COOKIE } from '@/components/app-shell/constants';

/**
 * The protected shell.
 *
 * Authorization is enforced here, in the layout, not in middleware — a route
 * accidentally excluded from a middleware matcher would be unprotected, whereas
 * a route placed under this layout cannot render without a session.
 *
 * Layout: the environment banner (sticky, full width) above a left sidebar and
 * the page. Below `lg` the sidebar becomes a top bar with a navigation drawer.
 * The page column is `min-w-0` so wide content (tables, code) scrolls inside
 * itself and can never push the page sideways.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (user === null) redirect('/login');

  const [workspaceName, cookieStore] = await Promise.all([readWorkspaceName(user.id), cookies()]);
  const collapsed = cookieStore.get(SIDEBAR_COOKIE)?.value === '1';

  return (
    <div className="min-h-dvh">
      <EnvironmentBanner />
      <div className="lg:flex">
        <Sidebar
          email={user.email}
          workspaceName={workspaceName}
          initialCollapsed={collapsed}
          bannerOffset={environmentBannerVisible()}
          signOutAction={signOut}
        />
        <main id="main" className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">{children}</div>
        </main>
      </div>
    </div>
  );
}

/**
 * The workspace's display name for the sidebar. Read under the anon key, so RLS
 * limits it to the user's own membership. Purely cosmetic: any failure renders
 * the sidebar without a name rather than failing the page.
 */
async function readWorkspaceName(userId: string): Promise<string | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: member } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (member === null) return null;
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('name')
      .eq('id', String(member.workspace_id))
      .maybeSingle();
    return workspace?.name === undefined || workspace.name === null ? null : String(workspace.name);
  } catch {
    return null;
  }
}
