import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';

describe('migrations', () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.close(); });

  it('applies cleanly and creates the expected tables', async () => {
    const r = await db.raw<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(r.rows.map((x) => x.tablename)).toEqual([
      'audit_logs',
      // P4 — campaign preparation (0009). Carries no recipient and cannot
      // reach a sending state; see tests/no-sending.test.ts.
      'campaigns',
      'contact_lists',
      'contacts',
      // P2 — the import engine (0006).
      'import_jobs',
      'import_rejections',
      'imports',
      'list_members',
      'rate_limits',
      // P3 — the trusted-sender foundation (0008). Configuration and
      // verification state only; neither table can address a recipient.
      'sender_domains',
      'sender_identities',
      'suppressions',
      // P4 — reusable message content (0009).
      'templates',
      'workspace_members',
      'workspace_settings',
      'workspaces',
    ]);
  });
});
