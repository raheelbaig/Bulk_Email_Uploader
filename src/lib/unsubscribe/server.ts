import 'server-only';
import { serverEnv } from '@/lib/env';
import {
  mintUnsubscribeToken,
  verifyUnsubscribeToken,
  type UnsubscribeClaims,
  type UnsubscribeKeys,
} from './token';

/**
 * The unsubscribe signer, bound to this deployment's keys.
 *
 * Adding a key version: add `UNSUBSCRIBE_SECRET_V2` to `lib/env`, add it to the
 * map below, and move `ACTIVE_VERSION`. Keep `v1` in the map for as long as mail
 * signed with it may still be opened — which is, in practice, forever.
 */
const ACTIVE_VERSION = 'v1';

function keys(): UnsubscribeKeys {
  const env = serverEnv();
  const map: Record<string, string> = {};
  if (env.UNSUBSCRIBE_SECRET_V1 !== undefined) map['v1'] = env.UNSUBSCRIBE_SECRET_V1;
  return map;
}

/** Null when no signing key is configured — the caller must treat that as "no mechanism". */
export function unsubscribeUrlFor(claims: UnsubscribeClaims, appUrl: string): string | null {
  const keyMap = keys();
  if (keyMap[ACTIVE_VERSION] === undefined) return null;
  const token = mintUnsubscribeToken(claims, keyMap, ACTIVE_VERSION);
  return `${appUrl.replace(/\/+$/, '')}/u/${token}`;
}

export function readUnsubscribeToken(token: unknown): UnsubscribeClaims | null {
  return verifyUnsubscribeToken(token, keys());
}
