-- =============================================================================
-- TEST FIXTURE ONLY — never applied to a real Supabase project
-- =============================================================================
-- Supabase provisions these roles, the `auth` schema, `auth.users` and
-- `auth.uid()` for us. The test suite runs migrations against a bare PostgreSQL
-- instance, so the parts of Supabase that our migrations depend on are recreated
-- here as faithfully as possible.
--
-- The two properties that matter for the security tests:
--   * `service_role` has BYPASSRLS, exactly as on Supabase. This is what makes
--     "the worker is not protected by RLS" a real, testable condition rather
--     than an assertion in a comment.
--   * `auth.uid()` reads the `request.jwt.claims` GUC, which is how Supabase
--     propagates the authenticated subject into the session.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Mirrors Supabase's implementation: read the subject from the request JWT
-- claims GUC, returning NULL when unauthenticated.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'anon')
$$;

grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- =============================================================================
-- Supabase Storage (minimal)
-- =============================================================================
-- Migration 0007 creates the private `imports` bucket and the workspace-scoped
-- policies on storage.objects. Emulating enough of the storage schema here means
-- those policies are executed and *tested* rather than merely written — a
-- cross-workspace read of a staged upload is a real assertion in
-- tests/import-storage.test.ts, not a static grep over the migration.
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets(id) on delete cascade,
  name       text not null,
  owner      uuid,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_storage_objects unique (bucket_id, name)
);

-- Supabase's helper: splits an object name into its path segments, dropping the
-- final one (the file itself). `a/b/c.csv` → {a,b}.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end
$$;

grant execute on function storage.foldername(text) to anon, authenticated, service_role;
