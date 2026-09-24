import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Worker request authentication — ARCHITECTURE §12.3, §13.1.
 *
 *   X-Timestamp: <unix seconds>
 *   X-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>
 *
 * The timestamp is inside the MAC and must be within ±300 s, so a captured
 * request cannot be replayed later. It *can* be replayed within the window —
 * which is harmless by construction: a tick is idempotent (every state change it
 * makes is a guarded conditional update), so a replay does at most what the next
 * scheduled tick would have done anyway.
 *
 * Pure: the secret is passed in, so this is testable without an environment.
 */

export const SIGNATURE_WINDOW_SECONDS = 300;

export type WorkerAuthFailure =
  | 'not_configured'
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale'
  | 'bad_signature';

export function signWorkerRequest(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

export function verifyWorkerRequest(input: {
  secret: string | undefined;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowSeconds?: number;
}): { ok: true } | { ok: false; reason: WorkerAuthFailure } {
  if (input.secret === undefined || input.secret.length < 32) return { ok: false, reason: 'not_configured' };
  if (input.timestamp === null || input.signature === null) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{9,11}$/.test(input.timestamp)) return { ok: false, reason: 'bad_timestamp' };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(input.timestamp)) > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, reason: 'stale' };
  }

  const expected = Buffer.from(signWorkerRequest(input.secret, input.timestamp, input.body));
  const given = Buffer.from(input.signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
