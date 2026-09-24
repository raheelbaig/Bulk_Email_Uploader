-- =============================================================================
-- 0010 — P5: the sending engine
-- =============================================================================
-- The first migration that lets a campaign move toward delivery. Read this header
-- before the DDL: the design is ADR-0001 (send idempotency) and ADR-0002
-- (availability and recovery), and this file is where both become constraints
-- rather than prose.
--
-- What is added:
--
--   email_jobs      one row per recipient per campaign. It is the recipient
--                   list, the frozen personalization snapshot, the delivery state
--                   machine, and the queue. Not pgmq, for the same reason
--                   import_jobs is not (migration 0006): the WASM database the
--                   test suite runs against cannot load it, and a conditional
--                   UPDATE gives the same correctness argument.
--   send_attempts   ADR-0001's durable record of intent, committed BEFORE the
--                   provider is called, so every crash is classifiable.
--   rate_ledger     the per-minute send budget (ARCHITECTURE §18.3). Windows do
--                   not accrue (ADR-0002 §5.3): an idle hour banks nothing.
--
-- The guarantees, and where each one lives:
--
--   G1  A recipient appears at most once per campaign.
--         UNIQUE (campaign_id, contact_id) and UNIQUE (campaign_id, to_email).
--   G2  At most one provider acceptance per job, ever.
--         Partial unique index uq_attempts_one_accepted.
--   G3  At most one attempt in flight per job.
--         Partial unique index uq_attempts_one_open, plus a trigger that refuses
--         a new attempt while one is open or accepted.
--   G4  An unknown outcome is never retried automatically (fail closed).
--         The reaper reclaims only claims with no open or accepted attempt; the
--         reconciler moves stale open attempts to `unknown` and their job to
--         `send_uncertain`, which nothing leaves without a human decision or the
--         audited `redispatch` policy.
--   G5  A suppressed or inactive recipient is not claimed.
--         The eligibility predicate is inside the claim; a trigger also moves
--         pending jobs out of the claimable set the moment a suppression lands.
--   G6  Nothing retries forever. attempts is capped at 5 by a CHECK.
--   G7  Every job and campaign transition is guarded, for every role.
--
-- Every function that changes sending state is callable by service_role only.
-- A browser session can read delivery state for its own workspace and change
-- none of it.
-- =============================================================================

-- =============================================================================
-- Types
-- =============================================================================

-- ARCHITECTURE §7.4, plus ADR-0001's `send_uncertain` and one addition:
-- `skipped` — the contact became inactive, was deleted, or changed address
-- between launch and send. Distinct from `suppressed` so the report can say
-- which, but counted together in campaigns.n_suppressed ("not contacted").
-- `delivered`, `bounced` and `complained` arrive with P6's event pipeline; they
-- are declared now so that P6 adds transitions, not an enum migration.
create type job_status as enum (
  'pending',
  'claimed',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'suppressed',
  'skipped',
  'cancelled',
  'send_uncertain'
);

create type attempt_state as enum ('dispatched', 'accepted', 'rejected', 'unknown');

-- =============================================================================
-- campaigns — launch stamp and execution mode
-- =============================================================================

-- Target for the composite foreign key from email_jobs, so a job cannot point at
-- another workspace's campaign.
alter table campaigns
  add constraint uq_campaigns_ws_id unique (workspace_id, id);

-- Whether this campaign's messages go to the provider or to the dry-run sink.
-- Stamped once, at launch, in the same statement as `launched_at`. A campaign
-- launched as a dry run stays a dry run: switching the deployment to live mode
-- later must not turn a rehearsal into a real send half way through.
alter table campaigns
  add column execution_mode text
    check (execution_mode is null or execution_mode in ('dry_run', 'live'));

alter table campaigns
  add constraint ck_campaigns_launch_stamped
    check ((launched_at is null) = (execution_mode is null));

-- Past `scheduled`, a campaign has launched. `paused` and `failed` may or may not
-- have (a missed schedule pauses a campaign that never started), so they are not
-- listed.
alter table campaigns
  add constraint ck_campaigns_launched
    check (status not in ('queued', 'sending', 'completed') or launched_at is not null);

-- =============================================================================
-- The campaign state machine, extended
-- =============================================================================
-- Migration 0009 said P5 must edit this function to add a transition toward
-- delivery. These are the transitions, and the only ones:
--
--   scheduled → queued     the worker, when the time arrives and preflight re-runs clean
--   scheduled → paused     the worker, when the time was missed by more than the
--                          grace window (ADR-0002 §5.1) or the re-run preflight fails
--   queued    → sending    the worker, in the statement that materialises the jobs
--   queued    → failed     materialisation could not proceed
--   sending   → completed  no job remains pending, claimed or uncertain
--   sending   → failed     likewise, and not one message was accepted
--   sending   → paused     a person, a provider halt, or a sender that stopped being ready
--   paused    → sending    a person resumes (launched campaigns only — trigger)
--   paused    → draft      a person unschedules (never-launched campaigns only — trigger)
--   queued | sending | paused → cancelled
-- =============================================================================
create or replace function app.campaign_transition_allowed(
  old_status campaign_status,
  new_status campaign_status
)
returns boolean
language sql
immutable
as $fn$
  select case old_status
    when 'draft'      then new_status in ('validating', 'cancelled')
    when 'validating' then new_status in ('scheduled', 'draft', 'cancelled')
    when 'scheduled'  then new_status in ('draft', 'cancelled', 'queued', 'paused')
    when 'queued'     then new_status in ('sending', 'failed', 'cancelled')
    when 'sending'    then new_status in ('completed', 'failed', 'paused', 'cancelled')
    when 'paused'     then new_status in ('sending', 'draft', 'cancelled')
    else false
  end
