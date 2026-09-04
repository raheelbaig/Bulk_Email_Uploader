import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth/session';
import { ForbiddenError } from '@/lib/errors';
import { enrichContext } from '@/lib/observability/context';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface WorkspaceAccess {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

const ROLE_RANK: Record<WorkspaceRole, number> = { member: 1, admin: 2, owner: 3 };

function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

/**
 * Resolves and authorizes workspace access for the current request.
 *
 * `workspaceId` arrives from the browser — a route param, a form field — and is
 * therefore treated as a *claim to be verified*, never as an authorization
 * input. What authorizes the request is the membership row found for the
 * session's user, which the browser cannot influence.
 *
 * This runs under the anon key, so RLS independently constrains the lookup. Two
 * layers, either of which alone would deny a cross-tenant request.
 */
export async function requireWorkspace(
  workspaceId: string,
  options?: { minimumRole?: WorkspaceRole },
): Promise<WorkspaceAccess> {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();

  // A missing row and a query error are treated identically. Distinguishing
  // "does not exist" from "not yours" would let a caller enumerate workspaces.
  if (error !== null || data === null || !isWorkspaceRole(data.role)) {
    throw new ForbiddenError(error ?? undefined);
  }

  const minimum = options?.minimumRole;
  if (minimum !== undefined && ROLE_RANK[data.role] < ROLE_RANK[minimum]) {
    throw new ForbiddenError();
  }

  enrichContext({ workspaceId });
  return { userId: user.id, workspaceId, role: data.role };
}

/**
 * The workspace for the current user when none was specified.
 *
 * Every user has exactly one workspace after signup bootstrap. When multiple
 * workspaces per user arrive, this becomes an explicit selection rather than a
 * silent "first row", and callers relying on the implicit choice will need review.
 */
export async function currentWorkspace(): Promise<WorkspaceAccess> {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error !== null || data === null || !isWorkspaceRole(data.role)) {
    throw new ForbiddenError(error ?? undefined);
  }

  const workspaceId = String(data.workspace_id);
  enrichContext({ workspaceId });
  return { userId: user.id, workspaceId, role: data.role };
}
