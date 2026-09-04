import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { UnauthenticatedError } from '@/lib/errors';
import { enrichContext } from '@/lib/observability/context';

export interface AuthenticatedUser {
  id: string;
  email: string | undefined;
}

/**
 * The authenticated user, or null.
 *
 * Always `getUser()`, never `getSession()`. `getSession()` returns whatever the
 * cookie decodes to without revalidating the JWT's signature against the auth
 * server — fine for rendering a name, never acceptable as an authorization
 * input. This distinction is the difference between a session check and an
 * auth bypass.
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error !== null || data.user === null) return null;

  enrichContext({ userId: data.user.id });
  return { id: data.user.id, email: data.user.email };
}

/** As `getCurrentUser`, but throws `UnauthenticatedError` instead of returning null. */
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (user === null) throw new UnauthenticatedError();
  return user;
}
