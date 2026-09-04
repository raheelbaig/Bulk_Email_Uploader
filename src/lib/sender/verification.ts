import 'server-only';
import { emailProvider, EmailProviderError, type EmailProvider, type ProviderDomainIdentity } from './provider';
import { nodeDnsResolver, type DnsResolver } from './dns/resolver';
import { evaluateSpf, type SpfEvaluation } from './dns/spf';
import { evaluateDmarc, type DmarcEvaluation } from './dns/dmarc';
import { dmarcRecordName } from './domain-name';
import { isDomainUsable, type VerificationStatus } from './status';
import { senderRepository, backgroundSenderRepository } from './repository';
import { unscopedServiceClient } from '@/lib/db/service';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { ForbiddenError } from '@/lib/errors';
import type {
  DomainVerificationPatch,
  DueDomain,
  SenderDomainRecord,
  SenderRepository,
} from './ports';

/**
 * The verifier.
 *
 * This is the only code in the system permitted to write a verification status.
 * Its inputs are the provider's own verdict and DNS answers; nothing it stores
 * originates from a request. That is what enforces the rule "the user can never
 * self-declare a domain as verified" at the layer above the database's refusal
 * to grant them the privilege.
 *
 * The decision — statuses from provider state plus DNS evaluations — is pure and
 * exported separately from the orchestration, so every mapping (including the
 * hostile and transient cases) is testable without a provider or a resolver.
 */

export interface VerificationDeps {
  provider: EmailProvider;
  resolver: DnsResolver;
  now?: () => Date;
}

export interface DomainCheckResult {
  patch: DomainVerificationPatch;
  usable: boolean;
  spf: SpfEvaluation;
  dmarc: DmarcEvaluation;
  identity: ProviderDomainIdentity | null;
}

/** Provider verification state → stored status. */
function fromProviderState(state: ProviderDomainIdentity['dkim']['status']): VerificationStatus {
  switch (state) {
    case 'verified':
      return 'verified';
    case 'failed':
      return 'failed';
    // A temporary provider failure is not a hard failure. Recording it as one
    // would take a working domain out of service over a transient condition the
    // next check will clear.
    case 'temporary_failure':
    case 'pending':
    case 'not_started':
      return 'pending';
  }
}

/**
 * The DNS name whose SPF record governs this domain's mail.
 *
 * SPF authorises the *envelope* sender, which is the MAIL FROM domain when one
 * is configured. Checking the organisational domain instead would report a
 * verified SPF for a domain whose actual envelope is `amazonses.com`, which is
 * exactly the false positive §7 forbids.
 */
export function spfCheckName(domain: SenderDomainRecord, identity: ProviderDomainIdentity | null): string {
  return identity?.mailFrom.domain ?? domain.mail_from_domain ?? domain.domain;
}

/**
 * Maps provider and DNS answers onto stored status.
 *
 * `previous` exists for one reason: a lookup failure is not evidence. When DNS
 * cannot be read, the previous status is carried forward rather than being
 * downgraded, so a resolver timeout does not take a verified domain out of
 * service. A *successful* lookup that finds nothing does downgrade it — that is
 * evidence.
 */
