import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceForWorkspace } from '@/lib/db/service';
import type { EligibilityReader, SuppressionRecord, ContactStatusRecord } from './index';

/**
 * Reader implementations for the eligibility authority.
 *
 * Both return the same shapes; the decision logic in `./index.ts` is unaware of
 * which one it was handed. See that file for why the port exists.
 */

/**
 * Reads under the caller's JWT, so RLS applies as a second layer.
 *
 * Use this on every request-scoped path. The workspace id must still come from
 * `requireWorkspace()` — RLS is the backstop, not the primary check.
 */
export function rlsEligibilityReader(supabase: SupabaseClient): EligibilityReader {
  return {
    async findSuppressions(workspaceId, emails): Promise<SuppressionRecord[]> {
      const { data, error } = await supabase
        .from('suppressions')
        .select('email_normalized, reason')
        .eq('workspace_id', workspaceId)
        .in('email_normalized', emails);

      if (error !== null) throw new Error(`suppression lookup failed: ${error.message}`);
      return (data ?? []).map((row) => ({
        emailNormalized: String(row.email_normalized),
        reason: String(row.reason),
      }));
    },

    async findContactStatuses(workspaceId, emails): Promise<ContactStatusRecord[]> {
      const { data, error } = await supabase
        .from('contacts')
        .select('email_normalized, status')
        .eq('workspace_id', workspaceId)
        .in('email_normalized', emails);

      if (error !== null) throw new Error(`contact lookup failed: ${error.message}`);
      return (data ?? []).map((row) => ({
        emailNormalized: String(row.email_normalized),
        status: String(row.status),
      }));
    },
  };
}

/**
 * Reads under the service role, which bypasses RLS.
 *
 * For background work with no user session — the P5 worker, P6 provider event
 * handlers. Tenant scoping comes from `serviceForWorkspace`, which cannot build
 * an unfiltered query.
 */
export function serviceEligibilityReader(): EligibilityReader {
  return {
    async findSuppressions(workspaceId, emails): Promise<SuppressionRecord[]> {
      const { data, error } = await serviceForWorkspace(workspaceId)
        .select('suppressions', 'email_normalized, reason')
        .in('email_normalized', emails);

      if (error !== null) throw new Error(`suppression lookup failed: ${error.message}`);
      return ((data ?? []) as unknown as { email_normalized: string; reason: string }[]).map((row) => ({
        emailNormalized: row.email_normalized,
        reason: row.reason,
      }));
    },

    async findContactStatuses(workspaceId, emails): Promise<ContactStatusRecord[]> {
      const { data, error } = await serviceForWorkspace(workspaceId)
        .select('contacts', 'email_normalized, status')
        .in('email_normalized', emails);

      if (error !== null) throw new Error(`contact lookup failed: ${error.message}`);
      return ((data ?? []) as unknown as { email_normalized: string; status: string }[]).map((row) => ({
        emailNormalized: row.email_normalized,
        status: row.status,
      }));
    },
  };
}
