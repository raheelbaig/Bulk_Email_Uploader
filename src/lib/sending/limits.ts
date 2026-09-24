/**
 * Provider limits → a send budget. ARCHITECTURE §18.1–18.2.
 *
 * No sending limit is hard-coded (§15.3): the rate and the daily cap come from
 * the provider on every tick, scaled by `PROVIDER_SAFETY_FACTOR` so the system
 * stops short of the provider's own ceiling rather than discovering it through
 * throttling errors. `SentLast24Hours` is the provider's own count and is
 * authoritative over anything this system has counted.
 *
 * A limit that cannot be read yields null, and live sending waits for a tick
 * that can read it. Guessing a budget is how a sandboxed account (200 a day, one
 * a second) gets its first suspension.
 *
 * Deliberately free of `server-only`: pure.
 */

import type { ProviderSendingLimits } from '@/lib/sender/provider/types';
import type { ProviderBudget } from './worker';

export function budgetFromLimits(limits: ProviderSendingLimits, safetyFactor: number): ProviderBudget | null {
  if (!limits.sendingEnabled) return { perMinute: 0, remainingToday: 0 };
  if (limits.maxSendRate === null || limits.max24HourSend === null || limits.sentLast24Hours === null) {
    return null;
  }

  const factor = Math.min(1, Math.max(0.1, safetyFactor));
  // Max24HourSend of -1 is SES's way of saying "unlimited".
  const dailyCap = limits.max24HourSend < 0 ? Number.MAX_SAFE_INTEGER : Math.floor(limits.max24HourSend * factor);

  return {
    perMinute: Math.max(0, Math.floor(limits.maxSendRate * 60 * factor)),
    remainingToday: Math.max(0, dailyCap - limits.sentLast24Hours),
  };
}
