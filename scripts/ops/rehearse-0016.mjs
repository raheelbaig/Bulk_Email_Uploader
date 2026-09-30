// Local-only rehearsal of B2 + its verification, on PGlite. Touches no network.
//   node scripts/ops/rehearse-0016.mjs   (from the repository root)
// Applies 0001–0015 with production's default ACLs, runs the 'pre' checks,
// applies 0016 exactly as scripts/migrate.mjs does, runs the 'post' checks, then
// injects faults one at a time (each rolled back) to prove the checks catch them.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecks, snapshot } from './checks-0016.mjs';

const cwd = process.cwd();
const imp = (p) => import(pathToFileURL(join(cwd, 'node_modules', ...p.split('/'))).href);
const { PGlite } = await imp('@electric-sql/pglite/dist/index.js');
const { pg_trgm } = await imp('@electric-sql/pglite/dist/contrib/pg_trgm.js');
const lib = await import(pathToFileURL(join(cwd, 'scripts', 'migrate-lib.mjs')).href);

const dir = join(cwd, 'supabase', 'migrations');
const repo = { files: readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((filename) => ({ filename, body: readFileSync(join(dir, filename), 'utf8') })) };

const pg = await new PGlite({ extensions: { pg_trgm } });
await pg.exec(readFileSync(join(cwd, 'supabase', 'testing', '0000_supabase_emulation.sql'), 'utf8'));
// Production's default privileges (read from pg_default_acl on okthffhjecrylqvlsoxj).
await pg.exec(`
  alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
await pg.exec(lib.TRACKING_TABLE_SQL);
for (const f of repo.files.filter((f) => f.filename !== '0016_provider_events.sql')) {
  await pg.exec(lib.normalizeMigration(f.body));
  await pg.query('insert into public.schema_migrations (filename, checksum) values ($1, $2)', [f.filename, lib.fingerprint(f.body)]);
}
// Some rows, so count comparisons are not trivially 0 = 0.
await pg.exec(`
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'owner@example.com');
`).catch((e) => console.log('seed note:', e.message));

const q = async (text, params = []) => (await pg.query(text, params)).rows;
const report = (label, results) => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n== ${label}: ${results.length - failed.length}/${results.length} passed`);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}${r.detail ? `  — ${r.detail}` : ''}`);
  return failed;
};

const pre = await runChecks(q, { phase: 'pre', repo, lib, env: { EMAIL_SENDING_MODE: 'disabled' } });
const preFailed = report('PRE (0001–0015 applied)', pre);
const snap = await snapshot(q);

// Exactly what scripts/migrate.mjs apply() does for one pending file.
const f16 = repo.files.find((f) => f.filename === '0016_provider_events.sql');
await pg.transaction(async (tx) => {
  await tx.exec(lib.normalizeMigration(f16.body));
  await tx.query('insert into public.schema_migrations (filename, checksum) values ($1, $2)', ['0016_provider_events.sql', lib.fingerprint(f16.body)]);
});

const post = await runChecks(q, { phase: 'post', snap, repo, lib, env: { EMAIL_SENDING_MODE: 'disabled' } });
const postFailed = report('POST (0016 applied)', post);

// Negative controls: each fault must turn at least the named check red.
const faults = [
  ['grant delete to service_role', 'grant delete on public.provider_events to service_role', ['S4', 'S5']],
  ['grant select to anon', 'grant select on public.provider_events to anon', ['S3', 'S6']],
  ['RLS not forced', 'alter table public.provider_events no force row level security', ['S2']],
  ['anon can execute bounce fn', 'grant execute on function public.events_record_bounce(text,timestamptz,timestamptz,text,uuid,uuid,text[],text,text) to anon', ['S7', 'S12']],
  ['definer search_path unpinned', 'alter function app.strengthen_suppression(uuid,text,suppression_reason,text,text,uuid) reset search_path', ['S9']],
  ['trigger disabled', 'alter table public.suppressions disable trigger trg_suppressions_guard_update', ['O7']],
  ['old job machine', readFileSync(join(dir, '0010_sending_engine.sql'), 'utf8').replace(/\r/g, '').match(/create or replace function app\.job_transition_allowed[\s\S]*?\$fn\$;/)[0], ['O9']],
  ['checksum drift', `update public.schema_migrations set checksum='x' where filename='0012_send_approval.sql'`, ['M4']],
  ['row lost', `delete from app.rls_policy_exceptions where table_name='provider_events'`, ['O10']],
  ['business row changes', `delete from public.workspace_members`, ['D1']],
  ['sending row appears', `insert into public.rate_ledger (workspace_id, window_start) select id, now() from public.workspaces limit 1`, ['D3', 'D1']],
];
let controlsOk = true;
for (const [name, ddl, want] of faults) {
  await pg.exec('begin');
  let caught = null;
  try {
    await pg.exec(ddl);
    const r = await runChecks(q, { phase: 'post', snap, repo, lib, env: { EMAIL_SENDING_MODE: 'disabled' } });
    caught = r.filter((x) => !x.ok).map((x) => x.id.split(' ')[0]);
  } catch (e) {
    caught = [`(fault not injectable: ${e.message.split('\n')[0]})`];
  }
  await pg.exec('rollback');
  const hit = want.some((w) => caught.includes(w));
  if (!hit) controlsOk = false;
  console.log(`${hit ? 'CAUGHT ' : 'MISSED '} ${name} -> failing: ${caught.join(',')}`);
}
const again = await runChecks(q, { phase: 'post', snap, repo, lib, env: { EMAIL_SENDING_MODE: 'disabled' } });
console.log(`\nafter rollbacks: ${again.filter((r) => r.ok).length}/${again.length} pass`);
console.log(`\nREHEARSAL ${preFailed.length === 0 && postFailed.length === 0 && controlsOk ? 'OK' : 'NOT OK'}`);
