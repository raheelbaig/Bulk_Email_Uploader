/**
 * Keyset (cursor) pagination.
 *
 * Deliberately not OFFSET. Offset pagination re-scans and discards every skipped
 * row, so page 500 costs 500 pages of work — an unbounded scan by another name
 * (ARCHITECTURE §Performance). A keyset cursor turns every page into an index
 * seek at constant cost.
 *
 * Ordering is always (created_at desc, id desc). `id` is the tiebreaker, which
 * is what makes the order total and therefore the pagination stable: without it,
 * rows sharing a timestamp could be returned twice or skipped entirely.
 */

export interface Cursor {
  createdAt: string;
  id: string;
}

export type PageDirection = 'forward' | 'backward';

export interface PageRequest {
  limit: number;
  cursor?: Cursor | undefined;
  direction?: PageDirection;
}

export interface Page<T> {
  items: T[];
  nextCursor: Cursor | null;
  prevCursor: Cursor | null;
  hasMore: boolean;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE);
}

/** Opaque to the client: a cursor is a position, not an API. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): Cursor | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return undefined;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return undefined;

    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
    if (Number.isNaN(Date.parse(createdAt))) return undefined;

    return { createdAt, id };
  } catch {
    // A malformed cursor is a bad request, not an error worth surfacing: fall
    // back to the first page.
    return undefined;
  }
}

export interface RowWithCursor {
  id: string;
  created_at: string;
}

/**
 * Turns `limit + 1` fetched rows into a page.
 *
 * The extra row is how `hasMore` is known without a second count query.
 * Backward pages are fetched in ascending order and reversed here, so the caller
 * always receives rows in the canonical descending order.
 */
export function buildPage<T extends RowWithCursor>(
  rows: T[],
  limit: number,
  direction: PageDirection,
  hasCursor: boolean,
): Page<T> {
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const items = direction === 'backward' ? [...trimmed].reverse() : trimmed;

  const first = items[0];
  const last = items[items.length - 1];

  const cursorOf = (row: T | undefined): Cursor | null =>
    row === undefined ? null : { createdAt: row.created_at, id: row.id };

  if (direction === 'backward') {
    return {
      items,
      // Going backward, "more" means more rows before this page.
      prevCursor: hasMore ? cursorOf(first) : null,
      nextCursor: cursorOf(last),
      hasMore,
    };
  }

  return {
    items,
    nextCursor: hasMore ? cursorOf(last) : null,
    prevCursor: hasCursor ? cursorOf(first) : null,
    hasMore,
  };
}
