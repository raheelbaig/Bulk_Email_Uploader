import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { listSenderIdentities } from '@/lib/sender/identities';
import { getSendingSettings } from '@/lib/workspace/settings';
import { listCampaigns, workspaceTimeZone, type CampaignRecord } from '@/lib/campaigns/service';

/**
 * Read-only figures for the dashboard.
 *
 * Every query runs under the anon key, so RLS scopes it to the signed-in
 * user's workspace. Counts are `head` requests (no rows transferred); contacts
 * use Postgres's estimate, which is exact for small tables and avoids a full
 * scan for large ones. A failed read yields `null` — shown as "—" — rather than
 * failing the page: the dashboard is a guide, not a source of record.
 */

export interface DashboardData {
  workspaceName: string | null;
  timeZone: string;
  counts: {
    contacts: number | null;
    lists: number | null;
    templates: number | null;
    campaigns: number | null;
    imports: number | null;
    domains: number | null;
  };
  senders: { total: number; ready: number } | null;
  postalAddressSet: boolean | null;
  recentCampaigns: CampaignRecord[];
  recentActivity: Array<{ action: string; created_at: string }>;
}

type CountTable = 'contacts' | 'contact_lists' | 'templates' | 'campaigns' | 'imports' | 'sender_domains';

export async function loadDashboard(workspaceId: string): Promise<DashboardData> {
  const supabase = await createSupabaseServerClient();

  const count = async (table: CountTable, estimated = false): Promise<number | null> => {
    try {
      const { count: n, error } = await supabase
        .from(table)
        .select('*', { count: estimated ? 'estimated' : 'exact', head: true })
        .eq('workspace_id', workspaceId);
      return error !== null || n === null ? null : n;
    } catch {
      return null;
    }
  };

  const soft = async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await promise;
    } catch {
      return fallback;
    }
  };

  const [
    workspace,
    contacts,
    lists,
    templates,
    campaigns,
    imports,
    domains,
    identities,
    settings,
    campaignPage,
    timeZone,
    activity,
  ] = await Promise.all([
    soft<{ data: unknown }>(
      Promise.resolve(supabase.from('workspaces').select('name').eq('id', workspaceId).maybeSingle()),
      { data: null },
    ),
    count('contacts', true),
    count('contact_lists'),
    count('templates'),
    count('campaigns'),
    count('imports'),
    count('sender_domains'),
    soft(listSenderIdentities(workspaceId), null),
    soft(getSendingSettings(workspaceId), null),
    soft(listCampaigns(workspaceId, { limit: 5 }), null),
    soft(workspaceTimeZone(workspaceId), 'UTC'),
    soft<{ data: unknown[] | null }>(
      Promise.resolve(
        supabase.from('audit_logs').select('action, created_at').order('created_at', { ascending: false }).limit(6),
      ),
      { data: null },
    ),
  ]);

  const name = (workspace.data as { name?: unknown } | null)?.name;

  return {
    workspaceName: typeof name === 'string' ? name : null,
    timeZone,
    counts: { contacts, lists, templates, campaigns, imports, domains },
    senders:
      identities === null
        ? null
        : { total: identities.length, ready: identities.filter((view) => view.readiness.ready).length },
    postalAddressSet: settings === null ? null : settings.postalAddress !== null,
    recentCampaigns: campaignPage?.items ?? [],
    recentActivity: ((activity.data ?? []) as Array<{ action: unknown; created_at: unknown }>).map((row) => ({
      action: String(row.action),
      created_at: String(row.created_at),
    })),
  };
}
