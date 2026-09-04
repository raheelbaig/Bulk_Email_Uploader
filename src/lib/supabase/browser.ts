'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client. Anon key only — RLS is the whole protection here.
 *
 * There is deliberately no browser equivalent of the service-role client, and
 * `lib/db/service.ts` is `server-only` so importing it from a Client Component
 * fails the build rather than shipping a key to the browser.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  );
}
