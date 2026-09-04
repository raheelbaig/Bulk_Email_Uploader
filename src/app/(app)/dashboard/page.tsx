import { ShieldCheck } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const access = await currentWorkspace();
  const supabase = await createSupabaseServerClient();

  // Read under the anon key: RLS applies, so this cannot return another
  // workspace's row even if the id were wrong.
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('name, created_at')
    .eq('id', access.workspaceId)
    .maybeSingle();

  const { data: recent } = await supabase
    .from('audit_logs')
    .select('action, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {workspace?.name ?? 'Your workspace'}
        </h1>
        <p className="text-sm text-[--color-muted-foreground]">
          You are signed in as {access.role}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <ShieldCheck className="h-4 w-4 text-[--color-muted-foreground]" aria-hidden />
          <CardTitle>Sending is not enabled</CardTitle>
          <CardDescription>
            This deployment is at the foundation stage. There is no sending engine, no provider
            connection and no way to dispatch a message — by construction, not by configuration.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[--color-muted-foreground]">
            Contacts, templates, campaigns and delivery arrive in later phases. Nothing on this
            deployment can put an email into anyone&rsquo;s inbox.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>Audit records for this workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {recent === null || recent.length === 0 ? (
            <p className="text-sm text-[--color-muted-foreground]">Nothing recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {recent.map((row, i) => (
                <li key={i} className="flex items-baseline justify-between gap-4">
                  <code className="text-xs">{String(row.action)}</code>
                  <span className="text-xs text-[--color-muted-foreground]">
                    {new Date(String(row.created_at)).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
