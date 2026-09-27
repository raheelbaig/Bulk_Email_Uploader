import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

/**
 * Session refresh only. No authorization decisions are made here — see
 * lib/supabase/middleware.ts for why.
 */
export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation output.
    // `\\.` in source is a literal `\.` in the pattern; a single backslash would
    // be dropped by the string literal and match any character.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
