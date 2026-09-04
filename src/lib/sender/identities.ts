import 'server-only';
import { requireWorkspace } from '@/lib/auth/workspace';
import { writeAuditLog } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/errors';
import { normalizeEmail, NORMALIZE_FAILURE_MESSAGE } from '@/lib/email/normalize';
import { senderRepository } from './repository';
import { evaluateSenderReadiness, type SenderReadiness } from './readiness';
import { domainReadiness } from './status';
import type { SenderDomainRecord, SenderIdentityRecord, SenderRepository } from './ports';

/**
 * Sender identities.
 *
 * The rule this module exists to enforce — an identity may only be created under
 * a sending domain this workspace owns, and its address must sit under that
 * exact domain — is enforced three times over, deliberately:
 *
 *   1. Here, so the user gets a message that explains the problem.
 *   2. By RLS, so a request made outside this code path is still tenant-scoped.
 *   3. By the composite foreign key in migration 0008, so it is impossible
 *      rather than merely checked.
 *
 * Only the third is a guarantee. The first two produce good errors.
 */

export interface SenderIdentityInput {
  fromEmail: unknown;
  fromName: unknown;
  replyTo?: unknown;
}

export interface SenderIdentityView {
  record: SenderIdentityRecord;
  domain: SenderDomainRecord | null;
  readiness: SenderReadiness;
}

const MAX_NAME_LENGTH = 120;

/** C0 and C1 control ranges, plus DEL. Written as escapes so the source stays ASCII. */
const CONTROL = new RegExp('[\u0000-\u001F\u007F-\u009F]');

/**
 * Validates a display name.
 *
 * Control characters are rejected rather than stripped. A newline in a display
 * name is a header injection the moment P5 composes a message, and silently
 * repairing hostile input teaches nobody anything — the database refuses it too.
 */
function parseFromName(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (value.length === 0) throw new ValidationError('Enter a sender name.');
  if (value.length > MAX_NAME_LENGTH) {
    throw new ValidationError(`Sender names are limited to ${MAX_NAME_LENGTH} characters.`);
  }
  if (CONTROL.test(value)) {
    throw new ValidationError('The sender name contains characters that are not allowed.');
  }
  return value;
}

function parseEmail(input: unknown, field: 'from' | 'replyTo'): string {
  const result = normalizeEmail(input);
  if (!result.ok) {
    const detail = NORMALIZE_FAILURE_MESSAGE[result.reason];
    throw new ValidationError(
      field === 'from' ? detail : `Reply-to address: ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`,
    );
  }
  return result.normalized;
}

async function viewFor(
  repository: SenderRepository,
  record: SenderIdentityRecord,
  domains: SenderDomainRecord[] | null,
): Promise<SenderIdentityView> {
  const domain =
    domains === null
      ? await repository.getDomain(record.domain_id)
      : (domains.find((d) => d.id === record.domain_id) ?? null);
  return { record, domain, readiness: evaluateSenderReadiness({ identity: record, domain }) };
}

export async function listSenderIdentities(workspaceId: string): Promise<SenderIdentityView[]> {
  await requireWorkspace(workspaceId);
  const repository = await senderRepository(workspaceId);

  const [identities, domains] = await Promise.all([
    repository.listIdentities(),
    repository.listDomains(),
  ]);

  return Promise.all(identities.map((record) => viewFor(repository, record, domains)));
}

/**
 * Creates a sender identity.
 *
 * The domain is resolved from the *address*, not from a form field: a request
 * that names a domain id is checked against the address's own domain, so a
 * forged id cannot attach `hello@otherdomain.com` to `example.com`.
 *
 * A domain in a FAILED state is refused, because nothing about that identity
 * could ever work. A PENDING domain is accepted: preparing addresses while DNS
 * propagates is normal, and readiness — not existence — is what gates sending.
 */
