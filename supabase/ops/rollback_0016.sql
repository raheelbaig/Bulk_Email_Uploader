-- =============================================================================
-- ROLLBACK for migration 0016 — operator script, NOT a migration
-- =============================================================================
-- Removes P6's provider-event ingestion: the provider_events table, the
-- events_record_* functions, the suppression-strengthening helper and guard,
-- and restores app.job_transition_allowed to its 0010 body (verbatim). Tested
-- by tests/migration-safety.test.ts, which asserts the schema after this script
-- equals a fresh 0001–0015 build and that every business row survives.
--
-- Run this BEFORE rollback_0015.sql / rollback_0011_0014.sql if those are also
-- needed.
--
-- Before running: point the SNS subscription away from /api/webhooks/ses (or
-- deploy code without the route). Otherwise SNS keeps delivering to a handler
-- whose functions no longer exist; it answers 500 and SNS retries, which is
-- safe but noisy.
--
-- WHAT IS LOST:
--   - provider_events rows (the event ledger: which SNS notifications were
--     received, matched or ignored). Nothing else refers to them.
--
-- WHAT IS KEPT, deliberately:
--   - every suppression an event created or strengthened. Rolling back code
--     must never make a bounced or complaining address mailable again.
--   - job statuses and campaign counters (bounced / complained). Under the
--     0010 state machine those jobs simply have no further transitions.
--   - audit_logs rows (append-only; never touched).
-- =============================================================================

begin;

drop function if exists public.events_record_bounce(text, timestamptz, timestamptz, text, uuid, uuid, text[], text, text);
drop function if exists public.events_record_complaint(text, timestamptz, timestamptz, text, uuid, uuid, text[], text);
drop function if exists public.events_record_ignored(text, timestamptz, text, text);
drop function if exists app.events_audit(uuid, uuid, uuid, text, text, text, timestamptz, text, text, text, jsonb);
drop function if exists app.events_match_job(uuid, uuid, text, text[]);
drop function if exists app.events_begin(text, text, timestamptz, timestamptz, text, jsonb);
drop function if exists app.events_suppress(uuid, text, suppression_reason, text, uuid);
drop function if exists app.strengthen_suppression(uuid, text, suppression_reason, text, text, uuid);

drop trigger if exists trg_suppressions_guard_update on suppressions;
drop function if exists app.guard_suppression_update();

delete from app.rls_policy_exceptions where table_name = 'provider_events';
drop table if exists provider_events;

-- Verbatim from 0010.
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

do $rollback$
begin
  if to_regclass('public.schema_migrations') is not null then
    delete from public.schema_migrations where filename = '0016_provider_events.sql';
  end if;
end;
$rollback$;

commit;
