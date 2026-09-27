-- =============================================================================
-- ROLLBACK for migrations 0011–0014 — operator script, NOT a migration
-- =============================================================================
-- Generated from the verbatim 0010 definitions (do not hand-edit the function
-- bodies below; regenerate instead). Tested by tests/migration-safety.test.ts,
-- which asserts the schema after this script equals a fresh 0001–0010 build.
--
-- ORDER OF OPERATIONS
--   1. Stop the scheduler (supabase/ops/p5_schedule.sql's cron job) or confirm
--      EMAIL_SENDING_MODE=disabled, so no worker runs during the rollback.
--   2. Deploy the application version from BEFORE these migrations. The newer
--      code calls the 4-argument sending_claim_jobs / sending_reserve_budget,
--      which this script removes.
--   3. If migration 0015 is applied, run rollback_0015.sql first: its
--      constraint uses app.is_canonical_email(), which this script drops.
--   4. Run this file in ONE transaction (it opens and commits its own).
--
-- WHAT IS LOST
--   campaigns.approved_send_mode and workspace_settings.postal_address are
--   dropped with their data. Re-applying 0012 leaves every scheduled campaign
--   unapproved (held until rescheduled), which is the safe state; the postal
--   address must be re-entered under Settings.
--
-- WHAT IS NOT LOST
--   No contact, suppression, list, template, campaign, job or attempt row is
--   touched. Dropping the 0011 constraints only relaxes a check.
-- =============================================================================

begin;

-- ── 0014 ─────────────────────────────────────────────────────────────────────
alter table workspace_settings drop column if exists postal_address;

-- ── 0013 ─────────────────────────────────────────────────────────────────────
drop function if exists public.sending_refund_budget(uuid, integer);
drop function if exists public.sending_reserve_budget(uuid, integer, integer, integer);
drop function if exists public.sending_claim_jobs(uuid, uuid, integer, integer);
drop index if exists ix_email_jobs_recent_contact;

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

revoke all on function public.sending_reserve_budget(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.sending_reserve_budget(uuid, integer, integer) to service_role;
revoke all on function public.sending_claim_jobs(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.sending_claim_jobs(uuid, uuid, integer) to service_role;

-- ── 0012 ─────────────────────────────────────────────────────────────────────
-- The trigger function is restored before the column goes, so no statement ever
-- runs the 0012 guard against a table without the column.
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

alter table campaigns drop column if exists approved_send_mode;

-- ── 0011 ─────────────────────────────────────────────────────────────────────
alter table contacts drop constraint if exists ck_contacts_email_canonical;
alter table suppressions drop constraint if exists ck_suppressions_email_canonical;
drop function if exists app.is_canonical_email(text);

-- ── The runner's record ──────────────────────────────────────────────────────
do $rollback$
begin
  if to_regclass('public.schema_migrations') is not null then
    delete from public.schema_migrations
     where filename in (
       '0011_canonical_email.sql',
       '0012_send_approval.sql',
       '0013_send_limits.sql',
       '0014_postal_address.sql'
     );
  end if;
end;
$rollback$;

commit;
