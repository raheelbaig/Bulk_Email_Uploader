import { describe, it, expect } from 'vitest';
import {
  checkStoredSchedule,
  formatInZone,
  isValidTimeZone,
  MAX_SCHEDULE_AHEAD_MS,
  MIN_SCHEDULE_LEAD_MS,
  parseScheduleRequest,
  toLocalInputValue,
  zonedWallClockToUtc,
} from '@/lib/campaigns/schedule';

/**
 * Scheduling and timezones.
 *
 * The bug this suite exists to prevent: a person in Europe/London types 09:00,
 * the server interprets it as 09:00 UTC because that is the zone the function
 * happens to run in, and in summer the campaign is scheduled an hour early.
 */

const NOW = new Date('2026-03-01T12:00:00.000Z');

describe('timezone conversion', () => {
  it('interprets a wall-clock time in the zone it was typed in', () => {
    // 09:00 in New York on a winter date is 14:00 UTC (UTC-5).
    expect(zonedWallClockToUtc('2026-01-15T09:00', 'America/New_York')?.toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
    // The same wall-clock time in Tokyo is the previous midnight UTC.
    expect(zonedWallClockToUtc('2026-01-15T09:00', 'Asia/Tokyo')?.toISOString()).toBe(
      '2026-01-15T00:00:00.000Z',
    );
    expect(zonedWallClockToUtc('2026-01-15T09:00', 'UTC')?.toISOString()).toBe(
      '2026-01-15T09:00:00.000Z',
    );
  });

  it('applies the offset in force at that date, not today', () => {
    // New York is UTC-5 in January and UTC-4 in July. A fixed offset gets one of
    // these wrong; asking Intl at the candidate instant gets both right.
    expect(zonedWallClockToUtc('2026-07-15T09:00', 'America/New_York')?.toISOString()).toBe(
      '2026-07-15T13:00:00.000Z',
    );
  });

  it('handles a time just after a DST transition', () => {
    // Europe/London springs forward at 01:00 UTC on 2026-03-29.
    expect(zonedWallClockToUtc('2026-03-29T02:00', 'Europe/London')?.toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    expect(zonedWallClockToUtc('2026-03-28T02:00', 'Europe/London')?.toISOString()).toBe(
      '2026-03-28T02:00:00.000Z',
    );
  });

  it('handles midnight, which some ICU builds render as hour 24', () => {
    expect(zonedWallClockToUtc('2026-01-15T00:00', 'UTC')?.toISOString()).toBe(
      '2026-01-15T00:00:00.000Z',
    );
    expect(toLocalInputValue('2026-01-15T00:00:00.000Z', 'UTC')).toBe('2026-01-15T00:00');
  });

  it('round-trips an instant through the input format', () => {
    const instant = '2026-06-15T13:30:00.000Z';
    const local = toLocalInputValue(instant, 'America/New_York');
    expect(zonedWallClockToUtc(local, 'America/New_York')?.toISOString()).toBe(instant);
  });

  it.each(['', 'Not/AZone', 'x'.repeat(100)])('rejects the invalid timezone %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });

  it.each(['UTC', 'Europe/London', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney'])(
    'accepts %s',
    (zone) => {
      expect(isValidTimeZone(zone)).toBe(true);
    },
  );
});

describe('parseScheduleRequest', () => {
  it('accepts a time comfortably in the future', () => {
    const result = parseScheduleRequest({ local: '2026-03-02T09:00', timeZone: 'UTC', now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.at.toISOString()).toBe('2026-03-02T09:00:00.000Z');
      expect(result.farFuture).toBe(false);
    }
  });

  it.each([
    ['nothing', '', 'empty'],
    ['a malformed value', 'tomorrow please', 'malformed'],
    ['a date with no time', '2026-03-02', 'malformed'],
  ])('rejects %s', (_label, local, reason) => {
    const result = parseScheduleRequest({ local, timeZone: 'UTC', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it('refuses a time in the past', () => {
    const result = parseScheduleRequest({ local: '2026-02-28T09:00', timeZone: 'UTC', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('in_past');
  });

  it('refuses a time inside the minimum lead', () => {
    const soon = new Date(NOW.getTime() + MIN_SCHEDULE_LEAD_MS - 60_000);
    const local = toLocalInputValue(soon, 'UTC');
    const result = parseScheduleRequest({ local, timeZone: 'UTC', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_soon');
  });

  it('refuses a time more than a year ahead', () => {
    const far = new Date(NOW.getTime() + MAX_SCHEDULE_AHEAD_MS + 86_400_000);
    const result = parseScheduleRequest({
      local: toLocalInputValue(far, 'UTC'),
      timeZone: 'UTC',
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_far');
  });

  it('refuses an unrecognised workspace timezone rather than guessing', () => {
    const result = parseScheduleRequest({ local: '2026-03-02T09:00', timeZone: 'Mars/Olympus', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_timezone');
  });

  it('flags a schedule more than three months out as far future, but accepts it', () => {
    const result = parseScheduleRequest({ local: '2026-09-01T09:00', timeZone: 'UTC', now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.farFuture).toBe(true);
  });

  it('a time that is valid in one zone can be in the past in another', () => {
    // 12:30 UTC is future; 12:30 in Tokyo on the same date is long gone.
    expect(parseScheduleRequest({ local: '2026-03-01T12:30', timeZone: 'UTC', now: NOW }).ok).toBe(true);
    expect(parseScheduleRequest({ local: '2026-03-01T12:30', timeZone: 'Asia/Tokyo', now: NOW }).ok).toBe(
      false,
    );
  });
});

describe('checkStoredSchedule', () => {
  it('re-validates a stored instant, because a draft can sit until it goes stale', () => {
    expect(checkStoredSchedule('2026-03-02T09:00:00.000Z', NOW).ok).toBe(true);

    const stale = checkStoredSchedule('2026-02-01T09:00:00.000Z', NOW);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('in_past');
  });

  it('reports an absent schedule distinctly from an invalid one', () => {
    const absent = checkStoredSchedule(null, NOW);
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.reason).toBe('empty');

    const bad = checkStoredSchedule('not a date', NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('malformed');
  });

  it('does not apply the minimum lead to something already stored', () => {
    // A campaign scheduled last week for two minutes from now is not "too soon"
    // — it is simply due. The lead exists to catch typos at the point of entry.
    const soon = new Date(NOW.getTime() + 60_000).toISOString();
    expect(checkStoredSchedule(soon, NOW).ok).toBe(true);
  });
});

describe('display', () => {
  it('renders an instant in the workspace zone', () => {
    expect(formatInZone('2026-01-15T14:00:00.000Z', 'America/New_York')).toContain('09:00');
    expect(formatInZone('2026-01-15T14:00:00.000Z', 'UTC')).toContain('14:00');
  });

  it('falls back to UTC rather than throwing on a bad zone', () => {
    expect(formatInZone('2026-01-15T14:00:00.000Z', 'Mars/Olympus')).toContain('14:00');
  });

  it('renders an unparseable instant as a dash rather than "Invalid Date"', () => {
    expect(formatInZone('nonsense', 'UTC')).toBe('—');
    expect(toLocalInputValue('nonsense', 'UTC')).toBe('');
  });
});
