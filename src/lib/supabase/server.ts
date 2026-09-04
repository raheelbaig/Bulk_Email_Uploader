import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * Uses the anon key, so every query is subject to RLS under the caller's JWT.
 * This is the client that virtually all application code should use — the
 * service-role client (lib/db/service.ts) bypasses RLS and is a last resort.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? '',
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. Session refresh happens in
            // middleware, which can — so this is safe to swallow here and would
            // be noise if logged on every render.
          }
        },
      },
    },
  );
}
