'use server';

import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { RECOVERY_COOKIE, RECOVERY_FLOW } from '@/lib/auth/recovery';
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

/** The signed-in user's workspace, for an audit row. Null when there is none. */
async function membershipOf(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  return data === null ? null : String(data.workspace_id);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (data.user !== null) {
    const workspaceId = await membershipOf(supabase, data.user.id);
    if (workspaceId !== null) {
      const meta = await requestMeta();
      await writeAuditLog({
        workspaceId,
        actorId: data.user.id,
        actorType: 'user',
        action: 'auth.logout',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
  }
  await supabase.auth.signOut();
  redirect('/login');
}

const resetRequestSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) });

/** Shown for every well-formed request, whether or not the account exists. */
const RESET_SENT =
  'If an account uses that address, we have sent it a link to choose a new password. The link works once and expires soon.';

/**
 * Asks Supabase Auth to email a password-recovery link.
 *
 * The answer never says whether the address has an account, and the throttle
 * counts per address whether or not it exists, so neither is an oracle. The
 * link returns to /auth/confirm with a fixed flag that sends it on to
 * /reset-password; that URL must be in the project's Redirect URLs list.
 */
export async function requestPasswordReset(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  return runWithContext({ requestId: newRequestId(), route: 'action:requestPasswordReset' }, async () => {
    const parsed = resetRequestSchema.safeParse({ email: formData.get('email') });
    if (!parsed.success) return { message: 'Enter the email address you sign in with.' };

    const meta = await requestMeta();
    const throttled = await throttle([
      ['auth.password_reset_account', parsed.data.email],
      ['auth.password_reset_ip', meta.ip],
    ]);
    if (throttled !== null) return { message: throttled };

    const appUrl = process.env['NEXT_PUBLIC_APP_URL'] ?? '';
    const redirectTo = new URL('/auth/confirm', appUrl.length > 0 ? appUrl : 'http://localhost');
    redirectTo.searchParams.set('flow', RECOVERY_FLOW);

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
      ...(appUrl.length > 0 ? { redirectTo: redirectTo.toString() } : {}),
    });
    if (error !== null) {
      // Logged by code only: the address is not repeated in logs.
      logger.warn('password reset request failed', { reason: error.code ?? error.message, status: error.status });
    }
    return { ok: true, message: RESET_SENT };
  });
}

const newPasswordSchema = z
  .object({
    password: z.string().min(8, 'Use at least 8 characters.').max(200, 'Use at most 200 characters.'),
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, { message: 'The two passwords do not match.' });

/**
 * Sets a new password for the session a recovery link created.
 *
 * Refuses without the recovery marker (lib/auth/recovery) — the page does too,
 * so this only matters to a forged form post. Clears the marker on success.
 */
export async function updatePassword(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  return runWithContext({ requestId: newRequestId(), route: 'action:updatePassword' }, async () => {
    const jar = await cookies();
    const supabase = await createSupabaseServerClient();
    const { data: current } = await supabase.auth.getUser();
    if (current.user === null || jar.get(RECOVERY_COOKIE) === undefined) {
      return { message: 'This reset link has expired. Request a new one.' };
    }

    const parsed = newPasswordSchema.safeParse({ password: formData.get('password'), confirm: formData.get('confirm') });
    if (!parsed.success) return { message: parsed.error.issues[0]?.message ?? 'Choose a different password.' };

    const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
    if (error !== null) {
      logger.warn('password update rejected', { reason: error.code ?? error.message, status: error.status });
      // Supabase's own messages here are about the password (too weak, same as
      // before), never about anyone else's account, so they are safe to show.
      return {
        message:
          error.code === 'same_password'
            ? 'Choose a password you have not used for this account before.'
            : error.code === 'weak_password'
              ? 'That password is too easy to guess. Choose a longer or less common one.'
              : 'We could not change the password. Request a new link and try again.',
      };
    }

    jar.delete(RECOVERY_COOKIE);
    const workspaceId = await membershipOf(supabase, current.user.id);
    if (workspaceId !== null) {
      const meta = await requestMeta();
      await writeAuditLog({
        workspaceId,
        actorId: current.user.id,
        actorType: 'user',
        action: 'auth.password_changed',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    redirect('/dashboard');
  });
}
