import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '@/lib/env';
import { logger } from '@/lib/observability/logger';

/**
 * Service-role database access.
 *
 * ═══ READ THIS BEFORE USING ANYTHING IN THIS FILE ═══
 *
 * The service role has BYPASSRLS. Every policy in `supabase/migrations` is
 * inert here. Tenant isolation on this path is provided by application code and
 * nothing else, which is why the safe entry points below refuse to build a query
 * without a workspace id.
 *
 * This module is `server-only`: importing it from a Client Component is a build
 * error, which is what keeps SUPABASE_SERVICE_ROLE_KEY out of the browser bundle.
 */

/**
 * The column carrying tenancy for each table.
 *
 * `workspaces` is keyed by `id` rather than `workspace_id` — it *is* the tenant.
 * Getting this wrong would silently disable scoping, so it is data, checked by a
 * test, rather than a convention repeated at each call site.
 */
export const TENANT_COLUMN = {
  workspaces: 'id',
  workspace_members: 'workspace_id',
  workspace_settings: 'workspace_id',
  audit_logs: 'workspace_id',
  contacts: 'workspace_id',
  contact_lists: 'workspace_id',
  list_members: 'workspace_id',
  suppressions: 'workspace_id',
  imports: 'workspace_id',
  import_jobs: 'workspace_id',
  sender_domains: 'workspace_id',
  sender_identities: 'workspace_id',
  templates: 'workspace_id',
  campaigns: 'workspace_id',
} as const satisfies Record<string, string>;

/**
 * Tables with no tenant column of their own.
 *
 * `import_rejections` hangs off `imports` and is reached only through a parent
 * row whose workspace has already been verified — denormalising a workspace_id
 * onto it would create state that can disagree with its parent. `rate_limits` is
 * keyed by an opaque bucket string that already embeds the subject.
 *
 * Listed rather than merely absent so that "this table has no tenant column" is
 * a decision on the record, checked by tests/service-scoping.test.ts, rather
 * than an omission that looks identical to a mistake.
 */
export const TENANTLESS_TABLES = ['import_rejections', 'rate_limits'] as const;

export type WorkspaceScopedTable = keyof typeof TENANT_COLUMN;

export function tenantColumnFor(table: WorkspaceScopedTable): string {
  return TENANT_COLUMN[table];
}

let client: SupabaseClient | undefined;

function rawClient(): SupabaseClient {
  if (client !== undefined) return client;
  const env = serverEnv();
  client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/**
 * A service-role accessor bound to one workspace.
 *
 * Every read and write it produces carries the tenant filter, applied here
 * rather than left to the caller. This is the only sanctioned way for
 * background code — workers, webhook handlers, cron endpoints — to touch
 * workspace data.
 */
export function serviceForWorkspace(workspaceId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new Error('serviceForWorkspace requires a workspace UUID');
  }

  const db = rawClient();

  return {
    workspaceId,

    select(table: WorkspaceScopedTable, columns = '*') {
      return db.from(table).select(columns).eq(tenantColumnFor(table), workspaceId);
    },

    insert(table: WorkspaceScopedTable, rows: Record<string, unknown>[]) {
      const column = tenantColumnFor(table);
      // Overwrite rather than trust: a caller-supplied tenant column that
      // disagreed with the binding would be a cross-tenant write.
      return db.from(table).insert(rows.map((row) => ({ ...row, [column]: workspaceId })));
    },

    upsert(
      table: WorkspaceScopedTable,
      rows: Record<string, unknown>[],
      options?: { onConflict?: string },
    ) {
      const column = tenantColumnFor(table);
      return db
        .from(table)
        .upsert(rows.map((row) => ({ ...row, [column]: workspaceId })), options ?? {});
    },

    update(table: WorkspaceScopedTable, patch: Record<string, unknown>) {
      const column = tenantColumnFor(table);
      const { [column]: _dropped, ...safe } = patch;
      void _dropped; // a tenant-column rewrite is never accepted from a patch
      return db.from(table).update(safe).eq(column, workspaceId);
    },

    /**
     * Calls a database function.
     *
     * Two statements the import engine needs — the conflict-resolving contact
     * upsert and the atomic rate-limit window — cannot be expressed through
     * PostgREST's query builder. They live in migration 0006 and are reached
     * here. Each takes its workspace as an argument, and each re-checks that
     * argument against the row it is about to touch, so a mismatched pair is
     * refused by the database rather than trusted from this layer.
     */
    rpc(
      fn: 'import_upsert_contacts' | 'consume_rate_limit' | 'campaign_audience_counts',
      args: Record<string, unknown>,
    ) {
      return db.rpc(fn, args);
    },

    /**
     * A query builder for a table that has no tenant column of its own.
     *
     * The allowed set is a closed union, so this cannot become a general escape
     * hatch back to unscoped access — asking for `contacts` here is a type
     * error. Both permitted tables are reached through a parent whose workspace
     * has already been verified (`import_rejections` through `imports`) or are
     * keyed by a string that embeds its subject (`rate_limits`).
     */
    tenantlessTable(table: (typeof TENANTLESS_TABLES)[number]) {
      return db.from(table);
    },

    /**
     * Private-bucket storage, scoped to this workspace by construction.
     *
     * Every key is required to sit under `{workspaceId}/`, checked here rather
     * than at the call sites. The service role bypasses the bucket policies from
     * migration 0007 exactly as it bypasses RLS, so this prefix check is the
     * only thing standing between a path built from a request parameter and
     * another tenant's staged upload.
     */
    storage: makeScopedStorage(db, workspaceId),
  };
}

