-- =============================================================================
-- 0017 — P6 completion: Send / Delivery / Reject events, sending health, and
--        provider-event retention
-- =============================================================================
-- Design: docs/adr/0005-provider-events-and-consent-plan.md §1.4–§1.5 (the
-- parts 0016 recorded as "not built"), ADR-0001 §3.2 (the reconciliation
-- channel) and docs/adr/0006-event-reconciliation-and-health.md. Nothing here
-- sends, schedules or enables anything.
--
-- What is added:
--
--   app.events_resolve_attempt   the ADR-0001 §3.2 reconciliation step: an
--                                authentic SES event about attempt N of job J
--                                proves SES accepted that attempt, so an attempt
--                                still `dispatched` (the worker has not recorded
--                                the answer yet, or crashed) or already `unknown`
--                                (the reconciler gave up) becomes `accepted`, and
--                                its job `sent`. Every event type runs it first,
--                                which also closes the race where a bounce
--                                arrived before the worker had committed the
--                                provider message id (0016 recorded that bounce
--                                as `unmatched` and suppressed nobody).
--   events_record_send           Send: reconciliation only.
--   events_record_delivery       Delivery: job sent → delivered, n_delivered + 1.
--   events_record_reject         Reject (SES accepted the call, then refused the
--                                message — e.g. a virus): job sent → failed,
--                                n_sent − 1, n_failed + 1. Never suppresses: a
--                                content refusal says nothing about the address.
--   events_record_bounce         \ re-created with the attempt number, the
--   events_record_complaint      / reconciliation step and the health guard.
--   workspace_send_health        bounce and complaint rates over the workspace's
--                                last 500 live messages. SECURITY INVOKER, so a
--                                member reads only their own workspace.
--   app.events_health_guard      when a bounce or complaint pushes a rate past
--                                its threshold, every `sending` campaign in the
--                                workspace pauses, in the same transaction.
--   events_prune                 deletes provider-event rows older than the
--                                retention window (never under 30 days).
--
-- The guarantees of 0016 (E1–E5) hold for every new function. Added:
--
--   E6  An event can only ever move an attempt to `accepted` — the one outcome
--         its existence proves — and only an attempt that is still open or was
--         given up on. It never creates an attempt, never touches a `rejected`
--         one, and never moves a job that a person has already decided about
--         (failed by "leave it", or back in the queue by "send again").
--   E7  Counters move with job transitions only, so each job counts once per
--         state however often, and in whatever order, its events arrive.
--   E8  Auto-pause is edge-triggered: it runs when an event that worsens a rate
--         is applied, never on a timer. A person may resume (that is an audited
--         decision); the next bad event pauses again. A level-triggered check
--         would hold the workspace forever, since a paused workspace sends
--         nothing that could bring its rate back down.
-- =============================================================================

