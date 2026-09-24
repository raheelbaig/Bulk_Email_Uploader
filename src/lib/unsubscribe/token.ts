import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless unsubscribe tokens — ARCHITECTURE §10.
 *
 *   payload = "v1" . workspace_id . campaign_id . job_id
 *   token   = base64url(payload) "." base64url(HMAC-SHA256(key[v], payload))
 *
 * One departure from §10.1: the token names the *job*, not the contact. The job
 * row carries the address frozen at launch, so the link keeps working after the
 * contact is deleted — an unsubscribe that stops working because someone tidied
 * the contact list is a compliance failure.
 *
 * Properties (§10.2): nothing stored, not enumerable, not forgeable without the
 * key, idempotent, versioned for rotation, and **no expiry**. An unsubscribe link
 * must work for as long as the email exists.
 *
 * Pure: keys are passed in. `./server.ts` binds them to the environment.
 */

export interface UnsubscribeClaims {
  workspaceId: string;
  campaignId: string;
  jobId: string;
}

export type UnsubscribeKeys = Readonly<Record<string, string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^v\d{1,3}$/;
/** Generous: a real token is ~200 characters. Anything far longer is not one. */
const MAX_TOKEN_LENGTH = 512;

function mac(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

export function mintUnsubscribeToken(
  claims: UnsubscribeClaims,
  keys: UnsubscribeKeys,
  activeVersion: string,
): string {
  const key = keys[activeVersion];
  if (key === undefined || key.length < 32) {
    throw new Error('the active unsubscribe key is not configured');
  }
  for (const id of [claims.workspaceId, claims.campaignId, claims.jobId]) {
    if (!UUID.test(id)) throw new Error('unsubscribe claims must be lowercase UUIDs');
  }
  const payload = [activeVersion, claims.workspaceId, claims.campaignId, claims.jobId].join('.');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${mac(key, payload)}`;
}

/** Null for anything that is not a genuine token. Never throws. */
export function verifyUnsubscribeToken(token: unknown, keys: UnsubscribeKeys): UnsubscribeClaims | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;

  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const fields = payload.split('.');
  if (fields.length !== 4) return null;
  const [version, workspaceId, campaignId, jobId] = fields as [string, string, string, string];

  if (!VERSION.test(version)) return null;
  if (![workspaceId, campaignId, jobId].every((id) => UUID.test(id))) return null;

  const key = keys[version];
  if (key === undefined || key.length < 32) return null; // unknown or retired version

  const expected = Buffer.from(mac(key, payload));
  const given = Buffer.from(signature);
  // Length first: timingSafeEqual throws on a mismatch, and a MAC's length is
  // fixed and public, so checking it leaks nothing (§10.3).
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;

  return { workspaceId, campaignId, jobId };
}
