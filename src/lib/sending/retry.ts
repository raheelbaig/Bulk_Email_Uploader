/**
 * Retry timing — ARCHITECTURE §14.2.
 *
 *   after attempt 1 → up to 1 min
 *   after attempt 2 → up to 4 min
 *   after attempt 3 → up to 15 min
 *   after attempt 4 → up to 1 hour
 *   attempt 5 is the last; the database refuses a sixth (email_jobs.attempts CHECK)
 *
 * Full jitter. Its purpose is queue hygiene, not disguise: a thousand messages
 * that failed in the same second must not all retry in the same second, or a
 * transient provider blip becomes a synchronised retry storm that reproduces it.
 *
 * A floor of ten seconds keeps a jittered retry from landing back in the tick
 * that just failed.
 */

export const MAX_ATTEMPTS = 5;

const BACKOFF_CEILING_MS = [60_000, 240_000, 900_000, 3_600_000] as const;
const MIN_DELAY_MS = 10_000;

/** A halted account is not retried on the backoff schedule; it waits for a person. */
export const HALT_RETRY_DELAY_MS = 15 * 60_000;

/** Null when `attempts` has used the last one. */
export function nextAttemptAt(
  attempts: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const ceiling = BACKOFF_CEILING_MS[attempts - 1];
  if (ceiling === undefined) return null;
  const delay = Math.max(MIN_DELAY_MS, Math.floor(random() * ceiling));
  return new Date(now.getTime() + delay);
}
