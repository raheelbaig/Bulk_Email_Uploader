import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Proof 6 (application half).
 *
 * The database proof (tests/rls.test.ts) shows service_role bypasses RLS. This
 * shows the application layer that has to compensate: the sanctioned accessor
 * cannot produce an unfiltered query, and cannot be talked into a cross-tenant
 * write by a caller-supplied tenant column.
 */

interface Recorded {
  table: string;
  op: string;
  filters: [string, unknown][];
  payload?: unknown;
}

const recorded: Recorded[] = [];

/** A PostgREST-shaped stub that records what was built. */
function makeBuilder(entry: Recorded) {
  const builder = {
    select(_columns?: string) {
      entry.op = 'select';
      return builder;
    },
    insert(rows: unknown) {
      entry.op = 'insert';
      entry.payload = rows;
      return builder;
    },
    update(patch: unknown) {
      entry.op = 'update';
      entry.payload = patch;
      return builder;
    },
    eq(column: string, value: unknown) {
      entry.filters.push([column, value]);
      return builder;
    },
  };
  return builder;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const entry: Recorded = { table, op: '', filters: [] };
      recorded.push(entry);
      return makeBuilder(entry);
    },
  }),
}));

vi.mock('@/lib/env', () => ({
  serverEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: 'https://stub.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role-key-value',
  }),
}));

const loggerWarn = vi.fn();
vi.mock('@/lib/observability/logger', () => ({
  logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  serviceForWorkspace,
  unscopedServiceClient,
  tenantColumnFor,
  TENANT_COLUMN,
  TENANTLESS_TABLES,
} = await import('@/lib/db/service');

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  recorded.length = 0;
  loggerWarn.mockReset();
});

describe('tenant column mapping', () => {
  it('knows that workspaces is keyed by id, not workspace_id', () => {
    expect(tenantColumnFor('workspaces')).toBe('id');
  });

  it.each([
    'workspace_members',
    'workspace_settings',
    'audit_logs',
    'imports',
    'import_jobs',
    'sender_domains',
    'sender_identities',
    'templates',
    'campaigns',
  ] as const)('%s is keyed by workspace_id', (table) => {
    expect(tenantColumnFor(table)).toBe('workspace_id');
  });

  /**
   * Every table is either scoped or explicitly declared tenantless. A table that
   * is neither is a table someone forgot, and the service-role path would then
   * have no filter for it at all — which is the exact failure this mapping
   * exists to prevent.
   */
  it('accounts for every table the schema declares', async () => {
    const schema = await import('@/lib/db/schema');
    const { getTableConfig } = await import('drizzle-orm/pg-core');
    const declared = [
      schema.workspaces,
      schema.workspaceMembers,
      schema.workspaceSettings,
      schema.auditLogs,
      schema.contacts,
      schema.contactLists,
      schema.listMembers,
      schema.suppressions,
      schema.imports,
      schema.importRejections,
      schema.importJobs,
      schema.rateLimits,
      schema.senderDomains,
      schema.senderIdentities,
      schema.templates,
      schema.campaigns,
      schema.emailJobs,
      schema.sendAttempts,
      schema.rateLedger,
    ].map((t) => getTableConfig(t).name);

    const accounted = [...Object.keys(TENANT_COLUMN), ...TENANTLESS_TABLES];
    expect(accounted.sort()).toEqual(declared.sort());
  });

  it('declares tenantless tables deliberately, and only the two that qualify', () => {
    // `import_rejections` is reached through its parent import; `rate_limits` is
    // keyed by a bucket string that already names its subject. Nothing else may
    // be added here without the reasoning being visible in review.
    expect([...TENANTLESS_TABLES].sort()).toEqual(['import_rejections', 'rate_limits']);
  });

  it('a tenantless table cannot be reached through the scoped accessors', () => {
    // A type-level guarantee, asserted at runtime too: the scoped helpers know
    // only the tables that carry a tenant column.
    for (const table of TENANTLESS_TABLES) {
      expect(Object.keys(TENANT_COLUMN)).not.toContain(table);
    }
  });
});

describe('serviceForWorkspace always scopes', () => {
  it('rejects a non-UUID workspace id rather than building an unscoped query', () => {
    expect(() => serviceForWorkspace('')).toThrow(/workspace UUID/);
    expect(() => serviceForWorkspace('all')).toThrow(/workspace UUID/);
    expect(() => serviceForWorkspace("' or true --")).toThrow(/workspace UUID/);
  });

  it('applies the tenant filter to every select', () => {
    const db = serviceForWorkspace(WS_A);
    db.select('workspace_settings');
    db.select('audit_logs');
    db.select('workspaces');

    expect(recorded).toHaveLength(3);
    expect(recorded[0]?.filters).toEqual([['workspace_id', WS_A]]);
    expect(recorded[1]?.filters).toEqual([['workspace_id', WS_A]]);
    expect(recorded[2]?.filters).toEqual([['id', WS_A]]);
  });

  it('applies the tenant filter to every update', () => {
    serviceForWorkspace(WS_A).update('workspace_settings', { display_timezone: 'UTC' });
    expect(recorded[0]?.filters).toEqual([['workspace_id', WS_A]]);
  });

  it('stamps the tenant column on insert, overriding whatever the caller passed', () => {
    serviceForWorkspace(WS_A).insert('audit_logs', [
      { action: 'auth.login', workspace_id: WS_B },
      { action: 'auth.logout' },
    ]);

    const rows = recorded[0]?.payload as Record<string, unknown>[];
    expect(rows[0]?.['workspace_id']).toBe(WS_A);
    expect(rows[1]?.['workspace_id']).toBe(WS_A);
  });

  it('drops a tenant-column rewrite from an update patch', () => {
    serviceForWorkspace(WS_A).update('workspace_settings', {
      display_timezone: 'UTC',
      workspace_id: WS_B,
    });

    const patch = recorded[0]?.payload as Record<string, unknown>;
    expect(patch).not.toHaveProperty('workspace_id');
    expect(patch['display_timezone']).toBe('UTC');
    expect(recorded[0]?.filters).toEqual([['workspace_id', WS_A]]);
  });

  it('binds each accessor to one workspace', () => {
    serviceForWorkspace(WS_A).select('audit_logs');
    serviceForWorkspace(WS_B).select('audit_logs');
    expect(recorded[0]?.filters).toEqual([['workspace_id', WS_A]]);
    expect(recorded[1]?.filters).toEqual([['workspace_id', WS_B]]);
  });
});

describe('the unscoped escape hatch is loud', () => {
  it('logs the reason it was used', () => {
    unscopedServiceClient('webhook: resolving workspace from provider message id');
    expect(loggerWarn).toHaveBeenCalledWith('unscoped service-role client acquired', {
      reason: 'webhook: resolving workspace from provider message id',
    });
  });
});
