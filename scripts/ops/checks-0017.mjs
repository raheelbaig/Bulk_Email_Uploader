// Read-only checks for migration 0017, shared by the production verifier
// (scripts/ops/verify-0017.mjs, postgres.js inside a READ ONLY transaction) and
// the local rehearsal (scripts/ops/rehearse-0017.mjs, PGlite). Every statement
// here is a SELECT.
//
//   q(text, params) -> Promise<rows[]>
//   phase 'pre'  : immediately before applying (16 applied, 0017 absent)
//   phase 'post' : immediately after applying
//   snap         : result of snapshot() taken in 'pre'; 'post' compares against it
//   repo         : { files: [{ filename, body }] } from supabase/migrations
//   lib          : scripts/migrate-lib.mjs (matchesRecorded)

export const M17 = '0017_event_reconciliation.sql';

const TS = 'timestamp with time zone';
const CORRELATED = `text, ${TS}, ${TS}, text, uuid, uuid, integer, text[]`;

// Every function 0017 creates (or re-creates), by argument types.
export const FUNCTIONS_0017 = {
  'public.events_record_send': CORRELATED,
  'public.events_record_delivery': CORRELATED,
  'public.events_record_reject': `${CORRELATED}, text`,
  'public.events_record_bounce': `${CORRELATED}, text, text`,
  'public.events_record_complaint': `${CORRELATED}, text`,
  'public.events_prune': 'integer, integer',
  'public.workspace_send_health': 'uuid',
  'app.events_resolve_attempt': 'uuid, uuid, integer, text, text[]',
  'app.events_audit_resolved': 'uuid, uuid, text, text, text',
  'app.events_health_guard': 'uuid',
  'app.events_reconcile': 'text, text, uuid, uuid, integer, text, text[]',
  'app.events_applied': 'text, uuid, uuid, text',
  'app.events_unmatched': 'text, text',
};
// Callable by service_role only. workspace_send_health is the one member-readable function.
const SERVICE_ONLY = Object.keys(FUNCTIONS_0017).filter((f) => f !== 'public.workspace_send_health');

// The 0016 signatures 0017 drops.
const DROPPED = {
  'public.events_record_bounce': `text, ${TS}, ${TS}, text, uuid, uuid, text[], text, text`,
  'public.events_record_complaint': `text, ${TS}, ${TS}, text, uuid, uuid, text[], text`,
};

// The job state machine after 0017. Anything not listed is false.
export const JOB_TRANSITIONS = {
  pending: ['claimed', 'suppressed', 'skipped', 'cancelled'],
  claimed: ['sent', 'pending', 'failed', 'send_uncertain', 'suppressed', 'skipped'],
  send_uncertain: ['pending', 'failed', 'sent', 'cancelled'],
  sent: ['delivered', 'bounced', 'complained', 'failed'],
  delivered: ['bounced', 'complained'],
  bounced: ['complained'],
};
export const JOB_TRANSITIONS_0016 = { ...JOB_TRANSITIONS, sent: ['delivered', 'bounced', 'complained'] };

async function functionsNamed(q, qualified) {
  const [schema, name] = qualified.split('.');
  return q(
    `select p.oid::int as oid, oidvectortypes(p.proargtypes) as args, p.prosecdef as definer,
            coalesce(array_to_string(p.proconfig, ','), '') as config,
            (select r.rolsuper or r.rolbypassrls from pg_roles r where r.oid = p.proowner) as owner_bypasses_rls
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.proname = $2`,
    [schema, name],
  );
}

async function jobMatrixDiff(q, expected) {
  const rows = await q(
    `select a.s::text as o, b.s::text as n, app.job_transition_allowed(a.s, b.s) as ok
       from unnest(enum_range(null::job_status)) a(s) cross join unnest(enum_range(null::job_status)) b(s)`,
  );
  return rows.filter(({ o, n, ok }) => ok !== (expected[o] ?? []).includes(n)).map(({ o, n, ok }) => `${o}->${n}=${ok}`);
}

async function canExecute(q, role, oid) {
  return (await q(`select has_function_privilege($1, $2::oid, 'execute') as ok`, [role, oid]))[0].ok;
}

export async function snapshot(q) {
  const tables = (
    await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' order by 1`)
  ).map((r) => r.relname);
  const counts = {};
  for (const t of tables) counts[t] = Number((await q(`select count(*)::int as n from public."${t}"`))[0].n);
  const migrations = await q(`select filename, checksum from public.schema_migrations order by filename`);
  return { counts, migrations };
}

