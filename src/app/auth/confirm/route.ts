import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import { RECOVERY_COOKIE, RECOVERY_FLOW, RECOVERY_MAX_AGE_SECONDS } from '@/lib/auth/recovery';

const OTP_TYPES: readonly EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'];

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value);
}

/**
 * Landing point for the links in Supabase Auth emails (signup confirmation and
 * password recovery).
 *
 * Two shapes arrive here:
 * - `?code=` — the PKCE flow `@supabase/ssr` uses by default. Supabase has
 *   already confirmed the address before redirecting; the code is exchanged for
 *   a session using the verifier cookie set at signup, so it only succeeds in
 *   the browser that signed up.
 * - `?token_hash=&type=` — for an email template that links here directly.
 *
 * Both destinations are fixed. There is deliberately no `next` parameter: a
 * caller-chosen redirect target on an unauthenticated GET is an open redirect.
 */
export async function GET(request: NextRequest) {
  return runWithContext({ requestId: newRequestId(), route: 'GET /auth/confirm' }, async () => {
    const params = request.nextUrl.searchParams;
    const code = params.get('code');
    const tokenHash = params.get('token_hash');
    const type = params.get('type');

    const supabase = await createSupabaseServerClient();
    let failure: string | null = params.get('error_code') ?? params.get('error') ?? 'missing_code';

    if (code !== null) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      failure = error === null ? null : (error.code ?? error.message);
    } else if (tokenHash !== null && isOtpType(type)) {
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      failure = error === null ? null : (error.code ?? error.message);
    }

    // A password-recovery link: either our fixed `flow` flag on the PKCE
    // redirect, or the OTP type on a direct template link. The destination is
    // still fixed; the flag only chooses between two of them.
    const recovery = params.get('flow') === RECOVERY_FLOW || type === 'recovery';

    if (failure === null && recovery) {
      const response = NextResponse.redirect(new URL('/reset-password', request.url));
      response.cookies.set(RECOVERY_COOKIE, '1', {
        httpOnly: true,
        secure: request.nextUrl.protocol === 'https:',
        sameSite: 'lax',
        path: '/',
        maxAge: RECOVERY_MAX_AGE_SECONDS,
      });
      return response;
    }

    if (failure === null) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }

    if (recovery) {
      logger.warn('password recovery link rejected', { reason: failure });
      return NextResponse.redirect(new URL('/forgot-password?notice=link-expired', request.url));
    }

    logger.warn('auth confirmation rejected', { reason: failure });
    return NextResponse.redirect(new URL('/login?notice=confirm-failed', request.url));
  });
}