export async function createSenderIdentity(
  workspaceId: string,
  input: SenderIdentityInput,
): Promise<SenderIdentityView> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('sender.identity_write', access.userId, access.workspaceId);

  const fromEmail = parseEmail(input.fromEmail, 'from');
  const fromName = parseFromName(input.fromName);
  const replyToRaw = typeof input.replyTo === 'string' ? input.replyTo.trim() : '';
  const replyTo = replyToRaw.length === 0 ? null : parseEmail(replyToRaw, 'replyTo');

  const emailDomain = fromEmail.slice(fromEmail.lastIndexOf('@') + 1);

  const repository = await senderRepository(access.workspaceId);
  const domain = await repository.findDomainByName(emailDomain);

  if (domain === null) {
    // Deliberately the same answer whether the domain belongs to another
    // workspace or does not exist at all.
    throw new ValidationError(
      'Add and verify that sending domain before you can send from an address on it.',
    );
  }

  const readiness = domainReadiness({
    spfStatus: domain.spf_status,
    dkimStatus: domain.dkim_status,
    dmarcStatus: domain.dmarc_status,
    mailFromStatus: domain.mail_from_status,
    dmarcPolicy: domain.dmarc_policy,
    lastCheckedAt: domain.last_checked_at,
  });
  if (readiness === 'FAILED') {
    throw new ConflictError(
      'That sending domain failed verification. Fix its DNS records before adding addresses to it.',
    );
  }

  const record = await repository.insertIdentity({
    domainId: domain.id,
    fromEmail,
    fromName,
    replyTo,
  });

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'identity.added',
    entityType: 'sender_identity',
    entityId: record.id,
    metadata: { fromEmail: record.from_email, domain: domain.domain },
  });

  return viewFor(repository, record, [domain]);
}

/**
 * Updates the editable fields.
 *
 * `from_email` and `domain_id` are not among them, here or in the column-level
 * grant. Changing an identity's address is a re-point at a different domain and
 * would need the same checks as creation, so it is a delete and a create — both
 * of which are audited.
 */
export async function updateSenderIdentity(
  workspaceId: string,
  identityId: string,
  input: { fromName: unknown; replyTo?: unknown },
): Promise<SenderIdentityView> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('sender.identity_write', access.userId, access.workspaceId);

  const fromName = parseFromName(input.fromName);
  const replyToRaw = typeof input.replyTo === 'string' ? input.replyTo.trim() : '';
  const replyTo = replyToRaw.length === 0 ? null : parseEmail(replyToRaw, 'replyTo');

  const repository = await senderRepository(access.workspaceId);
  const record = await repository.updateIdentity(identityId, { fromName, replyTo });
  if (record === null) throw new ForbiddenError();

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'identity.updated',
    entityType: 'sender_identity',
    entityId: record.id,
    metadata: { fromEmail: record.from_email },
  });

  return viewFor(repository, record, null);
}

export async function deleteSenderIdentity(
  workspaceId: string,
  identityId: string,
): Promise<void> {
  const access = await requireWorkspace(workspaceId);
  const repository = await senderRepository(access.workspaceId);

  const record = await repository.getIdentity(identityId);
  if (record === null) throw new ForbiddenError();

  const removed = await repository.deleteIdentity(identityId);
  if (!removed) throw new ForbiddenError();

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'identity.removed',
    entityType: 'sender_identity',
    entityId: identityId,
    metadata: { fromEmail: record.from_email },
  });
}

/**
 * The readiness authority's request-path entry point.
 *
 * P4's campaign preflight calls this — it must not read the status columns
 * itself. See `./readiness.ts` for the full contract.
 */
export async function getSenderReadiness(args: {
  workspaceId: string;
  senderIdentityId: string;
}): Promise<SenderReadiness> {
  await requireWorkspace(args.workspaceId);
  const repository = await senderRepository(args.workspaceId);

  const identity = await repository.getIdentity(args.senderIdentityId);
  const domain = identity === null ? null : await repository.getDomain(identity.domain_id);

  return evaluateSenderReadiness({ identity, domain });
}
