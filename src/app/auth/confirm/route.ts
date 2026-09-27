import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';

const OTP_TYPES: readonly EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'];

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value);
}

/**
 * Landing point for the links in Supabase Auth emails (signup confirmation).
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

    if (failure === null) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }

    logger.warn('auth confirmation rejected', { reason: failure });
    return NextResponse.redirect(new URL('/login?notice=confirm-failed', request.url));
  });
}
