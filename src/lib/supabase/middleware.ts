import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the auth session cookie on every matched request.
 *
 * This function performs NO authorization. Middleware matchers are easy to get
 * subtly wrong, and a route accidentally excluded from the matcher would then be
 * unprotected. Authorization lives in the route handlers and layouts
 * (requireUser / requireWorkspace) and in RLS. Middleware only keeps the cookie
 * fresh — see ARCHITECTURE §26.5.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser() revalidates the JWT against the auth server. getSession() only
  // decodes the cookie, so it is never an authorization input.
  await supabase.auth.getUser();

  return response;
}
