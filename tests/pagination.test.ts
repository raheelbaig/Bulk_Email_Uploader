import { describe, it, expect } from 'vitest';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  encodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type RowWithCursor,
} from '@/lib/pagination';

/**
 * Keyset pagination mechanics.
 *
 * The cursor is a position in a total ordering, not an API: it must round-trip
 * exactly, and it must refuse anything it did not produce. A cursor accepted
 * from a hostile client is a filter the caller controls.
 */

function row(id: string, createdAt: string): RowWithCursor {
  return { id, created_at: createdAt };
}

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const TS = '2026-09-03T10:00:00.000Z';

describe('clampLimit', () => {
  it('defaults when unspecified or not a number', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('caps an oversized request rather than honouring it', () => {
    // A client asking for 10,000 rows is the unbounded query this design exists
    // to prevent, so the cap is enforced here rather than trusted upstream.
    expect(clampLimit(10_000)).toBe(MAX_PAGE_SIZE);
    expect(clampLimit(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
  });

  it('floors a request below one', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-50)).toBe(1);
  });

  it('truncates a fractional limit', () => {
    expect(clampLimit(10.9)).toBe(10);
  });

  it('honours a reasonable request', () => {
    expect(clampLimit(25)).toBe(25);
  });
});

describe('cursor encoding', () => {
  it('round-trips exactly', () => {
    const cursor = { createdAt: TS, id: UUID_A };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is opaque — not readable as the underlying values', () => {
    const encoded = encodeCursor({ createdAt: TS, id: UUID_A });
    expect(encoded).not.toContain(UUID_A);
    expect(encoded).not.toContain('2026');
  });

  it('is URL-safe', () => {
    const encoded = encodeCursor({ createdAt: TS, id: UUID_A });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  describe('rejects anything it did not produce', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an object', {}],
      ['an empty string', ''],
      ['plain garbage', 'not-a-cursor'],
      ['base64 without a separator', Buffer.from('nopipe').toString('base64url')],
      ['a non-UUID id', Buffer.from(`${TS}|not-a-uuid`).toString('base64url')],
      ['an unparseable timestamp', Buffer.from(`never|${UUID_A}`).toString('base64url')],
      ['an empty timestamp', Buffer.from(`|${UUID_A}`).toString('base64url')],
      ['an injected SQL fragment', Buffer.from(`' or 1=1 --|${UUID_A}`).toString('base64url')],
    ])('%s', (_label, input) => {
      expect(decodeCursor(input)).toBeUndefined();
    });

    it('an over-long value, without attempting to decode it', () => {
      expect(decodeCursor('a'.repeat(500))).toBeUndefined();
    });
  });

  it('splits on the last separator, so a timestamp containing one is safe', () => {
    // Defensive: the id is a UUID and cannot contain '|', so taking the last
    // separator keeps parsing unambiguous whatever precedes it.
    const encoded = Buffer.from(`2026-09-03T10:00:00|000Z|${UUID_A}`).toString('base64url');
    expect(decodeCursor(encoded)).toBeUndefined();
  });
});

describe('buildPage', () => {
  const rows = [
    row(UUID_A, '2026-09-03T10:00:00.000Z'),
    row(UUID_B, '2026-09-03T09:00:00.000Z'),
    row('33333333-3333-3333-3333-333333333333', '2026-09-03T08:00:00.000Z'),
  ];

  describe('forward', () => {
    it('reports no next page when the extra row is absent', () => {
      const page = buildPage(rows.slice(0, 2), 2, 'forward', false);
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it('trims the sentinel row and exposes a next cursor', () => {
      // The query fetches limit + 1; the extra row is how hasMore is known
      // without a second COUNT query.
      const page = buildPage(rows, 2, 'forward', false);
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toEqual({ createdAt: rows[1]!.created_at, id: rows[1]!.id });
    });

    it('offers no previous cursor on the first page', () => {
      expect(buildPage(rows, 2, 'forward', false).prevCursor).toBeNull();
    });

    it('offers a previous cursor once paging has begun', () => {
      const page = buildPage(rows, 2, 'forward', true);
      expect(page.prevCursor).toEqual({ createdAt: rows[0]!.created_at, id: rows[0]!.id });
    });

    it('preserves the descending order it was given', () => {
      const page = buildPage(rows, 3, 'forward', false);
      expect(page.items.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    });
  });

  describe('backward', () => {
    // A backward page is fetched ascending and reversed here, so callers always
    // receive the canonical descending order regardless of direction.
    const ascending = [...rows].reverse();

    it('reverses into canonical order', () => {
      const page = buildPage(ascending, 3, 'backward', true);
      expect(page.items.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    });

    it('maps the sentinel row to a previous cursor, not a next one', () => {
      const page = buildPage(ascending, 2, 'backward', true);
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.prevCursor).not.toBeNull();
      expect(page.nextCursor).not.toBeNull();
    });

    it('reports no previous page at the start of the set', () => {
      const page = buildPage(ascending.slice(0, 2), 2, 'backward', true);
      expect(page.hasMore).toBe(false);
      expect(page.prevCursor).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles an empty result', () => {
      const page = buildPage([], 10, 'forward', false);
      expect(page).toEqual({ items: [], nextCursor: null, prevCursor: null, hasMore: false });
    });

    it('handles an empty backward result', () => {
      const page = buildPage([], 10, 'backward', true);
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
      expect(page.prevCursor).toBeNull();
    });

    it('handles a single row exactly filling the page', () => {
      const page = buildPage([rows[0]!], 1, 'forward', false);
      expect(page.items).toHaveLength(1);
      expect(page.hasMore).toBe(false);
    });
  });

  it('a cursor from one page decodes to the position the next page resumes at', () => {
    const first = buildPage(rows, 2, 'forward', false);
    expect(first.nextCursor).not.toBeNull();

    const encoded = encodeCursor(first.nextCursor!);
    const decoded = decodeCursor(encoded);

    // The resumption point is the last row of the page just returned, so the
    // next page begins strictly after it — no row is repeated or skipped.
    expect(decoded).toEqual({ createdAt: rows[1]!.created_at, id: rows[1]!.id });
  });
});
