import type { TestDb } from './db';
import type { DnsAnswer, DnsFailure, DnsResolver, MxRecord } from '@/lib/sender/dns/resolver';
import type {
  EmailProvider,
  ProviderDomainIdentity,
  ProviderSendingLimits,
  ProviderVerificationState,
} from '@/lib/sender/provider/types';
import { EmailProviderError } from '@/lib/sender/provider/types';
import type {
  DomainProvisioningPatch,
  DomainVerificationPatch,
  NewSenderIdentity,
  SenderDomainRecord,
  SenderIdentityRecord,
  SenderRepository,
} from '@/lib/sender/ports';
import { ConflictError } from '@/lib/errors';

/**
 * Test doubles for the three ports P3 talks through.
 *
 * The repository double is backed by the *real* migrated database, so every
 * constraint the schema carries — the composite identity→domain foreign key, the
 * unique domain per workspace, ON DELETE RESTRICT — is exercised by the service
 * tests rather than mocked away. Only the HTTP-shaped ports (the provider and
 * DNS) are simulated, because there is nothing real to talk to.
 */

// ─────────────────────────────────────────────────────────────────────────────
// DNS
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeZone {
  txt?: Record<string, string[][]>;
  cname?: Record<string, string[]>;
  mx?: Record<string, MxRecord[]>;
  /** Names whose lookup fails at the transport level, with the reason. */
  fail?: Record<string, DnsFailure>;
}

/**
 * A resolver over an in-memory zone.
 *
 * A name that is present answers; a name that is absent answers `no_data`, which
 * is a real answer; a name in `fail` produces a transport failure, which is not.
 * That distinction is the one `computeVerification` depends on.
 */
