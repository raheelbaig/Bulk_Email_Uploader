import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireWorkspace } from '@/lib/auth/workspace';
import { normalizeEmail, NORMALIZE_FAILURE_MESSAGE } from '@/lib/email/normalize';
import { ValidationError, ForbiddenError, InternalError } from '@/lib/errors';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { buildPage, clampLimit, type Cursor, type Page, type PageDirection } from '@/lib/pagination';

/**
 * Suppression.
 *
 * Keyed by (workspace_id, email_normalized) and never by contact_id, so a
 * suppression outlives the contact it relates to and can exist before one is
 * created (ARCHITECTURE §4.2). Nothing here decides eligibility — that lives in
 * `lib/eligibility`, which is the only module permitted to make that call.
 */

export const SUPPRESSION_REASONS = [
  'unsubscribe',
  'hard_bounce',
  'complaint',
  'invalid',
  'manually_blocked',
  'provider_suppressed',
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * Reasons a person may undo through the application.
 *
 * Must stay in step with `app.suppression_reason_is_reversible` in migration
 * 0005 — the database is the enforcement point, this constant only shapes the
 * UI. `tests/suppression.test.ts` asserts the two agree.
 */
export const REVERSIBLE_REASONS: readonly SuppressionReason[] = ['manually_blocked', 'invalid'];

export function isReversible(reason: string): boolean {
  return (REVERSIBLE_REASONS as readonly string[]).includes(reason);
}

export interface Suppression {
  id: string;
  workspace_id: string;
  email_normalized: string;
  reason: SuppressionReason;
  source: string;
  campaign_id: string | null;
  detail: string | null;
  created_at: string;
}

const SELECT_COLUMNS =
  'id, workspace_id, email_normalized, reason, source, campaign_id, detail, created_at';

export const suppressionInputSchema = z.object({
  email: z.string().min(1, 'Enter an email address.').max(320),
  reason: z.enum(SUPPRESSION_REASONS),
  source: z.string().trim().min(1).max(60).default('manual'),
  detail: z
    .string()
    .trim()
    .max(500)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional(),
  campaignId: z.uuid().nullable().optional(),
});

export type SuppressionInput = z.input<typeof suppressionInputSchema>;

function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

// ─────────────────────────────────────────────────────────────────────────────

export async function listSuppressions(
  workspaceId: string,
  options: {
    search?: string | undefined;
    reason?: SuppressionReason | undefined;
    limit?: number;
    cursor?: Cursor | undefined;
    direction?: PageDirection;
  } = {},
): Promise<Page<Suppression>> {
  await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();

  const limit = clampLimit(options.limit);
  const direction: PageDirection = options.direction ?? 'forward';
  const ascending = direction === 'backward';

  let query = supabase
    .from('suppressions')
    .select(SELECT_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending })
    .order('id', { ascending })
    .limit(limit + 1);

  if (options.reason !== undefined) query = query.eq('reason', options.reason);

  const search = options.search?.trim();
  if (search !== undefined && search.length >= 2) {
    // Prefix match, served by the uq_suppressions btree. A leading wildcard here
    // would be a sequential scan, and there is no trigram index on this table.
    const escaped = search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
    query = query.like('email_normalized', `${escaped}%`);
  }

  const cursor = options.cursor;
  if (cursor !== undefined) {
    const op = ascending ? 'gt' : 'lt';
    query = query.or(
      `created_at.${op}.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.${op}.${cursor.id})`,
    );
  }

  const { data, error } = await query;
  if (error !== null) {
    logger.error('suppression query failed', { dbError: error.message });
    throw new InternalError(error);
  }

  return buildPage(rows<Suppression>(data), limit, direction, cursor !== undefined);
}

