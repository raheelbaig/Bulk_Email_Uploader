import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { serviceForWorkspace } from '@/lib/db/service';
import { logger } from '@/lib/observability/logger';
import { ConflictError, InternalError } from '@/lib/errors';
import type {
  DeleteOutcome,
  DomainProvisioningPatch,
  DomainVerificationPatch,
  NewSenderIdentity,
  SenderDomainRecord,
  SenderIdentityRecord,
  SenderRepository,
} from './ports';

/**
 * The production repository.
 *
 * ── Two modes, and why ────────────────────────────────────────────────────
 *
 * `senderRepository()` serves a request. Reads and the writes a person is
 * allowed to make go through the caller's own JWT, so RLS remains a second,
 * independent layer behind the `requireWorkspace` check in the service. Writes
 * to *derived* state — verification status, DKIM tokens, `verified_at` — go
 * through the workspace-scoped service role, because `authenticated` deliberately
 * holds no grant on those columns at all (migration 0008). The columns a browser
 * must never write are unreachable from the browser's credentials; the columns
 * it may write are still policed by RLS.
 *
 * `backgroundSenderRepository()` serves the periodic sweep, which has no session
 * and therefore no RLS identity — an RLS-scoped read there would correctly
 * return nothing. It runs entirely under `serviceForWorkspace`, which is bound
 * to one workspace and cannot build a query without its tenant filter. The
 * user-only mutations are unavailable in this mode rather than silently allowed:
 * a background job has no business creating or deleting sender configuration.
 */

const DOMAIN_COLUMNS =
  'id, workspace_id, domain, ses_identity_arn, dkim_tokens, mail_from_domain, ' +
  'spf_status, dkim_status, dmarc_status, dmarc_policy, mail_from_status, ' +
  'last_checked_at, last_check_error, created_at, updated_at';

const IDENTITY_COLUMNS =
  'id, workspace_id, domain_id, from_email, from_name, reply_to, from_domain, ' +
  'verified_at, created_at, updated_at';

/** Unique violation. */
const PG_UNIQUE_VIOLATION = '23505';
/** Foreign-key violation — here, the composite identity→domain key. */
const PG_FK_VIOLATION = '23503';

type SenderTable = 'sender_domains' | 'sender_identities';

function unavailable(operation: string): never {
  throw new InternalError(`${operation} is not available without a signed-in caller`);
}

