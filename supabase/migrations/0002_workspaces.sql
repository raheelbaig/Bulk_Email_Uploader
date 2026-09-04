-- =============================================================================
-- 0002 — Tenancy: workspaces, workspace_members, workspace_settings
-- =============================================================================
-- Workspace tenancy exists from commit one (locked decision L1). Retrofitting a
-- tenant column across every table and rewriting every policy later is the most
-- expensive change this schema could be asked to absorb.
-- =============================================================================

create table workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create trigger trg_workspaces_touch
  before update on workspaces
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- The PK covers (workspace_id, user_id). Lookups by user alone - which is what
-- app.current_workspace_ids() does on every policy evaluation - need their own index.
create index ix_workspace_members_user on workspace_members (user_id);

-- -----------------------------------------------------------------------------
-- Per-workspace preferences.
--
-- Beyond the blueprint's P0 scope, added deliberately for two reasons:
--   1. It is the first genuinely user-writable workspace-scoped table, which is
--      what makes the "cannot rewrite workspace_id via UPDATE" guarantee
--      testable rather than merely asserted.
--   2. It is where the operational policy knobs from ADR-0001/0002 will live
--      (UNCERTAIN_ATTEMPT_POLICY, SCHEDULE_GRACE_MINUTES, send caps).
-- -----------------------------------------------------------------------------
create table workspace_settings (
  workspace_id       uuid primary key references workspaces(id) on delete cascade,
  display_timezone   text not null default 'UTC' check (length(display_timezone) between 1 and 64),
  notification_email text check (notification_email is null or position('@' in notification_email) > 1),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);

create trigger trg_workspace_settings_touch
  before update on workspace_settings
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Workspace membership resolution
--
-- SECURITY DEFINER is required: a policy on workspace_members that queries
-- workspace_members would recurse. Definer rights read the table directly,
-- bypassing the policy.
--
-- STABLE lets the planner evaluate this once per statement rather than per row.
--
-- `set search_path` is MANDATORY on every SECURITY DEFINER function. Without it
-- a caller can shadow `public` and hijack execution as the function owner.
-- -----------------------------------------------------------------------------
create or replace function app.current_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select wm.workspace_id
  from public.workspace_members wm
  where wm.user_id = auth.uid()
$$;

comment on function app.current_workspace_ids() is
  'Workspace ids the current JWT subject belongs to. The sole membership authority for RLS policies.';

create or replace function app.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
      and wm.role = any(allowed_roles)
  )
$$;

comment on function app.has_workspace_role(uuid, text[]) is
  'True when the current JWT subject holds one of the given roles in the workspace.';

-- Lock these down. They are SECURITY DEFINER and are exposed through PostgREST
-- by default; only the roles that need them may execute them.
revoke all on function app.current_workspace_ids() from public;
revoke all on function app.has_workspace_role(uuid, text[]) from public;
grant execute on function app.current_workspace_ids() to authenticated;
grant execute on function app.has_workspace_role(uuid, text[]) to authenticated;

-- =============================================================================
-- Row Level Security
--
-- FORCE is not redundant with ENABLE: without FORCE, the table owner bypasses
-- every policy, and migrations run as owner.
--
-- Note: FORCE does not override the BYPASSRLS role attribute. Supabase's
-- service_role has BYPASSRLS, so worker/webhook code is NOT protected by these
-- policies and must carry explicit workspace filters. See lib/db/service.ts.
-- =============================================================================

alter table workspaces         enable row level security;
alter table workspaces         force  row level security;
alter table workspace_members  enable row level security;
alter table workspace_members  force  row level security;
alter table workspace_settings enable row level security;
alter table workspace_settings force  row level security;

-- Deny by default. Supabase grants privileges on new public tables to anon and
-- authenticated through default privileges; we revoke and re-grant explicitly so
-- least privilege holds at the GRANT layer as well as the policy layer.
revoke all on workspaces         from anon, authenticated;
revoke all on workspace_members  from anon, authenticated;
revoke all on workspace_settings from anon, authenticated;

-- service_role privileges are declared explicitly rather than inherited from
-- Supabase's default privileges. Relying on ambient grants means the schema
-- behaves differently on a project whose defaults were changed, and it hides
-- from review exactly what the worker path can reach.
grant select, insert, update, delete on workspaces         to service_role;
grant select, insert, update, delete on workspace_members  to service_role;
grant select, insert, update, delete on workspace_settings to service_role;

-- -----------------------------------------------------------------------------
-- workspaces
-- -----------------------------------------------------------------------------
grant select on workspaces to authenticated;
grant update (name) on workspaces to authenticated;   -- column-level: id is not updatable at all

create policy workspaces_select on workspaces
  for select to authenticated
  using (id in (select app.current_workspace_ids()));

create policy workspaces_update on workspaces
  for update to authenticated
  using      (app.has_workspace_role(id, array['owner', 'admin']))
  with check (app.has_workspace_role(id, array['owner', 'admin']));

-- No INSERT policy: workspaces are created only by the signup bootstrap (0004).
-- No DELETE policy: workspace deletion is a destructive operation reserved for a
-- later, explicitly designed flow.

-- -----------------------------------------------------------------------------
-- workspace_members
-- -----------------------------------------------------------------------------
grant select on workspace_members to authenticated;

create policy workspace_members_select on workspace_members
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

-- No INSERT/UPDATE/DELETE policies. Membership changes are an invitation flow
-- that does not exist yet; until it does, members cannot be added or removed by
-- an authenticated client at all.

-- -----------------------------------------------------------------------------
-- workspace_settings
-- -----------------------------------------------------------------------------
grant select on workspace_settings to authenticated;
grant update (display_timezone, notification_email) on workspace_settings to authenticated;

create policy workspace_settings_select on workspace_settings
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

-- USING controls which rows may be targeted.
-- WITH CHECK controls what the row may become - it is what prevents a member of
-- workspace A from rewriting workspace_id to move the row into workspace B.
-- Omitting WITH CHECK here would be a cross-tenant write vulnerability.
create policy workspace_settings_update on workspace_settings
  for update to authenticated
  using      (app.has_workspace_role(workspace_id, array['owner', 'admin']))
  with check (app.has_workspace_role(workspace_id, array['owner', 'admin']));
