// Local-only rehearsal of applying 0017 and its verification, on PGlite. No network.
//   node scripts/ops/rehearse-0017.mjs   (from the repository root)
// Applies 0001–0016 with production's default ACLs, runs the 'pre' checks,
// applies 0017 exactly as scripts/migrate.mjs does, runs the 'post' checks, then
// injects faults one at a time (each rolled back) to prove the checks catch them.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { M17, runChecks, snapshot } from './checks-0017.mjs';

const cwd = process.cwd();
const imp = (p) => import(pathToFileURL(join(cwd, 'node_modules', ...p.split('/'))).href);
const { PGlite } = await imp('@electric-sql/pglite/dist/index.js');
const { pg_trgm } = await imp('@electric-sql/pglite/dist/contrib/pg_trgm.js');
const lib = await import(pathToFileURL(join(cwd, 'scripts', 'migrate-lib.mjs')).href);

const dir = join(cwd, 'supabase', 'migrations');
const repo = {
  files: readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => ({ filename, body: readFileSync(join(dir, filename), 'utf8') })),
};

const pg = await new PGlite({ extensions: { pg_trgm } });
await pg.exec(readFileSync(join(cwd, 'supabase', 'testing', '0000_supabase_emulation.sql'), 'utf8'));
// Production's default privileges (read from pg_default_acl on okthffhjecrylqvlsoxj).
await pg.exec(`
  alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
await pg.exec(lib.TRACKING_TABLE_SQL);
for (const f of repo.files.filter((f) => f.filename !== M17)) {
  await pg.exec(lib.normalizeMigration(f.body));
  await pg.query('insert into public.schema_migrations (filename, checksum) values ($1, $2)', [f.filename, lib.fingerprint(f.body)]);
}
await pg.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'owner@example.com')`);

const q = async (text, params = []) => (await pg.query(text, params)).rows;
const env = { EMAIL_SENDING_MODE: 'disabled' };
const report = (label, results) => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n== ${label}: ${results.length - failed.length}/${results.length} passed`);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}${r.detail ? `  — ${r.detail}` : ''}`);
  return failed;
};

const preFailed = report('PRE (0001–0016 applied)', await runChecks(q, { phase: 'pre', repo, lib, env }));
const snap = await snapshot(q);

// Exactly what scripts/migrate.mjs apply() does for one pending file.
const f17 = repo.files.find((f) => f.filename === M17);
await pg.transaction(async (tx) => {
  await tx.exec(lib.normalizeMigration(f17.body));
  await tx.query('insert into public.schema_migrations (filename, checksum) values ($1, $2)', [M17, lib.fingerprint(f17.body)]);
});

const postFailed = report('POST (0017 applied)', await runChecks(q, { phase: 'post', snap, repo, lib, env }));

const send = 'public.events_record_send(text,timestamptz,timestamptz,text,uuid,uuid,integer,text[])';
const faults = [
  ['anon can execute Send', `grant execute on function ${send} to anon`, ['F3']],
  ['members can prune', 'grant execute on function public.events_prune(integer,integer) to authenticated', ['F3']],
  ['anon reads health', 'grant execute on function public.workspace_send_health(uuid) to anon', ['F4']],
  ['prune search_path unpinned', 'alter function public.events_prune(integer,integer) reset search_path', ['F5']],
  ['index dropped', 'drop index public.ix_email_jobs_ws_sent', ['F9']],
  ['old job machine', readFileSync(join(dir, '0016_provider_events.sql'), 'utf8').replace(/\r/g, '').match(/create or replace function app\.job_transition_allowed[\s\S]*?\$fn\$;/)[0], ['F8']],
  ['provider_events delete granted', 'grant delete on public.provider_events to service_role', ['S3']],
  ['checksum drift', `update public.schema_migrations set checksum = 'x' where filename = '0016_provider_events.sql'`, ['M2']],
  ['business row changes', 'delete from public.workspace_members', ['D1']],
  ['RLS not forced', 'alter table public.provider_events no force row level security', ['S1', 'S4']],
];
let controlsOk = true;
for (const [name, ddl, want] of faults) {
  await pg.exec('begin');
  let caught;
  try {
    await pg.exec(ddl);
    caught = (await runChecks(q, { phase: 'post', snap, repo, lib, env })).filter((x) => !x.ok).map((x) => x.id.split(' ')[0]);
  } catch (e) {
    caught = [`(fault not injectable: ${e.message.split('\n')[0]})`];
  }
  await pg.exec('rollback');
  const hit = want.some((w) => caught.includes(w));
  if (!hit) controlsOk = false;
  console.log(`${hit ? 'CAUGHT ' : 'MISSED '} ${name} -> failing: ${caught.join(',')}`);
}
const again = await runChecks(q, { phase: 'post', snap, repo, lib, env });
console.log(`\nafter rollbacks: ${again.filter((r) => r.ok).length}/${again.length} pass`);
const ok = preFailed.length === 0 && postFailed.length === 0 && controlsOk && again.every((r) => r.ok);
console.log(`\nREHEARSAL ${ok ? 'OK' : 'NOT OK'}`);
process.exit(ok ? 0 : 1);
