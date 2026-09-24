-- =============================================================================
-- P5 — the send-tick schedule (OPERATOR-APPLIED, NOT A MIGRATION)
-- =============================================================================
-- Starts the clock that drives the sending engine: once a minute, pg_cron asks
-- pg_net to POST an HMAC-signed request to /api/internal/worker/tick.
--
-- This file lives outside supabase/migrations on purpose. Deploying the
-- application must never start sending machinery by itself; applying this is a
-- deliberate, one-time act by an operator, after:
--
--   1. EMAIL_SENDING_MODE is set to the mode you intend (`dry_run` first), and
--      WORKER_HMAC_SECRET is set in the app's environment;
--   2. the same secret and the app's public URL are stored in Vault (below).
--
-- Even with this applied, `EMAIL_SENDING_MODE=disabled` (the default) makes
-- every tick a no-op. Removing the schedule: see the end of this file.
--
-- It does not touch DNS, MX records or anything outside this database. Inbound
-- mail for the domain is unaffected.
--
-- Requires the pg_cron, pg_net and pgcrypto extensions (Supabase: Database →
-- Extensions). Not run by the test suite: the WASM database it uses provides
-- none of them, which is why the queue itself is a plain table (migration 0010).
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;

-- Secrets live in Vault, never in the cron command text (ARCHITECTURE §12.2).
-- Run once, with real values, then delete them from your shell history:
--
--   select vault.create_secret('<same value as WORKER_HMAC_SECRET>', 'worker_hmac_secret');
--   select vault.create_secret('https://<your-app-host>', 'app_url');

-- -----------------------------------------------------------------------------
-- The dispatcher — ARCHITECTURE §12.3
--
-- Signs exactly what lib/sending/worker-auth.ts verifies:
--   X-Timestamp: unix seconds
--   X-Signature: v1=hex(HMAC-SHA256(secret, timestamp || '.' || body))
-- The body is the fixed string '{}'; the worker ignores it beyond the signature.
-- -----------------------------------------------------------------------------
create or replace function app.dispatch_tick(endpoint text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_secret text;
  v_base   text;
  v_ts     text := extract(epoch from now())::bigint::text;
  v_body   text := '{}';
  v_sig    text;
  v_req    bigint;
begin
  if endpoint !~ '^/api/internal/worker/[a-z]+$' then
    raise exception 'dispatch_tick: unexpected endpoint';
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'worker_hmac_secret';
  select decrypted_secret into v_base   from vault.decrypted_secrets where name = 'app_url';
  if v_secret is null or v_base is null then
    raise exception 'dispatch_tick: worker_hmac_secret and app_url must be stored in Vault';
  end if;

  v_sig := encode(extensions.hmac(v_ts || '.' || v_body, v_secret, 'sha256'), 'hex');

  select net.http_post(
    url                  := v_base || endpoint,
    body                 := v_body::jsonb,
    headers              := jsonb_build_object(
                              'Content-Type', 'application/json',
                              'X-Timestamp',  v_ts,
                              'X-Signature',  'v1=' || v_sig),
    timeout_milliseconds := 55000
  ) into v_req;

  return v_req;
end;
$fn$;

-- §12.6: the sharpest edge in the scheduling design. Without this, any logged-in
-- user could make the database issue signed requests through PostgREST.
revoke all on function app.dispatch_tick(text) from public, anon, authenticated;

-- One tick a minute. Overlapping ticks are safe by design (every state change
-- is a guarded conditional update); missed ticks are not backfilled.
select cron.schedule(
  'send-tick',
  '* * * * *',
  $$ select app.dispatch_tick('/api/internal/worker/tick') $$
);

-- pg_net keeps every response. Prune it, or it quietly consumes the database
-- budget (ARCHITECTURE §12.5).
select cron.schedule(
  'prune-net-responses',
  '17 * * * *',
  $$ delete from net._http_response where created < now() - interval '1 day' $$
);

-- Rate-ledger windows are worthless after a minute (ADR-0002 §5.3).
select cron.schedule(
  'prune-rate-ledger',
  '23 3 * * *',
  $$ delete from public.rate_ledger where window_start < now() - interval '2 days' $$
);

-- =============================================================================
-- To stop the clock:
--
--   select cron.unschedule('send-tick');
--   select cron.unschedule('prune-net-responses');
--   select cron.unschedule('prune-rate-ledger');
--
-- Stopping the clock stops new work. Campaigns and jobs stay exactly where they
-- are, and resume from there if the schedule is applied again.
-- =============================================================================
