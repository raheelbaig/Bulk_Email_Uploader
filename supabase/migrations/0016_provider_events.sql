-- =============================================================================
-- 0016 — P6: SES bounce and complaint ingestion
-- =============================================================================
-- Design: docs/adr/0005-provider-events-and-consent-plan.md Part 1 (which
-- names this "0015"; that number went to the canonical job address, so the
-- event model is 0016). Nothing here sends, schedules or enables anything. It
-- gives the webhook (`app/api/webhooks/ses`) somewhere safe to write.
--
-- What is added:
--
--   provider_events         one row per SNS notification, keyed by its SNS
--                           MessageId. The primary key is the idempotency
--                           mechanism: a re-delivered or replayed notification
--                           finds its row already there and changes nothing.
--   events_record_bounce    \
--   events_record_complaint  > one transaction each, service_role only
--   events_record_ignored   /
--   app.guard_suppression_update
--                           a suppression's subject never changes, and its
--                           reason may only move from reversible to
--                           irreversible (see "Strengthening" below).
--
-- The guarantees, and where each one lives:
--
--   E1  One effect per SNS notification, however often it is delivered.
--         PRIMARY KEY (sns_message_id), inserted first; a conflict returns
--         'duplicate' before anything else is touched. Concurrent duplicates
--         serialise on the key: the second waits for the first to commit, then
--         finds the row.
--   E2  A forged or mis-tagged event cannot suppress anyone.
--         The route verifies the SNS signature. Behind that, the event must
--         name a job (from its tags) that exists IN the tagged workspace, was
--         sent LIVE, carries the event's provider message id, and whose frozen
--         address is among the event's recipients. Any mismatch is recorded as
--         'unmatched' and nothing else happens. Tags are sender-controlled data
--         and are never trusted on their own.
--   E3  All or nothing. Event row, suppression, job, counter and audit row are
--         written in one function call — one transaction. Any failure rolls the
--         event row back too, so the provider's retry finds nothing recorded
--         and processes it afresh.
--   E4  Transient and undetermined bounces never suppress (ARCHITECTURE §16.5).
--   E5  No client can read or write provider events, or call these functions.
--
-- Addresses are never stored here. A matched event points at its job, which
-- already holds the frozen address; an unmatched one needs none.
-- =============================================================================

-- =============================================================================
-- provider_events
-- =============================================================================
create table provider_events (
  -- SNS MessageId: a UUID in practice; bounded, not parsed, so a format change
  -- on AWS's side cannot make a genuine notification unrecordable.
  sns_message_id      text primary key check (length(sns_message_id) between 1 and 128),
  event_type          text not null check (event_type in (
                        'bounce', 'complaint', 'delivery', 'send', 'reject',
                        'delivery_delay', 'rendering_failure', 'open', 'click',
                        'subscription', 'other')),
  -- SES `mail.messageId` — the id SendEmail returned, stored on the job.
  provider_message_id text check (provider_message_id is null or length(provider_message_id) between 1 and 256),
  -- Set only once the event has been matched to a job in that workspace.
  workspace_id        uuid references workspaces(id) on delete cascade,
  job_id              uuid,
  -- The SNS envelope's Timestamp (publication) and the SES event's own time.
  sns_timestamp       timestamptz not null,
  occurred_at         timestamptz,
  received_at         timestamptz not null default now(),
  -- When the outcome below was decided (same transaction as the insert).
  processed_at        timestamptz not null default now(),
  outcome             text not null check (outcome in ('applied', 'unmatched', 'ignored')),
  suppression_action  text check (suppression_action is null
                                  or suppression_action in ('created', 'strengthened', 'existing', 'none')),
  -- Codes only: bounce type/subtype, feedback type, why an event was unmatched.
  -- Never an address, a diagnostic string or the raw payload.
  detail              jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(detail) = 'object')
                        check (pg_column_size(detail) < 2048),

  constraint ck_provider_events_matched check (
    (outcome = 'applied') = (workspace_id is not null and job_id is not null)
  ),
  -- A matched event names a job of its own workspace, structurally.
  constraint fk_provider_events_job
    foreign key (workspace_id, job_id) references email_jobs (workspace_id, id)
);

create index ix_provider_events_job on provider_events (job_id) where job_id is not null;
create index ix_provider_events_ws_received
  on provider_events (workspace_id, received_at desc) where workspace_id is not null;
create index ix_provider_events_received on provider_events (received_at);

comment on table provider_events is
  'P6 (0016): one row per SES event notification received over SNS, keyed by SNS MessageId for idempotency. Service role only; holds codes, never an address or raw payload.';

-- =============================================================================
-- Job transitions for provider events
-- =============================================================================
-- 0010 declared sent → delivered | bounced | complained. A complaint normally
-- arrives after delivery, and SES can report an asynchronous bounce after a
-- delivery, so those are added. A job never moves backwards: complained is
-- terminal, and a later bounce leaves a complained job where it is.
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

