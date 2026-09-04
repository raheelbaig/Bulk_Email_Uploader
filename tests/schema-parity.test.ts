import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createTestDb, type TestDb } from './helpers/db';
import {
  workspaces,
  workspaceMembers,
  workspaceSettings,
  auditLogs,
  contacts,
  contactLists,
  listMembers,
  suppressions,
  imports,
  importRejections,
  importJobs,
  rateLimits,
  senderDomains,
  senderIdentities,
  templates,
  campaigns,
} from '@/lib/db/schema';

/**
 * Drift detection between the Drizzle schema and the SQL migrations.
 *
 * The migrations are the source of truth — they carry the policies, triggers and
 * grants Drizzle cannot express. This suite proves the TypeScript mirror still
 * matches, so a column renamed in SQL fails the build here rather than surfacing
 * as a runtime error in a request.
 */
describe('Drizzle ↔ SQL schema parity', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  const tables = [
    workspaces,
    workspaceMembers,
    workspaceSettings,
    auditLogs,
    contacts,
    contactLists,
    listMembers,
    suppressions,
    imports,
    importRejections,
    importJobs,
    rateLimits,
    senderDomains,
    senderIdentities,
    templates,
    campaigns,
  ];

  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))(
    '%s matches the migrated table',
    async (_name, table) => {
      const config = getTableConfig(table);

      const actual = await db.raw<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable
           from information_schema.columns
          where table_schema = 'public' and table_name = $1
          order by column_name`,
        [config.name],
      );

      const actualByName = new Map(actual.rows.map((r) => [r.column_name, r.is_nullable === 'YES']));

      expect(actual.rows.length, `table ${config.name} not found in the database`).toBeGreaterThan(0);

      for (const column of config.columns) {
        const nullableInDb = actualByName.get(column.name);
        expect(nullableInDb, `${config.name}.${column.name} is missing from the database`).toBeDefined();
        expect(
          nullableInDb,
          `${config.name}.${column.name} nullability disagrees (drizzle notNull=${column.notNull})`,
        ).toBe(!column.notNull);
      }
    },
  );

  it('declares every table that exists in the database', async () => {
    const declared = new Set(tables.map((t) => getTableConfig(t).name));
    const actual = await db.raw<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    );
    const undeclared = actual.rows.map((r) => r.tablename).filter((t) => !declared.has(t));
    expect(undeclared, `tables in SQL but missing from lib/db/schema.ts: ${undeclared.join(', ')}`).toEqual(
      [],
    );
  });
});
