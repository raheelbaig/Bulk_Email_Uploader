/**
 * Sending health — how a workspace's recent live mail is being received.
 *
 * The figures come from `workspace_send_health` (migration 0017): the last 500
 * live messages that reached Amazon SES, and how many of them hard-bounced or
 * were marked as spam. The pause itself happens in the database, in the same
 * transaction as the event that crossed a threshold (`app.events_health_guard`);
 * this module only explains the numbers. The constants below mirror that
 * function and are pinned to it by tests/sending-health.test.ts.
 *
 * Deliberately free of `server-only`: pure, and rendered by a page.
 */

export interface SendHealth {
  sample: number;
  bounced: number;
  complained: number;
}

/** Below this many messages there is no verdict, and nothing pauses. */
export const HEALTH_MIN_SAMPLE = 100;
/** 4%: below the ~5% where SES reviews an account. */
export const BOUNCE_PAUSE_RATE = 0.04;
/** 0.08%: below the ~0.1% where SES reviews an account. */
export const COMPLAINT_PAUSE_RATE = 0.0008;

export type HealthState = 'no_data' | 'too_few' | 'healthy' | 'over_threshold';

export interface HealthView {
  state: HealthState;
  bounceRate: number;
  complaintRate: number;
  bounceOver: boolean;
  complaintOver: boolean;
}

export function describeHealth(health: SendHealth): HealthView {
  const { sample, bounced, complained } = health;
  if (sample <= 0) {
    return { state: 'no_data', bounceRate: 0, complaintRate: 0, bounceOver: false, complaintOver: false };
  }
  const bounceRate = bounced / sample;
  const complaintRate = complained / sample;
  if (sample < HEALTH_MIN_SAMPLE) {
    return { state: 'too_few', bounceRate, complaintRate, bounceOver: false, complaintOver: false };
  }
  // Integer comparisons, exactly as the SQL makes them, so a rate on the line
  // is judged the same way here and there.
  const bounceOver = bounced * 100 >= sample * 4;
  const complaintOver = complained * 10000 >= sample * 8;
  return {
    state: bounceOver || complaintOver ? 'over_threshold' : 'healthy',
    bounceRate,
    complaintRate,
    bounceOver,
    complaintOver,
  };
}

/** `0.0412` → `"4.12%"`; small rates keep enough digits to be seen. */
export function formatRate(rate: number): string {
  const percent = rate * 100;
  if (percent === 0) return '0%';
  return `${percent < 1 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}