export function computeVerification(input: {
  previous: SenderDomainRecord;
  identity: ProviderDomainIdentity | null;
  spf: SpfEvaluation;
  dmarc: DmarcEvaluation;
  providerError: string | null;
  checkedAt: Date;
}): DomainCheckResult {
  const { previous, identity, spf, dmarc } = input;

  // ── DKIM ────────────────────────────────────────────────────────────────
  // The provider's verdict is authoritative and is never inferred from DNS:
  // seeing the CNAMEs resolve is not the same as SES having accepted them.
  // `usableForSending` is required as well as DKIM success, because that is the
  // flag SES itself gates sending on.
  let dkimStatus: VerificationStatus;
  if (identity === null) {
    dkimStatus = input.providerError === null ? 'pending' : previous.dkim_status;
  } else {
    const dkim = fromProviderState(identity.dkim.status);
    // Both conditions, and a DKIM success that the provider will still not send
    // from is *pending*, not verified — falling through to `dkim` here would
    // report exactly the state SES refuses to send in as ready to send.
    if (dkim !== 'verified') dkimStatus = dkim;
    else dkimStatus = identity.usableForSending ? 'verified' : 'pending';
  }

  // ── MAIL FROM ───────────────────────────────────────────────────────────
  let mailFromStatus: VerificationStatus;
  if (identity === null) {
    // No answer from the provider is not an answer about MAIL FROM.
    mailFromStatus = previous.mail_from_status;
  } else if (identity.mailFrom.domain === null) {
    mailFromStatus = 'not_configured';
  } else {
    mailFromStatus = fromProviderState(identity.mailFrom.status);
  }

  // ── SPF ─────────────────────────────────────────────────────────────────
  let spfStatus: VerificationStatus;
  switch (spf.verdict) {
    case 'authorized':
      spfStatus = 'verified';
      break;
    case 'malformed':
    case 'multiple_records':
      spfStatus = 'failed';
      break;
    case 'lookup_failed':
      spfStatus = previous.spf_status;
      break;
    case 'missing':
    case 'not_authorized':
      spfStatus = 'pending';
      break;
  }

  // ── DMARC ───────────────────────────────────────────────────────────────
  let dmarcStatus: VerificationStatus;
  let dmarcPolicy: string | null;
  switch (dmarc.verdict) {
    case 'enforcing':
      dmarcStatus = 'verified';
      dmarcPolicy = dmarc.policy;
      break;
    case 'monitoring_only':
      // A record exists and is valid, but asks receivers to do nothing. Not a
      // failure, and deliberately not "verified" either.
      dmarcStatus = 'pending';
      dmarcPolicy = dmarc.policy;
      break;
    case 'malformed':
    case 'multiple_records':
      dmarcStatus = 'failed';
      dmarcPolicy = null;
      break;
    case 'lookup_failed':
      dmarcStatus = previous.dmarc_status;
      dmarcPolicy = previous.dmarc_policy;
      break;
    case 'missing':
      dmarcStatus = 'not_configured';
      dmarcPolicy = null;
      break;
  }

  const patch: DomainVerificationPatch = {
    spf_status: spfStatus,
    dkim_status: dkimStatus,
    dmarc_status: dmarcStatus,
    dmarc_policy: dmarcPolicy,
    mail_from_status: mailFromStatus,
    last_checked_at: input.checkedAt.toISOString(),
    last_check_error: input.providerError,
  };

  return {
    patch,
    usable: isDomainUsable({
      spfStatus,
      dkimStatus,
      dmarcStatus,
      mailFromStatus,
      dmarcPolicy,
      lastCheckedAt: patch.last_checked_at,
    }),
    spf,
    dmarc,
    identity,
  };
}

async function defaultDeps(): Promise<VerificationDeps> {
  return { provider: emailProvider(), resolver: await nodeDnsResolver() };
}

/**
 * Runs one domain's checks and persists the result.
 *
 * Takes an already-authorized repository, so it is equally callable from a
 * request (after `requireWorkspace`) and from the periodic sweep. Never throws
 * on a provider or DNS fault: a failed check is *recorded* — that is the point
 * of `last_check_error` — rather than surfacing as a 500 that leaves the row
 * stale and the user with nothing to act on.
 */
export async function runDomainCheck(
  repository: SenderRepository,
  domain: SenderDomainRecord,
  deps: VerificationDeps,
): Promise<DomainCheckResult> {
  const checkedAt = (deps.now ?? (() => new Date()))();

  let identity: ProviderDomainIdentity | null = null;
  let providerError: string | null = null;

  try {
    identity = await deps.provider.getDomainIdentity(domain.domain);
    if (identity === null) {
      providerError = 'This domain is not registered with the sending provider yet.';
    }
  } catch (cause) {
    providerError =
      cause instanceof EmailProviderError
        ? cause.detail
        : 'The sending provider could not be reached.';
    logger.warn('sender domain provider lookup failed', {
      domainId: domain.id,
      workspaceId: repository.workspaceId,
      cause,
    });
  }

  const [spfAnswer, dmarcAnswer] = await Promise.all([
    deps.resolver.resolveTxt(spfCheckName(domain, identity)),
    deps.resolver.resolveTxt(dmarcRecordName(domain.domain)),
  ]);

  // A resolver that answers "no such name" has answered. Only a transport-level
  // failure is treated as "we do not know", which `evaluateSpf` distinguishes by
  // being handed null.
  const spfTxt = spfAnswer.ok
    ? spfAnswer.records
    : spfAnswer.reason === 'no_data' || spfAnswer.reason === 'nxdomain'
      ? []
      : null;
  const dmarcTxt = dmarcAnswer.ok
    ? dmarcAnswer.records
    : dmarcAnswer.reason === 'no_data' || dmarcAnswer.reason === 'nxdomain'
      ? []
      : null;

  const result = computeVerification({
    previous: domain,
    identity,
    spf: evaluateSpf({ txt: spfTxt }),
    dmarc: evaluateDmarc(dmarcTxt),
    providerError,
    checkedAt,
  });

  await repository.updateDomainVerification(domain.id, result.patch);

  // The identity stamp follows the domain, so `verified_at` can never disagree
  // with the authority that decides usability.
  const wasUsable = isDomainUsable({
    spfStatus: domain.spf_status,
    dkimStatus: domain.dkim_status,
    dmarcStatus: domain.dmarc_status,
    mailFromStatus: domain.mail_from_status,
    dmarcPolicy: domain.dmarc_policy,
    lastCheckedAt: domain.last_checked_at,
  });

  if (result.usable !== wasUsable) {
    await repository.setIdentityVerification(
      domain.id,
      result.usable ? result.patch.last_checked_at : null,
    );
  }

  await recordCheckAudit({
    workspaceId: repository.workspaceId,
    domain,
    result,
    wasUsable,
  });

  return result;
}

