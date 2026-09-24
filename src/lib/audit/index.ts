import 'server-only';
import { z } from 'zod';
import { unscopedServiceClient } from '@/lib/db/service';
import { logger } from '@/lib/observability/logger';
import { redact } from '@/lib/observability/redact';

/**
 * Audit log writer.
 *
 * Append-only: users hold SELECT and nothing else (migration 0003), and a
 * trigger rejects UPDATE/DELETE from every role including service_role. Writes
 * go through the service role because `authenticated` has no INSERT policy —
 * by design, so a compromised browser session cannot forge history.
 */

/**
 * The closed set of auditable actions.
 *
 * A union rather than a free string so that a typo becomes a type error and the
 * set of things the system claims to audit is reviewable in one place. Actions
 * for later phases are listed now to fix their names before they are written
 * into stored data and become awkward to change.
 */
export const AUDIT_ACTIONS = [
  // auth
  'auth.login',
  'auth.logout',
  'auth.signup',
  'auth.password_reset_requested',
  // tenancy
  'workspace.bootstrapped',
  'workspace.renamed',
  'workspace.settings_updated',
  // contacts, lists, suppression (P1)
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'list.created',
  'list.updated',
  'list.deleted',
  'list.member_added',
  'list.member_removed',
  // imports (P2)
  'import.started',
  'import.mapped',
  'import.completed',
  'import.failed',
  // sender domains and identities (P3)
  'domain.added',
  'domain.verified',
  'domain.verification_failed',
  'domain.updated',
  'domain.removed',
  'identity.added',
  'identity.updated',
  'identity.removed',
  // templates and campaigns (P4)
  'template.created',
  'template.updated',
  'template.deleted',
  'campaign.created',
  'campaign.updated',
  'campaign.deleted',
  'campaign.scheduled',
  'campaign.unscheduled',
  'campaign.preflight_passed',
  'campaign.preflight_failed',
  'campaign.cancelled',
  'suppression.added_manual',
  'suppression.removed',
  // the sending engine (P5)
  'campaign.launched',
  'campaign.paused',
  'campaign.resumed',
  'campaign.missed_schedule',
  'campaign.completed',
  'campaign.failed',
  'policy.auto_paused',
  'send.uncertain_held',
  'send.uncertain_redispatched',
  'send.uncertain_left',
  'suppression.unsubscribed',
  // reserved for later phases — named now, unused until then
  'suppression.auto',
  'policy.rate_changed',
  'policy.health_state_changed',
  'test_send.dispatched',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const metadataSchema = z.record(z.string(), z.unknown());

export interface AuditEntry {
  workspaceId: string;
  action: AuditAction;
  actorId?: string | undefined;
  actorType?: 'user' | 'system' | 'provider';
  entityType?: string | undefined;
  entityId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Writes one audit record.
 *
 * Metadata is redacted before it is stored, not only before it is logged. An
 * audit table that accumulates tokens is a liability rather than a control, and
 * unlike a log it is retained forever.
 *
 * Failures are logged and swallowed: an audit write must never be the reason a
 * user-facing action fails. Where an action genuinely must not happen without
 * its audit record, use `writeAuditLogInTransaction` once P1 introduces a
 * transactional database handle.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  const metadata = entry.metadata === undefined ? {} : metadataSchema.parse(entry.metadata);

  const row = {
    workspace_id: entry.workspaceId,
    actor_id: entry.actorId ?? null,
    actor_type: entry.actorType ?? (entry.actorId === undefined ? 'system' : 'user'),
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId ?? null,
    metadata: redact(metadata) as Record<string, unknown>,
    ip: entry.ip ?? null,
    user_agent: entry.userAgent ?? null,
  };

  try {
    const db = unscopedServiceClient('audit log write');
    const { error } = await db.from('audit_logs').insert(row);
    if (error !== null) {
      logger.error('audit write failed', {
        action: entry.action,
        workspaceId: entry.workspaceId,
        dbError: error.message,
      });
    }
  } catch (cause) {
    logger.error('audit write threw', { action: entry.action, cause });
  }
}
