/**
 * Scheduling, and the timezone problem underneath it.
 *
 * A person types "9 December, 09:00". That is a *wall-clock* time in some zone,
 * and it is not an instant until the zone is known. Storing the string, or
 * calling `new Date(value)` on the server and hoping, are the two classic ways
 * this goes wrong: the first cannot be compared to anything, and the second
 * silently interprets the input in whichever zone the server happens to run in
 * — which on a serverless platform is UTC, in a region the user never chose.
 *
 * So: the wall-clock time and the workspace's zone arrive together, are
 * converted to a UTC instant here, and only the instant is stored
 * (`campaigns.scheduled_at` is `timestamptz`). Rendering goes the other way, in
 * the same zone, so what a person reads back is what they typed.
 *
 * The conversion uses `Intl`, which carries the IANA database — including the
 * DST rules that make this non-trivial. No dependency, no hand-maintained offset
 * table.
 *
 * Deliberately free of `server-only`: pure, and the editor shows the resolved
 * UTC instant as you type so a DST surprise is visible before it is stored.
 */

/** The soonest a campaign may be scheduled. Enough to notice a mistake. */
export const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

/** The furthest ahead. Beyond a year, a scheduled campaign is a forgotten one. */
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/** Far enough ahead to be worth a second look, but allowed. */
export const FAR_FUTURE_MS = 90 * 24 * 60 * 60 * 1000;

export type ScheduleFailure =
  | 'empty'
  | 'malformed'
  | 'unknown_timezone'
  | 'in_past'
  | 'too_soon'
  | 'too_far';

export type ScheduleResult =
  | { ok: true; at: Date; farFuture: boolean }
  | { ok: false; reason: ScheduleFailure };

export const SCHEDULE_FAILURE_MESSAGE: Record<ScheduleFailure, string> = {
  empty: 'Choose a date and time to schedule this campaign.',
  malformed: 'That is not a valid date and time.',
  unknown_timezone: 'This workspace has an unrecognised timezone. Update it in workspace settings.',
  in_past: 'That time has already passed. Choose a time in the future.',
  too_soon: 'Schedule at least five minutes from now.',
  too_far: 'A campaign cannot be scheduled more than a year ahead.',
};

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset, in milliseconds, between a zone's wall clock and UTC at `instant`.
 *
 * Derived by formatting the instant in the zone and reading the result back as
 * if it were UTC. The difference is the offset — including whatever DST was in
 * force at that moment, which is the part a fixed table gets wrong twice a year.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // Some ICU versions render midnight as hour 24 under hour12:false.
  const hour = read('hour') % 24;

  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), hour, read('minute'), read('second'));
  return asUtc - instant.getTime();
}

/**
 * Turns a wall-clock time in a zone into a UTC instant.
 *
 * Two passes. The first guesses the offset using the wall-clock value read as if
 * it were UTC; the second corrects it using the offset actually in force at the
 * candidate instant. That second pass is what makes a time on a DST boundary
 * land correctly rather than an hour out.
 */
export function zonedWallClockToUtc(local: string, timeZone: string): Date | null {
  const match = LOCAL_DATETIME.exec(local.trim());
  if (match === null) return null;

  const [, year, month, day, hour, minute, second] = match;
  const wall = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? '0'),
  );
  if (!Number.isFinite(wall)) return null;

  const firstPass = wall - zoneOffsetMs(new Date(wall), timeZone);
  const corrected = wall - zoneOffsetMs(new Date(firstPass), timeZone);

  const result = new Date(corrected);
  return Number.isNaN(result.getTime()) ? null : result;
}

/**
 * Validates a requested schedule.
 *
 * `now` is injected so the boundaries are testable without waiting, and so the
 * preflight and the write path judge the same instant rather than two instants a
 * few milliseconds apart.
 */
export function parseScheduleRequest(input: {
  local: unknown;
  timeZone: string;
  now?: Date;
}): ScheduleResult {
  const now = input.now ?? new Date();

  const local = typeof input.local === 'string' ? input.local.trim() : '';
  if (local.length === 0) return { ok: false, reason: 'empty' };
  if (!isValidTimeZone(input.timeZone)) return { ok: false, reason: 'unknown_timezone' };

  const at = zonedWallClockToUtc(local, input.timeZone);
  if (at === null) return { ok: false, reason: 'malformed' };

  const delta = at.getTime() - now.getTime();
  if (delta < 0) return { ok: false, reason: 'in_past' };
  if (delta < MIN_SCHEDULE_LEAD_MS) return { ok: false, reason: 'too_soon' };
  if (delta > MAX_SCHEDULE_AHEAD_MS) return { ok: false, reason: 'too_far' };

  return { ok: true, at, farFuture: delta > FAR_FUTURE_MS };
}

/**
 * Re-checks a stored instant.
 *
 * A campaign can sit in draft long enough for its schedule to go stale, so the
 * preflight validates what is stored rather than trusting that it was valid when
 * it was written.
 */
export function checkStoredSchedule(scheduledAt: string | null, now: Date = new Date()): ScheduleResult {
  if (scheduledAt === null) return { ok: false, reason: 'empty' };

  const at = new Date(scheduledAt);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: 'malformed' };

  const delta = at.getTime() - now.getTime();
  if (delta < 0) return { ok: false, reason: 'in_past' };
  if (delta > MAX_SCHEDULE_AHEAD_MS) return { ok: false, reason: 'too_far' };

  return { ok: true, at, farFuture: delta > FAR_FUTURE_MS };
}

/** Renders an instant in a zone, for display. Never used as an input. */
export function formatInZone(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) return '—';

  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** The value a `datetime-local` input wants, for an instant in a zone. */
export function toLocalInputValue(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) return '';

  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';

  const hour = String(Number(read('hour')) % 24).padStart(2, '0');
  return `${read('year')}-${read('month')}-${read('day')}T${hour}:${read('minute')}`;
}
