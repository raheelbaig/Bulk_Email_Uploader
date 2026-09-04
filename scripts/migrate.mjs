#!/usr/bin/env node
/**
 * Applies supabase/migrations/*.sql in filename order to DATABASE_URL.
 *
 * Deterministic and reviewable: plain SQL files, applied in order, recorded by
 * filename with a checksum. A file that changes after being applied is a hard
 * error — editing an applied migration means two environments silently diverge.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const DIR = join(process.cwd(), 'supabase', 'migrations');
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('[migrate] DATABASE_URL is not set.');
  process.exit(2);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await sql`
    create table if not exists schema_migrations (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Map(
    (await sql`select filename, checksum from schema_migrations`).map((r) => [r.filename, r.checksum]),
  );

  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const filename of files) {
    const body = readFileSync(join(DIR, filename), 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex');
    const previous = applied.get(filename);

    if (previous !== undefined) {
      if (previous !== checksum) {
        console.error(
          `[migrate] ${filename} changed after it was applied.\n` +
          `          Migrations are immutable. Add a new migration instead.`,
        );
        process.exit(1);
      }
      continue;
    }

    process.stdout.write(`[migrate] applying ${filename} … `);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (filename, checksum) values (${filename}, ${checksum})`;
    });
    console.log('ok');
    count += 1;
  }

  console.log(count === 0 ? '[migrate] already up to date' : `[migrate] applied ${count} migration(s)`);
} finally {
  await sql.end();
}
