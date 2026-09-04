import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Extension availability.
 *
 * Migration 0005 depends on pg_trgm for indexed contact search. If it were ever
 * unavailable, `create extension if not exists` would fail loudly — but a future
 * change could make that conditional and let search silently degrade into a
 * sequential scan. This asserts the dependency is really satisfied.
 */
describe('required extensions', () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.close(); });

  it('pg_trgm is installed', async () => {
    const r = await db.raw<{ extname: string }>(
      `select extname from pg_extension where extname = 'pg_trgm'`,
    );
    expect(r.rows.map((x) => x.extname)).toEqual(['pg_trgm']);
  });

  it('the contacts search index exists and uses gin_trgm_ops', async () => {
    const r = await db.raw<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname='public' and indexname='ix_contacts_search'`,
    );
    expect(r.rows[0]?.indexdef).toMatch(/gin/i);
    expect(r.rows[0]?.indexdef).toMatch(/gin_trgm_ops/);
  });

  it('search_text is generated, so it cannot drift from its source columns', async () => {
    const r = await db.raw<{ is_generated: string }>(
      `select is_generated from information_schema.columns
        where table_schema='public' and table_name='contacts' and column_name='search_text'`,
    );
    expect(r.rows[0]?.is_generated).toBe('ALWAYS');
  });

  it('installs no extension the platform does not need', async () => {
    const r = await db.raw<{ extname: string }>(
      `select extname from pg_extension where extname not in ('plpgsql') order by extname`,
    );
    expect(r.rows.map((x) => x.extname)).toEqual(['pg_trgm']);
  });
});
