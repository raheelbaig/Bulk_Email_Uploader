-- =============================================================================
-- 0006 — P2: the import engine
-- =============================================================================
-- Four tables and two functions:
--
--   imports            one row per uploaded spreadsheet, carrying the six
--                      outcome counters and the state machine
--   import_rejections  one row per input row that did not become a new contact,
--                      with the reason a person can act on
--   import_jobs        the minimum background-processing queue. Not pgmq: pgmq
--                      arrives with the sending engine in P5 and is not
--                      available in the WASM database the test suite runs
--                      against. The claim semantics here are deliberately the
--                      same shape as the P5 job claim (ARCHITECTURE §8.1) so
--                      that migrating to pgmq later changes the transport, not
--                      the correctness argument.
--   rate_limits        the fixed-window API limiter from ARCHITECTURE §3.9,
--                      introduced now because P2 is the first phase with
--                      endpoints worth abusing.
--
-- No sending capability is added, or possible, here.
-- =============================================================================

create type import_status as enum (
  'uploaded',
  'mapping',
  'processing',
  'completed',
  'failed'
);

-- =============================================================================
-- imports
-- =============================================================================
create table imports (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  actor_id        uuid not null references auth.users(id),
  -- Stored for display only. The filename is attacker-controlled: it is never
  -- used to route the parser (magic bytes do that) and never interpolated into
  -- a path (the storage key is derived from ids — see storage_path below).
  filename        text not null check (length(filename) between 1 and 255),
  byte_size       bigint not null check (byte_size >= 0 and byte_size <= 26214400),
  content_type    text not null check (length(content_type) between 1 and 128),
  storage_path    text not null check (length(storage_path) between 1 and 512),
  status          import_status not null default 'uploaded',
  column_mapping  jsonb,
  -- ON DELETE SET NULL, not CASCADE: deleting a list must not erase the record
  -- of an import that happened.
  target_list_id  uuid references contact_lists(id) on delete set null,
  rows_total      integer not null default 0 check (rows_total      >= 0),
  rows_valid      integer not null default 0 check (rows_valid      >= 0),
  rows_invalid    integer not null default 0 check (rows_invalid    >= 0),
  rows_duplicate  integer not null default 0 check (rows_duplicate  >= 0),
  rows_suppressed integer not null default 0 check (rows_suppressed >= 0),
  rows_rejected   integer not null default 0 check (rows_rejected   >= 0),
  error_message   text check (error_message is null or length(error_message) <= 500),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),

  -- The constraint that makes "no row is silently discarded" a property of the
  -- database rather than of the code that happens to be running. A completed
  -- import whose buckets do not account for every input row cannot be written.
  constraint ck_rows_reconcile check (
    status <> 'completed' or
    rows_total = rows_valid + rows_invalid + rows_duplicate
               + rows_suppressed + rows_rejected
  ),

  -- A completed or failed import must say when it finished; anything earlier
  -- must not. Prevents a half-written terminal state looking authoritative.
  constraint ck_import_finished check (
    (status in ('completed', 'failed')) = (finished_at is not null)
  ),

  -- An unbounded mapping is a jsonb injection surface and a storage risk. The
  -- application validates the shape; this bounds the size regardless.
  constraint ck_column_mapping_size check (
    column_mapping is null or pg_column_size(column_mapping) < 16384
  ),

  -- Only a failed import carries a message. A completed one explaining itself
  -- in prose would be a contradiction the UI would have to guess at.
  constraint ck_error_only_when_failed check (
    error_message is null or status = 'failed'
  )
);

-- Listing is keyset-paginated by (created_at desc, id desc) within a workspace,
-- exactly as contacts and lists are.
create index ix_imports_ws_created on imports (workspace_id, created_at desc, id desc);

-- The queue runner and the storage sweeper both ask "which imports are still in
-- flight, or still hold a staged file". Partial: terminal rows are the majority
-- and are never scanned by either.
create index ix_imports_active
  on imports (status, created_at)
  where status in ('uploaded', 'mapping', 'processing');

-- P1 left contacts.import_id unconstrained because this table did not exist.
-- Wiring it now costs no backfill: no import has ever run.
alter table contacts
  add constraint fk_contacts_import
  foreign key (import_id) references imports(id) on delete set null;

