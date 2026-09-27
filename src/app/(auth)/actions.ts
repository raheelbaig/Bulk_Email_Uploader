'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import { consumeSubjectRateLimit, RATE_LIMITS, type RateLimitAction } from '@/lib/rate-limit';

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
});

export interface AuthFormState {
  message: string | null;
  /** True when `message` is a notice (e.g. "check your inbox"), not an error. */
  ok?: boolean;
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
 * Consumes one unit from each limiter with a subject, and returns the first
 * refusal's message, or null. Fails open with the limiter (lib/rate-limit).
 */
async function throttle(checks: Array<[RateLimitAction, string | undefined]>): Promise<string | null> {
  for (const [action, subject] of checks) {
    if (subject === undefined || subject.length === 0) continue;
    const decision = await consumeSubjectRateLimit(action, subject);
    if (!decision.allowed) return RATE_LIMITS[action].message;
  }
  return null;
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

    // Before the password is checked, so a throttled guess costs Supabase
    // nothing and learns nothing. Counted per address whether or not the
    // account exists, so the refusal is not an existence oracle either.
    const meta = await requestMeta();
    const throttled = await throttle([
      ['auth.sign_in_account', parsed.data.email],
      ['auth.sign_in_ip', meta.ip],
    ]);
    if (throttled !== null) return { message: throttled };

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

    // Supabase only reports an unconfirmed address after the password matched,
    // so saying so reveals nothing to someone who does not hold the account.
    if (error?.code === 'email_not_confirmed') {
      logger.warn('sign-in rejected', { reason: error.code });
      return {
        message:
          'Confirm your email address first, using the link we sent you. To get a new link, sign up again with the same email address.',
      };
    }

    if (error !== null || data.user === null) {
      logger.warn('sign-in rejected', { reason: error?.message ?? 'no user returned' });
      return { message: 'Check your email address and password.' };
    }

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

    const throttled = await throttle([['auth.sign_up_ip', (await requestMeta()).ip]]);
    if (throttled !== null) return { message: throttled };

    const workspaceName = String(formData.get('workspace_name') ?? '').trim().slice(0, 120);

    const appUrl = process.env['NEXT_PUBLIC_APP_URL'] ?? '';
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        data: workspaceName.length > 0 ? { workspace_name: workspaceName } : {},
        // Must be in the Supabase project's Redirect URLs allow list; otherwise
        // Supabase falls back to the Site URL (the index page forwards it here).
        ...(appUrl.length > 0 ? { emailRedirectTo: new URL('/auth/confirm', appUrl).toString() } : {}),
      },
    });

    if (error !== null) {
      logger.warn('sign-up rejected', { reason: error.code ?? error.message, status: error.status });
      // Never confirm whether the address is already registered.
      return { message: 'We could not create that account. Try a different email address.' };
    }

    // With "Confirm email" on, Supabase returns no session until the link in the
    // email is followed — and returns the same shape for an address that is
    // already registered, so this message is not an existence oracle either.
    if (data.session === null) {
      return {
        ok: true,
        message: 'Check your inbox for a confirmation link. After confirming, you will be signed in.',
      };
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
