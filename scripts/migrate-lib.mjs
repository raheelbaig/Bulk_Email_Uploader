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
      projectRef: supabaseProjectRef(u),
    };
  } catch {
    return { host: null, port: null, database: null, local: false, projectRef: null };
  }
}

/**
 * The Supabase project a connection string points at, or null.
 *
 * Every project in a region shares one pooler host, so the host alone cannot
 * say which project is about to change. The ref can: the pooler's user is
 * `postgres.<ref>`, and a direct connection's host is `db.<ref>.supabase.co`.
 * The ref is not a secret — it is in the public NEXT_PUBLIC_SUPABASE_URL — so
 * it may be printed; the rest of the username and the password never are.
 */
export function supabaseProjectRef(u) {
  const direct = /^db\.([a-z0-9]{15,30})\.supabase\.co$/.exec(u.hostname);
  if (direct) return direct[1];
  if (/\.pooler\.supabase\.com$/.test(u.hostname)) {
    const pooled = /^postgres\.([a-z0-9]{15,30})$/.exec(decodeURIComponent(u.username));
    if (pooled) return pooled[1];
  }
  return null;
}

export function parseArgs(argv) {
  const known = new Set(['--dry-run', '--yes-production', '--confirm-production']);
  const refArg = argv.find((a) => a.startsWith('--project-ref='));
  const unknown = argv.filter((a) => !known.has(a) && a !== refArg);
  return {
    dryRun: argv.includes('--dry-run'),
    yesProduction: argv.includes('--yes-production'),
    confirmProduction: argv.includes('--confirm-production'),
    projectRef: refArg === undefined ? null : refArg.slice('--project-ref='.length),
    unknown,
  };
}

/**
 * Whether an apply (not a dry run) may proceed. Null when it may, otherwise the
 * reason. Every rule for remote targets lives here so it can be tested. There
 * is one real database, so any non-local target is treated as production:
 *
 *   1. --yes-production is required for any non-local database;
 *   2. --project-ref must name the project DATABASE_URL points at;
 *   3. --confirm-production is also required, so a remote apply always takes
 *      three deliberate flags.
 */
export function applyRefusal(target, args) {
  if (target.local) return null;
  if (!args.yesProduction) {
    return (
      'refusing to apply migrations to a non-local database without --yes-production.\n' +
      '          Run with --dry-run first to see what would be applied.'
    );
  }
  const expected = target.projectRef ?? target.host;
  if (args.projectRef !== expected) {
    return (
      `refusing: DATABASE_URL points at ${target.projectRef === null ? `host ${target.host}` : `Supabase project ${target.projectRef}`}.\n` +
      `          Re-run with --project-ref=${expected} to confirm that is the database you mean to change.`
    );
  }
  if (!args.confirmProduction) {
    return (
      `refusing: ${expected} is the production database.\n` +
      '          Applying to it also needs --confirm-production, and explicit approval.'
    );
  }
  return null;
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
