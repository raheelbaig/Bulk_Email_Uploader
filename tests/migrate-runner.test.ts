import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  TRACKING_TABLE_SQL,
  describeTarget,
  fingerprint,
  matchesRecorded,
  normalizeMigration,
  parseArgs,
} from '../scripts/migrate-lib.mjs';
import { createHash } from 'node:crypto';
import { migrationFiles } from './helpers/db';

/**
 * The migration runner (scripts/migrate.mjs). Its database-facing behaviour is
 * exercised here on PGlite; nothing in this file connects to a real server.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('migration fingerprint', () => {
  it('is identical for CRLF and LF checkouts of the same file', () => {
    const lf = 'create table t (\n  id int\n);\n';
    expect(fingerprint(lf.replace(/\n/g, '\r\n'))).toBe(fingerprint(lf));
  });

  it('still detects any real change', () => {
    expect(fingerprint('select 1;\n')).not.toBe(fingerprint('select 2;\n'));
    expect(fingerprint('select 1;\n')).not.toBe(fingerprint('select 1; \n'));
    // A lone CR is content, not a line ending.
    expect(fingerprint('a\rb')).not.toBe(fingerprint('a\nb'));
  });

  it('only folds CRLF', () => {
    expect(normalizeMigration('a\r\nb\rc\n')).toBe('a\nb\rc\n');
  });

  it('accepts a checksum recorded over the raw bytes by the previous runner', () => {
    const crlf = 'select 1;\r\n';
    expect(matchesRecorded(crlf, sha(crlf))).toBe(true);
    expect(matchesRecorded(crlf, sha('select 1;\n'))).toBe(true);
    expect(matchesRecorded(crlf, sha('select 2;\n'))).toBe(false);
  });

  it.each(migrationFiles())('%s fingerprints the same regardless of checkout line endings', (file) => {
    const body = readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8');
    const lf = body.replace(/\r\n/g, '\n');
    expect(fingerprint(body)).toBe(fingerprint(lf));
    expect(fingerprint(body)).toBe(fingerprint(lf.replace(/\n/g, '\r\n')));
  });
});

describe('target description', () => {
  it('never contains credentials', () => {
    const secret = 'S3cr3t-p@ss';
    const url = `postgresql://postgres.abcdefghij:${encodeURIComponent(secret)}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
    const t = describeTarget(url);
    expect(t).toEqual({ host: 'aws-0-eu-west-1.pooler.supabase.com', port: '5432', database: 'postgres', local: false });
    expect(JSON.stringify(t)).not.toContain('S3cr3t');
    expect(JSON.stringify(t)).not.toContain('postgres.abcdefghij');
  });

  it('recognises local hosts', () => {
    expect(describeTarget('postgres://u:p@localhost:54322/postgres').local).toBe(true);
    expect(describeTarget('postgres://u:p@127.0.0.1/db').local).toBe(true);
    expect(describeTarget('postgres://u:p@[::1]:5432/db').local).toBe(true);
    expect(describeTarget('postgres://u:p@db.example.com/db').local).toBe(false);
  });

  it('does not echo an unparseable URL', () => {
    expect(describeTarget('not a url with secret')).toEqual({ host: null, port: null, database: null, local: false });
  });
});

describe('arguments', () => {
  it('parses the flags and rejects unknown ones', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, yesProduction: false, unknown: [] });
    expect(parseArgs(['--dry-run', '--yes-production'])).toEqual({ dryRun: true, yesProduction: true, unknown: [] });
    expect(parseArgs(['--yes'])).toMatchObject({ unknown: ['--yes'] });
  });
});

describe('runner source', () => {
  const source = readFileSync(join(process.cwd(), 'scripts', 'migrate.mjs'), 'utf8');

  it('never prints the connection string', () => {
    const printing = source.split('\n').filter((l) => /console\.|stdout\.write/.test(l));
    for (const line of printing) expect(line).not.toMatch(/\burl\b|DATABASE_URL\}/);
  });

  it('serialises runs with an advisory lock and gates remote targets', () => {
    expect(source).toContain('pg_advisory_lock(');
    expect(source).toContain('pg_advisory_unlock(');
    expect(source).toMatch(/!target\.local && !args\.dryRun && !args\.yesProduction/);
    expect(source).toContain("sql.begin('read only'");
  });
});

describe('tracking table hardening', () => {
  async function supabaseLike(): Promise<PGlite> {
    const pg = await new PGlite();
    await pg.exec(readFileSync(join(process.cwd(), 'supabase', 'testing', '0000_supabase_emulation.sql'), 'utf8'));
    return pg;
  }

  it('enables RLS and leaves the API roles with no privileges, even after Supabase-style grants', async () => {
    const pg = await supabaseLike();
    // Supabase's default privileges grant every new public table to the API roles.
    await pg.exec(`
      create table public.schema_migrations (filename text primary key, checksum text not null, applied_at timestamptz not null default now());
      grant all on public.schema_migrations to anon, authenticated, service_role;
    `);
    await pg.exec(TRACKING_TABLE_SQL);

    const { rows: rls } = await pg.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.schema_migrations'::regclass`,
    );
    expect(rls[0]?.relrowsecurity).toBe(true);

    for (const role of ['anon', 'authenticated', 'service_role']) {
      const { rows } = await pg.query<{ p: boolean }>(
        `select has_table_privilege($1, 'public.schema_migrations', 'select,insert,update,delete,truncate,references,trigger') as p`,
        [role],
      );
      expect(rows[0]?.p, role).toBe(false);
    }

    await pg.exec('set role anon');
    await expect(pg.query('select * from public.schema_migrations')).rejects.toThrow(/permission denied/);
    await pg.exec('reset role');

    await pg.close();
  });

  it('is idempotent and works where the Supabase roles do not exist', async () => {
    const pg = await new PGlite();
    await pg.exec(TRACKING_TABLE_SQL);
    await pg.exec(TRACKING_TABLE_SQL);
    await pg.query(`insert into public.schema_migrations (filename, checksum) values ('0001_x.sql', 'abc')`);
    const { rows } = await pg.query('select filename from public.schema_migrations');
    expect(rows).toHaveLength(1);
    await pg.close();
  });
});
