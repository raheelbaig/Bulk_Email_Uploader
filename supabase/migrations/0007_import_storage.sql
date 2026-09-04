-- =============================================================================
-- 0007 — P2: private storage for staged spreadsheet uploads
-- =============================================================================
-- The `imports` bucket is temporary staging, not a document store. A file lives
-- there from the moment the browser uploads it until the import finishes, and is
-- deleted immediately on success (ARCHITECTURE §20.1). The 24-hour sweep in
-- lib/imports/lifecycle.ts is the backstop for imports that never completed —
-- deletion is never left to the frontend.
--
-- Object key: `{workspace_id}/{import_id}/{filename}`, which reads as
-- `imports/{workspace_id}/{import_id}/{filename}` including the bucket.
-- Both ids are server-generated; the filename is sanitised before use and is
-- never a path (§20.3 — the filename is attacker-controlled).
--
-- Guarded for the `storage` schema so the migration is a no-op on a bare
-- PostgreSQL instance. The test suite emulates enough of storage
-- (supabase/testing/0000) that these policies are executed and tested for real
-- rather than asserted by grep.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'storage schema absent — skipping bucket provisioning';
    return;
  end if;

  -- ── The bucket ────────────────────────────────────────────────────────────
  -- public = false. A public bucket would make every staged upload readable by
  -- URL alone, which is the entire threat this design exists to prevent.
  --
  -- file_size_limit is the first of the two size checks required by §20.3; the
  -- second runs on the server before a byte is parsed. A limit enforced only at
  -- the upload policy is one HTTP client away from not being enforced.
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'imports',
    'imports',
    false,
    26214400,                                   -- 25 MiB
    array[
      'text/csv',
      'text/plain',
      'text/tab-separated-values',
      'application/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream'                -- browsers send this for .xlsx often enough
    ]
  )
  on conflict (id) do update
    set public             = false,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- ── RLS on the object table ───────────────────────────────────────────────
  -- Supabase enables this by default and `storage.objects` is owned by
  -- `supabase_storage_admin`, so the ALTER may be refused depending on which
  -- role runs the migration. Enabling it is therefore attempted, not demanded —
  -- but the *outcome* is then verified, and a table without RLS aborts the
  -- migration. Resilient about how it gets there; fail-closed about whether it
  -- is true.
  begin
    execute 'alter table storage.objects enable row level security';
  exception
    when insufficient_privilege then
      raise notice 'cannot alter storage.objects; relying on the project default';
  end;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects' and c.relrowsecurity
  ) then
    raise exception
      'storage.objects does not have row level security enabled — the imports bucket would be readable across workspaces';
  end if;

  -- Idempotent re-run.
  execute 'drop policy if exists imports_objects_select on storage.objects';
  execute 'drop policy if exists imports_objects_insert on storage.objects';
  execute 'drop policy if exists imports_objects_delete on storage.objects';

  -- The tenancy predicate, repeated in each policy: the first path segment must
  -- be a workspace the caller belongs to. Compared as text rather than cast to
  -- uuid, because a malformed key must fail the policy, not raise.
  execute $p$
    create policy imports_objects_select on storage.objects
      for select to authenticated
      using (
        bucket_id = 'imports'
        and exists (
          select 1 from app.current_workspace_ids() ws
          where ws::text = (storage.foldername(name))[1]
        )
      )
  $p$;

  execute $p$
    create policy imports_objects_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'imports'
        and exists (
          select 1 from app.current_workspace_ids() ws
          where ws::text = (storage.foldername(name))[1]
        )
      )
  $p$;

  -- Delete, so abandoning an upload is possible from the client. There is
  -- deliberately no UPDATE policy: an object is written once. Allowing an
  -- overwrite would let a caller swap a validated file for a different one
  -- between inspection and parsing.
  execute $p$
    create policy imports_objects_delete on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'imports'
        and exists (
          select 1 from app.current_workspace_ids() ws
          where ws::text = (storage.foldername(name))[1]
        )
      )
  $p$;

  -- On a bare instance the emulation has no grants of its own. On Supabase these
  -- already exist, so a refusal here is not a problem — the policies above are
  -- what actually constrain access, and they have been verified.
  begin
    execute 'grant select, insert, delete on storage.objects to authenticated';
    execute 'grant select on storage.buckets to authenticated';
  exception
    when insufficient_privilege then
      raise notice 'storage grants already managed by the platform';
  end;
end
$$;
