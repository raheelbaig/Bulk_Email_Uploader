-- =============================================================================
-- 0004 — Workspace bootstrap on signup
-- =============================================================================
-- Runs as a trigger on auth.users rather than in application code, so that every
-- signup path produces a workspace: email/password, OAuth, magic link, admin
-- invite, or a row created directly by Supabase Auth. Application-side bootstrap
-- would be skipped by any path that does not route through our handler, leaving
-- an authenticated user with no workspace - a state the rest of the system has
-- no sensible behaviour for.
--
-- Idempotent: a user who somehow already has a workspace does not get a second.
-- =============================================================================

create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_workspace_id uuid;
  workspace_name   text;
begin
  -- Never trust user-supplied metadata for anything but a display name, and
  -- bound it. raw_user_meta_data is client-controlled at signup.
  workspace_name := coalesce(
    nullif(trim(left(new.raw_user_meta_data ->> 'workspace_name', 120)), ''),
    'My workspace'
  );

  if exists (select 1 from public.workspace_members where user_id = new.id) then
    return new;
  end if;

  insert into public.workspaces (name)
  values (workspace_name)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  insert into public.workspace_settings (workspace_id)
  values (new_workspace_id);

  insert into public.audit_logs (workspace_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (
    new_workspace_id, new.id, 'system', 'workspace.bootstrapped', 'workspace', new_workspace_id,
    jsonb_build_object('source', 'signup_trigger')
  );

  return new;
end;
$$;

comment on function app.handle_new_user() is
  'Creates a workspace, owner membership, settings row and audit record for each new auth user. Idempotent.';

revoke all on function app.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();
