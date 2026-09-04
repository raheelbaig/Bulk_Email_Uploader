import type { TestDb } from './db';

export interface RlsFinding {
  table: string;
  problem: 'rls-disabled' | 'no-policies-and-not-registered';
}

const IGNORED_TABLES = new Set(['schema_migrations']);

/**
 * The RLS coverage guard.
 *
 * Two independent failures are possible and both are caught:
 *
 *   1. A table with RLS disabled. Every row is readable by any authenticated
 *      caller. This is the single highest-severity mistake available in this
 *      schema, and it is a one-line omission in a migration.
 *
 *   2. A table with RLS enabled but no policies. This *is* secure — deny-all —
 *      but it is indistinguishable from a half-finished migration, so it must be
 *      declared in `app.rls_policy_exceptions` with a reason. Silence is not
 *      allowed to mean either "intended" or "forgotten".
 */
export async function findRlsGaps(db: TestDb): Promise<RlsFinding[]> {
  const tables = await db.raw<{
    tablename: string;
    rls_enabled: boolean;
    policy_count: string;
    registered: boolean;
  }>(`
    select
      c.relname                                   as tablename,
      c.relrowsecurity                            as rls_enabled,
      (select count(*)::text from pg_policy p where p.polrelid = c.oid) as policy_count,
      (e.table_name is not null)                  as registered
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join app.rls_policy_exceptions e on e.table_name = c.relname
    where n.nspname = 'public'
      and c.relkind = 'r'
    order by c.relname
  `);

  const findings: RlsFinding[] = [];

  for (const row of tables.rows) {
    if (IGNORED_TABLES.has(row.tablename)) continue;

    if (!row.rls_enabled) {
      findings.push({ table: row.tablename, problem: 'rls-disabled' });
      continue;
    }
    if (Number(row.policy_count) === 0 && !row.registered) {
      findings.push({ table: row.tablename, problem: 'no-policies-and-not-registered' });
    }
  }

  return findings;
}

/**
 * FORCE ROW LEVEL SECURITY is separately checkable and separately forgettable.
 * Without it the table owner bypasses every policy — and migrations run as owner.
 */
export async function findMissingForceRls(db: TestDb): Promise<string[]> {
  const rows = await db.raw<{ tablename: string }>(`
    select c.relname as tablename
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity
      and not c.relforcerowsecurity
    order by c.relname
  `);
  return rows.rows.map((r) => r.tablename).filter((t) => !IGNORED_TABLES.has(t));
}

/**
 * An UPDATE policy without WITH CHECK controls which rows may be *targeted* but
 * not what they may *become* — which is exactly the cross-tenant write hole this
 * schema is built to prevent. `polwithcheck` being null on an UPDATE policy
 * (polcmd = 'w') is that hole.
 */
export async function findUpdatePoliciesMissingWithCheck(db: TestDb): Promise<string[]> {
  const rows = await db.raw<{ label: string }>(`
    select c.relname || '.' || p.polname as label
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and p.polcmd = 'w'
      and p.polwithcheck is null
    order by 1
  `);
  return rows.rows.map((r) => r.label);
}
