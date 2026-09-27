-- =============================================================================
-- 0013 — Daily send cap and per-contact cooldown
-- =============================================================================
-- Found by the second QA pass (2026-09-25).
--
-- 1. DAILY CAP. The only volume controls were a per-minute budget per workspace
--    (default 60/min, up to 3,000) and, in live mode, SES's own remaining daily
--    quota. A production SES account's quota is typically tens of thousands a
--    day, so the first live day could send ~86,000 messages from a domain with
--    no sending history — exactly the pattern mailbox providers treat as spam.
--    `sending_reserve_budget` now also enforces a per-workspace cap per UTC day,
--    passed by the worker from SEND_DAILY_CAP. Warm-up is done by raising that
--    cap on a schedule (see docs/adr/0004); the software's job is to make the
--    cap impossible to exceed, including by overlapping workers.
--
-- 2. CONTACT COOLDOWN. Nothing stopped two campaigns reaching the same person
--    minutes apart — two lists sharing contacts, or one campaign cloned and
--    scheduled twice. `sending_claim_jobs` now skips a recipient who was sent
--    to (or is being sent to) by another campaign of the same execution mode
--    within the cooldown window, passed by the worker from
--    CONTACT_COOLDOWN_HOURS. Dry runs count only against dry runs and live sends
--    only against live sends, so a rehearsal never blocks a real campaign.
--    A skipped recipient is `skipped` / `frequency_cap`: not contacted by this
--    campaign, and never retried by it.
--
-- Both functions take a per-workspace transaction-scoped advisory lock, so the
-- checks are exact under concurrent ticks: the daily sum cannot be raced across
-- a minute boundary, and two campaigns claiming the same address at the same
-- instant see each other's claim.
--
-- The new arguments have no defaults, deliberately: a caller that forgets them
-- fails loudly instead of silently sending without a cap. The 0010 signatures
-- are dropped so nothing can reach the uncapped versions.
-- =============================================================================

drop function public.sending_reserve_budget(uuid, integer, integer);

create function public.sending_reserve_budget(
  p_workspace_id uuid,
  p_per_minute integer,
  p_requested integer,
  p_daily_cap integer
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_window   timestamptz := date_trunc('minute', now());
  v_day      timestamptz := date_trunc('day', now(), 'UTC');
  v_reserved integer;
  v_today    integer;
  v_granted  integer;
begin
  if p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'a daily cap is required' using errcode = 'check_violation';
  end if;

  -- One budget decision per workspace at a time. The minute row's lock alone
  -- does not serialise two ticks in different minutes against the daily sum.
  perform pg_advisory_xact_lock(hashtextextended('send_budget:' || p_workspace_id::text, 0));

  insert into rate_ledger (workspace_id, window_start, reserved)
  values (p_workspace_id, v_window, 0)
  on conflict do nothing;

  select reserved into v_reserved
    from rate_ledger
   where workspace_id = p_workspace_id and window_start = v_window
   for update;

  select coalesce(sum(reserved), 0)::int into v_today
    from rate_ledger
   where workspace_id = p_workspace_id and window_start >= v_day;

  v_granted := greatest(0, least(p_requested, p_per_minute - v_reserved, p_daily_cap - v_today));

  if v_granted > 0 then
    update rate_ledger
       set reserved = reserved + v_granted
     where workspace_id = p_workspace_id and window_start = v_window;
  end if;

  return v_granted;
end;
$fn$;

-- Hands back reserved budget the claim did not use. The worker reserves before
-- it claims (so it never holds claims it has no budget for), and a campaign with
-- fewer pending jobs than the grant leaves the difference unused. Per minute
-- that was harmless; against a daily cap it would quietly spend the day's
-- allowance on nothing. The refund goes to the workspace's most recent window,
-- which is the one the reservation was taken from; it never goes below zero.
create function public.sending_refund_budget(p_workspace_id uuid, p_unused integer)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if coalesce(p_unused, 0) <= 0 then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('send_budget:' || p_workspace_id::text, 0));
  update rate_ledger r
     set reserved = greatest(0, r.reserved - p_unused)
   where r.workspace_id = p_workspace_id
     and r.window_start = (select max(l.window_start) from rate_ledger l where l.workspace_id = p_workspace_id);
end;
$fn$;

revoke all on function public.sending_refund_budget(uuid, integer) from public, anon, authenticated;
grant execute on function public.sending_refund_budget(uuid, integer) to service_role;

-- Serves the cooldown lookup: recent activity for one address in one workspace.
create index ix_email_jobs_recent_contact
  on email_jobs (workspace_id, to_email)
  where status in ('claimed', 'sent', 'delivered', 'bounced', 'complained', 'send_uncertain');

drop function public.sending_claim_jobs(uuid, uuid, integer);

create function public.sending_claim_jobs(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_limit integer,
  p_cooldown_minutes integer
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
  v_mode    text;
  v_dropped integer;
begin
  if p_cooldown_minutes is null or p_cooldown_minutes < 0 then
    raise exception 'a cooldown is required (0 disables it)' using errcode = 'check_violation';
  end if;

  select c.execution_mode into v_mode
    from campaigns c
   where c.workspace_id = p_workspace_id and c.id = p_campaign_id and c.status = 'sending';
  if not found or coalesce(p_limit, 0) <= 0 then
    return;
  end if;

  -- Claims in one workspace are serialised, so a claim made by another campaign
  -- a moment ago is committed and visible to the cooldown check below.
  perform pg_advisory_xact_lock(hashtextextended('send_claim:' || p_workspace_id::text, 0));

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

  -- Qualified throughout: `id` is also this function's output column, and an
  -- unqualified reference is ambiguous inside PL/pgSQL.
  with verdict as (
    select j.id as job_id,
           case
             when exists (select 1 from suppressions s
                           where s.workspace_id = j.workspace_id
                             and s.email_normalized = j.to_email)
               then 'suppressed'
             when not exists (select 1 from contacts ct
                               where ct.workspace_id = j.workspace_id
                                 and ct.id = j.contact_id
                                 and ct.status = 'active'
                                 and ct.email_normalized = j.to_email)
               then 'contact_inactive'
             when p_cooldown_minutes > 0 and exists (
                    select 1
                      from email_jobs o
                      join campaigns oc on oc.id = o.campaign_id
                     where o.workspace_id = j.workspace_id
                       and o.to_email = j.to_email
                       and o.campaign_id <> j.campaign_id
                       and oc.execution_mode = v_mode
                       and o.status in ('claimed', 'sent', 'delivered', 'bounced', 'complained', 'send_uncertain')
                       and coalesce(o.sent_at, o.claimed_at, o.updated_at, o.created_at)
                             > now() - make_interval(mins => p_cooldown_minutes))
               then 'frequency_cap'
             else null
           end as reason
      from email_jobs j
     where j.id = any(v_ids)
       and j.status = 'pending'
  )
  update email_jobs j
     set status = case when v.reason = 'suppressed' then 'suppressed'::job_status else 'skipped'::job_status end,
         last_error_class = 'ineligible',
         last_error_code = v.reason
    from verdict v
   where j.id = v.job_id
     and v.reason is not null
     and j.status = 'pending';
  get diagnostics v_dropped = row_count;

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

revoke all on function public.sending_reserve_budget(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.sending_reserve_budget(uuid, integer, integer, integer) to service_role;
revoke all on function public.sending_claim_jobs(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.sending_claim_jobs(uuid, uuid, integer, integer) to service_role;
