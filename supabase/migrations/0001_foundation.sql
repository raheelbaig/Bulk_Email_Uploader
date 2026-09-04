-- =============================================================================
-- 0001 — Foundation: app schema, helper functions, RLS policy-exception registry
-- =============================================================================
-- P0. No extensions are required: gen_random_uuid() is core from PostgreSQL 13.
-- Later phases add pgcrypto (HMAC in the cron dispatcher), pg_trgm (contact
-- search), pgmq, pg_cron and pg_net. They are deliberately NOT created here so
-- that P0 migrations run on any stock PostgreSQL 13+, including the WASM build
-- used by the test suite.
-- =============================================================================

create schema if not exists app;

revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.touch_updated_at() is
  'BEFORE UPDATE trigger: maintains updated_at. Not SECURITY DEFINER - it needs no privileges.';

-- -----------------------------------------------------------------------------
-- RLS policy-exception registry
--
-- The CI guard asserts that every table in `public` has RLS enabled AND has at
-- least one policy. A table that is intentionally deny-all (readable only by the
-- service role) has no policies by design, so it must be registered here with a
-- reason. Registration is a deliberate, reviewable act in a migration - not a
-- silent omission.
-- -----------------------------------------------------------------------------
create table if not exists app.rls_policy_exceptions (
  table_name text primary key,
  reason     text not null,
  created_at timestamptz not null default now()
);

comment on table app.rls_policy_exceptions is
  'Tables intentionally having no RLS policies (deny-all to authenticated). Consumed by the CI RLS coverage guard.';

revoke all on app.rls_policy_exceptions from public, authenticated, anon;