$fn$;

comment on function app.campaign_transition_allowed(campaign_status, campaign_status) is
  'The complete campaign state machine (0009, extended by 0010). completed, cancelled and failed are terminal.';

create or replace function app.guard_campaign_write()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a campaign may only be created in the draft state'
        using errcode = 'check_violation';
    end if;
    if new.launched_at is not null or new.execution_mode is not null then
      raise exception 'a campaign cannot be created already launched'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'a campaign cannot move between workspaces'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status
     and not app.campaign_transition_allowed(old.status, new.status) then
    raise exception 'campaign transition % to % is not permitted', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- The launch stamp is written once. Un-launching a campaign would let it be
  -- launched again, and a second launch of the same campaign is a second send.
  if old.launched_at is not null
     and (new.launched_at is distinct from old.launched_at
          or new.execution_mode is distinct from old.execution_mode) then
    raise exception 'the launch stamp of a campaign cannot be changed'
      using errcode = 'check_violation';
  end if;
  if old.launched_at is null and new.launched_at is not null
     and not (old.status = 'scheduled' and new.status = 'queued') then
    raise exception 'a campaign is launched only by the scheduled → queued transition'
      using errcode = 'check_violation';
  end if;

  -- paused has two meanings, and the launch stamp tells them apart.
  if old.status = 'paused' and new.status = 'draft' and old.launched_at is not null then
    raise exception 'a campaign that has started sending cannot return to draft'
      using errcode = 'check_violation';
  end if;
  if old.status = 'paused' and new.status = 'sending' and old.launched_at is null then
    raise exception 'a campaign that never started cannot be resumed; unschedule and schedule it again'
      using errcode = 'check_violation';
  end if;

  -- A pause reason describes a pause, and nothing else.
  if new.status is distinct from old.status and new.status <> 'paused' then
    new.pause_reason := null;
  end if;

  -- 0009 guarantee 4, unchanged.
  if new.template_snapshot is distinct from old.template_snapshot
     and old.status not in ('draft', 'validating')
     and new.status not in ('draft', 'validating') then
    raise exception 'the template snapshot of a % campaign cannot be changed', old.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

-- A campaign with delivery history is history. Only a campaign that never
-- launched may be deleted, whatever its status.
drop policy campaigns_delete on campaigns;
create policy campaigns_delete on campaigns
  for delete to authenticated
  using (
    workspace_id in (select app.current_workspace_ids())
    and status in ('draft', 'cancelled')
    and launched_at is null
  );

-- =============================================================================
-- email_jobs
-- =============================================================================
create table email_jobs (
  id                  uuid not null default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  campaign_id         uuid not null,
  -- Nullable: deleting a contact must not erase the record that they were sent
  -- something. The claim treats a null contact as "no longer in the audience".
  contact_id          uuid,
  -- Frozen at launch (ARCHITECTURE §7.2). The worker never joins to contacts
  -- to find out whom to address.
  to_email            text not null check (length(to_email) between 3 and 254),
  merge_data          jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(merge_data) = 'object')
                        check (pg_column_size(merge_data) < 65536),
  status              job_status not null default 'pending',
  -- G6. A bug that tries to write a sixth attempt raises instead of looping.
  attempts            smallint not null default 0 check (attempts between 0 and 5),
  next_attempt_at     timestamptz not null default now(),
  claimed_at          timestamptz,
  sent_at             timestamptz,
  provider_message_id text check (provider_message_id is null or length(provider_message_id) between 1 and 256),
  last_error_class    text check (last_error_class is null
                                  or last_error_class in ('transient', 'permanent', 'halt', 'uncertain', 'ineligible', 'render')),
  last_error_code     text check (last_error_code is null or length(last_error_code) <= 100),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz,

  primary key (id),
  constraint uq_email_jobs_ws_id unique (workspace_id, id),

  -- G1, twice. The contact key makes launch idempotent; the address key means
  -- that even two contacts that somehow share an address get one message.
  constraint uq_email_jobs_campaign_contact unique (campaign_id, contact_id),
  constraint uq_email_jobs_campaign_email   unique (campaign_id, to_email),

  -- NO ACTION rather than CASCADE: a campaign with jobs cannot be deleted out
  -- from under its delivery history. (Deleting a workspace still removes both,
  -- because NO ACTION is checked at the end of the cascading statement.)
  constraint fk_email_jobs_campaign
    foreign key (workspace_id, campaign_id) references campaigns (workspace_id, id),

  constraint fk_email_jobs_contact
    foreign key (workspace_id, contact_id) references contacts (workspace_id, id)
    on delete set null (contact_id),

  constraint ck_email_jobs_claimed check (status <> 'claimed' or claimed_at is not null),
  constraint ck_email_jobs_sent_has_id check (
    status not in ('sent', 'delivered', 'bounced', 'complained') or provider_message_id is not null
  )
);

