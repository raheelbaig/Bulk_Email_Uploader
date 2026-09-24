#!/usr/bin/env node
/**
 * Applies supabase/migrations/*.sql in filename order to DATABASE_URL.
 *
 * Deterministic and reviewable: plain SQL files, applied in order, recorded by
 * filename with a checksum. A file that changes after being applied is a hard
 * error — editing an applied migration means two environments silently diverge.
 *
 *   pnpm db:migrate                    local database (localhost only)
 *   pnpm db:migrate --dry-run          report pending migrations; changes nothing
 *   pnpm db:migrate --yes-production   required for any non-local host
 *
 * DATABASE_URL is read from the environment, then from .env.local. Only the
 * host, port and database name are ever printed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import {
  MIGRATION_LOCK_KEY,
  TRACKING_TABLE_SQL,
  describeTarget,
  fingerprint,
  loadEnvLocal,
  matchesRecorded,
  normalizeMigration,
  parseArgs,
} from './migrate-lib.mjs';

const DIR = join(process.cwd(), 'supabase', 'migrations');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0) {
    console.error(`[migrate] unknown argument(s): ${args.unknown.join(' ')}`);
    console.error('          usage: db:migrate [--dry-run] [--yes-production]');
    return 2;
  }

  loadEnvLocal(join(process.cwd(), '.env.local'));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL is not set (checked environment and .env.local).');
    return 2;
  }

  const target = describeTarget(url);
  if (target.host === null) {
    console.error('[migrate] DATABASE_URL is not a parseable postgres:// URL.');
    return 2;
  }
  console.log(
    `[migrate] target: host=${target.host} port=${target.port} database=${target.database}` +
      (target.local ? ' (local)' : ' (REMOTE)') +
      (args.dryRun ? ' — dry run' : ''),
  );

  if (!target.local && !args.dryRun && !args.yesProduction) {
    console.error(
      '[migrate] refusing to apply migrations to a non-local database without --yes-production.\n' +
        '          Run with --dry-run first to see what would be applied.',
    );
    return 2;
  }

  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const bodies = new Map(files.map((f) => [f, readFileSync(join(DIR, f), 'utf8')]));

  // max: 1 pins every statement — the advisory lock, and each migration's
  // transaction — to one session, so the session-level lock covers them all.
  // max_lifetime: null stops postgres.js recycling that session mid-run.
  const sql = postgres(url, { max: 1, max_lifetime: null, onnotice: () => {} });

  try {
    if (args.dryRun) return await dryRun(sql, files, bodies);
    return await apply(sql, files, bodies);
  } finally {
    await sql.end();
  }
}

/** Reads only, inside a read-only transaction: the database rejects any write. */
async function dryRun(sql, files, bodies) {
  return sql.begin('read only', async (tx) => {
    const [{ exists }] = await tx`select to_regclass('public.schema_migrations') is not null as exists`;
    const applied = exists
      ? new Map((await tx`select filename, checksum from public.schema_migrations`).map((r) => [r.filename, r.checksum]))
      : new Map();

    if (!exists) console.log('[migrate] public.schema_migrations does not exist yet (would be created)');

    const drifted = files.filter((f) => applied.has(f) && !matchesRecorded(bodies.get(f), applied.get(f)));
    const pending = files.filter((f) => !applied.has(f));

    for (const f of drifted) console.error(`[migrate] ${f} changed after it was applied — a real run would stop here`);
    console.log(`[migrate] applied: ${files.length - pending.length}, pending: ${pending.length}`);
    for (const f of pending) console.log(`          would apply ${f}`);
    console.log('[migrate] dry run: no changes made');
    return drifted.length > 0 ? 1 : 0;
  });
}

async function apply(sql, files, bodies) {
  const [{ acquired }] = await sql`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as acquired`;
  if (!acquired) {
    console.log('[migrate] another migration run holds the lock; waiting …');
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
  }

  try {
    await sql.begin((tx) => tx.unsafe(TRACKING_TABLE_SQL));

    // Read under the lock: a run that finished while we waited is reflected here.
    const applied = new Map(
      (await sql`select filename, checksum from public.schema_migrations`).map((r) => [r.filename, r.checksum]),
    );

    // Verify every applied file before touching anything.
    for (const filename of files) {
      const previous = applied.get(filename);
      if (previous !== undefined && !matchesRecorded(bodies.get(filename), previous)) {
        console.error(
          `[migrate] ${filename} changed after it was applied.\n` +
            `          Migrations are immutable. Add a new migration instead.`,
        );
        return 1;
      }
    }

    let count = 0;
    for (const filename of files) {
      if (applied.has(filename)) continue;
      const body = normalizeMigration(bodies.get(filename));
      const checksum = fingerprint(body);

      process.stdout.write(`[migrate] applying ${filename} … `);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into public.schema_migrations (filename, checksum) values (${filename}, ${checksum})`;
      });
      console.log('ok');
      count += 1;
    }

    console.log(count === 0 ? '[migrate] already up to date' : `[migrate] applied ${count} migration(s)`);
    return 0;
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  // The driver's message and SQLSTATE only — never the connection options.
  console.error(`[migrate] failed: ${err?.message ?? 'unknown error'}${err?.code ? ` (${err.code})` : ''}`);
  process.exitCode = 1;
}
