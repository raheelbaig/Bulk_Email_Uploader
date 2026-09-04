import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import {
  findRlsGaps,
  findMissingForceRls,
  findUpdatePoliciesMissingWithCheck,
} from './helpers/rls-guard';

/**
 * The migration guard.
 *
 * This is the CI gate that catches the highest-severity mistake this codebase can
 * make: a table added in a future migration without RLS. It runs against the real
 * migration files, so it protects every phase from here on.
 */
describe('RLS coverage guard', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  // ── Proof 8 ────────────────────────────────────────────────────────────────
  it('proof 8: every public table has RLS enabled and is either policied or registered', async () => {
    const findings = await findRlsGaps(db);
    expect(
      findings,
      `RLS gaps:\n${findings.map((f) => `  ${f.table}: ${f.problem}`).join('\n')}`,
    ).toEqual([]);
  });

  it('every RLS-enabled table also has FORCE, so the owner is not exempt', async () => {
    const missing = await findMissingForceRls(db);
    expect(missing, `missing FORCE ROW LEVEL SECURITY: ${missing.join(', ')}`).toEqual([]);
  });

  it('every UPDATE policy has a WITH CHECK clause', async () => {
    const missing = await findUpdatePoliciesMissingWithCheck(db);
    expect(missing, `UPDATE policies without WITH CHECK: ${missing.join(', ')}`).toEqual([]);
  });

  it('every SECURITY DEFINER function pins its search_path', async () => {
    const rows = await db.raw<{ label: string }>(`
      select n.nspname || '.' || p.proname as label
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'public')
        and p.prosecdef
        and (p.proconfig is null or not exists (
          select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'
        ))
      order by 1
    `);
    const offenders = rows.rows.map((r) => r.label);
    expect(
      offenders,
      `SECURITY DEFINER without a pinned search_path (privilege-escalation risk): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  // ── Proof 9 ────────────────────────────────────────────────────────────────
  describe('proof 9: the guard actually catches what it claims to', () => {
    it('flags a table with RLS disabled', async () => {
      await db.exec('create table guard_probe_open (id uuid primary key, workspace_id uuid);');
      try {
        const findings = await findRlsGaps(db);
        expect(findings).toContainEqual({ table: 'guard_probe_open', problem: 'rls-disabled' });
      } finally {
        await db.exec('drop table guard_probe_open;');
      }
    });

    it('flags an unregistered deny-all table, and accepts it once registered', async () => {
      await db.exec(`
        create table guard_probe_denyall (id uuid primary key, workspace_id uuid);
        alter table guard_probe_denyall enable row level security;
        alter table guard_probe_denyall force row level security;
      `);
      try {
        const before = await findRlsGaps(db);
        expect(before).toContainEqual({
          table: 'guard_probe_denyall',
          problem: 'no-policies-and-not-registered',
        });

        await db.exec(`
          insert into app.rls_policy_exceptions (table_name, reason)
          values ('guard_probe_denyall', 'test fixture: intentionally service-role only');
        `);

        const after = await findRlsGaps(db);
        expect(after.map((f) => f.table)).not.toContain('guard_probe_denyall');
      } finally {
        await db.exec(`
          delete from app.rls_policy_exceptions where table_name = 'guard_probe_denyall';
          drop table guard_probe_denyall;
        `);
      }
    });

    it('flags an UPDATE policy that omits WITH CHECK', async () => {
      await db.exec(`
        create table guard_probe_nocheck (id uuid primary key, workspace_id uuid);
        alter table guard_probe_nocheck enable row level security;
        alter table guard_probe_nocheck force row level security;
        create policy p_bad on guard_probe_nocheck for update to authenticated using (true);
      `);
      try {
        const missing = await findUpdatePoliciesMissingWithCheck(db);
        expect(missing).toContain('guard_probe_nocheck.p_bad');
      } finally {
        await db.exec('drop table guard_probe_nocheck;');
      }
    });
  });

  /**
   * The exception registry is a closed list, asserted here rather than merely
   * permitted by the guard above. A future migration that registers a table
   * without this test being updated fails the build, which is the point: a
   * deny-all table must be a decision someone made and someone else reviewed.
   */
  it('registers exactly the two deliberately deny-all tables, each with a reason', async () => {
    const rows = await db.raw<{ table_name: string; reason: string }>(
      'select table_name, reason from app.rls_policy_exceptions order by table_name',
    );

    expect(rows.rows.map((r) => r.table_name)).toEqual([
      // P2. Background queue state and limiter counters: service-role only.
      'import_jobs',
      'rate_limits',
    ]);
    for (const row of rows.rows) {
      expect(row.reason.length, `${row.table_name} needs a real reason`).toBeGreaterThan(30);
    }
  });
});
