/**
 * The ports the import runner talks through.
 *
 * Same reasoning as the eligibility reader port (lib/eligibility/index.ts): the
 * decisions — which bucket a row lands in, when a chunk is flushed, what the
 * counters say, whether the result reconciles — must be identical wherever they
 * run, so they live in one implementation and only the data access varies.
 *
 * In production these are backed by PostgREST under the service role. In tests
 * they are backed by SQL against a real migrated database, which is what makes
 * "50,000 rows reconcile" and "a late failure does not roll back early chunks"
 * assertions about the actual engine rather than about a mock of it.
 *
 * Deliberately free of `server-only`: this file declares types and nothing else,
 * and the test harness implements them.
 */

import type { ImportStatus, RejectionBucket } from './constants';

export interface ImportRecord {
  id: string;
  workspace_id: string;
  actor_id: string;
  filename: string;
  byte_size: number;
  content_type: string;
  storage_path: string;
  status: ImportStatus;
  column_mapping: unknown;
  target_list_id: string | null;
  rows_total: number;
  rows_valid: number;
  rows_invalid: number;
  rows_duplicate: number;
  rows_suppressed: number;
  rows_rejected: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface RejectionRecord {
  row_number: number;
  raw_row: Record<string, string>;
  bucket: RejectionBucket;
  reason: string;
}

export interface UpsertRow {
  email_normalized: string;
  email_raw: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  custom: Record<string, string>;
  status: 'active' | 'suppressed';
}

export interface UpsertOutcome {
  email_normalized: string;
  /** True when the row created a contact; false when it enriched an existing one. */
  inserted: boolean;
}

export interface ImportCounters {
  rows_total: number;
  rows_valid: number;
  rows_invalid: number;
  rows_duplicate: number;
  rows_suppressed: number;
  rows_rejected: number;
}

export interface ClaimedJob {
  import_id: string;
  workspace_id: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Data access for one workspace's imports.
 *
 * Every method is workspace-scoped by construction — implementations are built
 * from a workspace id, never handed one per call — so there is no method here
 * that *could* read across tenants.
 */
export interface ImportRepository {
  readonly workspaceId: string;

  get(importId: string): Promise<ImportRecord | null>;

  /**
   * Applies a guarded transition.
   *
   * Implementations must express this as a conditional write naming the expected
   * current status, so a losing racer changes nothing and learns that it lost.
   * Returns false when the row was not in `from`.
   */
  transition(
    importId: string,
    from: readonly ImportStatus[],
    to: ImportStatus,
    patch?: Partial<{
      column_mapping: unknown;
      target_list_id: string | null;
      started_at: string;
      finished_at: string;
      error_message: string | null;
    }> &
      Partial<ImportCounters>,
  ): Promise<boolean>;

  /** Counter updates during processing. Never touches status. */
  updateCounters(importId: string, counters: Partial<ImportCounters>): Promise<void>;

  insertRejections(importId: string, rejections: readonly RejectionRecord[]): Promise<void>;

  /** Clears prior rejections, so a retried import does not double-count them. */
  clearRejections(importId: string): Promise<void>;

  countRejections(importId: string): Promise<number>;

  /**
   * The chunked upsert. Backed by `public.import_upsert_contacts`: one
   * statement, conflict-resolving, enrichment-preserving, and reporting
   * insert-versus-update per row.
   */
  upsertContacts(
    importId: string,
    rows: readonly UpsertRow[],
    targetListId: string | null,
  ): Promise<UpsertOutcome[]>;

  // ── The queue ─────────────────────────────────────────────────────────────

  enqueue(importId: string): Promise<void>;
  /** Atomic claim. Returns null when another runner already holds the job. */
  claim(importId: string): Promise<ClaimedJob | null>;
  completeJob(importId: string): Promise<void>;
  /** Records the failure and either reschedules or marks the job dead. */
  failJob(importId: string, error: string): Promise<{ willRetry: boolean; attempts: number }>;
}

/**
 * Staged-file access.
 *
 * `openStream` exists separately from `download` so CSV can be parsed
 * incrementally: reading a 25 MB file into one string to parse it would defeat
 * the streaming parser it is handed to.
 */
export interface ImportStorage {
  /** The leading bytes, for magic-byte validation before anything is parsed. */
  head(path: string, bytes: number): Promise<Uint8Array>;
  download(path: string): Promise<Uint8Array>;
  openStream(path: string): Promise<AsyncIterable<Uint8Array>>;
  remove(paths: readonly string[]): Promise<void>;
  /** Object names under a prefix, with creation times, for the 24-hour sweep. */
  list(prefix: string): Promise<Array<{ name: string; createdAt: string | null }>>;
}