create trigger trg_email_jobs_touch
  before update on email_jobs
  for each row execute function app.touch_updated_at();

-- The claim's exact predicate.
create index ix_email_jobs_runnable
  on email_jobs (campaign_id, next_attempt_at, id) where status = 'pending';
-- The reaper's predicate.
create index ix_email_jobs_claimed
  on email_jobs (claimed_at) where status = 'claimed';
-- The suppression trigger's predicate.
create index ix_email_jobs_pending_email
  on email_jobs (workspace_id, to_email) where status = 'pending';
-- Completion checks and the delivery report.
create index ix_email_jobs_campaign_status on email_jobs (campaign_id, status);
-- P6 correlates provider events by message id.
create index ix_email_jobs_message
  on email_jobs (provider_message_id) where provider_message_id is not null;

comment on table email_jobs is
  'One row per recipient per campaign: recipient, frozen merge data, delivery state and queue position. Written only by service_role through the sending_* functions (0010).';

-- -----------------------------------------------------------------------------
-- The job state machine (G7)
-- -----------------------------------------------------------------------------
create or replace function app.job_transition_allowed(old_status job_status, new_status job_status)
returns boolean
language sql
immutable
as $fn$
  select case old_status
    when 'pending'        then new_status in ('claimed', 'suppressed', 'skipped', 'cancelled')
    -- claimed → pending: a retry after a known rejection, the reaper, or a claim
    -- released unattempted. The reaper's guard is what makes that safe (G4).
    when 'claimed'        then new_status in ('sent', 'pending', 'failed', 'send_uncertain', 'suppressed', 'skipped')
    -- Only a human decision, or the audited redispatch policy, leaves here.
    when 'send_uncertain' then new_status in ('pending', 'failed', 'sent', 'cancelled')
    -- P6 territory; declared so the machine is complete.
    when 'sent'           then new_status in ('delivered', 'bounced', 'complained')
    else false
  end
$fn$;

create or replace function app.guard_email_job_write()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.attempts <> 0 then
      raise exception 'an email job is created pending and unattempted'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- What a job *is* never changes after launch. Only what happened to it does.
  if new.workspace_id is distinct from old.workspace_id
     or new.campaign_id is distinct from old.campaign_id
     or new.to_email    is distinct from old.to_email
     or new.merge_data  is distinct from old.merge_data then
    raise exception 'an email job''s recipient and content are frozen'
      using errcode = 'check_violation';
  end if;

  -- A message id, once recorded, is a fact about the world.
  if old.provider_message_id is not null
     and new.provider_message_id is distinct from old.provider_message_id then
    raise exception 'a recorded provider message id cannot be changed'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status
     and not app.job_transition_allowed(old.status, new.status) then
    raise exception 'email job transition % to % is not permitted', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger trg_email_jobs_guard
  before insert or update on email_jobs
  for each row execute function app.guard_email_job_write();

-- =============================================================================
-- send_attempts — ADR-0001 §3.1
-- =============================================================================
create table send_attempts (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  job_id              uuid not null,
  attempt_no          smallint not null check (attempt_no between 1 and 5),
  -- Recorded per attempt as well as per campaign, so the audit trail of a single
  -- message says whether it was real without a join.
  mode                text not null check (mode in ('dry_run', 'live')),
  state               attempt_state not null default 'dispatched',
  dispatched_at       timestamptz not null default now(),
  resolved_at         timestamptz,
  provider_message_id text check (provider_message_id is null or length(provider_message_id) between 1 and 256),
  error_class         text check (error_class is null or error_class in ('transient', 'permanent', 'halt')),
  error_code          text check (error_code is null or length(error_code) <= 100),

  constraint uq_attempt unique (job_id, attempt_no),
  constraint fk_send_attempts_job
    foreign key (workspace_id, job_id) references email_jobs (workspace_id, id) on delete cascade,
  constraint ck_attempt_accepted_has_id check (state <> 'accepted' or provider_message_id is not null),
  constraint ck_attempt_resolved check ((state = 'dispatched') = (resolved_at is null))
);

-- G2 and G3, as indexes: no code path can talk its way past a unique index.
create unique index uq_attempts_one_accepted on send_attempts (job_id) where state = 'accepted';
create unique index uq_attempts_one_open     on send_attempts (job_id) where state = 'dispatched';
-- The reconciler's predicate.
create index ix_attempts_open on send_attempts (dispatched_at) where state = 'dispatched';

comment on table send_attempts is
  'ADR-0001: one row per provider call, committed before the call. dispatched = outcome not yet known.';