-- =============================================================================
-- Strengthening a suppression
-- =============================================================================
-- uq_suppressions allows one row per address. If the address is already
-- suppressed for a *reversible* reason (manually_blocked, invalid) and the
-- recipient then complains or hard-bounces, leaving the old reason in place
-- would let an owner remove the block and mail a person who complained. So an
-- event strengthens the reason; it never weakens one.
--
-- 0005 says a suppression's reason is never rewritten, so that a complaint
-- cannot be relabelled and deleted. That property is kept, and now enforced for
-- every role rather than by the absence of a grant: the only rewrite permitted
-- is reversible → irreversible, and the subject never changes.
create or replace function app.guard_suppression_update()
returns trigger
language plpgsql
as $fn$
begin
  if new.id               is distinct from old.id
     or new.workspace_id     is distinct from old.workspace_id
     or new.email_normalized is distinct from old.email_normalized
     or new.created_at       is distinct from old.created_at then
    raise exception 'a suppression''s subject cannot be changed'
      using errcode = 'check_violation';
  end if;

  if new.reason is distinct from old.reason
     and not (app.suppression_reason_is_reversible(old.reason)
              and not app.suppression_reason_is_reversible(new.reason)) then
    raise exception 'suppression reason % cannot become %', old.reason, new.reason
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger trg_suppressions_guard_update
  before update on suppressions
  for each row execute function app.guard_suppression_update();

