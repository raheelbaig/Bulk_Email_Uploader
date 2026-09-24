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
      // P4 — campaign preparation (0009). From P5 it can reach the delivery
      // states, only through the guarded transitions of migration 0010.
      'campaigns',
      'contact_lists',
      'contacts',
      // P5 — the sending engine (0010): the per-recipient job queue.
      'email_jobs',
      // P2 — the import engine (0006).
      'import_jobs',
      'import_rejections',
      'imports',
      'list_members',
      // P5 — the per-minute send budget (0010).
      'rate_ledger',
      'rate_limits',
      // P5 — ADR-0001's durable record of intent, one row per provider call.
      'send_attempts',
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
