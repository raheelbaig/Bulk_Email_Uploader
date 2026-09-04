-- =============================================================================
-- 0003 — Audit log
-- =============================================================================
-- Append-only from the application's perspective. Users may read their own
-- workspace's records and can never write, amend or delete them.
--
-- Retention: never. Audit records are a compliance artifact (ARCHITECTURE §22.4).
-- =============================================================================

create table audit_logs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_id     uuid references auth.users(id) on delete set null,
  actor_type   text not null default 'user' check (actor_type in ('user', 'system', 'provider')),
  action       text not null check (length(action) between 1 and 100),
  entity_type  text check (entity_type is null or length(entity_type) <= 60),
  entity_id    uuid,
  metadata     jsonb not null default '{}'::jsonb,
  ip           inet,
  user_agent   text check (user_agent is null or length(user_agent) <= 512),
  created_at   timestamptz not null default now(),
  -- An unbounded jsonb column is how a 500 MB database dies, and a large
  -- metadata blob is also a sign that something is being logged that shouldn't be.
  constraint ck_audit_metadata_size check (pg_column_size(metadata) < 8192)
);

create index ix_audit_ws_time on audit_logs (workspace_id, created_at desc);
create index ix_audit_entity  on audit_logs (entity_type, entity_id) where entity_id is not null;
create index ix_audit_actor   on audit_logs (actor_id, created_at desc) where actor_id is not null;

-- =============================================================================
-- Append-only enforcement
--
-- Defence in depth. RLS already denies UPDATE and DELETE to `authenticated`
-- because no such policy exists. This trigger additionally blocks amendment by
-- ANY role, including service_role and the table owner, both of which bypass or
-- are exempt from RLS in some configurations.
--
-- Deletion by cascade from workspaces is permitted: removing a workspace removes
-- its records. Row-level tampering is not.
-- =============================================================================
create or replace function app.reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger trg_audit_no_update
  before update on audit_logs
  for each row execute function app.reject_audit_mutation();

create trigger trg_audit_no_delete
  before delete on audit_logs
  for each row
  when (pg_trigger_depth() = 0)   -- allow ON DELETE CASCADE from workspaces
  execute function app.reject_audit_mutation();

-- =============================================================================
-- RLS
-- =============================================================================
alter table audit_logs enable row level security;
alter table audit_logs force  row level security;

revoke all on audit_logs from anon, authenticated;
grant select on audit_logs to authenticated;

-- The writer path needs INSERT and nothing more. Withholding UPDATE and DELETE
-- from service_role makes append-only true at the GRANT layer as well; the
-- trigger above remains as defence against a future migration widening this.
revoke all on audit_logs from service_role;
grant select, insert on audit_logs to service_role;

create policy audit_logs_select on audit_logs
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

-- No INSERT policy for `authenticated`, by design. All writes originate from
-- server-side code holding the service role, or from SECURITY DEFINER functions.