export function fakeResolver(zone: FakeZone): DnsResolver {
  const answer = <T>(map: Record<string, T> | undefined, name: string): DnsAnswer<T> => {
    const failure = zone.fail?.[name];
    if (failure !== undefined) return { ok: false, reason: failure };
    const found = map?.[name];
    if (found === undefined) return { ok: false, reason: 'no_data' };
    return { ok: true, records: found };
  };

  return {
    async resolveTxt(name) {
      return answer(zone.txt, name);
    },
    async resolveCname(name) {
      return answer(zone.cname, name);
    },
    async resolveMx(name) {
      return answer(zone.mx, name);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeIdentityState {
  status?: ProviderVerificationState;
  usableForSending?: boolean;
  dkimStatus?: ProviderVerificationState;
  dkimTokens?: string[];
  mailFromDomain?: string | null;
  mailFromStatus?: ProviderVerificationState;
}

export interface FakeProvider extends EmailProvider {
  /** Every call made, in order. Lets a test assert idempotency. */
  readonly calls: string[];
  /** Seeds or replaces an identity as the provider sees it. */
  setIdentity(domain: string, state: FakeIdentityState): void;
  /** Makes the next call of `operation` throw. */
  failNext(operation: string, error: EmailProviderError): void;
}

const DEFAULT_TOKENS = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'cccccccccccccccccccccccccccccccc',
];

function identityFrom(domain: string, state: FakeIdentityState): ProviderDomainIdentity {
  return {
    domain,
    status: state.status ?? 'pending',
    usableForSending: state.usableForSending ?? false,
    dkim: {
      tokens: state.dkimTokens ?? DEFAULT_TOKENS,
      status: state.dkimStatus ?? 'pending',
      signingEnabled: true,
    },
    mailFrom: {
      domain: state.mailFromDomain === undefined ? null : state.mailFromDomain,
      status: state.mailFromStatus ?? 'not_started',
    },
    identityArn: null,
  };
}

export function fakeProvider(options: { region?: string } = {}): FakeProvider {
  const identities = new Map<string, FakeIdentityState>();
  const calls: string[] = [];
  const failures = new Map<string, EmailProviderError>();

  const takeFailure = (operation: string): void => {
    const failure = failures.get(operation);
    if (failure !== undefined) {
      failures.delete(operation);
      throw failure;
    }
  };

  return {
    region: options.region ?? 'eu-west-1',
    calls,

    setIdentity(domain, state) {
      identities.set(domain, { ...identities.get(domain), ...state });
    },

    failNext(operation, error) {
      failures.set(operation, error);
    },

    async createDomainIdentity(domain) {
      calls.push(`createDomainIdentity:${domain}`);
      takeFailure('createDomainIdentity');
      // Create-or-fetch, exactly as the SES adapter behaves on
      // AlreadyExistsException: one identity, no error, no duplicate.
      if (!identities.has(domain)) identities.set(domain, {});
      return identityFrom(domain, identities.get(domain) ?? {});
    },

    async getDomainIdentity(domain) {
      calls.push(`getDomainIdentity:${domain}`);
      takeFailure('getDomainIdentity');
      const state = identities.get(domain);
      return state === undefined ? null : identityFrom(domain, state);
    },

    async configureMailFrom(domain, mailFromDomain) {
      calls.push(`configureMailFrom:${domain}:${mailFromDomain}`);
      takeFailure('configureMailFrom');
      const state = identities.get(domain);
      if (state === undefined) throw new EmailProviderError('not_found', 'no such identity');
      identities.set(domain, { ...state, mailFromDomain, mailFromStatus: 'pending' });
    },

    async getSendingLimits(): Promise<ProviderSendingLimits> {
      calls.push('getSendingLimits');
      takeFailure('getSendingLimits');
      return { sandbox: true, sendingEnabled: true, max24HourSend: 200, maxSendRate: 1, sentLast24Hours: 0 };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository, backed by a real migrated database
// ─────────────────────────────────────────────────────────────────────────────

const DOMAIN_COLUMNS =
  'id, workspace_id, domain, ses_identity_arn, dkim_tokens, mail_from_domain, ' +
  'spf_status::text as spf_status, dkim_status::text as dkim_status, ' +
  'dmarc_status::text as dmarc_status, dmarc_policy, ' +
  'mail_from_status::text as mail_from_status, last_checked_at, last_check_error, ' +
  'created_at, updated_at';

const IDENTITY_COLUMNS =
  'id, workspace_id, domain_id, from_email, from_name, reply_to, from_domain, ' +
  'verified_at, created_at, updated_at';

function isUnique(err: unknown): boolean {
  return /duplicate key|unique constraint/i.test((err as Error).message);
}

function isForeignKey(err: unknown): boolean {
  return /foreign key constraint/i.test((err as Error).message);
}

export function testSenderRepository(db: TestDb, workspaceId: string): SenderRepository {
  const domainBy = async (column: 'id' | 'domain', value: string) => {
    const res = await db.raw<SenderDomainRecord>(
      `select ${DOMAIN_COLUMNS} from sender_domains where workspace_id = $1 and ${column} = $2`,
      [workspaceId, value],
    );
    return res.rows[0] ?? null;
  };

  return {
    workspaceId,

    async listDomains() {
      const res = await db.raw<SenderDomainRecord>(
        `select ${DOMAIN_COLUMNS} from sender_domains where workspace_id = $1
          order by created_at desc, id desc`,
        [workspaceId],
      );
      return res.rows;
    },

    getDomain: (domainId) => domainBy('id', domainId),
    findDomainByName: (domain) => domainBy('domain', domain),

    async insertDomain(domain) {
      const res = await db.raw<SenderDomainRecord>(
        `insert into sender_domains (workspace_id, domain) values ($1, $2)
         on conflict (workspace_id, domain) do nothing
         returning ${DOMAIN_COLUMNS}`,
        [workspaceId, domain],
      );
      const created = res.rows[0];
      if (created !== undefined) return { record: created, created: true };

      const existing = await domainBy('domain', domain);
      if (existing === null) throw new Error('insertDomain found neither a new nor existing row');
      return { record: existing, created: false };
    },

    async updateDomainProvisioning(domainId, patch: DomainProvisioningPatch) {
      await db.raw(
        `update sender_domains
            set ses_identity_arn = coalesce($3, ses_identity_arn),
                dkim_tokens      = coalesce($4::text[], dkim_tokens),
                mail_from_domain = coalesce($5, mail_from_domain)
          where workspace_id = $1 and id = $2`,
        [
          workspaceId,
          domainId,
          patch.ses_identity_arn ?? null,
          patch.dkim_tokens ?? null,
          patch.mail_from_domain ?? null,
        ],
      );
    },

    async updateDomainVerification(domainId, patch: DomainVerificationPatch) {
      await db.raw(
        `update sender_domains
            set spf_status       = $3::verification_status,
                dkim_status      = $4::verification_status,
                dmarc_status     = $5::verification_status,
                dmarc_policy     = $6,
                mail_from_status = $7::verification_status,
                last_checked_at  = $8::timestamptz,
                last_check_error = $9
          where workspace_id = $1 and id = $2`,
        [
          workspaceId,
          domainId,
          patch.spf_status,
          patch.dkim_status,
          patch.dmarc_status,
          patch.dmarc_policy,
          patch.mail_from_status,
          patch.last_checked_at,
          patch.last_check_error,
        ],
      );
    },

    async deleteDomain(domainId) {
      try {
        const res = await db.raw(
          `delete from sender_domains where workspace_id = $1 and id = $2 returning id`,
          [workspaceId, domainId],
        );
        return res.rows.length > 0 ? 'deleted' : 'missing';
      } catch (err) {
        if (isForeignKey(err)) return 'in_use';
        throw err;
      }
    },

    async listIdentities() {
      const res = await db.raw<SenderIdentityRecord>(
        `select ${IDENTITY_COLUMNS} from sender_identities where workspace_id = $1
          order by created_at desc, id desc`,
        [workspaceId],
      );
      return res.rows;
    },

    async getIdentity(identityId) {
      const res = await db.raw<SenderIdentityRecord>(
        `select ${IDENTITY_COLUMNS} from sender_identities where workspace_id = $1 and id = $2`,
        [workspaceId, identityId],
      );
      return res.rows[0] ?? null;
    },

    async countIdentitiesForDomain(domainId) {
      const res = await db.raw<{ count: string }>(
        `select count(*)::text as count from sender_identities
          where workspace_id = $1 and domain_id = $2`,
        [workspaceId, domainId],
      );
      return Number(res.rows[0]?.count ?? '0');
    },

    async insertIdentity(input: NewSenderIdentity) {
      try {
        const res = await db.raw<SenderIdentityRecord>(
          `insert into sender_identities (workspace_id, domain_id, from_email, from_name, reply_to)
           values ($1, $2, $3, $4, $5)
           returning ${IDENTITY_COLUMNS}`,
          [workspaceId, input.domainId, input.fromEmail, input.fromName, input.replyTo],
        );
        const row = res.rows[0];
        if (row === undefined) throw new Error('identity insert returned no row');
        return row;
      } catch (err) {
        // The same translation the production repository performs, so the
        // service sees identical errors from either implementation.
        if (isUnique(err)) {
          throw new ConflictError('That sender address already exists in this workspace.', err);
        }
        if (isForeignKey(err)) {
          throw new ConflictError(
            'That address does not belong to the selected sending domain.',
            err,
          );
        }
        throw err;
      }
    },

    async updateIdentity(identityId, patch) {
      const res = await db.raw<SenderIdentityRecord>(
        `update sender_identities set from_name = $3, reply_to = $4
          where workspace_id = $1 and id = $2
          returning ${IDENTITY_COLUMNS}`,
        [workspaceId, identityId, patch.fromName, patch.replyTo],
      );
      return res.rows[0] ?? null;
    },

    async deleteIdentity(identityId) {
      const res = await db.raw(
        `delete from sender_identities where workspace_id = $1 and id = $2 returning id`,
        [workspaceId, identityId],
      );
      return res.rows.length > 0;
    },

    async setIdentityVerification(domainId, verifiedAt) {
      await db.raw(
        `update sender_identities set verified_at = $3::timestamptz
          where workspace_id = $1 and domain_id = $2`,
        [workspaceId, domainId, verifiedAt],
      );
    },
  };
}

/** A domain row in whatever state a test needs, without going through a service. */
export async function seedSenderDomain(
  db: TestDb,
  workspaceId: string,
  domain: string,
  state: Partial<{
    spf: string;
    dkim: string;
    dmarc: string;
    mailFrom: string;
    dmarcPolicy: string | null;
    mailFromDomain: string | null;
    dkimTokens: string[] | null;
    lastCheckedAt: string | null;
  }> = {},
): Promise<string> {
  const res = await db.raw<{ id: string }>(
    `insert into sender_domains
       (workspace_id, domain, spf_status, dkim_status, dmarc_status, dmarc_policy,
        mail_from_status, mail_from_domain, dkim_tokens, last_checked_at)
     values ($1, $2, $3::verification_status, $4::verification_status,
             $5::verification_status, $6, $7::verification_status, $8, $9::text[],
             $10::timestamptz)
     returning id`,
    [
      workspaceId,
      domain,
      state.spf ?? 'pending',
      state.dkim ?? 'pending',
      state.dmarc ?? 'not_configured',
      state.dmarcPolicy ?? null,
      state.mailFrom ?? 'not_configured',
      state.mailFromDomain === undefined ? null : state.mailFromDomain,
      state.dkimTokens === undefined ? null : state.dkimTokens,
      state.lastCheckedAt === undefined ? null : state.lastCheckedAt,
    ],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error(`failed to seed sender domain ${domain}`);
  return id;
}

/** A fully verified domain — the state a sender may actually be used from. */
export function verifiedDomainState() {
  return {
    spf: 'verified',
    dkim: 'verified',
    dmarc: 'verified',
    dmarcPolicy: 'quarantine',
    mailFrom: 'verified',
    lastCheckedAt: new Date().toISOString(),
  } as const;
}

export async function seedSenderIdentity(
  db: TestDb,
  workspaceId: string,
  domainId: string,
  fromEmail: string,
  extra: { fromName?: string; replyTo?: string | null; verifiedAt?: string | null } = {},
): Promise<string> {
  const res = await db.raw<{ id: string }>(
    `insert into sender_identities
       (workspace_id, domain_id, from_email, from_name, reply_to, verified_at)
     values ($1, $2, $3, $4, $5, $6::timestamptz)
     returning id`,
    [
      workspaceId,
      domainId,
      fromEmail,
      extra.fromName ?? 'Test Sender',
      extra.replyTo ?? null,
      extra.verifiedAt ?? null,
    ],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error(`failed to seed sender identity ${fromEmail}`);
  return id;
}

/** A TXT answer in the chunked shape a resolver actually returns. */
export function txt(...values: string[]): string[][] {
  return values.map((value) => [value]);
}