/** Direct lookup. Not an eligibility decision — see `lib/eligibility`. */
export async function findSuppression(
  workspaceId: string,
  email: string,
): Promise<Suppression | null> {
  await requireWorkspace(workspaceId);

  const normalized = normalizeEmail(email);
  if (!normalized.ok) return null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('suppressions')
    .select(SELECT_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('email_normalized', normalized.normalized)
    .maybeSingle();

  if (error !== null) {
    logger.error('suppression lookup failed', { dbError: error.message });
    throw new InternalError(error);
  }
  return data as unknown as Suppression | null;
}

/**
 * Adds a suppression. Idempotent.
 *
 * A repeat call returns the existing record rather than raising: suppression is
 * the safe direction, and a caller retrying after a timeout must not be punished
 * for it. The first reason recorded wins — a later 'manually_blocked' never
 * overwrites an earlier 'complaint', because that would downgrade a compliance
 * record into a reversible one.
 */
export async function addSuppression(
  workspaceId: string,
  input: SuppressionInput,
): Promise<{ suppression: Suppression; created: boolean }> {
  const access = await requireWorkspace(workspaceId);
  const parsed = suppressionInputSchema.parse(input);

  const normalized = normalizeEmail(parsed.email);
  if (!normalized.ok) throw new ValidationError(NORMALIZE_FAILURE_MESSAGE[normalized.reason]);

  const supabase = await createSupabaseServerClient();

  const existing = await supabase
    .from('suppressions')
    .select(SELECT_COLUMNS)
    .eq('workspace_id', access.workspaceId)
    .eq('email_normalized', normalized.normalized)
    .maybeSingle();

  if (existing.error !== null) {
    logger.error('suppression pre-check failed', { dbError: existing.error.message });
    throw new InternalError(existing.error);
  }
  if (existing.data !== null) {
    return { suppression: existing.data as unknown as Suppression, created: false };
  }

  const { data, error } = await supabase
    .from('suppressions')
    .insert({
      workspace_id: access.workspaceId,
      email_normalized: normalized.normalized,
      reason: parsed.reason,
      source: parsed.source,
      detail: parsed.detail ?? null,
      campaign_id: parsed.campaignId ?? null,
    })
    .select(SELECT_COLUMNS)
    .maybeSingle();

  if (error !== null) {
    // Lost the race against a concurrent insert. The unique constraint is the
    // real idempotency guarantee; the pre-check above is only an optimisation.
    if (error.code === '23505') {
      const raced = await supabase
        .from('suppressions')
        .select(SELECT_COLUMNS)
        .eq('workspace_id', access.workspaceId)
        .eq('email_normalized', normalized.normalized)
        .maybeSingle();
      if (raced.data !== null) {
        return { suppression: raced.data as unknown as Suppression, created: false };
      }
    }
    logger.error('suppression insert failed', { dbError: error.message, code: error.code });
    throw new InternalError(error);
  }
  if (data === null) throw new InternalError('insert returned no row');

  const suppression = data as unknown as Suppression;

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'suppression.added_manual',
    entityType: 'suppression',
    entityId: suppression.id,
    metadata: {
      reason: suppression.reason,
      source: suppression.source,
      emailDomain: normalized.domain,
    },
  });

  return { suppression, created: true };
}

/**
 * Removes a suppression.
 *
 * Two independent restrictions, both enforced in the RLS DELETE policy:
 * owner/admin only, and only reasons the database considers reversible. There is
 * no code path — for any role — that un-suppresses a complaint, an unsubscribe,
 * a hard bounce, or a provider suppression. The check below exists to produce a
 * clear message; the policy produces the guarantee.
 */
export async function removeSuppression(
  workspaceId: string,
  suppressionId: string,
): Promise<void> {
  const access = await requireWorkspace(workspaceId, { minimumRole: 'admin' });
  const supabase = await createSupabaseServerClient();

  const existing = await supabase
    .from('suppressions')
    .select(SELECT_COLUMNS)
    .eq('workspace_id', access.workspaceId)
    .eq('id', suppressionId)
    .maybeSingle();

  if (existing.error !== null || existing.data === null) {
    throw new ForbiddenError(existing.error ?? undefined);
  }

  const record = existing.data as unknown as Suppression;

  if (!isReversible(record.reason)) {
    throw new ValidationError(
      'This suppression cannot be removed. The recipient asked not to be emailed, or their provider rejected the address.',
    );
  }

  const { data, error } = await supabase
    .from('suppressions')
    .delete()
    .eq('workspace_id', access.workspaceId)
    .eq('id', suppressionId)
    .select('id')
    .maybeSingle();

  if (error !== null) {
    logger.error('suppression delete failed', { dbError: error.message });
    throw new InternalError(error);
  }
  if (data === null) throw new ForbiddenError();

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'suppression.removed',
    entityType: 'suppression',
    entityId: suppressionId,
    metadata: { reason: record.reason, emailDomain: record.email_normalized.split('@')[1] ?? null },
  });
}
