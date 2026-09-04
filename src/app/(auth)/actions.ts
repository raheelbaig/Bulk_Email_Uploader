'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
});

export interface AuthFormState {
  message: string | null;
}

async function requestMeta(): Promise<{ ip: string | undefined; userAgent: string | undefined }> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  return {
    ip: forwarded?.split(',')[0]?.trim(),
    userAgent: h.get('user-agent') ?? undefined,
  };
}

/**
 * Both actions return the same message for every credential failure —
 * "Check your email address and password." — regardless of whether the account
 * exists. Distinguishing the two turns the login form into an account-existence
 * oracle.
 */
export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  return runWithContext({ requestId: newRequestId(), route: 'action:signIn' }, async () => {
    const parsed = credentialsSchema.safeParse({
      email: formData.get('email'),
      password: formData.get('password'),
    });
    if (!parsed.success) {
      return { message: 'Check your email address and password.' };
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

    if (error !== null || data.user === null) {
      logger.warn('sign-in rejected', { reason: error?.message ?? 'no user returned' });
      return { message: 'Check your email address and password.' };
    }

    const meta = await requestMeta();
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', data.user.id)
      .limit(1)
      .maybeSingle();

    if (membership !== null) {
      await writeAuditLog({
        workspaceId: String(membership.workspace_id),
        actorId: data.user.id,
        actorType: 'user',
        action: 'auth.login',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }

    redirect('/dashboard');
  });
}

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  return runWithContext({ requestId: newRequestId(), route: 'action:signUp' }, async () => {
    const parsed = credentialsSchema.safeParse({
      email: formData.get('email'),
      password: formData.get('password'),
    });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { message: first?.message ?? 'Check your email address and password.' };
    }

    const workspaceName = String(formData.get('workspace_name') ?? '').trim().slice(0, 120);

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        data: workspaceName.length > 0 ? { workspace_name: workspaceName } : {},
      },
    });

    if (error !== null) {
      logger.warn('sign-up rejected', { reason: error.message });
      // Never confirm whether the address is already registered.
      return { message: 'We could not create that account. Try a different email address.' };
    }

    // The workspace, owner membership, settings row and audit record are created
    // by the on_auth_user_created trigger (migration 0004), so every signup path
    // produces them — not only this one.
    redirect('/dashboard');
  });
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}
