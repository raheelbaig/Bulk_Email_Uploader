-- =============================================================================
-- 0012 — A campaign launches only in the sending mode it was approved for
-- =============================================================================
-- Found by the second QA pass (2026-09-25).
--
-- Until now a campaign carried a time and nothing else. The worker launched any
-- due `scheduled` campaign in whatever mode the deployment happened to be in at
-- that moment. So a campaign scheduled while EMAIL_SENDING_MODE was `disabled`
-- — during QA, when "scheduled" demonstrably meant "nothing happens" — would
-- launch LIVE the first time the variable was changed, provided its time was
-- still ahead or within the missed-schedule grace window. A configuration change
-- alone was enough to turn old test campaigns into real mail.
--
-- The fix records the approval. Scheduling stamps `approved_send_mode` with the
-- deployment's mode at that moment, and a launch is permitted only in exactly
-- that mode. A mismatch is held by the worker (paused, never launched); a person
-- returns it to draft and schedules it again, which re-runs preflight under the
-- new mode and records a new approval. No new status is needed: `paused` with a
-- reason, and the existing unschedule path, already mean "a person must decide".
--
-- Enforced in three places, any one of which is sufficient:
--   1. the worker checks before preflight (lib/sending/worker.ts, `promote`);
--   2. sending_promote_campaign refuses a mode the campaign was not approved for;
--   3. the transition trigger refuses a launch stamp that disagrees with the
--      approval, for every role including the service role.
--
-- `authenticated` gets no privilege on the new column: its UPDATE grant on
-- campaigns is column-listed (0009), so a browser session cannot approve a
-- campaign for anything.
--
-- Existing rows get NULL, which matches no mode. A campaign scheduled before this
-- migration therefore cannot launch until it is scheduled again — failing closed.
-- =============================================================================

alter table campaigns
  add column approved_send_mode text
    check (approved_send_mode is null or approved_send_mode in ('disabled', 'dry_run', 'live'));

comment on column campaigns.approved_send_mode is
  'The deployment sending mode when a person scheduled this campaign. It may launch only in this mode (0012).';

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
    if new.approved_send_mode is not null then
      raise exception 'a campaign cannot be created already approved for sending'
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

  -- 0012. A draft is approved for nothing: returning to draft withdraws the
  -- approval, whoever writes the row and whatever else the statement says.
  if new.status = 'draft' then
    new.approved_send_mode := null;
  end if;

  -- 0012. The approval is recorded by the statement that schedules the campaign,
  -- and by no other.
  if new.approved_send_mode is distinct from old.approved_send_mode
     and new.approved_send_mode is not null
     and not (old.status = 'validating' and new.status = 'scheduled') then
    raise exception 'a campaign is approved for sending only when it is scheduled'
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

  -- 0012. A launch happens in the mode a person approved, or not at all.
  if old.launched_at is null and new.launched_at is not null
     and new.execution_mode is distinct from old.approved_send_mode then
    raise exception 'a campaign launches only in the sending mode it was approved for (approved %, launching %)',
      coalesce(old.approved_send_mode, 'nothing'), new.execution_mode
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

-- scheduled → queued, now also requiring the approval to match. Same signature
-- as 0010, so the grants recorded there still apply.
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
     and scheduled_at <= now()
     and approved_send_mode = p_mode;
  return found;
end;
$fn$;
