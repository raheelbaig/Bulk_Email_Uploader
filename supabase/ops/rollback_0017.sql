-- =============================================================================
-- ROLLBACK for migration 0017 — operator script, NOT a migration
-- =============================================================================
-- Removes 0017's Send / Delivery / Reject handling, the sending-health function
-- and guard, and the provider-event prune, and restores 0016's
-- events_record_bounce / events_record_complaint and app.job_transition_allowed
-- (verbatim). Tested by tests/migration-safety.test.ts, which asserts the schema
-- after this script equals a fresh 0001–0016 build and that every row survives.
--
-- Run this BEFORE rollback_0016.sql if that is also needed.
--
-- Before running: deploy code that calls the 0016 signatures (the commit before
-- 0017), or point the SNS subscription away. Otherwise the webhook calls
-- functions that no longer exist; it answers 500 and SNS retries, which is safe
-- but noisy.
--
-- WHAT IS LOST: nothing stored. 0017 adds no table and no column.
--
-- WHAT IS KEPT, deliberately:
--   - every job status and counter an event moved (delivered, failed by a
--     Reject, sent by reconciliation). Under the 0016 machine a job failed by a
--     Reject simply has no further transitions.
--   - every suppression, audit row and provider_events row.
-- =============================================================================

begin;

drop function if exists public.events_record_send(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[]);
drop function if exists public.events_record_delivery(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[]);
drop function if exists public.events_record_reject(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[], text);
drop function if exists public.events_record_bounce(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[], text, text);
drop function if exists public.events_record_complaint(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[], text);
drop function if exists public.events_prune(integer, integer);
drop function if exists app.events_reconcile(text, text, uuid, uuid, integer, text, text[]);
drop function if exists app.events_applied(text, uuid, uuid, text);
drop function if exists app.events_unmatched(text, text);
drop function if exists app.events_health_guard(uuid);
drop function if exists public.workspace_send_health(uuid);
drop function if exists app.events_audit_resolved(uuid, uuid, text, text, text);
drop function if exists app.events_resolve_attempt(uuid, uuid, integer, text, text[]);

drop index if exists ix_email_jobs_ws_sent;

-- Verbatim from 0016.
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
    -- Provider events (0016).
    when 'sent'           then new_status in ('delivered', 'bounced', 'complained')
    when 'delivered'      then new_status in ('bounced', 'complained')
    when 'bounced'        then new_status in ('complained')
    else false
  end
$fn$;