async function build(
  workspaceId: string,
  mode: 'request' | 'background',
): Promise<SenderRepository> {
  const service = serviceForWorkspace(workspaceId);
  // The RLS client is only constructed for a request: building one in a
  // background context would reach for cookies that are not there.
  const rls = mode === 'request' ? await createSupabaseServerClient() : null;

  const fail = (operation: string, error: { message: string; code?: string }): never => {
    logger.error('sender repository operation failed', {
      operation,
      dbError: error.message,
      code: error.code,
    });
    throw new InternalError(error);
  };

  /**
   * A workspace-filtered read.
   *
   * Both branches apply the tenant filter — the RLS branch explicitly and again
   * through its policies, the service branch through `serviceForWorkspace`,
   * which cannot produce an unfiltered query.
   */
  const read = (table: SenderTable, columns: string) =>
    rls === null
      ? service.select(table, columns)
      : rls.from(table).select(columns).eq('workspace_id', workspaceId);

  const readDomainBy = async (
    column: 'id' | 'domain',
    value: string,
  ): Promise<SenderDomainRecord | null> => {
    const { data, error } = await read('sender_domains', DOMAIN_COLUMNS)
      .eq(column, value)
      .maybeSingle();
    if (error !== null) fail(`getDomain:${column}`, error);
    return (data as unknown as SenderDomainRecord | null) ?? null;
  };

  return {
    workspaceId,

    async listDomains() {
      const { data, error } = await read('sender_domains', DOMAIN_COLUMNS)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(200);
      if (error !== null) fail('listDomains', error);
      return (data ?? []) as unknown as SenderDomainRecord[];
    },

    getDomain(domainId) {
      return readDomainBy('id', domainId);
    },

    findDomainByName(domain) {
      return readDomainBy('domain', domain);
    },

    /**
     * Insert-or-return.
     *
     * The unique constraint is the arbiter, not a prior SELECT: two concurrent
     * requests both find nothing, both insert, and exactly one wins. Catching
     * 23505 and re-reading is what makes the loser return the winner's row
     * instead of an error the user did nothing to deserve (§5).
     */
    async insertDomain(domain) {
      if (rls === null) unavailable('insertDomain');

      const { data, error } = await rls
        .from('sender_domains')
        .insert({ workspace_id: workspaceId, domain })
        .select(DOMAIN_COLUMNS)
        .maybeSingle();

      if (error !== null) {
        if (error.code === PG_UNIQUE_VIOLATION) {
          const existing = await readDomainBy('domain', domain);
          if (existing !== null) return { record: existing, created: false };
        }
        fail('insertDomain', error);
      }
      if (data === null) throw new InternalError('domain insert returned no row');
      return { record: data as unknown as SenderDomainRecord, created: true };
    },

    async updateDomainProvisioning(domainId, patch: DomainProvisioningPatch) {
      const { error } = await service.update('sender_domains', { ...patch }).eq('id', domainId);
      if (error !== null) fail('updateDomainProvisioning', error);
    },

    async updateDomainVerification(domainId, patch: DomainVerificationPatch) {
      const { error } = await service.update('sender_domains', { ...patch }).eq('id', domainId);
      if (error !== null) fail('updateDomainVerification', error);
    },

    async deleteDomain(domainId): Promise<DeleteOutcome> {
      if (rls === null) unavailable('deleteDomain');

      const { data, error } = await rls
        .from('sender_domains')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('id', domainId)
        .select('id')
        .maybeSingle();

      if (error !== null) {
        // The identity→domain foreign key is ON DELETE RESTRICT, so a domain
        // still in use refuses to go rather than cascading sender configuration
        // away (ARCHITECTURE §3.3).
        if (error.code === PG_FK_VIOLATION) return 'in_use';
        fail('deleteDomain', error);
      }
      return data === null ? 'missing' : 'deleted';
    },

    async listIdentities() {
      const { data, error } = await read('sender_identities', IDENTITY_COLUMNS)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(200);
      if (error !== null) fail('listIdentities', error);
      return (data ?? []) as unknown as SenderIdentityRecord[];
    },

    async getIdentity(identityId) {
      const { data, error } = await read('sender_identities', IDENTITY_COLUMNS)
        .eq('id', identityId)
        .maybeSingle();
      if (error !== null) fail('getIdentity', error);
      return (data as unknown as SenderIdentityRecord | null) ?? null;
    },

    async countIdentitiesForDomain(domainId) {
      const { data, error } = await read('sender_identities', 'id').eq('domain_id', domainId);
      if (error !== null) fail('countIdentitiesForDomain', error);
      return ((data ?? []) as unknown[]).length;
    },

    /**
     * The wrong-domain guarantee is enforced by the database, not by this
     * caller: the composite foreign key compares (workspace_id, domain_id,
     * from_domain) against a single sender_domains row, so an address under a
     * different domain — or under another workspace's domain — is a 23503.
     */
    async insertIdentity(input: NewSenderIdentity) {
      if (rls === null) unavailable('insertIdentity');

      const { data, error } = await rls
        .from('sender_identities')
        .insert({
          workspace_id: workspaceId,
          domain_id: input.domainId,
          from_email: input.fromEmail,
          from_name: input.fromName,
          reply_to: input.replyTo,
        })
        .select(IDENTITY_COLUMNS)
        .maybeSingle();

      if (error !== null) {
        if (error.code === PG_UNIQUE_VIOLATION) {
          throw new ConflictError('That sender address already exists in this workspace.', error);
        }
        if (error.code === PG_FK_VIOLATION) {
          throw new ConflictError(
            'That address does not belong to the selected sending domain.',
            error,
          );
        }
        fail('insertIdentity', error);
      }
      if (data === null) throw new InternalError('identity insert returned no row');
      return data as unknown as SenderIdentityRecord;
    },

    async updateIdentity(identityId, patch) {
      if (rls === null) unavailable('updateIdentity');

      const { data, error } = await rls
        .from('sender_identities')
        .update({ from_name: patch.fromName, reply_to: patch.replyTo })
        .eq('workspace_id', workspaceId)
        .eq('id', identityId)
        .select(IDENTITY_COLUMNS)
        .maybeSingle();
      if (error !== null) fail('updateIdentity', error);
      return (data as unknown as SenderIdentityRecord | null) ?? null;
    },

    async deleteIdentity(identityId) {
      if (rls === null) unavailable('deleteIdentity');

      const { data, error } = await rls
        .from('sender_identities')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('id', identityId)
        .select('id')
        .maybeSingle();
      if (error !== null) fail('deleteIdentity', error);
      return data !== null;
    },

    async setIdentityVerification(domainId, verifiedAt) {
      const { error } = await service
        .update('sender_identities', { verified_at: verifiedAt })
        .eq('domain_id', domainId);
      if (error !== null) fail('setIdentityVerification', error);
    },
  };
}

/** For a request, after `requireWorkspace` has authorized the caller. */
export function senderRepository(workspaceId: string): Promise<SenderRepository> {
  return build(workspaceId, 'request');
}

/** For the periodic sweep, which has no session. Reads and writes only. */
export function backgroundSenderRepository(workspaceId: string): Promise<SenderRepository> {
  return build(workspaceId, 'background');
}