-- =============================================================================
-- import_rejections
--
-- `raw_row` holds the original cells so the user can fix and re-upload. It is
-- deliberately the only place raw spreadsheet content is retained, it is never
-- copied into audit metadata or logs, and it is bounded so one malformed file
-- cannot consume the database.
-- =============================================================================
create table import_rejections (
  id         uuid primary key default gen_random_uuid(),
  import_id  uuid not null references imports(id) on delete cascade,
  row_number integer not null check (row_number >= 1),
  raw_row    jsonb not null,
  bucket     text not null check (bucket in ('invalid', 'duplicate', 'suppressed', 'rejected')),
  reason     text not null check (length(reason) between 1 and 300),
  created_at timestamptz not null default now(),

  constraint ck_rejection_row_size check (pg_column_size(raw_row) < 8192)
);

-- The only access pattern: "every rejection for this import, in row order",
-- for the results table and the CSV export. One index serves both.
create index ix_import_rejections_import on import_rejections (import_id, row_number);

-- =============================================================================
-- import_jobs — the minimum background queue
--
-- One row per import to process. `available_at` carries the retry backoff and
-- `attempts` bounds it. The claim is a single conditional UPDATE, which is what
-- makes two concurrent runners racing the same job produce exactly one winner
-- without an advisory lock or SELECT ... FOR UPDATE.
-- =============================================================================
create table import_jobs (
  import_id    uuid primary key references imports(id) on delete cascade,
  -- Denormalised so the runner can scope every subsequent query to a workspace
  -- without first reading `imports` under an unscoped service-role query.
  workspace_id uuid not null references workspaces(id) on delete cascade,
  status       text not null default 'queued'
                 check (status in ('queued', 'claimed', 'done', 'dead')),
  attempts     integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts >= 1),
  available_at timestamptz not null default now(),
  claimed_at   timestamptz,
  last_error   text check (last_error is null or length(last_error) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);

create trigger trg_import_jobs_touch
  before update on import_jobs
  for each row execute function app.touch_updated_at();

-- The claim query's exact predicate: runnable jobs, oldest first.
create index ix_import_jobs_runnable
  on import_jobs (available_at)
  where status = 'queued';

-- The reaper's predicate: claims that never completed.
create index ix_import_jobs_claimed
  on import_jobs (claimed_at)
  where status = 'claimed';

-- =============================================================================
-- rate_limits — fixed-window API limiter (ARCHITECTURE §3.9)
-- =============================================================================
create table rate_limits (
  bucket_key   text not null check (length(bucket_key) between 1 and 200),
  window_start timestamptz not null,
  count        integer not null default 0 check (count >= 0),
  primary key (bucket_key, window_start)
);

-- Retention prunes by window; nothing reads an expired one.
create index ix_rate_limits_window on rate_limits (window_start);

