// Read-only checks for migration 0016, shared by the production verifier
// (scripts/ops/verify-0016.mjs, postgres.js inside a READ ONLY transaction) and
// the local rehearsal (scripts/ops/rehearse-0016.mjs, PGlite). Every statement
// here is a SELECT.
//
//   q(text, params) -> Promise<rows[]>
//   phase 'pre'  : state immediately before B2 (15 applied, 0016 absent)
//   phase 'post' : state immediately after B2 (everything the plan lists)
//   snapshot     : result of a 'pre' run; 'post' compares against it
//   repo         : { files: [{ filename, body }] } from supabase/migrations
//   lib          : { matchesRecorded, fingerprint } from scripts/migrate-lib.mjs

export const P6_FUNCTIONS = [
  'public.events_record_bounce(p_sns_message_id text, p_sns_timestamp timestamp with time zone, p_occurred_at timestamp with time zone, p_message_id text, p_workspace_id uuid, p_job_id uuid, p_recipients text[], p_bounce_type text, p_bounce_subtype text)',
  'public.events_record_complaint(p_sns_message_id text, p_sns_timestamp timestamp with time zone, p_occurred_at timestamp with time zone, p_message_id text, p_workspace_id uuid, p_job_id uuid, p_recipients text[], p_feedback_type text)',
  'public.events_record_ignored(p_sns_message_id text, p_sns_timestamp timestamp with time zone, p_event_type text, p_message_id text)',
  'app.strengthen_suppression(p_workspace_id uuid, p_email text, p_reason suppression_reason, p_source text, p_detail text, p_campaign_id uuid)',
  'app.events_suppress(p_workspace_id uuid, p_email text, p_reason suppression_reason, p_detail text, p_campaign_id uuid)',
  'app.events_begin(p_sns_message_id text, p_event_type text, p_sns_timestamp timestamp with time zone, p_occurred_at timestamp with time zone, p_message_id text, p_detail jsonb)',
  'app.events_match_job(p_workspace_id uuid, p_job_id uuid, p_message_id text, p_recipients text[])',
  'app.events_audit(p_workspace_id uuid, p_job_id uuid, p_campaign_id uuid, p_sns_message_id text, p_message_id text, p_event_type text, p_occurred_at timestamp with time zone, p_suppression_action text, p_suppression_reason text, p_job_transition text, p_detail jsonb)',
];
const P6_NAMES = ['events_record_bounce', 'events_record_complaint', 'events_record_ignored', 'strengthen_suppression',
  'events_suppress', 'events_begin', 'events_match_job', 'events_audit', 'guard_suppression_update'];

// The 0016 job state machine. Anything not listed is false.
export const JOB_TRANSITIONS = {
  pending: ['claimed', 'suppressed', 'skipped', 'cancelled'],
  claimed: ['sent', 'pending', 'failed', 'send_uncertain', 'suppressed', 'skipped'],
  send_uncertain: ['pending', 'failed', 'sent', 'cancelled'],
  sent: ['delivered', 'bounced', 'complained'],
  delivered: ['bounced', 'complained'],
  bounced: ['complained'],
};
// The 0010 machine — what 'pre' must still show.
export const JOB_TRANSITIONS_0010 = { ...JOB_TRANSITIONS, delivered: [], bounced: [] };

export const SENDING_TABLES = ['campaigns', 'contact_lists', 'email_jobs', 'list_members', 'rate_ledger',
  'send_attempts', 'sender_domains', 'sender_identities', 'suppressions'];

const PE_INDEXES = ['ix_provider_events_job', 'ix_provider_events_received', 'ix_provider_events_ws_received', 'provider_events_pkey'];
const SUPPRESSION_TRIGGERS_PRE = ['trg_suppressions_cancel_jobs', 'trg_suppressions_sync_contact'];
const SUPPRESSION_TRIGGERS_POST = ['trg_suppressions_cancel_jobs', 'trg_suppressions_guard_update', 'trg_suppressions_sync_contact'];

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function jobMatrix(q) {
  const statuses = (await q(`select unnest(enum_range(null::job_status))::text s`)).map((r) => r.s);
  const rows = await q(
    `select a.s::text o, b.s::text n, app.job_transition_allowed(a.s, b.s) ok
       from unnest(enum_range(null::job_status)) a(s) cross join unnest(enum_range(null::job_status)) b(s)`);
  return { statuses, rows };
}

