import 'server-only';
import { requireWorkspace } from '@/lib/auth/workspace';
import { writeAuditLog } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { InternalError, ValidationError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/observability/logger';

/**
 * Workspace settings that affect what is sent.
 *
 * Today that is one field: the postal address appended to the footer of every
 * bulk message (migration 0014). Read and written under the caller's own
 * session, so RLS is the second layer — `workspace_settings_update` (0002)
 * admits only owners and admins, whatever this module checks first.
 */

export const POSTAL_ADDRESS_MIN = 10;
export const POSTAL_ADDRESS_MAX = 300;
const MAX_LINES = 6;
/** Every control character except the newline, which separates address lines. */
const CONTROL = new RegExp('[\\u0000-\\u0009\\u000B-\\u001F\\u007F]');

export interface WorkspaceSendingSettings {
  postalAddress: string | null;
}

/**
 * Normalises a submitted address: CRLF to LF, each line trimmed, blank lines
 * dropped. Empty means "remove it". Pure, so the rules are testable directly.
 */
export function parsePostalAddress(input: unknown): string | null {
  const raw = typeof input === 'string' ? input.replace(/\r\n?/g, '\n') : '';
  if (CONTROL.test(raw)) throw new ValidationError('The address contains characters that are not allowed.');

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  if (lines.length > MAX_LINES) throw new ValidationError(`Use at most ${MAX_LINES} lines for the address.`);

  const value = lines.join('\n');
  if (value.length < POSTAL_ADDRESS_MIN) {
    throw new ValidationError('That address looks too short. Include the street, town and postcode.');
  }
  if (value.length > POSTAL_ADDRESS_MAX) {
    throw new ValidationError(`Addresses are limited to ${POSTAL_ADDRESS_MAX} characters.`);
  }
  return value;
}

export async function getSendingSettings(workspaceId: string): Promise<WorkspaceSendingSettings> {
  await requireWorkspace(workspaceId);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('workspace_settings')
    .select('postal_address')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error !== null) throw new InternalError(error);
  const value: unknown = data?.postal_address;
  return { postalAddress: typeof value === 'string' && value.length > 0 ? value : null };
}

/**
 * Sets or clears the footer address. Owner or admin.
 *
 * Clearing it is allowed and immediately effective: campaigns that require
 * unsubscribe fail preflight, and one already sending pauses before its next
 * message (`lib/sending/worker`). That is the safe direction.
 */
export async function updatePostalAddress(workspaceId: string, input: unknown): Promise<string | null> {
  const access = await requireWorkspace(workspaceId, { minimumRole: 'admin' });
  await enforceRateLimit('campaign.write', access.userId, access.workspaceId);

  const postalAddress = parsePostalAddress(input);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('workspace_settings')
    .update({ postal_address: postalAddress })
    .eq('workspace_id', access.workspaceId)
    .select('workspace_id')
    .maybeSingle();
  if (error !== null) {
    logger.error('postal address update failed', { dbError: error.message, code: error.code });
    throw new InternalError(error);
  }
  if (data === null) throw new InternalError(new Error('workspace settings row not updated'));

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'workspace.settings_updated',
    // Which field changed, and whether it is now set. The address itself is in
    // the settings row; the audit trail does not need a second copy.
    metadata: { field: 'postal_address', set: postalAddress !== null },
  });

  return postalAddress;
}