export async function runChecks(q, { phase, snap, repo, lib, env }) {
  const results = [];
  const check = (id, ok, detail = '') => results.push({ id, ok: Boolean(ok), detail });

  // ── Migrations ────────────────────────────────────────────────────────────
  const applied = await q(`select filename, checksum from public.schema_migrations order by filename`);
  const repoNames = repo.files.map((f) => f.filename);
  const want = phase === 'pre' ? repoNames.filter((f) => f !== M17) : repoNames;
  check('M1 applied set', JSON.stringify(applied.map((r) => r.filename)) === JSON.stringify(want), `applied=${applied.length} expected=${want.length}`);
  const drift = applied
    .filter((r) => {
      const f = repo.files.find((x) => x.filename === r.filename);
      return f === undefined || !lib.matchesRecorded(f.body, r.checksum);
    })
    .map((r) => r.filename);
  check('M2 no checksum drift', drift.length === 0, drift.join(',') || 'every applied checksum matches the repository');

  if (phase === 'pre') {
    const present = [];
    for (const name of ['public.events_record_send', 'public.events_record_delivery', 'public.events_record_reject',
      'public.events_prune', 'public.workspace_send_health', 'app.events_resolve_attempt', 'app.events_health_guard']) {
      if ((await functionsNamed(q, name)).length > 0) present.push(name);
    }
    check('P1 no 0017 function exists yet', present.length === 0, present.join(',') || 'none present');
    const bounce = await functionsNamed(q, 'public.events_record_bounce');
    check('P2 bounce/complaint still at the 0016 signature',
      bounce.length === 1 && bounce[0].args === DROPPED['public.events_record_bounce'], bounce.map((b) => b.args).join(' | '));
    check('P3 job machine is 0016', (await jobMatrixDiff(q, JOB_TRANSITIONS_0016)).length === 0);
    const idx = await q(`select 1 from pg_indexes where schemaname = 'public' and indexname = 'ix_email_jobs_ws_sent'`);
    check('P4 health index absent', idx.length === 0);
  }

  if (phase === 'post') {
    // ── Functions, signatures, privileges ─────────────────────────────────
    const wrong = [];
    const oids = {};
    for (const [name, args] of Object.entries(FUNCTIONS_0017)) {
      const found = await functionsNamed(q, name);
      if (found.length !== 1 || found[0].args !== args) wrong.push(`${name}: ${found.map((f) => f.args).join(' | ') || 'missing'}`);
      else oids[name] = found[0];
    }
    check('F1 every 0017 function exists exactly once with its signature', wrong.length === 0, wrong.join('; ') || `${Object.keys(FUNCTIONS_0017).length} functions`);
    check('F2 the 0016 bounce/complaint signatures are gone',
      Object.keys(DROPPED).every((n) => (oids[n] ?? null) !== null && oids[n].args !== DROPPED[n]));

    const leaks = [];
    for (const name of SERVICE_ONLY) {
      const f = oids[name];
      if (f === undefined) continue;
      if (await canExecute(q, 'anon', f.oid)) leaks.push(`${name}:anon`);
      if (await canExecute(q, 'authenticated', f.oid)) leaks.push(`${name}:authenticated`);
      if (!(await canExecute(q, 'service_role', f.oid))) leaks.push(`${name}:service_role-missing`);
    }
    check('F3 event/prune functions: service_role only', leaks.length === 0, leaks.join(',') || `${SERVICE_ONLY.length} functions`);

    const health = oids['public.workspace_send_health'];
    check('F4 workspace_send_health: invoker, members yes, anon no',
      health !== undefined && !health.definer &&
        (await canExecute(q, 'authenticated', health.oid)) && !(await canExecute(q, 'anon', health.oid)) &&
        (await canExecute(q, 'service_role', health.oid)));

    const prune = oids['public.events_prune'];
    check('F5 events_prune: definer, pinned search_path', prune !== undefined && prune.definer && prune.config.includes('search_path='));
    check('F6 events_prune owner bypasses RLS (otherwise pruning deletes nothing — harmless, but ineffective)',
      prune !== undefined && prune.owner_bypasses_rls === true, prune === undefined ? '' : `owner_bypasses_rls=${prune.owner_bypasses_rls}`);

    const definerLeaks = [];
    for (const name of SERVICE_ONLY) {
      const f = oids[name];
      if (f !== undefined && !f.config.includes('search_path=')) definerLeaks.push(name);
    }
    check('F7 every 0017 function pins search_path', definerLeaks.length === 0, definerLeaks.join(','));

    const diff = await jobMatrixDiff(q, JOB_TRANSITIONS);
    check('F8 job machine = 0016 + sent->failed', diff.length === 0, diff.join(',') || 'matrix exact');

    const idx = await q(`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'ix_email_jobs_ws_sent'`);
    check('F9 health index present and partial', idx.length === 1 && /where \(sent_at is not null\)/i.test(idx[0].indexdef));

    // ── Security posture unchanged ───────────────────────────────────────
    const pe = (await q(`select relrowsecurity as r, relforcerowsecurity as f from pg_class where oid = 'public.provider_events'::regclass`))[0];
    check('S1 provider_events RLS on and forced', pe.r && pe.f);
    const pePolicies = await q(`select policyname from pg_policies where schemaname = 'public' and tablename = 'provider_events'`);
    check('S2 provider_events still has no policy (registered exception)', pePolicies.length === 0, pePolicies.map((p) => p.policyname).join(','));
    const peGrants = await q(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'provider_events' and grantee in ('anon', 'authenticated', 'service_role')
        order by 1, 2`,
    );
    const g = peGrants.map((r) => `${r.grantee}:${r.privilege_type}`);
    check('S3 provider_events grants: service_role select/insert/update only',
      JSON.stringify(g) === JSON.stringify(['service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE']), g.join(','));
    const weak = (
      await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'
                  and not (c.relrowsecurity and c.relforcerowsecurity)`)
    ).map((r) => r.relname);
    check('S4 every public table RLS on and forced', weak.length === 0, weak.join(','));

    // ── Data unchanged ───────────────────────────────────────────────────
    if (snap) {
      const now = await snapshot(q);
      const diffs = [];
      for (const [t, n0] of Object.entries(snap.counts)) {
        const expected = t === 'schema_migrations' ? n0 + 1 : n0;
        if (now.counts[t] !== expected) diffs.push(`${t}: ${n0} -> ${now.counts[t]}`);
      }
      const added = Object.keys(now.counts).filter((t) => !(t in snap.counts));
      check('D1 every table count vs pre snapshot (schema_migrations +1)', diffs.length === 0, diffs.join('; ') || `${Object.keys(snap.counts).length} tables identical`);
      check('D2 no new table', added.length === 0, added.join(','));
    }
  }

  check('E1 sending stays disabled in this environment', (env.EMAIL_SENDING_MODE ?? 'disabled') === 'disabled', `EMAIL_SENDING_MODE=${env.EMAIL_SENDING_MODE ?? '(unset: disabled)'}`);
  return results;
}
