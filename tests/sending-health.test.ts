import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { describeHealth, formatRate, HEALTH_MIN_SAMPLE } from '@/lib/sending/health';

/**
 * The health explanation shown to people must agree with the guard that
 * actually pauses sending (migration 0017, app.events_health_guard). The guard
 * is exercised against a real database in provider-events-db.test.ts; this
 * pins the page's copy of the thresholds to the SQL text.
 */

const SQL = readFileSync(join(process.cwd(), 'supabase', 'migrations', '0017_event_reconciliation.sql'), 'utf8');

describe('sending health thresholds', () => {
  it('match the SQL guard exactly', () => {
    expect(SQL).toContain(`if v_health.sample < ${HEALTH_MIN_SAMPLE} then`);
    expect(SQL).toContain('v_health.bounced * 100 >= v_health.sample * 4');
    expect(SQL).toContain('v_health.complained * 10000 >= v_health.sample * 8');
    expect(SQL).toContain('limit 500');
  });

  it.each([
    [{ sample: 0, bounced: 0, complained: 0 }, 'no_data'],
    [{ sample: 99, bounced: 50, complained: 5 }, 'too_few'],
    [{ sample: 100, bounced: 3, complained: 0 }, 'healthy'],
    [{ sample: 100, bounced: 4, complained: 0 }, 'over_threshold'],
    [{ sample: 1250, bounced: 0, complained: 1 }, 'over_threshold'],
    [{ sample: 1251, bounced: 0, complained: 1 }, 'healthy'],
  ] as const)('%o is %s', (health, state) => {
    expect(describeHealth(health).state).toBe(state);
  });

  it('formats rates so a small one is still visible', () => {
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.0008)).toBe('0.08%');
    expect(formatRate(0.04)).toBe('4.0%');
    expect(formatRate(0.125)).toBe('12.5%');
  });
});
