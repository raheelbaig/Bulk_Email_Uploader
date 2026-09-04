import 'server-only';
import { requireWorkspace } from '@/lib/auth/workspace';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { enforceRateLimit } from '@/lib/rate-limit';
import { ConflictError, ForbiddenError, InternalError, ValidationError } from '@/lib/errors';
import {
  DOMAIN_FAILURE_MESSAGE,
  mailFromDomainFor,
  normalizeDomainName,
} from './domain-name';
import { emailProvider, EmailProviderError, isProviderConfigured } from './provider';
import { senderRepository } from './repository';
import { requiredDnsRecords, type RequiredDnsRecord } from './records';
import {
  domainReadiness,
  isDomainUsable,
  readinessSummary,
  type DomainReadiness,
} from './status';
import { runDomainCheck, type DomainCheckResult, type VerificationDeps } from './verification';
import { nodeDnsResolver } from './dns/resolver';
import type { SenderDomainRecord } from './ports';

/**
 * Sender domains: adding, provisioning, re-checking, removing.
 *
 * Every entry point authorises through `requireWorkspace` before it touches
 * anything, and every one of them treats the supplied domain as untrusted until
 * `normalizeDomainName` has accepted it. Nothing here makes an HTTP request to
 * the user's domain — the only outbound calls are to the provider's fixed
 * endpoint and to DNS (§10).
 */

/** A domain plus everything the UI needs to render its card and setup page. */
export interface SenderDomainView {
  record: SenderDomainRecord;
  readiness: DomainReadiness;
  summary: string;
  usable: boolean;
  records: RequiredDnsRecord[];
  identityCount: number;
}

function viewFor(record: SenderDomainRecord, region: string, identityCount: number): SenderDomainView {
  const state = {
    spfStatus: record.spf_status,
    dkimStatus: record.dkim_status,
    dmarcStatus: record.dmarc_status,
    mailFromStatus: record.mail_from_status,
    dmarcPolicy: record.dmarc_policy,
    lastCheckedAt: record.last_checked_at,
  };
  return {
    record,
    readiness: domainReadiness(state),
    summary: readinessSummary(state),
    usable: isDomainUsable(state),
    records: requiredDnsRecords({
      domain: record.domain,
      dkimTokens: record.dkim_tokens,
      mailFromDomain: record.mail_from_domain,
      region,
    }),
    identityCount,
  };
}

/**
 * The provider's region, for building DNS record values.
 *
 * Falls back to a placeholder when the provider is unconfigured so the pages
 * still render and say so, rather than throwing on a settings page whose whole
 * purpose is to tell the operator that configuration is missing.
 */
function providerRegion(): string {
  return isProviderConfigured() ? emailProvider().region : 'us-east-1';
}

export async function listSenderDomains(workspaceId: string): Promise<SenderDomainView[]> {
  await requireWorkspace(workspaceId);
  const repository = await senderRepository(workspaceId);

  const [domains, identities] = await Promise.all([
    repository.listDomains(),
    repository.listIdentities(),
  ]);
  const region = providerRegion();

  return domains.map((record) =>
    viewFor(record, region, identities.filter((i) => i.domain_id === record.id).length),
  );
}

export async function getSenderDomain(
  workspaceId: string,
  domainId: string,
): Promise<SenderDomainView> {
  await requireWorkspace(workspaceId);
  const repository = await senderRepository(workspaceId);

  const record = await repository.getDomain(domainId);
  // Absent and not-yours answer identically, so a caller cannot enumerate ids.
  if (record === null) throw new ForbiddenError();

  return viewFor(record, providerRegion(), await repository.countIdentitiesForDomain(domainId));
}

/** Validates a domain, or throws a `ValidationError` naming what is wrong. */
export function parseDomainInput(input: unknown): string {
  const parsed = normalizeDomainName(input);
  if (!parsed.ok) throw new ValidationError(DOMAIN_FAILURE_MESSAGE[parsed.reason]);
  return parsed.domain;
}

function requireProvider() {
  if (!isProviderConfigured()) {
    throw new ValidationError(
      'Email sending is not configured for this deployment yet. Ask an administrator to add the provider credentials.',
    );
  }
  return emailProvider();
}

/** Provider failures, translated into something a person can act on. */
function providerFailure(cause: unknown): never {
  if (cause instanceof EmailProviderError) {
    switch (cause.kind) {
      case 'access_denied':
        throw new InternalError(cause);
      case 'rate_limited':
        throw new ConflictError(
          'The sending provider is rate limiting this account. Try again in a few minutes.',
          cause,
        );
      case 'invalid_request':
        throw new ValidationError('The sending provider rejected that domain.', cause);
      default:
        throw new InternalError(cause);
    }
  }
  throw new InternalError(cause);
}

export interface AddDomainResult {
  view: SenderDomainView;
  created: boolean;
}