create or replace function app.guard_send_attempt_write()
returns trigger
language plpgsql
as $fn$
declare
  v_status job_status;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'dispatched' then
      raise exception 'an attempt is recorded before its outcome is known'
        using errcode = 'check_violation';
    end if;

    select status into v_status from email_jobs where id = new.job_id;
    if v_status is distinct from 'claimed' then
      raise exception 'an attempt may only be made for a claimed job'
        using errcode = 'check_violation';
    end if;

    -- G3, and the heart of G4: while any attempt is open or accepted, no further
    -- attempt may exist. An `unknown` attempt does not block — a job only gets
    -- past `send_uncertain` by a recorded human decision or the audited policy.
    if exists (
      select 1 from send_attempts a
       where a.job_id = new.job_id and a.state in ('dispatched', 'accepted')
    ) then
      raise exception 'job % already has an open or accepted attempt', new.job_id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.job_id is distinct from old.job_id
     or new.workspace_id is distinct from old.workspace_id
     or new.attempt_no is distinct from old.attempt_no
     or new.mode is distinct from old.mode
     or new.dispatched_at is distinct from old.dispatched_at then
    raise exception 'an attempt''s identity is immutable'
      using errcode = 'check_violation';
  end if;

  if new.state is distinct from old.state and not (
       (old.state = 'dispatched' and new.state in ('accepted', 'rejected', 'unknown'))
       -- A provider event may still confirm an attempt the reconciler gave up on (P6).
    or (old.state = 'unknown' and new.state = 'accepted')
  ) then
    raise exception 'attempt transition % to % is not permitted', old.state, new.state
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger trg_send_attempts_guard
  before insert or update on send_attempts
  for each row execute function app.guard_send_attempt_write();

-- =============================================================================
-- rate_ledger — ARCHITECTURE §18.3, ADR-0002 §5.3
-- =============================================================================
create table rate_ledger (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  window_start timestamptz not null,
  reserved     integer not null default 0 check (reserved >= 0),
  primary key (workspace_id, window_start)
);

-- =============================================================================
-- Suppression cancels pending jobs — ARCHITECTURE §9.2, defence 2
-- =============================================================================
-- SECURITY DEFINER: a person adding a suppression by hand holds no privilege on
-- email_jobs or the campaign counters, and must not be refused for it.
create or replace function app.suppress_pending_jobs()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  with moved as (
    update email_jobs
       set status = 'suppressed',
           last_error_class = 'ineligible',
           last_error_code = 'suppressed'
     where workspace_id = new.workspace_id
       and to_email     = new.email_normalized
       and status       = 'pending'
    returning campaign_id
  ), per_campaign as (
    select campaign_id, count(*)::int as n from moved group by campaign_id
  )
  update campaigns c
     set n_suppressed = c.n_suppressed + p.n
    from per_campaign p
   where c.id = p.campaign_id;
  return new;
end;
$fn$;

create trigger trg_suppressions_cancel_jobs
  after insert on suppressions
  for each row execute function app.suppress_pending_jobs();

-- =============================================================================
-- Cancelling a campaign cancels what has not been sent
-- =============================================================================
create or replace function app.cancel_campaign_jobs()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update email_jobs
       set status = 'cancelled'
     where campaign_id = new.id
       and workspace_id = new.workspace_id
       and status in ('pending', 'send_uncertain');
  end if;
  return new;
end;
$fn$;

create trigger trg_campaigns_cancel_jobs
  after update of status on campaigns
  for each row execute function app.cancel_campaign_jobs();

-- =============================================================================
-- Worker functions
-- =============================================================================
-- Each is one transaction, which is the point: the worker talks to PostgREST,
-- which cannot hold a transaction across calls. Every multi-row state change is
-- therefore one function call, and every function re-checks the state it
-- expects rather than trusting the caller's view of it.
--
-- SECURITY INVOKER throughout, EXECUTE granted to service_role only.
-- =============================================================================

-- ADR-0002 §5.1: a campaign whose time passed more than the grace window ago is
-- held, never launched.
create or replace function public.sending_hold_missed_campaigns(p_grace_minutes integer)
returns table (workspace_id uuid, campaign_id uuid, scheduled_at timestamptz)
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  update campaigns c
     set status = 'paused', pause_reason = 'missed_schedule'
   where c.status = 'scheduled'
     and c.scheduled_at <= now() - make_interval(mins => greatest(1, p_grace_minutes))
  returning c.workspace_id, c.id, c.scheduled_at
$fn$;

create or replace function public.sending_due_campaigns(p_grace_minutes integer, p_limit integer)
returns table (workspace_id uuid, campaign_id uuid)
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select c.workspace_id, c.id
    from campaigns c
   where c.status = 'scheduled'
     and c.scheduled_at <= now()
     and c.scheduled_at >  now() - make_interval(mins => greatest(1, p_grace_minutes))
   order by c.scheduled_at, c.id
   limit greatest(0, least(p_limit, 100))
$fn$;