-- Verbatim from 0016.
create or replace function public.events_record_bounce(
  p_sns_message_id text,
  p_sns_timestamp  timestamptz,
  p_occurred_at    timestamptz,
  p_message_id     text,
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_recipients     text[],
  p_bounce_type    text,
  p_bounce_subtype text
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_detail      jsonb;
  v_match       record;
  v_reason      suppression_reason;
  v_action      text := 'none';
  v_transition  text := null;
begin
  if p_bounce_type is null or p_bounce_type not in ('Permanent', 'Transient', 'Undetermined') then
    raise exception 'unknown bounce type' using errcode = 'check_violation';
  end if;
  if p_bounce_subtype is not null and p_bounce_subtype !~ '^[A-Za-z]{1,40}$' then
    raise exception 'malformed bounce subtype' using errcode = 'check_violation';
  end if;

  v_detail := jsonb_strip_nulls(jsonb_build_object(
    'bounceType', p_bounce_type,
    'bounceSubType', p_bounce_subtype,
    'recipientCount', coalesce(cardinality(p_recipients), 0)
  ));

  if not app.events_begin(p_sns_message_id, 'bounce', p_sns_timestamp, p_occurred_at, p_message_id, v_detail) then
    return 'duplicate';
  end if;

  select * into v_match from app.events_match_job(p_workspace_id, p_job_id, p_message_id, p_recipients);
  if v_match.job_id is null then
    update provider_events
       set detail = detail || jsonb_build_object('unmatched', v_match.unmatched_reason)
     where sns_message_id = p_sns_message_id;
    return 'unmatched';
  end if;

  if p_bounce_type = 'Permanent' then
    v_reason := case when p_bounce_subtype in ('Suppressed', 'OnAccountSuppressionList')
                     then 'provider_suppressed'::suppression_reason
                     else 'hard_bounce'::suppression_reason end;
    v_action := app.events_suppress(
      p_workspace_id, v_match.to_email, v_reason,
      'ses bounce: ' || p_bounce_type || coalesce('/' || p_bounce_subtype, ''),
      v_match.campaign_id);

    -- The counter moves only with the job, so each job counts once.
    if v_match.status in ('sent', 'delivered') then
      update email_jobs set status = 'bounced'
       where workspace_id = p_workspace_id and id = v_match.job_id;
      update campaigns set n_bounced = n_bounced + 1
       where workspace_id = p_workspace_id and id = v_match.campaign_id;
      v_transition := v_match.status::text || '->bounced';
    end if;
  end if;

  update provider_events
     set outcome = 'applied', workspace_id = p_workspace_id, job_id = v_match.job_id,
         suppression_action = v_action, processed_at = now()
   where sns_message_id = p_sns_message_id;

  perform app.events_audit(p_workspace_id, v_match.job_id, v_match.campaign_id, p_sns_message_id,
                           p_message_id, 'bounce', p_occurred_at, v_action, v_reason::text,
                           v_transition, v_detail - 'recipientCount');
  return 'applied';
end;
$fn$;

-- Verbatim from 0016.
create or replace function public.events_record_complaint(
  p_sns_message_id text,
  p_sns_timestamp  timestamptz,
  p_occurred_at    timestamptz,
  p_message_id     text,
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_recipients     text[],
  p_feedback_type  text
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_detail      jsonb;
  v_match       record;
  v_action      text;
  v_transition  text := null;
begin
  if p_feedback_type is not null and p_feedback_type !~ '^[A-Za-z0-9-]{1,40}$' then
    raise exception 'malformed complaint feedback type' using errcode = 'check_violation';
  end if;

  v_detail := jsonb_strip_nulls(jsonb_build_object(
    'feedbackType', p_feedback_type,
    'recipientCount', coalesce(cardinality(p_recipients), 0)
  ));

  if not app.events_begin(p_sns_message_id, 'complaint', p_sns_timestamp, p_occurred_at, p_message_id, v_detail) then
    return 'duplicate';
  end if;

  select * into v_match from app.events_match_job(p_workspace_id, p_job_id, p_message_id, p_recipients);
  if v_match.job_id is null then
    update provider_events
       set detail = detail || jsonb_build_object('unmatched', v_match.unmatched_reason)
     where sns_message_id = p_sns_message_id;
    return 'unmatched';
  end if;

  v_action := app.events_suppress(
    p_workspace_id, v_match.to_email, 'complaint',
    'ses complaint' || coalesce(': ' || p_feedback_type, ''),
    v_match.campaign_id);

  if v_match.status in ('sent', 'delivered', 'bounced') then
    update email_jobs set status = 'complained'
     where workspace_id = p_workspace_id and id = v_match.job_id;
    update campaigns set n_complained = n_complained + 1
     where workspace_id = p_workspace_id and id = v_match.campaign_id;
    v_transition := v_match.status::text || '->complained';
  end if;

  update provider_events
     set outcome = 'applied', workspace_id = p_workspace_id, job_id = v_match.job_id,
         suppression_action = v_action, processed_at = now()
   where sns_message_id = p_sns_message_id;

  perform app.events_audit(p_workspace_id, v_match.job_id, v_match.campaign_id, p_sns_message_id,
                           p_message_id, 'complaint', p_occurred_at, v_action, 'complaint',
                           v_transition, v_detail - 'recipientCount');
  return 'applied';
end;
$fn$;

do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'public.events_record_bounce(text, timestamptz, timestamptz, text, uuid, uuid, text[], text, text)',
    'public.events_record_complaint(text, timestamptz, timestamptz, text, uuid, uuid, text[], text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$grants$;

do $rollback$
begin
  if to_regclass('public.schema_migrations') is not null then
    delete from public.schema_migrations where filename = '0017_event_reconciliation.sql';
  end if;
end;
$rollback$;

commit;