-- -----------------------------------------------------------------------------
-- The limiter itself.
--
-- One statement. The INSERT ... ON CONFLICT DO UPDATE ... WHERE is what makes
-- the check atomic: two concurrent requests at the cap cannot both observe
-- `count < limit` and both increment, because the second one's WHERE fails and
-- no row is returned. A read-then-write in application code has exactly that
-- race, which is how rate limiters are usually wrong.
--
-- SECURITY DEFINER so the limiter can be applied on paths that hold no write
-- privilege on the table; `authenticated` is never granted execute, because
-- limiting is a decision the server makes about a caller, not one a caller
-- makes about itself.
-- -----------------------------------------------------------------------------
create or replace function public.consume_rate_limit(
  p_bucket_key     text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_start timestamptz;
  v_allowed      boolean;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid rate limit configuration';
  end if;

  -- Floor now() to the window. to_timestamp(floor(epoch/n)*n) is stable across
  -- sessions and time zones, unlike date_trunc for non-calendar windows.
  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits (bucket_key, window_start, count)
  values (p_bucket_key, v_window_start, 1)
  on conflict (bucket_key, window_start) do update
    set count = public.rate_limits.count + 1
    where public.rate_limits.count < p_limit
  returning true into v_allowed;

  return coalesce(v_allowed, false);
end;
$$;

comment on function public.consume_rate_limit(text, integer, integer) is
  'Atomically consumes one unit from a fixed window. Returns false when the window is exhausted.';

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

-- These two functions live in `public`, not `app`, for one reason: PostgREST
-- only exposes functions in the schemas a project publishes, and the import
-- runner must reach them over HTTP. `app` is deliberately unpublished, which is
-- what keeps the membership helpers unreachable from a client. Publishing it to
-- expose two functions would widen that surface considerably, so the two travel
-- to `public` instead and are locked down by GRANT: execute is revoked from
-- anon and authenticated, so a client calling /rpc/import_upsert_contacts gets
-- a privilege error, not a contact.

-- Retention (ARCHITECTURE §22.1: rate_limits, 1 day).
create or replace function app.prune_rate_limits(p_older_than interval default interval '1 day')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limits where window_start < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function app.prune_rate_limits(interval) from public, anon, authenticated;
grant execute on function app.prune_rate_limits(interval) to service_role;

-- =============================================================================
-- The chunked contact upsert
--
-- This is the one place import rows become contacts, and it exists as a function
-- rather than as application code for three reasons:
--
--   1. `on conflict ... do update` is the duplicate defence. A SELECT-then-
--      INSERT is racy under concurrent imports of the same address; the unique
--      constraint is not. PostgREST cannot express this statement.
--   2. `xmax = 0` distinguishes an insert from an update *in the same
--      statement*, so the valid/duplicate counters are exact without a second
--      query.
--   3. `coalesce(excluded.x, contacts.x)` is the enrichment rule: an import
--      fills gaps and never blanks a populated field with an empty cell.
--
-- One round trip per chunk, one transaction per chunk. A failure at row 40,000
-- leaves the first 39,999 committed, which is what the honest partial result in
-- ARCHITECTURE §20.6 requires.
-- =============================================================================
create or replace function public.import_upsert_contacts(
  p_workspace_id uuid,
  p_import_id    uuid,
  p_rows         jsonb,
  p_list_id      uuid default null
)
returns table (email_normalized text, inserted boolean)
language plpgsql
as $$
-- The RETURNS TABLE columns are also PL/pgSQL variables, and `email_normalized`
-- is a real column on `contacts`. Without this, every unqualified mention is
-- ambiguous and the function fails at runtime rather than at creation.
#variable_conflict use_column
declare
  v_list_workspace uuid;
begin
  if p_workspace_id is null or p_import_id is null then
    raise exception 'workspace and import are required';
  end if;

  -- The import must belong to the workspace it claims. The runner already
  -- checked; re-checking here means no future caller can pass a mismatched pair
  -- and write contacts into the wrong tenant.
  if not exists (
    select 1 from public.imports
     where id = p_import_id and workspace_id = p_workspace_id
  ) then
    raise exception 'import does not belong to this workspace';
  end if;

  -- Same for the target list. The composite foreign key on list_members would
  -- reject the membership row anyway; failing here gives a clear error instead
  -- of a constraint violation halfway through a chunk.
  if p_list_id is not null then
    select workspace_id into v_list_workspace
      from public.contact_lists where id = p_list_id;
    if v_list_workspace is distinct from p_workspace_id then
      raise exception 'target list does not belong to this workspace';
    end if;
  end if;

  return query
  with input as (
    select
      r ->> 'email_normalized'                          as email_normalized,
      r ->> 'email_raw'                                 as email_raw,
      nullif(r ->> 'first_name', '')                    as first_name,
      nullif(r ->> 'last_name',  '')                    as last_name,
      nullif(r ->> 'company',    '')                    as company,
      nullif(r ->> 'website',    '')                    as website,
      nullif(r ->> 'phone',      '')                    as phone,
      coalesce(r -> 'custom', '{}'::jsonb)              as custom,
      coalesce(r ->> 'status', 'active')                as status
    from jsonb_array_elements(p_rows) as r
  ),
  upserted as (
    insert into public.contacts as c (
      workspace_id, email_normalized, email_raw,
      first_name, last_name, company, website, phone,
      custom, status, import_id
    )
    select
      p_workspace_id, i.email_normalized, i.email_raw,
      i.first_name, i.last_name, i.company, i.website, i.phone,
      i.custom, i.status, p_import_id
    from input i
    on conflict (workspace_id, email_normalized) do update
      set first_name = coalesce(excluded.first_name, c.first_name),
          last_name  = coalesce(excluded.last_name,  c.last_name),
          company    = coalesce(excluded.company,    c.company),
          website    = coalesce(excluded.website,    c.website),
          phone      = coalesce(excluded.phone,      c.phone),
          -- Right-biased merge: new keys win, existing keys the import does not
          -- mention survive.
          custom     = c.custom || excluded.custom,
          -- Status is never downgraded by an import. A contact the suppression
          -- table has marked 'suppressed' stays suppressed even if the
          -- spreadsheet arrives claiming otherwise; the only transition an
          -- import may cause is active → suppressed.
          status     = case
                         when excluded.status = 'suppressed' then 'suppressed'
                         else c.status
                       end,
          -- Deliberately NOT overwritten: import_id records the import that
          -- first created the contact, which is the provenance a user asks
          -- about. Enrichment does not rewrite history.
          updated_at = now()
    returning c.email_normalized, (xmax = 0) as inserted, c.id as contact_id
  ),
  membership as (
    insert into public.list_members (workspace_id, list_id, contact_id)
    select p_workspace_id, p_list_id, u.contact_id
    from upserted u
    where p_list_id is not null
    -- Idempotent: re-importing the same file does not error, and the composite
    -- primary key means a contact appears on a list exactly once.
    on conflict (list_id, contact_id) do nothing
    returning 1
  )
  select u.email_normalized, u.inserted
  from upserted u
  -- Force the membership CTE to run: an unreferenced data-modifying CTE is
  -- still executed by PostgreSQL, but making the dependency explicit stops a
  -- future edit from accidentally making it dead.
  where (select count(*) from membership) >= 0;
end;
$$;

comment on function public.import_upsert_contacts(uuid, uuid, jsonb, uuid) is
  'Chunked import upsert. Enriches without blanking, returns inserted/updated per row, and adds list membership when a target list is given.';

-- Only the import runner calls this, and it runs as service_role. `authenticated`
-- must not: the function writes contacts.status and contacts.import_id, both of
-- which are deliberately outside the client UPDATE grant.
revoke all on function public.import_upsert_contacts(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.import_upsert_contacts(uuid, uuid, jsonb, uuid) to service_role;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table imports            enable row level security;
alter table imports            force  row level security;
alter table import_rejections  enable row level security;
alter table import_rejections  force  row level security;
alter table import_jobs        enable row level security;
alter table import_jobs        force  row level security;
alter table rate_limits        enable row level security;
alter table rate_limits        force  row level security;

revoke all on imports           from anon, authenticated;
revoke all on import_rejections from anon, authenticated;
revoke all on import_jobs       from anon, authenticated;
revoke all on rate_limits       from anon, authenticated;

grant select, insert, update, delete on imports           to service_role;
grant select, insert, update, delete on import_rejections to service_role;
grant select, insert, update, delete on import_jobs       to service_role;
grant select, insert, update, delete on rate_limits       to service_role;

-- -----------------------------------------------------------------------------
-- imports — read-only to the client
--
-- SELECT and nothing else. Every write — creation, the mapping confirmation,
-- each state transition, the final counters — happens server-side under the
-- service role after `requireWorkspace()` has authorized the caller.
--
-- This is what makes "the client cannot rewrite import status" structural: there
-- is no INSERT or UPDATE policy and no INSERT or UPDATE grant, so a forged
-- PostgREST request against this table fails at the privilege layer before any
-- policy is consulted. A guarded state machine in application code alone would
-- be bypassable by anyone holding the anon key and a session.
-- -----------------------------------------------------------------------------
grant select on imports to authenticated;

create policy imports_select on imports
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

-- -----------------------------------------------------------------------------
-- import_rejections — read-only, reachable only through an owned import
--
-- No workspace_id column by design (it would be denormalised state that could
-- disagree with the parent). Tenancy is resolved through the import, which is
-- itself policied above.
-- -----------------------------------------------------------------------------
grant select on import_rejections to authenticated;

create policy import_rejections_select on import_rejections
  for select to authenticated
  using (
    exists (
      select 1 from imports i
      where i.id = import_rejections.import_id
        and i.workspace_id in (select app.current_workspace_ids())
    )
  );

-- -----------------------------------------------------------------------------
-- import_jobs and rate_limits — deny-all to authenticated
--
-- RLS enabled, zero policies. Registered below so the CI coverage guard can tell
-- "intentionally service-role only" from "someone forgot the policy".
-- -----------------------------------------------------------------------------
insert into app.rls_policy_exceptions (table_name, reason) values
  ('import_jobs',
   'Background queue state. Service-role only: exposing claim/attempt state to a client serves no purpose and inviting client writes would let a caller replay or starve a job.'),
  ('rate_limits',
   'Limiter counters (ARCHITECTURE §6.4). A client that could read its own counter learns exactly when to resume; one that could write it is not rate limited at all.');