create or replace function public.sending_active_campaigns(p_limit integer)
returns table (workspace_id uuid, campaign_id uuid, status text, execution_mode text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select c.workspace_id, c.id, c.status::text, c.execution_mode
    from campaigns c
   where c.status in ('queued', 'sending')
   order by c.launched_at, c.id
   limit greatest(0, least(p_limit, 100))
$fn$;

-- scheduled → queued. Stamps the launch, once. Refuses a campaign that is not
-- due yet, whatever the caller believes.
create or replace function public.sending_promote_campaign(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_mode text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if p_mode not in ('dry_run', 'live') then
    raise exception 'unknown execution mode %', p_mode using errcode = 'check_violation';
  end if;

  update campaigns
     set status = 'queued', launched_at = now(), execution_mode = p_mode
   where workspace_id = p_workspace_id
     and id = p_campaign_id
     and status = 'scheduled'
     and scheduled_at <= now();
  return found;
end;
$fn$;

create or replace function public.sending_pause_campaign(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_from text[],
  p_reason text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  update campaigns
     set status = 'paused', pause_reason = left(p_reason, 500)
   where workspace_id = p_workspace_id
     and id = p_campaign_id
     and status::text = any(p_from);
  return found;
end;
$fn$;

-- queued → sending, creating the jobs in the same transaction.
--
-- The recipient predicate is the SQL form of the eligibility authority
-- (lib/eligibility, `decide`): not suppressed, and an active contact. It is the
-- same expression as public.campaign_audience_counts (0009), so the number the
-- preflight showed and the rows created here come from one rule.
--
-- ON CONFLICT DO NOTHING makes this idempotent (ADR-0002 §8.3): a retry after a
-- crash produces the same job set, never a second one.
create or replace function public.sending_materialize_campaign(
  p_workspace_id uuid,
  p_campaign_id uuid
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_list_id uuid;
  v_total   integer;
begin
  select c.list_id into v_list_id
    from campaigns c
   where c.workspace_id = p_workspace_id and c.id = p_campaign_id and c.status = 'queued'
   for update;
  if not found then
    return null;
  end if;

  insert into email_jobs (workspace_id, campaign_id, contact_id, to_email, merge_data)
  select ct.workspace_id,
         p_campaign_id,
         ct.id,
         ct.email_normalized,
         jsonb_build_object(
           'first_name', ct.first_name,
           'last_name',  ct.last_name,
           'company',    ct.company,
           'website',    ct.website,
           'phone',      ct.phone,
           'custom',     coalesce(ct.custom, '{}'::jsonb)
         )
    from list_members lm
    join contacts ct
      on ct.workspace_id = lm.workspace_id
     and ct.id = lm.contact_id
   where lm.workspace_id = p_workspace_id
     and lm.list_id = v_list_id
     and ct.status = 'active'
     and not exists (
       select 1 from suppressions s
        where s.workspace_id = ct.workspace_id
          and s.email_normalized = ct.email_normalized
     )
  on conflict do nothing;

  select count(*)::int into v_total from email_jobs where campaign_id = p_campaign_id;

  update campaigns
     set status = 'sending', n_total = v_total
   where workspace_id = p_workspace_id and id = p_campaign_id and status = 'queued';

  return v_total;
end;
$fn$;

-- Atomic budget reservation. The row lock serialises concurrent ticks, so two
-- overlapping workers cannot jointly exceed the per-minute limit.
create or replace function public.sending_reserve_budget(
  p_workspace_id uuid,
  p_per_minute integer,
  p_requested integer
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_window   timestamptz := date_trunc('minute', now());
  v_reserved integer;
  v_granted  integer;
begin
  insert into rate_ledger (workspace_id, window_start, reserved)
  values (p_workspace_id, v_window, 0)
  on conflict do nothing;

  select reserved into v_reserved
    from rate_ledger
   where workspace_id = p_workspace_id and window_start = v_window
   for update;

  v_granted := greatest(0, least(p_requested, p_per_minute - v_reserved));

  if v_granted > 0 then
    update rate_ledger
       set reserved = reserved + v_granted
     where workspace_id = p_workspace_id and window_start = v_window;
  end if;

  return v_granted;
end;
$fn$;

-- The atomic claim — ARCHITECTURE §8.1, G5.
--
-- Candidates are locked with SKIP LOCKED so two overlapping ticks take disjoint
-- batches instead of queueing behind each other; the conditional UPDATE is still
-- what guarantees correctness. Ineligible candidates are moved out with a
-- reason; the rest are claimed. Nothing is claimed for a campaign that is not
-- `sending` — a pause takes effect at the next claim.
create or replace function public.sending_claim_jobs(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_limit integer
)
returns table (
  id uuid,
  contact_id uuid,
  to_email text,
  merge_data jsonb,
  attempts smallint
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_ids     uuid[];
  v_dropped integer;
begin
  perform 1 from campaigns c
   where c.workspace_id = p_workspace_id and c.id = p_campaign_id and c.status = 'sending';
  if not found or coalesce(p_limit, 0) <= 0 then
    return;
  end if;

  select array_agg(candidate.id) into v_ids
    from (
      select j.id
        from email_jobs j
       where j.workspace_id = p_workspace_id
         and j.campaign_id = p_campaign_id
         and j.status = 'pending'
         and j.next_attempt_at <= now()
       order by j.next_attempt_at, j.id
       limit least(p_limit, 500)
       for update skip locked
    ) candidate;

  if v_ids is null then
    return;
  end if;

  update email_jobs j
     set status = case
                    when exists (select 1 from suppressions s
                                  where s.workspace_id = j.workspace_id
                                    and s.email_normalized = j.to_email)
                    then 'suppressed'::job_status
                    else 'skipped'::job_status
                  end,
         last_error_class = 'ineligible',
         last_error_code = case
                             when exists (select 1 from suppressions s
                                           where s.workspace_id = j.workspace_id
                                             and s.email_normalized = j.to_email)
                             then 'suppressed'
                             else 'contact_inactive'
                           end
   where j.id = any(v_ids)
     and j.status = 'pending'
     and (
       exists (select 1 from suppressions s
                where s.workspace_id = j.workspace_id
                  and s.email_normalized = j.to_email)
       or not exists (select 1 from contacts c
                       where c.workspace_id = j.workspace_id
                         and c.id = j.contact_id
                         and c.status = 'active'
                         and c.email_normalized = j.to_email)
     );
  get diagnostics v_dropped = row_count;

  -- Qualified throughout: `id` is also this function's output column, and an
  -- unqualified reference is ambiguous inside PL/pgSQL.
  if v_dropped > 0 then
    update campaigns c
       set n_suppressed = c.n_suppressed + v_dropped
     where c.workspace_id = p_workspace_id and c.id = p_campaign_id;
  end if;

  return query
    update email_jobs j
       set status = 'claimed',
           claimed_at = now(),
           attempts = j.attempts + 1
     where j.id = any(v_ids)
       and j.status = 'pending'
    returning j.id, j.contact_id, j.to_email, j.merge_data, j.attempts;
end;
$fn$;

-- Hands back a claim that was never attempted: the tick ran out of time, the
-- message could not be composed, or the eligibility authority said no at the
-- last moment. Refused if an attempt is open or accepted — that job's outcome
-- belongs to the attempt, not to this function.
create or replace function public.sending_release_job(
  p_workspace_id uuid,
  p_job_id uuid,
  p_outcome text,
  p_code text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_campaign uuid;
begin
  if p_outcome not in ('pending', 'suppressed', 'skipped', 'failed') then
    raise exception 'unknown release outcome %', p_outcome using errcode = 'check_violation';
  end if;

  update email_jobs j
     set status = p_outcome::job_status,
         -- No attempt row carries this number, so giving it back keeps
         -- (job_id, attempt_no) dense and the cap honest.
         attempts = case when p_outcome = 'pending' then j.attempts - 1 else j.attempts end,
         claimed_at = null,
         next_attempt_at = case when p_outcome = 'pending' then now() else j.next_attempt_at end,
         last_error_class = case p_outcome
                              when 'pending' then j.last_error_class
                              when 'failed'  then 'render'
                              else 'ineligible'
                            end,
         last_error_code = case when p_outcome = 'pending' then j.last_error_code else left(p_code, 100) end
   where j.workspace_id = p_workspace_id
     and j.id = p_job_id
     and j.status = 'claimed'
     and not exists (
       select 1 from send_attempts a
        where a.job_id = j.id
          and (a.state in ('dispatched', 'accepted') or a.attempt_no = j.attempts)
     )
  returning j.campaign_id into v_campaign;

  if v_campaign is null then
    return false;
  end if;

  if p_outcome in ('suppressed', 'skipped') then
    update campaigns set n_suppressed = n_suppressed + 1 where id = v_campaign;
  elsif p_outcome = 'failed' then
    update campaigns set n_failed = n_failed + 1 where id = v_campaign;
  end if;
  return true;
end;
$fn$;

-- ADR-0001 §3.1 step 2: the record of intent, committed before the call.
-- attempt_no is the claim's own attempt count, so it is the number the message
-- tags carry and the number any later provider event will quote back.
create or replace function public.sending_begin_attempt(
  p_workspace_id uuid,
  p_job_id uuid,
  p_mode text
)
returns table (attempt_id uuid, attempt_no smallint)
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  insert into send_attempts (workspace_id, job_id, attempt_no, mode)
  select j.workspace_id, j.id, j.attempts, p_mode
    from email_jobs j
   where j.workspace_id = p_workspace_id
     and j.id = p_job_id
     and j.status = 'claimed'
  returning id, attempt_no
$fn$;

create or replace function public.sending_record_accepted(
  p_workspace_id uuid,
  p_attempt_id uuid,
  p_message_id text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_job uuid;
  v_campaign uuid;
begin
  update send_attempts
     set state = 'accepted', provider_message_id = p_message_id, resolved_at = now()
   where workspace_id = p_workspace_id
     and id = p_attempt_id
     and state in ('dispatched', 'unknown')
  returning job_id into v_job;

  if v_job is null then
    return false;
  end if;

  update email_jobs
     set status = 'sent',
         sent_at = now(),
         provider_message_id = p_message_id,
         claimed_at = case when status = 'claimed' then claimed_at else null end,
         last_error_class = null,
         last_error_code = null
   where id = v_job
     and status in ('claimed', 'send_uncertain')
  returning campaign_id into v_campaign;

  -- The counter moves only with the job, so a repeated call moves it once.
  if v_campaign is not null then
    update campaigns set n_sent = n_sent + 1 where id = v_campaign;
  end if;
  return true;
end;
$fn$;

-- A known rejection: the provider answered, and the answer was no. Only this
-- path may return a job to the queue after an attempt (G4).
create or replace function public.sending_record_rejected(
  p_workspace_id uuid,
  p_attempt_id uuid,
  p_class text,
  p_code text,
  p_retry_at timestamptz
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_job      uuid;
  v_attempts smallint;
  v_campaign uuid;
begin
  if p_class not in ('transient', 'permanent', 'halt') then
    raise exception 'unknown failure class %', p_class using errcode = 'check_violation';
  end if;

  update send_attempts
     set state = 'rejected', error_class = p_class, error_code = left(p_code, 100), resolved_at = now()
   where workspace_id = p_workspace_id
     and id = p_attempt_id
     and state = 'dispatched'
  returning job_id into v_job;

  if v_job is null then
    return null;
  end if;

  select j.attempts, j.campaign_id into v_attempts, v_campaign
    from email_jobs j
   where j.id = v_job and j.status = 'claimed'
   for update;
  if not found then
    return null;
  end if;

  if p_class in ('transient', 'halt') and v_attempts < 5 and p_retry_at is not null then
    update email_jobs
       set status = 'pending',
           claimed_at = null,
           next_attempt_at = p_retry_at,
           last_error_class = p_class,
           last_error_code = left(p_code, 100)
     where id = v_job;
    return 'pending';
  end if;

  update email_jobs
     set status = 'failed',
         claimed_at = null,
         last_error_class = case when p_class = 'halt' then 'halt' else p_class end,
         last_error_code = left(p_code, 100)
   where id = v_job;
  update campaigns set n_failed = n_failed + 1 where id = v_campaign;
  return 'failed';
end;
$fn$;

-- ADR-0001 §3.3: reclaim ONLY jobs that provably never reached the provider.
-- The guard is the existence of an attempt record, not the nullness of a column.
create or replace function public.sending_reap_claimed(p_timeout_minutes integer)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_count integer;
begin
  update email_jobs j
     set status = 'pending',
         claimed_at = null,
         attempts = j.attempts - 1,
         next_attempt_at = now()
   where j.status = 'claimed'
     and j.claimed_at < now() - make_interval(mins => greatest(1, p_timeout_minutes))
     and not exists (
       select 1 from send_attempts a
        where a.job_id = j.id
          and (a.state in ('dispatched', 'accepted') or a.attempt_no = j.attempts)
     );
  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ADR-0001 §3.4: an attempt still open after the grace window becomes `unknown`,
-- and its job `send_uncertain`. With policy `redispatch` (audited by the caller)
-- uncertain jobs with attempts to spare go back to the queue; the default,
-- `hold`, leaves them for a person.
create or replace function public.sending_reconcile_attempts(
  p_grace_minutes integer,
  p_policy text
)
returns table (workspace_id uuid, uncertain integer, redispatched integer)
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  with stale as (
    update send_attempts a
       set state = 'unknown', resolved_at = now()
     where a.state = 'dispatched'
       and a.dispatched_at < now() - make_interval(mins => greatest(10, p_grace_minutes))
    returning a.job_id
  ), moved as (
    update email_jobs j
       set status = 'send_uncertain',
           claimed_at = null,
           last_error_class = 'uncertain',
           last_error_code = 'outcome_unknown'
      from stale
     where j.id = stale.job_id
       and j.status = 'claimed'
    returning j.workspace_id
  ), redispatched as (
    -- Only under the explicit `redispatch` policy, and only jobs that were
    -- already uncertain before this call: all CTEs share one snapshot, so a job
    -- made uncertain above is redispatched no sooner than the next tick.
    update email_jobs j
       set status = 'pending', next_attempt_at = now()
     where p_policy = 'redispatch'
       and j.status = 'send_uncertain'
       and j.attempts < 5
    returning j.workspace_id
  ), per_workspace as (
    select m.workspace_id, 1 as u, 0 as r from moved m
    union all
    select d.workspace_id, 0, 1 from redispatched d
  )
  select p.workspace_id, sum(p.u)::int, sum(p.r)::int
    from per_workspace p
   group by p.workspace_id
$fn$;

-- A person's decision about one uncertain job. `redispatch` accepts the risk of a
-- duplicate and is audited by the caller; `leave` records the job as failed.
create or replace function public.sending_resolve_uncertain(
  p_workspace_id uuid,
  p_job_id uuid,
  p_decision text
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_campaign uuid;
begin
  if p_decision = 'redispatch' then
    update email_jobs
       set status = 'pending', next_attempt_at = now()
     where workspace_id = p_workspace_id and id = p_job_id
       and status = 'send_uncertain' and attempts < 5
    returning campaign_id into v_campaign;
    return case when v_campaign is null then null else 'pending' end;
  elsif p_decision = 'leave' then
    update email_jobs
       set status = 'failed', last_error_code = 'uncertain_left'
     where workspace_id = p_workspace_id and id = p_job_id and status = 'send_uncertain'
    returning campaign_id into v_campaign;
    if v_campaign is null then
      return null;
    end if;
    update campaigns set n_failed = n_failed + 1 where id = v_campaign;
    return 'failed';
  end if;
  raise exception 'unknown decision %', p_decision using errcode = 'check_violation';
end;
$fn$;

-- ARCHITECTURE §14.3 `halt`: the provider says the account cannot send. Every
-- sending campaign in the workspace stops, rather than each one discovering it
-- a message at a time.
create or replace function public.sending_pause_workspace(p_workspace_id uuid, p_reason text)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_count integer;
begin
  update campaigns
     set status = 'paused', pause_reason = left(p_reason, 500)
   where workspace_id = p_workspace_id and status = 'sending';
  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ARCHITECTURE §14.5, amended: an uncertain job holds completion open, because
-- it is waiting for a decision. `failed` means not one message was accepted and
-- at least one failed; anything else that finishes is `completed`, and the UI
-- shows the breakdown rather than a bare success claim.
create or replace function public.sending_finish_campaign(p_workspace_id uuid, p_campaign_id uuid)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_sent   integer;
  v_failed integer;
  v_status campaign_status;
begin
  select c.n_sent, c.n_failed into v_sent, v_failed
    from campaigns c
   where c.workspace_id = p_workspace_id and c.id = p_campaign_id and c.status = 'sending'
   for update;
  if not found then
    return null;
  end if;

  if exists (
    select 1 from email_jobs j
     where j.campaign_id = p_campaign_id
       and j.status in ('pending', 'claimed', 'send_uncertain')
  ) then
    return null;
  end if;

  v_status := case when v_sent = 0 and v_failed > 0 then 'failed' else 'completed' end;
  update campaigns
     set status = v_status, completed_at = now()
   where workspace_id = p_workspace_id and id = p_campaign_id;
  return v_status::text;
end;
$fn$;

-- The unsubscribe link's write. Keyed by job so it keeps working after the
-- contact is deleted: the address was frozen onto the job at launch. The
-- suppression is idempotent (ARCHITECTURE §10.2); the counter moves only when a
-- suppression was actually created.
create or replace function public.sending_record_unsubscribe(p_workspace_id uuid, p_job_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_email    text;
  v_campaign uuid;
  v_created  uuid;
begin
  select j.to_email, j.campaign_id into v_email, v_campaign
    from email_jobs j
   where j.workspace_id = p_workspace_id and j.id = p_job_id;
  if not found then
    return null;
  end if;

  insert into suppressions (workspace_id, email_normalized, reason, source, campaign_id)
  values (p_workspace_id, v_email, 'unsubscribe', 'unsubscribe_link', v_campaign)
  on conflict (workspace_id, email_normalized) do nothing
  returning id into v_created;

  if v_created is not null then
    update campaigns set n_unsubscribed = n_unsubscribed + 1 where id = v_campaign;
    return true;
  end if;
  return false;
end;
$fn$;

-- Delivery report for the campaign page. SECURITY INVOKER, granted to
-- authenticated: RLS decides what the caller may count.
create or replace function public.campaign_delivery_counts(p_workspace_id uuid, p_campaign_id uuid)
returns table (status text, n bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select j.status::text, count(*)::bigint
    from email_jobs j
   where j.workspace_id = p_workspace_id and j.campaign_id = p_campaign_id
   group by j.status
$fn$;

-- -----------------------------------------------------------------------------
-- Function privileges
-- -----------------------------------------------------------------------------
do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sending_hold_missed_campaigns(integer)',
    'public.sending_due_campaigns(integer, integer)',
    'public.sending_active_campaigns(integer)',
    'public.sending_promote_campaign(uuid, uuid, text)',
    'public.sending_pause_campaign(uuid, uuid, text[], text)',
    'public.sending_materialize_campaign(uuid, uuid)',
    'public.sending_reserve_budget(uuid, integer, integer)',
    'public.sending_claim_jobs(uuid, uuid, integer)',
    'public.sending_release_job(uuid, uuid, text, text)',
    'public.sending_begin_attempt(uuid, uuid, text)',
    'public.sending_record_accepted(uuid, uuid, text)',
    'public.sending_record_rejected(uuid, uuid, text, text, timestamptz)',
    'public.sending_reap_claimed(integer)',
    'public.sending_reconcile_attempts(integer, text)',
    'public.sending_resolve_uncertain(uuid, uuid, text)',
    'public.sending_pause_workspace(uuid, text)',
    'public.sending_finish_campaign(uuid, uuid)',
    'public.sending_record_unsubscribe(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$grants$;

revoke all on function public.campaign_delivery_counts(uuid, uuid) from public;
grant execute on function public.campaign_delivery_counts(uuid, uuid) to authenticated, service_role;

-- The trigger functions are not callable as functions by anyone who matters, but
-- a SECURITY DEFINER function is revoked from PUBLIC as a rule.
revoke all on function app.suppress_pending_jobs() from public;
revoke all on function app.cancel_campaign_jobs() from public;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table email_jobs    enable row level security;
alter table email_jobs    force  row level security;
alter table send_attempts enable row level security;
alter table send_attempts force  row level security;
alter table rate_ledger   enable row level security;
alter table rate_ledger   force  row level security;

revoke all on email_jobs    from anon, authenticated;
revoke all on send_attempts from anon, authenticated;
revoke all on rate_ledger   from anon, authenticated;

-- No DELETE for the service role on delivery history: retention (P7) will be a
-- reviewed function, not a privilege lying around for any code path to use.
grant select, insert, update on email_jobs    to service_role;
grant select, insert, update on send_attempts to service_role;
grant select, insert, update on rate_ledger   to service_role;

-- Read-only to members of the workspace. Every write is the worker's.
grant select on email_jobs    to authenticated;
grant select on send_attempts to authenticated;

create policy email_jobs_select on email_jobs
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy send_attempts_select on send_attempts
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

insert into app.rls_policy_exceptions (table_name, reason) values
  ('rate_ledger',
   'Send-budget counters (ARCHITECTURE §18.3). Service-role only: a client that could write its window is not rate limited, and one that could read it learns nothing it needs.');