export interface ScopedStorage {
  readonly bucket: string;
  /** Throws unless `path` sits under this workspace's prefix. */
  assertOwnedPath(path: string): string;
  keyFor(importId: string, filename: string): string;
  createSignedUploadUrl(path: string): Promise<{ signedUrl: string; token: string; path: string }>;
  download(path: string): Promise<Uint8Array>;
  /** A real byte stream, so a large CSV is never held whole in memory. */
  downloadStream(path: string): Promise<AsyncIterable<Uint8Array>>;
  /** Reads only the leading bytes, then stops. For magic-byte validation. */
  head(path: string, bytes: number): Promise<Uint8Array>;
  remove(paths: string[]): Promise<void>;
  list(prefix: string): Promise<Array<{ name: string; createdAt: string | null }>>;
}

/** Adapts a web `ReadableStream` to an async iterable in every runtime. */
async function* iterateStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function makeScopedStorage(db: SupabaseClient, workspaceId: string): ScopedStorage {
  const prefix = `${workspaceId}/`;
  const bucket = 'imports';

  const assertOwnedPath = (path: string): string => {
    // Traversal is checked before the prefix: `{ws}/../{other}/f.csv` starts
    // with the right prefix and is still a cross-tenant read.
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
      throw new Error('storage path is not well formed');
    }
    if (!path.startsWith(prefix)) {
      throw new Error('storage path does not belong to this workspace');
    }
    return path;
  };

  const downloadBlob = async (path: string): Promise<Blob> => {
    const { data, error } = await db.storage.from(bucket).download(assertOwnedPath(path));
    if (error !== null || data === null) {
      throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
    }
    return data;
  };

  return {
    bucket,
    assertOwnedPath,

    keyFor(importId: string, filename: string): string {
      return `${prefix}${importId}/${filename}`;
    },

    async createSignedUploadUrl(path: string) {
      const { data, error } = await db.storage
        .from(bucket)
        .createSignedUploadUrl(assertOwnedPath(path));
      if (error !== null || data === null) {
        throw new Error(`signed upload url failed: ${error?.message ?? 'no data'}`);
      }
      return { signedUrl: data.signedUrl, token: data.token, path: data.path };
    },

    async download(path: string) {
      return new Uint8Array(await (await downloadBlob(path)).arrayBuffer());
    },

    async downloadStream(path: string) {
      return iterateStream((await downloadBlob(path)).stream());
    },

    async head(path: string, bytes: number) {
      const stream = (await downloadBlob(path)).stream();
      const chunks: Uint8Array[] = [];
      let collected = 0;

      for await (const chunk of iterateStream(stream)) {
        chunks.push(chunk);
        collected += chunk.length;
        if (collected >= bytes) break;
      }

      const out = new Uint8Array(Math.min(collected, bytes));
      let at = 0;
      for (const chunk of chunks) {
        if (at >= out.length) break;
        const take = Math.min(chunk.length, out.length - at);
        out.set(chunk.subarray(0, take), at);
        at += take;
      }
      return out;
    },

    async remove(paths: string[]) {
      if (paths.length === 0) return;
      const { error } = await db.storage.from(bucket).remove(paths.map(assertOwnedPath));
      if (error !== null) throw new Error(`storage remove failed: ${error.message}`);
    },

    async list(prefix_: string) {
      const scoped = prefix_.length === 0 ? workspaceId : assertOwnedPath(prefix_);
      const { data, error } = await db.storage.from(bucket).list(scoped, { limit: 1000 });
      if (error !== null) throw new Error(`storage list failed: ${error.message}`);
      return (data ?? []).map((item) => ({
        name: item.name,
        createdAt: item.created_at ?? null,
      }));
    },
  };
}

/**
 * Unscoped service-role client.
 *
 * For the few operations that genuinely span tenants — retention sweeps, the
 * webhook handler resolving which workspace an inbound provider event belongs to
 * before any workspace id is known. Every use is logged with its reason and is
 * greppable in review.
 *
 * If you are reaching for this to read one workspace's rows, use
 * `serviceForWorkspace` instead.
 */
export function unscopedServiceClient(reason: string): SupabaseClient {
  logger.warn('unscoped service-role client acquired', { reason });
  return rawClient();
}

/** Test-only: drops the memoised client. */
export function resetServiceClientCache(): void {
  client = undefined;
}