/**
 * Adds a sending domain and provisions it with the provider.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * Every step is safe to repeat, because every step is reached again on a retry:
 *
 *   1. `insertDomain` returns the existing row instead of failing on the unique
 *      constraint, so a double-submitted form produces one row.
 *   2. `createDomainIdentity` treats the provider's "already exists" as success
 *      and reads the identity back, so no duplicate identity is created.
 *   3. MAIL FROM is configured only when it is not already what we want.
 *   4. Verification then runs and *overwrites* status, so a repeat cannot leave
 *      a domain claiming a state it no longer has.
 *
 * A domain added, deleted and re-added therefore re-adopts its existing provider
 * identity, keeping the DKIM tokens the user already published.
 */
export async function addSenderDomain(
  workspaceId: string,
  input: unknown,
  deps?: Partial<VerificationDeps>,
): Promise<AddDomainResult> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('sender.domain_add', access.userId, access.workspaceId);

  const domain = parseDomainInput(input);
  const provider = deps?.provider ?? requireProvider();
  const repository = await senderRepository(access.workspaceId);

  const { record, created } = await repository.insertDomain(domain);

  if (created) {
    await writeAuditLog({
      workspaceId: access.workspaceId,
      actorId: access.userId,
      actorType: 'user',
      action: 'domain.added',
      entityType: 'sender_domain',
      entityId: record.id,
      metadata: { domain },
    });
  }

  let identity;
  try {
    identity = await provider.createDomainIdentity(domain);
  } catch (cause) {
    logger.warn('sender domain provisioning failed', { workspaceId, domain, cause });
    providerFailure(cause);
  }

  // The MAIL FROM subdomain is derived, never supplied by the request. See
  // `mailFromDomainFor` for why that matters.
  const mailFrom = mailFromDomainFor(domain);
  if (mailFrom !== null && identity.mailFrom.domain !== mailFrom) {
    try {
      await provider.configureMailFrom(domain, mailFrom);
      identity = (await provider.getDomainIdentity(domain)) ?? identity;
    } catch (cause) {
      // A MAIL FROM failure is not fatal to the add: the domain row exists, DKIM
      // records can already be published, and the next verification retries.
      logger.warn('custom MAIL FROM configuration failed', { workspaceId, domain, cause });
    }
  }

  await repository.updateDomainProvisioning(record.id, {
    ses_identity_arn: identity.identityArn,
    dkim_tokens: identity.dkim.tokens.length > 0 ? identity.dkim.tokens : null,
    mail_from_domain: identity.mailFrom.domain ?? mailFrom,
  });

  const refreshed = await repository.getDomain(record.id);
  if (refreshed === null) throw new InternalError('domain disappeared during provisioning');

  // Run the checks immediately so the setup page shows real state rather than
  // the column defaults.
  await runDomainCheck(repository, refreshed, {
    provider,
    resolver: deps?.resolver ?? (await nodeDnsResolver()),
    ...(deps?.now === undefined ? {} : { now: deps.now }),
  });

  const finalRecord = await repository.getDomain(record.id);
  return {
    view: viewFor(finalRecord ?? refreshed, provider.region, 0),
    created,
  };
}

/** User-triggered re-check. Safe to repeat; rate limited per user and workspace. */
export async function refreshSenderDomain(
  workspaceId: string,
  domainId: string,
  deps?: Partial<VerificationDeps>,
): Promise<DomainCheckResult> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('sender.domain_verify', access.userId, access.workspaceId);

  const repository = await senderRepository(access.workspaceId);
  const record = await repository.getDomain(domainId);
  if (record === null) throw new ForbiddenError();

  return runDomainCheck(repository, record, {
    provider: deps?.provider ?? requireProvider(),
    resolver: deps?.resolver ?? (await nodeDnsResolver()),
    ...(deps?.now === undefined ? {} : { now: deps.now }),
  });
}

/**
 * Removes a sending domain from this workspace.
 *
 * Owner or admin only, enforced here and again by the RLS policy in migration
 * 0008. A domain with identities under it is refused by the foreign key rather
 * than cascading them away.
 *
 * The provider identity is deliberately *not* deleted. P3's IAM policy grants no
 * identity-deletion permission (docs/ses-iam-policy.json): a bug or a hostile
 * request would otherwise be able to destroy sending configuration across an
 * entire AWS account, and the recovery — re-publishing DKIM records and waiting
 * for propagation — is measured in days. Removing the identity in AWS is a
 * deliberate console action.
 */
export async function removeSenderDomain(workspaceId: string, domainId: string): Promise<void> {
  const access = await requireWorkspace(workspaceId, { minimumRole: 'admin' });
  const repository = await senderRepository(access.workspaceId);

  const record = await repository.getDomain(domainId);
  if (record === null) throw new ForbiddenError();

  const outcome = await repository.deleteDomain(domainId);
  if (outcome === 'in_use') {
    throw new ConflictError(
      'Remove the sender addresses that use this domain before deleting it.',
    );
  }
  if (outcome === 'missing') throw new ForbiddenError();

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'domain.removed',
    entityType: 'sender_domain',
    entityId: domainId,
    metadata: { domain: record.domain },
  });
}