/**
 * Audits transitions only.
 *
 * A six-hourly sweep over every domain would otherwise write an audit row per
 * domain per run forever, which is both noise and a slow leak of the free-tier
 * storage budget (§22). What matters historically is when a domain *became*
 * usable and when it stopped being so.
 */
async function recordCheckAudit(args: {
  workspaceId: string;
  domain: SenderDomainRecord;
  result: DomainCheckResult;
  wasUsable: boolean;
}): Promise<void> {
  const { workspaceId, domain, result, wasUsable } = args;

  if (result.usable && !wasUsable) {
    await writeAuditLog({
      workspaceId,
      actorType: 'system',
      action: 'domain.verified',
      entityType: 'sender_domain',
      entityId: domain.id,
      // The domain name only. DKIM tokens are configuration the audit trail has
      // no use for, and an audit table is retained far longer than a log.
      metadata: { domain: domain.domain },
    });
    return;
  }

  const failedNow =
    result.patch.dkim_status === 'failed' ||
    result.patch.spf_status === 'failed' ||
    result.patch.mail_from_status === 'failed';
  const failedBefore =
    domain.dkim_status === 'failed' ||
    domain.spf_status === 'failed' ||
    domain.mail_from_status === 'failed';

  if ((failedNow && !failedBefore) || (wasUsable && !result.usable)) {
    await writeAuditLog({
      workspaceId,
      actorType: 'system',
      action: 'domain.verification_failed',
      entityType: 'sender_domain',
      entityId: domain.id,
      metadata: {
        domain: domain.domain,
        dkim: result.patch.dkim_status,
        spf: result.patch.spf_status,
        mailFrom: result.patch.mail_from_status,
      },
    });
  }
}

/**
 * Re-checks one domain for a workspace. Authorization is the caller's job.
 */
export async function verifySenderDomain(
  workspaceId: string,
  domainId: string,
  deps?: VerificationDeps,
): Promise<DomainCheckResult> {
  const repository = await senderRepository(workspaceId);
  const domain = await repository.getDomain(domainId);
  if (domain === null) throw new ForbiddenError();
  return runDomainCheck(repository, domain, deps ?? (await defaultDeps()));
}

/**
 * The periodic sweep.
 *
 * ── Why there is no HTTP endpoint for this in P3 ──────────────────────────
 *
 * ARCHITECTURE §12 schedules re-verification with pg_cron calling an internal
 * worker route, and that route authenticates with `WORKER_HMAC_SECRET` — which
 * belongs to P5 along with the rest of the worker surface. Shipping the endpoint
 * now would mean shipping either an unauthenticated mutation endpoint or half of
 * P5's authentication scheme. So P3 ships the *service*: a single function a
 * scheduler can call once its authenticated entry point exists, with the sweep
 * order already backed by an index (`ix_sender_domains_recheck`).
 *
 * The unscoped client is used only to discover which workspaces have work; every
 * read and write that follows goes through a workspace-bound repository.
 */
export async function verifyDueSenderDomains(options: {
  limit?: number;
  olderThanMinutes?: number;
  deps?: VerificationDeps;
}): Promise<{ checked: number; failed: number }> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const cutoff = new Date(Date.now() - (options.olderThanMinutes ?? 360) * 60_000).toISOString();

  const db = unscopedServiceClient('periodic sender-domain verification sweep');
  const { data, error } = await db
    .from('sender_domains')
    .select('id, workspace_id')
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error !== null) {
    logger.error('sender domain sweep query failed', { dbError: error.message });
    return { checked: 0, failed: 0 };
  }

  const due = (data ?? []) as unknown as DueDomain[];
  const deps = options.deps ?? (await defaultDeps());

  let checked = 0;
  let failed = 0;

  for (const row of due) {
    try {
      const repository = await backgroundSenderRepository(row.workspace_id);
      const domain = await repository.getDomain(row.id);
      if (domain === null) continue;
      await runDomainCheck(repository, domain, deps);
      checked += 1;
    } catch (cause) {
      // One workspace's failure must not stop the sweep.
      failed += 1;
      logger.error('sender domain check failed during sweep', {
        workspaceId: row.workspace_id,
        domainId: row.id,
        cause,
      });
    }
  }

  return { checked, failed };
}