function matrixDiff({ statuses, rows }, expected) {
  const bad = [];
  for (const { o, n, ok } of rows) {
    const want = (expected[o] ?? []).includes(n);
    if (ok !== want) bad.push(`${o}->${n}=${ok}`);
  }
  for (const k of Object.keys(expected)) if (!statuses.includes(k)) bad.push(`unknown status ${k}`);
  return bad;
}

export async function snapshot(q) {
  const tables = (await q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                            where n.nspname='public' and c.relkind='r' order by 1`)).map((r) => r.relname);
  const counts = {};
  for (const t of tables) counts[t] = Number((await q(`select count(*)::int n from public."${t}"`))[0].n);
  const anon_exec_fns = (await q(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' f
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname in ('public','app') and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1`)).map((r) => r.f);
  const table_grants = await q(`select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) privs
      from information_schema.role_table_grants
     where table_schema='public' and grantee in ('anon','authenticated','service_role','PUBLIC')
     group by 1,2 order by 1,2`);
  // Recorded for the audit trail; the checks above compare the fields they need.
  const migrations = await q(`select filename, checksum, applied_at from public.schema_migrations order by filename`);
  const rls = await q(`select c.relname, c.relrowsecurity enabled, c.relforcerowsecurity forced
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1`);
  const rls_exceptions = await q(`select table_name from app.rls_policy_exceptions order by 1`);
  const suppression_triggers = await q(`select tgname, tgenabled::text en, tgtype::int ty from pg_trigger
      where tgrelid='public.suppressions'::regclass and not tgisinternal order by 1`);
  const job_transition_allowed = (await q(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app' and p.proname='job_transition_allowed'`)).map((r) => r.def);
  const extensions = await q(`select extname, extversion from pg_extension order by 1`);
  return { counts, anon_exec_fns, table_grants, migrations, rls, rls_exceptions, suppression_triggers, job_transition_allowed, extensions };
}

export async function runChecks(q, { phase, snap, repo, lib, expectCounts, env }) {
  const results = [];
  const check = (id, ok, detail = '') => results.push({ id, ok: Boolean(ok), detail });

  // ---- Migration state -------------------------------------------------------
  const applied = await q(`select filename, checksum, applied_at from public.schema_migrations order by filename`);
  const repoNames = repo.files.map((f) => f.filename);
  const wantApplied = phase === 'pre' ? repoNames.filter((f) => f !== '0016_provider_events.sql') : repoNames;
  check('M1 applied count', applied.length === wantApplied.length, `applied=${applied.length} expected=${wantApplied.length}`);
  const appliedNames = applied.map((r) => r.filename);
  const pending = repoNames.filter((f) => !appliedNames.includes(f));
  const unknown = appliedNames.filter((f) => !repoNames.includes(f));
  check('M2 pending set', eq(pending, phase === 'pre' ? ['0016_provider_events.sql'] : []), `pending=[${pending.join(',')}]`);
  check('M3 no tracking rows unknown to repo', unknown.length === 0, unknown.join(','));
  const drift = applied.filter((r) => {
    const f = repo.files.find((x) => x.filename === r.filename);
    return f && !lib.matchesRecorded(f.body, r.checksum);
  }).map((r) => r.filename);
  check('M4 no checksum drift', drift.length === 0, drift.join(',') || 'all applied checksums match repo');
  if (phase === 'post') {
    const row = applied.find((r) => r.filename === '0016_provider_events.sql');
    const body = repo.files.find((f) => f.filename === '0016_provider_events.sql').body;
    check('M5 0016 recorded with runner checksum', row && row.checksum === lib.fingerprint(body) && row.applied_at != null,
      row ? `applied_at=${new Date(row.applied_at).toISOString()}` : 'no row');
    const latest = applied.reduce((a, b) => (new Date(a.applied_at) > new Date(b.applied_at) ? a : b));
    check('M6 0016 is the most recent apply', latest.filename === '0016_provider_events.sql', `latest=${latest.filename}`);
  }

  // ---- Objects ---------------------------------------------------------------
  const reg = (await q(`select to_regclass('public.provider_events')::text t`))[0].t;
  const idx = (await q(`select indexname from pg_indexes where schemaname='public' and tablename='provider_events' order by 1`)).map((r) => r.indexname);
  const fns = await q(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' sig,
                              n.nspname||'.'||p.proname nm, p.prosecdef secdef, p.proconfig::text cfg,
                              pg_get_userbyid(p.proowner) owner, p.oid::int oid
                         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                        where p.proname = any($1::text[]) order by 1`, [P6_NAMES]);
  const trg = (await q(`select tgname, tgenabled::text en, tgtype::int ty, tgfoid::regprocedure::text fn
                          from pg_trigger where tgrelid='public.suppressions'::regclass and not tgisinternal order by 1`));
  const exc = await q(`select table_name from app.rls_policy_exceptions where table_name='provider_events'`);
  const jt = await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='app' and p.proname='job_transition_allowed'`);
  check('O0 single job_transition_allowed overload', jt[0].n === 1, `overloads=${jt[0].n}`);

  if (phase === 'pre') {
    check('O1 provider_events absent', reg === null, `to_regclass=${reg}`);
    check('O2 no provider_events indexes', idx.length === 0, idx.join(','));
    check('O3 no P6 functions', fns.length === 0, fns.map((f) => f.sig).join('; '));
    check('O4 suppressions triggers = 0015 set', eq(trg.map((t) => t.tgname), SUPPRESSION_TRIGGERS_PRE), trg.map((t) => t.tgname).join(','));
    check('O5 no rls_policy_exceptions row', exc.length === 0);
    const bad = matrixDiff(await jobMatrix(q), JOB_TRANSITIONS_0010);
    check('O6 job transitions = 0010 machine', bad.length === 0, bad.join(' ') || 'full status matrix matches 0010');
  } else {
    check('O1 provider_events exists', reg === 'provider_events', `to_regclass=${reg}`);
    check('O2 provider_events indexes', eq(idx, PE_INDEXES), idx.join(','));
    const cons = (await q(`select conname from pg_constraint where conrelid='public.provider_events'::regclass order by 1`)).map((r) => r.conname);
    check('O3 matched/job constraints', cons.includes('ck_provider_events_matched') && cons.includes('fk_provider_events_job'), cons.join(','));
    const sigs = fns.map((f) => f.sig);
    const missing = P6_FUNCTIONS.filter((s) => !sigs.includes(s));
    check('O4 all 8 P6 functions, exact signatures', missing.length === 0, missing.join('; ') || '8/8');
    check('O5 guard_suppression_update() exists', sigs.includes('app.guard_suppression_update()'));
    check('O6 no extra P6 overloads', fns.length === 9, `found=${fns.length} expected=9`);
    const g = trg.find((t) => t.tgname === 'trg_suppressions_guard_update');
    // tgtype 19 = ROW(1) | BEFORE(2) | UPDATE(16)
    check('O7 trg_suppressions_guard_update BEFORE UPDATE FOR EACH ROW, enabled',
      g && g.en === 'O' && g.ty === 19 && g.fn === 'app.guard_suppression_update()', g ? JSON.stringify(g) : 'missing');
    check('O8 suppressions triggers = 0016 set', eq(trg.map((t) => t.tgname), SUPPRESSION_TRIGGERS_POST), trg.map((t) => t.tgname).join(','));
    const bad = matrixDiff(await jobMatrix(q), JOB_TRANSITIONS);
    check('O9 job transitions = 0016 machine (full matrix)', bad.length === 0,
      bad.join(' ') || 'delivered->bounced/complained, bounced->complained added; nothing else changed');
    check('O10 rls_policy_exceptions row', exc.length === 1);
    const pol = await q(`select count(*)::int n from pg_policies where schemaname='public' and tablename='provider_events'`);
    check('O11 no RLS policies on provider_events', pol[0].n === 0, `policies=${pol[0].n}`);
    const n = await q(`select count(*)::int n from public.provider_events`);
    check('O12 provider_events empty', n[0].n === 0, `rows=${n[0].n}`);

    // ---- Security ------------------------------------------------------------
    const rls = (await q(`select relrowsecurity r, relforcerowsecurity f from pg_class where oid='public.provider_events'::regclass`))[0];
    check('S1 provider_events RLS enabled', rls.r === true);
    check('S2 provider_events RLS forced', rls.f === true);
    const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const clientHits = [];
    for (const role of ['anon', 'authenticated']) {
      for (const p of privs) {
        const r = await q(`select has_table_privilege($1, 'public.provider_events', $2) ok`, [role, p]);
        if (r[0].ok) clientHits.push(`${role}:${p}`);
      }
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        const r = await q(`select has_any_column_privilege($1, 'public.provider_events', $2) ok`, [role, p]);
        if (r[0].ok) clientHits.push(`${role}:column ${p}`);
      }
    }
    check('S3 anon/authenticated have no table or column privilege', clientHits.length === 0, clientHits.join(',') || 'none');
    const acl = await q(`select coalesce(nullif(a.grantee,0)::regrole::text,'PUBLIC') g, a.privilege_type p
                           from pg_class c, aclexplode(c.relacl) a where c.oid='public.provider_events'::regclass order by 1,2`);
    const owner = (await q(`select pg_get_userbyid(relowner) o from pg_class where oid='public.provider_events'::regclass`))[0].o;
    const sr = acl.filter((a) => a.g === 'service_role').map((a) => a.p).sort();
    check('S4 service_role = SELECT, INSERT, UPDATE exactly', eq(sr, ['INSERT', 'SELECT', 'UPDATE']), sr.join(','));
    check('S5 service_role has no DELETE/TRUNCATE', !sr.includes('DELETE') && !sr.includes('TRUNCATE'));
    const others = [...new Set(acl.map((a) => a.g))].filter((g) => g !== 'service_role' && g !== owner);
    check('S6 no other grantee on provider_events (incl. PUBLIC)', others.length === 0, `owner=${owner} others=[${others.join(',')}]`);

    const fnHits = [];
    for (const f of fns) {
      const ex = (await q(`select coalesce(nullif(a.grantee,0)::regrole::text,'PUBLIC') g
                             from pg_proc p, aclexplode(p.proacl) a where p.oid=$1 and a.privilege_type='EXECUTE'`, [f.oid])).map((r) => r.g);
      for (const role of ['anon', 'authenticated']) {
        if ((await q(`select has_function_privilege($1, $2::oid, 'EXECUTE') ok`, [role, f.oid]))[0].ok) fnHits.push(`${f.nm}:${role}`);
      }
      if (ex.includes('PUBLIC')) fnHits.push(`${f.nm}:PUBLIC`);
      if (f.nm !== 'app.guard_suppression_update') {
        const sre = (await q(`select has_function_privilege('service_role', $1::oid, 'EXECUTE') ok`, [f.oid]))[0].ok;
        if (!sre) fnHits.push(`${f.nm}:service_role MISSING`);
        const extra = ex.filter((g) => g !== 'service_role' && g !== f.owner);
        if (extra.length) fnHits.push(`${f.nm}:extra ${extra.join('/')}`);
      }
    }
    check('S7 P6 functions: EXECUTE service_role only (never PUBLIC/anon/authenticated)', fnHits.length === 0, fnHits.join(', ') || '9/9 as intended');
    const definers = fns.filter((f) => f.secdef);
    check('S8 only app.strengthen_suppression is SECURITY DEFINER', eq(definers.map((f) => f.nm), ['app.strengthen_suppression']),
      definers.map((f) => `${f.nm} owner=${f.owner}`).join(', '));
    const unpinned = definers.filter((f) => f.cfg !== '{"search_path=public, pg_temp"}');
    check('S9 SECURITY DEFINER search_path pinned to public, pg_temp', definers.length > 0 && unpinned.length === 0,
      definers.map((f) => `${f.nm} ${f.cfg}`).join(', '));
    const invokerUnpinned = fns.filter((f) => !f.secdef && f.nm !== 'app.guard_suppression_update' && f.cfg !== '{"search_path=public, pg_temp"}');
    check('S10 invoker P6 functions search_path pinned', invokerUnpinned.length === 0, invokerUnpinned.map((f) => f.nm).join(','));

    const tables = await q(`select c.relname, c.relrowsecurity r, c.relforcerowsecurity f from pg_class c join pg_namespace n on n.oid=c.relnamespace
                             where n.nspname='public' and c.relkind='r' order by 1`);
    const weak = tables.filter((t) => !t.r || (!t.f && t.relname !== 'schema_migrations')).map((t) => t.relname);
    check('S11 every public table RLS on, forced (schema_migrations: enabled only)', weak.length === 0, `${tables.length} tables; weak=[${weak.join(',')}]`);

    if (snap) {
      const now = await snapshot(q);
      const newAnon = now.anon_exec_fns.filter((f) => !snap.anon_exec_fns.includes(f));
      const goneAnon = snap.anon_exec_fns.filter((f) => !now.anon_exec_fns.includes(f));
      check('S12 anon-executable functions unchanged', newAnon.length === 0 && goneAnon.length === 0,
        `new=[${newAnon.join(', ')}] removed=[${goneAnon.join(', ')}]`);
      const key = (r) => `${r.table_name}|${r.grantee}|${r.privs}`;
      const before = snap.table_grants.map(key);
      const after = now.table_grants.map(key);
      const added = after.filter((k) => !before.includes(k));
      const removed = before.filter((k) => !after.includes(k));
      check('S13 table grants: only provider_events|service_role|INSERT,SELECT,UPDATE added',
        eq(added, ['provider_events|service_role|INSERT,SELECT,UPDATE']) && removed.length === 0,
        `added=[${added.join(' ')}] removed=[${removed.join(' ')}]`);

      // ---- Data safety -------------------------------------------------------
      const diffs = [];
      for (const [t, n0] of Object.entries(snap.counts)) {
        const want = t === 'schema_migrations' ? n0 + 1 : n0;
        if (now.counts[t] !== want) diffs.push(`${t}: ${n0} -> ${now.counts[t]}`);
      }
      const newTables = Object.keys(now.counts).filter((t) => !(t in snap.counts));
      check('D1 every table count vs pre-B2 snapshot (schema_migrations +1)', diffs.length === 0, diffs.join('; ') || `${Object.keys(snap.counts).length} tables identical`);
      check('D2 only new table is provider_events', eq(newTables, ['provider_events']), newTables.join(','));
    }
  }

  // ---- Data safety (both phases) ---------------------------------------------
  const counts = {};
  for (const t of [...SENDING_TABLES, ...Object.keys(expectCounts ?? {})]) {
    counts[t] = Number((await q(`select count(*)::int n from public."${t}"`))[0].n);
  }
  const nonEmpty = SENDING_TABLES.filter((t) => counts[t] !== 0).map((t) => `${t}=${counts[t]}`);
  check('D3 sending tables still empty', nonEmpty.length === 0, nonEmpty.join(',') || SENDING_TABLES.join(',') + ' = 0');
  if (expectCounts) {
    const off = Object.entries(expectCounts)
      .map(([t, n]) => [t, t === 'schema_migrations' && phase === 'post' ? n + 1 : n])
      .filter(([t, n]) => counts[t] !== n).map(([t, n]) => `${t}: expected ${n} got ${counts[t]}`);
    check('D4 counts vs recorded baseline', off.length === 0, off.join('; ') || 'all match');
  }

  // ---- Sending surface -------------------------------------------------------
  const ext = (await q(`select extname from pg_extension where extname in ('pg_cron','pg_net','http','dblink')`)).map((r) => r.extname);
  check('X1 no pg_cron/pg_net/http/dblink', ext.length === 0, ext.join(','));
  if (env) {
    check('X2 EMAIL_SENDING_MODE=disabled', env.EMAIL_SENDING_MODE === 'disabled', `mode=${env.EMAIL_SENDING_MODE ?? '(unset)'}`);
    const aws = Object.keys(env).filter((k) => /^AWS_/.test(k));
    check('X3 no AWS_* variables loaded', aws.length === 0, aws.join(','));
  }
  return results;
}