-- The one writer of that transition. SECURITY DEFINER so that no role needs an
-- UPDATE grant on suppressions; EXECUTE is service_role only (below).
create or replace function app.strengthen_suppression(
  p_workspace_id uuid,
  p_email        text,
  p_reason       suppression_reason,
  p_source       text,
  p_detail       text,
  p_campaign_id  uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if app.suppression_reason_is_reversible(p_reason) then
    raise exception 'a suppression can only be strengthened to an irreversible reason'
      using errcode = 'check_violation';
  end if;

  update suppressions
     set reason = p_reason,
         source = p_source,
         detail = left(p_detail, 500),
         campaign_id = p_campaign_id
   where workspace_id = p_workspace_id
     and email_normalized = p_email
     and app.suppression_reason_is_reversible(reason);
  return found;
end;
$fn$;

-- =============================================================================
-- Shared steps
-- =============================================================================

-- Suppresses an address for a provider event. Returns what happened:
--   created       a new suppression (the 0005 and 0010 triggers then mark the
--                 contact suppressed and cancel its pending jobs everywhere)
--   strengthened  an existing reversible suppression now carries this reason
--   existing      already suppressed for an irreversible reason; left as is
create or replace function app.events_suppress(
  p_workspace_id uuid,
  p_email        text,
  p_reason       suppression_reason,
  p_detail       text,
  p_campaign_id  uuid
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_created uuid;
begin
  insert into suppressions (workspace_id, email_normalized, reason, source, campaign_id, detail)
  values (p_workspace_id, p_email, p_reason, 'ses_event', p_campaign_id, left(p_detail, 500))
  on conflict (workspace_id, email_normalized) do nothing
  returning id into v_created;

  if v_created is not null then
    return 'created';
  end if;
  if app.strengthen_suppression(p_workspace_id, p_email, p_reason, 'ses_event', p_detail, p_campaign_id) then
    return 'strengthened';
  end if;
  return 'existing';
end;
$fn$;

-- Records a notification, or reports it as already recorded. The row starts as
-- 'unmatched'; the caller upgrades it in the same transaction if it applies.
create or replace function app.events_begin(
  p_sns_message_id text,
  p_event_type     text,
  p_sns_timestamp  timestamptz,
  p_occurred_at    timestamptz,
  p_message_id     text,
  p_detail         jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_inserted text;
begin
  insert into provider_events (sns_message_id, event_type, provider_message_id, sns_timestamp,
                               occurred_at, processed_at, outcome, detail)
  values (p_sns_message_id, p_event_type, p_message_id, p_sns_timestamp,
          p_occurred_at, now(), 'unmatched', coalesce(p_detail, '{}'::jsonb))
  on conflict (sns_message_id) do nothing
  returning sns_message_id into v_inserted;
  return v_inserted is not null;
end;
$fn$;

-- E2: the job this event is about, or nothing. Every condition must hold.
create or replace function app.events_match_job(
  p_workspace_id uuid,
  p_job_id       uuid,
  p_message_id   text,
  p_recipients   text[]
)
returns table (job_id uuid, campaign_id uuid, to_email text, status job_status, unmatched_reason text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_job email_jobs%rowtype;
  v_mode text;
begin
  if p_workspace_id is null or p_job_id is null then
    return query select null::uuid, null::uuid, null::text, null::job_status, 'no_tags'::text;
    return;
  end if;
  if p_message_id is null then
    return query select null::uuid, null::uuid, null::text, null::job_status, 'no_message_id'::text;
    return;
  end if;

  -- Locked: two events for the same job (a bounce and a complaint, say)
  -- serialise here, so the job transition and counters see each other.
  select j.* into v_job
    from email_jobs j
   where j.workspace_id = p_workspace_id
     and j.id = p_job_id
     and j.provider_message_id = p_message_id
   for update;
  if not found then
    return query select null::uuid, null::uuid, null::text, null::job_status, 'no_job'::text;
    return;
  end if;

  -- A dry-run message never reached SES, so no genuine event can concern it.
  select c.execution_mode into v_mode
    from campaigns c
   where c.workspace_id = v_job.workspace_id and c.id = v_job.campaign_id;
  if v_mode is distinct from 'live' then
    return query select null::uuid, null::uuid, null::text, null::job_status, 'not_live'::text;
    return;
  end if;

  if p_recipients is null or not (v_job.to_email = any(p_recipients)) then
    return query select null::uuid, null::uuid, null::text, null::job_status, 'recipient_mismatch'::text;
    return;
  end if;

  return query select v_job.id, v_job.campaign_id, v_job.to_email, v_job.status, null::text;
end;
$fn$;

-- The audit row for an applied event. Codes and ids only: the job identifies
-- the recipient to anyone entitled to read it; the address is not repeated.
create or replace function app.events_audit(
  p_workspace_id       uuid,
  p_job_id             uuid,
  p_campaign_id        uuid,
  p_sns_message_id     text,
  p_message_id         text,
  p_event_type         text,
  p_occurred_at        timestamptz,
  p_suppression_action text,
  p_suppression_reason text,
  p_job_transition     text,
  p_detail             jsonb
)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  insert into audit_logs (workspace_id, actor_type, action, entity_type, entity_id, metadata)
  values (
    p_workspace_id,
    'provider',
    case when p_suppression_action in ('created', 'strengthened') then 'suppression.auto'
         else 'provider_event.recorded' end,
    'email_job',
    p_job_id,
    jsonb_build_object(
      'provider', 'ses',
      'eventType', p_event_type,
      'snsMessageId', p_sns_message_id,
      'providerMessageId', p_message_id,
      'campaignId', p_campaign_id,
      'occurredAt', p_occurred_at,
      'suppressionAction', p_suppression_action,
      'suppressionReason', p_suppression_reason,
      'jobTransition', p_job_transition
    ) || coalesce(p_detail, '{}'::jsonb)
  )
$fn$;

-- =============================================================================
-- Event functions — one transaction each, service_role only
-- =============================================================================
-- Returns 'applied', 'duplicate' or 'unmatched'. Raises on malformed input, so
-- a caller bug surfaces as an error (and a provider retry), never as silent
-- success.

-- Bounce. Permanent: suppress (hard_bounce, or provider_suppressed when SES's
-- own list refused it — ARCHITECTURE §16.5), job → bounced, n_bounced + 1.
-- Transient / Undetermined: recorded against the job, nothing else (E4).
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

-- Complaint. Always suppresses, whatever the feedback type (ARCHITECTURE
-- §16.5): a person who reported the mail is not mailed again. Job → complained
-- from sent, delivered or bounced; n_complained + 1.
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

-- Every other authentic notification (Delivery, Send, Reject, DeliveryDelay,
-- RenderingFailure, subscription confirmations, anything new): recorded so a
-- replay is still a no-op and the pipeline's health is visible, acted on never.
create or replace function public.events_record_ignored(
  p_sns_message_id text,
  p_sns_timestamp  timestamptz,
  p_event_type     text,
  p_message_id     text
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if not app.events_begin(p_sns_message_id, p_event_type, p_sns_timestamp, null, p_message_id, '{}'::jsonb) then
    return 'duplicate';
  end if;
  update provider_events set outcome = 'ignored' where sns_message_id = p_sns_message_id;
  return 'ignored';
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
    'public.events_record_bounce(text, timestamptz, timestamptz, text, uuid, uuid, text[], text, text)',
    'public.events_record_complaint(text, timestamptz, timestamptz, text, uuid, uuid, text[], text)',
    'public.events_record_ignored(text, timestamptz, text, text)',
    'app.strengthen_suppression(uuid, text, suppression_reason, text, text, uuid)',
    'app.events_suppress(uuid, text, suppression_reason, text, uuid)',
    'app.events_begin(text, text, timestamptz, timestamptz, text, jsonb)',
    'app.events_match_job(uuid, uuid, text, text[])',
    'app.events_audit(uuid, uuid, uuid, text, text, text, timestamptz, text, text, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$grants$;

revoke all on function app.guard_suppression_update() from public;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table provider_events enable row level security;
alter table provider_events force  row level security;

revoke all on provider_events from anon, authenticated;
-- No DELETE: retention will be a reviewed function, as for delivery history.
revoke all on provider_events from service_role;
grant select, insert, update on provider_events to service_role;

insert into app.rls_policy_exceptions (table_name, reason) values
  ('provider_events',
   'SES/SNS event ledger (P6, 0016). Service-role only: a client that could write it could forge bounces and complaints, and nothing in it is for display.');
