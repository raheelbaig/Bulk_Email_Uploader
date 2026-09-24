/**
 * Pure pieces of the migration runner, kept apart from scripts/migrate.mjs so
 * they can be tested without a database connection.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Line endings are a checkout artifact (core.autocrlf), not part of a
 * migration's meaning. Fingerprinting the raw bytes made the same commit hash
 * differently on Windows and Linux, which the runner reports as "changed after
 * it was applied". Only CRLF is folded; every other byte is significant.
 */
export function normalizeMigration(body) {
  return body.replace(/\r\n/g, '\n');
}

export function fingerprint(body) {
  return createHash('sha256').update(normalizeMigration(body)).digest('hex');
}

/**
 * Checksums recorded before normalization were taken over the raw bytes. A
 * stored value is accepted if it matches either form of the file as it exists
 * now — both describe exactly these contents, so immutability still holds.
 */
export function matchesRecorded(body, recorded) {
  if (recorded === fingerprint(body)) return true;
  return recorded === createHash('sha256').update(body).digest('hex');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * What may be printed about the target: host, port and database name. Never
 * the user or password. An unparseable URL yields nulls rather than echoing
 * the input back.
 */
export function describeTarget(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return {
      host,
      port: u.port || '5432',
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
      local: LOCAL_HOSTS.has(host),
    };
  } catch {
    return { host: null, port: null, database: null, local: false };
  }
}

export function parseArgs(argv) {
  const known = new Set(['--dry-run', '--yes-production']);
  const unknown = argv.filter((a) => !known.has(a));
  return {
    dryRun: argv.includes('--dry-run'),
    yesProduction: argv.includes('--yes-production'),
    unknown,
  };
}

/**
 * Loads .env.local into process.env without overriding variables already set,
 * so an explicit `DATABASE_URL=… pnpm db:migrate` still wins. Returns whether
 * the file was found.
 */
export function loadEnvLocal(path) {
  if (!existsSync(path)) return false;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path);
    return true;
  }
  // Node < 20.12 fallback: KEY=VALUE lines, optional quotes, # comments.
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    process.env[m[1]] = value;
  }
  return true;
}

/** Arbitrary but fixed: every runner against the same database contends on it. */
export const MIGRATION_LOCK_KEY = 7_210_842_551;

/**
 * The tracking table lives in `public` (not `supabase_migrations`, which the
 * Supabase CLI owns). Supabase's default privileges grant every new `public`
 * table to anon/authenticated/service_role and expose it through PostgREST, so
 * the table is locked down explicitly: RLS on with no policies, and every
 * privilege revoked from the API roles. Only the owner — the migration role
 * that created it — can read or write it.
 *
 * The API roles exist on Supabase but not on a bare local Postgres, so each
 * revoke is conditional. Idempotent; runs on every migrate.
 */
export const TRACKING_TABLE_SQL = `
create table if not exists public.schema_migrations (
  filename   text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;

revoke all on table public.schema_migrations from public;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.schema_migrations from %I', r);
    end if;
  end loop;
end
$$;
`;
