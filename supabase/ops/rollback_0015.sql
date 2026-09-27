-- =============================================================================
-- ROLLBACK for migration 0015 — operator script, NOT a migration
-- =============================================================================
-- Removes ck_email_jobs_to_email_canonical. Tested by
-- tests/migration-safety.test.ts, which asserts the schema after this script
-- equals a fresh 0001–0014 build.
--
-- Run this BEFORE rollback_0011_0014.sql if both are needed: 0015's constraint
-- uses app.is_canonical_email(), which that script drops.
--
-- WHAT IS LOST: nothing. Dropping a CHECK only relaxes it; no row is touched.
-- =============================================================================

begin;

alter table email_jobs drop constraint if exists ck_email_jobs_to_email_canonical;

do $rollback$
begin
  if to_regclass('public.schema_migrations') is not null then
    delete from public.schema_migrations where filename = '0015_canonical_job_address.sql';
  end if;
end;
$rollback$;

commit;