-- =============================================================================
-- Job transitions
-- =============================================================================
-- 0016 plus one: sent → failed, for a Reject event. SES returned a message id,
-- then refused the message before delivery, so nothing reached the recipient.
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
    -- Provider events (0016; sent → failed is 0017's Reject).
    when 'sent'           then new_status in ('delivered', 'bounced', 'complained', 'failed')
    when 'delivered'      then new_status in ('bounced', 'complained')
    when 'bounced'        then new_status in ('complained')
    else false
  end
$fn$;

-- The health view's predicate: a workspace's most recent messages.
create index ix_email_jobs_ws_sent
  on email_jobs (workspace_id, sent_at desc) where sent_at is not null;

-- =============================================================================
-- Reconciliation — ADR-0001 §3.2
-- =============================================================================
-- Returns what happened:
--   resolved       the attempt was open or unknown; it is now accepted and the
--                  job sent (n_sent + 1)
--   already        the attempt was already accepted with this message id
-- or why nothing happened (recorded on the event as `reconcile`):
--   no_tags        the event did not carry workspace, job and attempt tags
--   no_message_id  the event had no message id
--   no_attempt     no such attempt of that job in that workspace
--   not_live       the attempt was a dry run, which never reached SES
--   recipient_mismatch
--                  the job's frozen address is not among the event's recipients
--   message_id_mismatch
--                  the attempt or the job already carries a different message id
--   attempt_rejected
--                  the worker recorded a known refusal for this attempt
--   superseded     a later attempt of the job exists (a person chose to send again)
--   job_state      a person has already decided about the job
--
-- Lock order matches sending_record_accepted (attempt, then job), so the worker
-- recording the same acceptance concurrently cannot deadlock with this. Whichever
-- commits second finds the attempt accepted and changes nothing.
create or replace function app.events_resolve_attempt(
  p_workspace_id uuid,
  p_job_id       uuid,
  p_attempt_no   integer,
  p_message_id   text,
  p_recipients   text[]
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_attempt send_attempts%rowtype;
  v_job     email_jobs%rowtype;
begin
  if p_workspace_id is null or p_job_id is null or p_attempt_no is null then
    return 'no_tags';
  end if;
  if p_message_id is null then
    return 'no_message_id';
  end if;

  select a.* into v_attempt
    from send_attempts a
   where a.workspace_id = p_workspace_id
     and a.job_id = p_job_id
     and a.attempt_no = p_attempt_no
   for update;
  if not found then
    return 'no_attempt';
  end if;
  if v_attempt.mode <> 'live' then
    return 'not_live';
  end if;

  select j.* into v_job
    from email_jobs j
   where j.workspace_id = p_workspace_id and j.id = p_job_id
   for update;
  if not found then
    return 'no_attempt';
  end if;
  if p_recipients is null or not (v_job.to_email = any(p_recipients)) then
    return 'recipient_mismatch';
  end if;

  if v_attempt.state = 'accepted' then
    return case when v_attempt.provider_message_id = p_message_id then 'already' else 'message_id_mismatch' end;
  end if;
  if v_attempt.state = 'rejected' then
    return 'attempt_rejected';
  end if;
  -- dispatched or unknown from here. A later attempt exists only after a person
  -- (or the audited redispatch policy) chose to send again; that attempt owns
  -- the job now, and confirming this one would collide with it.
  if v_job.attempts <> v_attempt.attempt_no then
    return 'superseded';
  end if;
  if v_job.provider_message_id is not null then
    return 'message_id_mismatch';
  end if;
  if v_job.status not in ('claimed', 'send_uncertain') then
    return 'job_state';
  end if;

  update send_attempts
     set state = 'accepted', provider_message_id = p_message_id, resolved_at = now()
   where id = v_attempt.id;

  update email_jobs
     set status = 'sent',
         sent_at = coalesce(sent_at, now()),
         provider_message_id = p_message_id,
         claimed_at = case when status = 'claimed' then claimed_at else null end,
         last_error_class = null,
         last_error_code = null
   where workspace_id = p_workspace_id and id = p_job_id;

  update campaigns set n_sent = n_sent + 1
   where workspace_id = p_workspace_id and id = v_job.campaign_id;
  return 'resolved';
end;
$fn$;

-- The audit row for a reconciliation (a held or in-flight attempt confirmed by
-- the provider). Separate from app.events_audit because no suppression is
-- involved and the transition is the whole story.
create or replace function app.events_audit_resolved(
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_sns_message_id text,
  p_message_id     text,
  p_event_type     text
)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  insert into audit_logs (workspace_id, actor_type, action, entity_type, entity_id, metadata)
  select p_workspace_id, 'provider', 'send.confirmed_by_provider', 'email_job', p_job_id,
         jsonb_build_object(
           'provider', 'ses',
           'eventType', p_event_type,
           'snsMessageId', p_sns_message_id,
           'providerMessageId', p_message_id,
           'campaignId', j.campaign_id)
    from email_jobs j
   where j.workspace_id = p_workspace_id and j.id = p_job_id
$fn$;

-- =============================================================================
-- Sending health — ADR-0005 §1.4, ADR-0006
-- =============================================================================
-- The workspace's last 500 live messages that reached SES. `bounced` and
-- `complained` are the job states 0016 sets for permanent bounces and
-- complaints, so each message counts once. SECURITY INVOKER: a member reads only
-- their own workspace (email_jobs_select); the service role reads any.
create or replace function public.workspace_send_health(p_workspace_id uuid)
returns table (sample integer, bounced integer, complained integer)
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  with recent as (
    select j.status
      from email_jobs j
      join campaigns c on c.workspace_id = j.workspace_id and c.id = j.campaign_id
     where j.workspace_id = p_workspace_id
       and j.sent_at is not null
       and c.execution_mode = 'live'
     order by j.sent_at desc
     limit 500
  )
  select count(*)::int,
         count(*) filter (where status = 'bounced')::int,
         count(*) filter (where status = 'complained')::int
    from recent
$fn$;

-- Thresholds: ADR-0005 §1.5 — 4% bounces, 0.08% complaints, each below the
-- point (about 5% and 0.1%) where SES reviews an account. No verdict below 100
-- messages: two bounces in a ten-message test are not a rate.
--
-- Returns the reason it paused for, or null. Writes the audit row itself, so
-- the pause and its explanation commit together with the event.
create or replace function app.events_health_guard(p_workspace_id uuid)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_health record;
  v_reason text;
  v_count  integer;
begin
  select * into v_health from public.workspace_send_health(p_workspace_id);
  if v_health.sample < 100 then
    return null;
  end if;

  if v_health.complained * 10000 >= v_health.sample * 8 then
    v_reason := 'complaint_rate_high';
  elsif v_health.bounced * 100 >= v_health.sample * 4 then
    v_reason := 'bounce_rate_high';
  else
    return null;
  end if;

  update campaigns
     set status = 'paused', pause_reason = v_reason
   where workspace_id = p_workspace_id and status = 'sending';
  get diagnostics v_count = row_count;
  if v_count = 0 then
    return null;
  end if;

  insert into audit_logs (workspace_id, actor_type, action, metadata)
  values (p_workspace_id, 'system', 'policy.auto_paused',
          jsonb_build_object('reason', v_reason, 'campaignsPaused', v_count,
                             'sample', v_health.sample, 'bounced', v_health.bounced,
                             'complained', v_health.complained));
  return v_reason;
end;
$fn$;

-- =============================================================================
-- Event functions — one transaction each, service_role only
-- =============================================================================
-- 0016's bounce and complaint functions gain p_attempt_no; the old signatures
-- are dropped so PostgREST never has two candidates to choose between.
drop function public.events_record_bounce(text, timestamptz, timestamptz, text, uuid, uuid, text[], text, text);
drop function public.events_record_complaint(text, timestamptz, timestamptz, text, uuid, uuid, text[], text);

-- Records the reconciliation outcome on the event row and audits a resolution.
create or replace function app.events_reconcile(
  p_sns_message_id text,
  p_event_type     text,
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_attempt_no     integer,
  p_message_id     text,
  p_recipients     text[]
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_result text;
begin
  v_result := app.events_resolve_attempt(p_workspace_id, p_job_id, p_attempt_no, p_message_id, p_recipients);
  update provider_events
     set detail = detail || jsonb_build_object('reconcile', v_result)
   where sns_message_id = p_sns_message_id;
  if v_result = 'resolved' then
    perform app.events_audit_resolved(p_workspace_id, p_job_id, p_sns_message_id, p_message_id, p_event_type);
  end if;
  return v_result;
end;
$fn$;

-- Marks an event row matched to its job.
create or replace function app.events_applied(
  p_sns_message_id text,
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_action         text
)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  update provider_events
     set outcome = 'applied', workspace_id = p_workspace_id, job_id = p_job_id,
         suppression_action = p_action, processed_at = now()
   where sns_message_id = p_sns_message_id
$fn$;

create or replace function app.events_unmatched(p_sns_message_id text, p_reason text)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  update provider_events
     set detail = detail || jsonb_build_object('unmatched', p_reason)
   where sns_message_id = p_sns_message_id
$fn$;

-- Send: SES accepted the message. Reconciliation is the whole effect.
create or replace function public.events_record_send(
  p_sns_message_id text,
  p_sns_timestamp  timestamptz,
  p_occurred_at    timestamptz,
  p_message_id     text,
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_attempt_no     integer,
  p_recipients     text[]
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_result text;
begin
  if not app.events_begin(p_sns_message_id, 'send', p_sns_timestamp, p_occurred_at, p_message_id,
                          jsonb_build_object('recipientCount', coalesce(cardinality(p_recipients), 0))) then
    return 'duplicate';
  end if;

  v_result := app.events_reconcile(p_sns_message_id, 'send', p_workspace_id, p_job_id, p_attempt_no,
                                   p_message_id, p_recipients);
  if v_result not in ('resolved', 'already') then
    perform app.events_unmatched(p_sns_message_id, v_result);
    return 'unmatched';
  end if;

  perform app.events_applied(p_sns_message_id, p_workspace_id, p_job_id, 'none');
  return 'applied';
end;
$fn$;

-- Delivery: the receiving server accepted the message. sent → delivered.
-- A job already bounced or complained stays where it is (jobs never move back).
-- Not audited: one row per message would bury the audit log, and the event row
-- already records which job it moved.
create or replace function public.events_record_delivery(
  p_sns_message_id text,
  p_sns_timestamp  timestamptz,
  p_occurred_at    timestamptz,
  p_message_id     text,
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_attempt_no     integer,
  p_recipients     text[]
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_match record;
begin
  if not app.events_begin(p_sns_message_id, 'delivery', p_sns_timestamp, p_occurred_at, p_message_id,
                          jsonb_build_object('recipientCount', coalesce(cardinality(p_recipients), 0))) then
    return 'duplicate';
  end if;

  perform app.events_reconcile(p_sns_message_id, 'delivery', p_workspace_id, p_job_id, p_attempt_no,
                               p_message_id, p_recipients);

  select * into v_match from app.events_match_job(p_workspace_id, p_job_id, p_message_id, p_recipients);
  if v_match.job_id is null then
    perform app.events_unmatched(p_sns_message_id, v_match.unmatched_reason);
    return 'unmatched';
  end if;

  if v_match.status = 'sent' then
    update email_jobs set status = 'delivered'
     where workspace_id = p_workspace_id and id = v_match.job_id;
    update campaigns set n_delivered = n_delivered + 1
     where workspace_id = p_workspace_id and id = v_match.campaign_id;
  end if;

  perform app.events_applied(p_sns_message_id, p_workspace_id, v_match.job_id, 'none');
  return 'applied';
end;
$fn$;

-- Reject: SES returned a message id, then refused to send the message (it
-- found a virus, for instance). Nothing reached the recipient, so the job is
-- failed and leaves the sent count. The address is not suppressed: the refusal
-- was about content.
create or replace function public.events_record_reject(
  p_sns_message_id text,
  p_sns_timestamp  timestamptz,
  p_occurred_at    timestamptz,
  p_message_id     text,
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_attempt_no     integer,
  p_recipients     text[],
  p_reason         text
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_detail     jsonb;
  v_match      record;
  v_transition text := null;
begin
  if p_reason is not null and p_reason !~ '^[A-Za-z0-9 ._-]{1,60}$' then
    raise exception 'malformed reject reason' using errcode = 'check_violation';
  end if;
  v_detail := jsonb_strip_nulls(jsonb_build_object(
    'rejectReason', p_reason,
    'recipientCount', coalesce(cardinality(p_recipients), 0)
  ));

  if not app.events_begin(p_sns_message_id, 'reject', p_sns_timestamp, p_occurred_at, p_message_id, v_detail) then
    return 'duplicate';
  end if;

  perform app.events_reconcile(p_sns_message_id, 'reject', p_workspace_id, p_job_id, p_attempt_no,
                               p_message_id, p_recipients);

  select * into v_match from app.events_match_job(p_workspace_id, p_job_id, p_message_id, p_recipients);
  if v_match.job_id is null then
    perform app.events_unmatched(p_sns_message_id, v_match.unmatched_reason);
    return 'unmatched';
  end if;

  if v_match.status = 'sent' then
    update email_jobs
       set status = 'failed', last_error_class = 'permanent', last_error_code = 'ses_reject'
     where workspace_id = p_workspace_id and id = v_match.job_id;
    update campaigns set n_sent = greatest(n_sent - 1, 0), n_failed = n_failed + 1
     where workspace_id = p_workspace_id and id = v_match.campaign_id;
    v_transition := 'sent->failed';
  end if;

  perform app.events_applied(p_sns_message_id, p_workspace_id, v_match.job_id, 'none');
  perform app.events_audit(p_workspace_id, v_match.job_id, v_match.campaign_id, p_sns_message_id,
                           p_message_id, 'reject', p_occurred_at, 'none', null,
                           v_transition, v_detail - 'recipientCount');
  return 'applied';
end;
$fn$;

-- Bounce. As 0016, plus: reconciliation first (so a bounce that overtakes the
-- worker's own commit still matches), and the health guard after a permanent
-- bounce moved a job.
create or replace function public.events_record_bounce(
  p_sns_message_id text,
  p_sns_timestamp  timestamptz,
  p_occurred_at    timestamptz,
  p_message_id     text,
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_attempt_no     integer,
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

  perform app.events_reconcile(p_sns_message_id, 'bounce', p_workspace_id, p_job_id, p_attempt_no,
                               p_message_id, p_recipients);

  select * into v_match from app.events_match_job(p_workspace_id, p_job_id, p_message_id, p_recipients);
  if v_match.job_id is null then
    perform app.events_unmatched(p_sns_message_id, v_match.unmatched_reason);
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

  perform app.events_applied(p_sns_message_id, p_workspace_id, v_match.job_id, v_action);
  perform app.events_audit(p_workspace_id, v_match.job_id, v_match.campaign_id, p_sns_message_id,
                           p_message_id, 'bounce', p_occurred_at, v_action, v_reason::text,
                           v_transition, v_detail - 'recipientCount');
  if v_transition is not null then
    perform app.events_health_guard(p_workspace_id);
  end if;
  return 'applied';
end;
$fn$;

-- Complaint. As 0016, plus reconciliation first and the health guard.
create or replace function public.events_record_complaint(
  p_sns_message_id text,
  p_sns_timestamp  timestamptz,
  p_occurred_at    timestamptz,
  p_message_id     text,
  p_workspace_id   uuid,
  p_job_id         uuid,
  p_attempt_no     integer,
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

  perform app.events_reconcile(p_sns_message_id, 'complaint', p_workspace_id, p_job_id, p_attempt_no,
                               p_message_id, p_recipients);

  select * into v_match from app.events_match_job(p_workspace_id, p_job_id, p_message_id, p_recipients);
  if v_match.job_id is null then
    perform app.events_unmatched(p_sns_message_id, v_match.unmatched_reason);
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

  perform app.events_applied(p_sns_message_id, p_workspace_id, v_match.job_id, v_action);
  perform app.events_audit(p_workspace_id, v_match.job_id, v_match.campaign_id, p_sns_message_id,
                           p_message_id, 'complaint', p_occurred_at, v_action, 'complaint',
                           v_transition, v_detail - 'recipientCount');
  if v_transition is not null then
    perform app.events_health_guard(p_workspace_id);
  end if;
  return 'applied';
end;
$fn$;

-- =============================================================================
-- Retention
-- =============================================================================
-- provider_events has no DELETE grant for anyone (0016). This is the one
-- reviewed way to remove rows: whole rows older than the window, never fewer
-- than 30 days, in bounded batches. Nothing refers to these rows (jobs,
-- suppressions and audit rows keep their own record), so pruning loses only the
-- raw ledger. SECURITY DEFINER because no role holds DELETE; EXECUTE is
-- service_role only. Called by the operator schedule (supabase/ops).
create or replace function public.events_prune(p_retain_days integer, p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_count integer;
begin
  delete from provider_events
   where sns_message_id in (
     select e.sns_message_id
       from provider_events e
      where e.received_at < now() - make_interval(days => greatest(30, coalesce(p_retain_days, 90)))
      order by e.received_at
      limit greatest(1, least(coalesce(p_limit, 5000), 50000))
   );
  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- -----------------------------------------------------------------------------
-- Function privileges
-- -----------------------------------------------------------------------------
do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'public.events_record_send(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[])',
    'public.events_record_delivery(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[])',
    'public.events_record_reject(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[], text)',
    'public.events_record_bounce(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[], text, text)',
    'public.events_record_complaint(text, timestamptz, timestamptz, text, uuid, uuid, integer, text[], text)',
    'public.events_prune(integer, integer)',
    'app.events_resolve_attempt(uuid, uuid, integer, text, text[])',
    'app.events_audit_resolved(uuid, uuid, text, text, text)',
    'app.events_health_guard(uuid)',
    'app.events_reconcile(text, text, uuid, uuid, integer, text, text[])',
    'app.events_applied(text, uuid, uuid, text)',
    'app.events_unmatched(text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$grants$;

-- Read by members for their own workspace (RLS applies: SECURITY INVOKER).
revoke all on function public.workspace_send_health(uuid) from public, anon;
grant execute on function public.workspace_send_health(uuid) to authenticated, service_role;
