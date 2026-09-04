-- =============================================================================
-- 0005 — P1: contacts, contact_lists, list_members, suppressions
-- =============================================================================
-- First migration to require an extension. pg_trgm backs contact search; it is
-- available on Supabase and, for the test suite, through PGlite's contrib
-- bundle. tests/extensions.test.ts asserts it is actually installed after
-- migration, so an unavailable extension fails the build rather than silently
-- degrading search into a sequential scan.
-- =============================================================================

create extension if not exists pg_trgm;

create type suppression_reason as enum (
  'unsubscribe',
  'hard_bounce',
  'complaint',
  'invalid',
  'manually_blocked',
  'provider_suppressed'
);

-- Reasons a person may never undo through the application. Removing a complaint
-- or unsubscribe suppression re-enables sending to someone who explicitly asked
-- to stop, which is a compliance failure rather than a preference.
create or replace function app.suppression_reason_is_reversible(reason suppression_reason)
returns boolean
language sql
immutable
as $$
  select reason in ('manually_blocked', 'invalid')
$$;

-- =============================================================================
-- contacts
-- =============================================================================
create table contacts (
  id               uuid not null default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  email_normalized text not null check (length(email_normalized) between 3 and 254),
  email_raw        text not null check (length(email_raw) between 3 and 320),
  first_name       text check (first_name is null or length(first_name) <= 120),
  last_name        text check (last_name  is null or length(last_name)  <= 120),
  company          text check (company    is null or length(company)    <= 200),
  website          text check (website    is null or length(website)    <= 300),
  phone            text check (phone      is null or length(phone)      <= 50),
  custom           jsonb not null default '{}'::jsonb,
  status           text not null default 'active'
                     check (status in ('active', 'suppressed', 'invalid')),
  -- No foreign key yet: the `imports` table arrives in P2, which adds it. The
  -- column exists now so contact rows created by P2 need no backfill.
  import_id        uuid,
  -- Stored generated column so search is a filter on a real column, queryable
  -- through PostgREST and served by one GIN index. The alternative — an
  -- expression index — stores nothing but can only be hit by repeating the exact
  -- expression, which would force every search through an RPC. The cost is
  -- roughly 60-100 bytes per contact, which the free-tier budget absorbs; the
  -- benefit is that no search path can accidentally become a sequential scan.
  search_text      text generated always as (
                     email_normalized || ' ' ||
                     coalesce(first_name, '') || ' ' ||
                     coalesce(last_name, '') || ' ' ||
                     coalesce(company, '')
                   ) stored,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz,

  primary key (id),
  constraint uq_contacts_ws_email unique (workspace_id, email_normalized),
  -- Target for the composite foreign key from list_members. This is what makes
  -- cross-workspace membership structurally impossible rather than merely
  -- checked. See list_members below.
  constraint uq_contacts_ws_id unique (workspace_id, id),
  constraint ck_contacts_custom_size check (pg_column_size(custom) < 4096)
);

create trigger trg_contacts_touch
  before update on contacts
  for each row execute function app.touch_updated_at();

-- Keyset pagination ordering: (created_at desc, id desc) within a workspace.
-- Deterministic, and the index serves both the ordering and the tenant filter,
-- so listing never degrades into a sort of the whole table.
create index ix_contacts_ws_created
  on contacts (workspace_id, created_at desc, id desc);

create index ix_contacts_import
  on contacts (import_id) where import_id is not null;

-- One GIN index covering every searchable field, rather than one per column.
-- Trigram indexes are large and the free-tier budget does not justify four.
create index ix_contacts_search on contacts using gin (search_text gin_trgm_ops);

-- =============================================================================
-- contact_lists
-- =============================================================================
create table contact_lists (
  id            uuid not null default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 120),
  -- Maintained by trigger. A stored counter rather than count(*) per render:
  -- dashboard latency must not grow with list size (ARCHITECTURE §C, "analytics
  -- computed with COUNT(*)").
  contact_count integer not null default 0 check (contact_count >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,

  primary key (id),
  constraint uq_contact_lists_ws_name unique (workspace_id, name),
  constraint uq_contact_lists_ws_id   unique (workspace_id, id)
);

create trigger trg_contact_lists_touch
  before update on contact_lists
  for each row execute function app.touch_updated_at();

create index ix_contact_lists_ws_created
  on contact_lists (workspace_id, created_at desc, id desc);

-- =============================================================================
-- list_members
--
-- workspace_id is denormalised here for one reason: it lets both foreign keys be
-- composite, so PostgreSQL itself refuses to link a contact in workspace A to a
-- list in workspace B. A trigger or an application check could be bypassed by
-- any future code path; a foreign key cannot.
-- =============================================================================
create table list_members (
  workspace_id uuid not null,
  list_id      uuid not null,
  contact_id   uuid not null,
  added_at     timestamptz not null default now(),

  primary key (list_id, contact_id),

  constraint fk_list_members_list
    foreign key (workspace_id, list_id)
    references contact_lists (workspace_id, id) on delete cascade,

  constraint fk_list_members_contact
    foreign key (workspace_id, contact_id)
    references contacts (workspace_id, id) on delete cascade
);

-- The PK covers (list_id, contact_id); "which lists is this contact on" needs
-- its own index, and so does the tenant filter used by RLS.
create index ix_list_members_contact on list_members (contact_id);
create index ix_list_members_ws      on list_members (workspace_id);

-- -----------------------------------------------------------------------------
-- contact_count maintenance
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER is required, not decorative: `contact_count` is deliberately
-- outside the authenticated UPDATE grant so no client can write it directly.
-- Without definer rights this trigger would fail with "permission denied" the
-- first time a normal user added a contact to a list.
create or replace function app.sync_list_contact_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update contact_lists set contact_count = contact_count + 1 where id = new.list_id;
  elsif tg_op = 'DELETE' then
    update contact_lists set contact_count = greatest(0, contact_count - 1) where id = old.list_id;
  end if;
  return null;
end;
$$;

create trigger trg_list_members_count
  after insert or delete on list_members
  for each row execute function app.sync_list_contact_count();

-- =============================================================================
-- suppressions
--
-- Keyed by (workspace_id, email_normalized) and deliberately NOT by contact_id.
-- Three reasons (ARCHITECTURE §4.2):
--   1. An address can be suppressed before any contact for it exists.
--   2. Deleting a contact must never delete its suppression — that would
--      resurrect a mailable address, the worst data loss available here.
--   3. Import-time checks run against addresses with no contact row yet.
-- The cost is no referential integrity to contacts. Accepted deliberately.
-- =============================================================================
create table suppressions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  email_normalized text not null check (length(email_normalized) between 3 and 254),
  reason           suppression_reason not null,
  source           text not null check (length(source) between 1 and 60),
  -- No foreign key: `campaigns` arrives in P4. A suppression must also outlive
  -- the campaign that caused it, so this stays nullable and unconstrained.
  campaign_id      uuid,
  detail           text check (detail is null or length(detail) <= 500),
  created_at       timestamptz not null default now(),

  constraint uq_suppressions unique (workspace_id, email_normalized)
);

-- uq_suppressions is also the lookup index for the eligibility check, which is
-- the hottest read in the system once sending exists. No second index needed.
create index ix_suppressions_ws_created on suppressions (workspace_id, created_at desc, id desc);

-- -----------------------------------------------------------------------------
-- Suppression → contact status synchronisation
--
-- Defence in depth. The eligibility authority checks the suppressions table
-- directly and does not rely on this; the flag exists so that a suppressed
-- contact is visibly suppressed in the UI and excluded from future list-based
-- selection without a join.
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER for the same reason: `contacts.status` is derived state and
-- is excluded from the authenticated UPDATE grant, so an owner removing a
-- reversible suppression would otherwise be blocked by their own privileges.
create or replace function app.sync_contact_status_on_suppress()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update contacts
       set status = 'suppressed'
     where workspace_id = new.workspace_id
       and email_normalized = new.email_normalized
       and status = 'active';
  elsif tg_op = 'DELETE' then
    -- Only reverse the flag this trigger set. A contact marked 'invalid' stays
    -- invalid; lifting a suppression does not vouch for the address.
    update contacts
       set status = 'active'
     where workspace_id = old.workspace_id
       and email_normalized = old.email_normalized
       and status = 'suppressed';
  end if;
  return null;
end;
$$;

create trigger trg_suppressions_sync_contact
  after insert or delete on suppressions
  for each row execute function app.sync_contact_status_on_suppress();

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table contacts      enable row level security;
alter table contacts      force  row level security;
alter table contact_lists enable row level security;
alter table contact_lists force  row level security;
alter table list_members  enable row level security;
alter table list_members  force  row level security;
alter table suppressions  enable row level security;
alter table suppressions  force  row level security;

revoke all on contacts      from anon, authenticated;
revoke all on contact_lists from anon, authenticated;
revoke all on list_members  from anon, authenticated;
revoke all on suppressions  from anon, authenticated;

grant select, insert, update, delete on contacts      to service_role;
grant select, insert, update, delete on contact_lists to service_role;
grant select, insert, update, delete on list_members  to service_role;
-- The worker path may add suppressions from provider events (P6) but has no
-- reason to remove them.
revoke all on suppressions from service_role;
grant select, insert on suppressions to service_role;

-- -----------------------------------------------------------------------------
-- contacts — full CRUD for any workspace member
-- -----------------------------------------------------------------------------
grant select on contacts to authenticated;
grant insert on contacts to authenticated;
grant delete on contacts to authenticated;
-- Column-level: workspace_id and id are absent, so a tenant rewrite is refused
-- before any policy is consulted. status is absent too — it is derived from the
-- suppressions table by trigger, never set directly by a client.
grant update (email_normalized, email_raw, first_name, last_name, company, website, phone, custom, updated_at)
  on contacts to authenticated;

create policy contacts_select on contacts
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy contacts_insert on contacts
  for insert to authenticated
  with check (workspace_id in (select app.current_workspace_ids()));

create policy contacts_update on contacts
  for update to authenticated
  using      (workspace_id in (select app.current_workspace_ids()))
  with check (workspace_id in (select app.current_workspace_ids()));

create policy contacts_delete on contacts
  for delete to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

-- -----------------------------------------------------------------------------
-- contact_lists
-- -----------------------------------------------------------------------------
grant select on contact_lists to authenticated;
grant insert on contact_lists to authenticated;
grant delete on contact_lists to authenticated;
-- contact_count is trigger-maintained; clients cannot write it.
grant update (name, updated_at) on contact_lists to authenticated;

create policy contact_lists_select on contact_lists
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy contact_lists_insert on contact_lists
  for insert to authenticated
  with check (workspace_id in (select app.current_workspace_ids()));

create policy contact_lists_update on contact_lists
  for update to authenticated
  using      (workspace_id in (select app.current_workspace_ids()))
  with check (workspace_id in (select app.current_workspace_ids()));

create policy contact_lists_delete on contact_lists
  for delete to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

-- -----------------------------------------------------------------------------
-- list_members — no UPDATE at all; membership is added or removed, never edited
-- -----------------------------------------------------------------------------
grant select, insert, delete on list_members to authenticated;

create policy list_members_select on list_members
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy list_members_insert on list_members
  for insert to authenticated
  with check (workspace_id in (select app.current_workspace_ids()));

create policy list_members_delete on list_members
  for delete to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

-- -----------------------------------------------------------------------------
-- suppressions
--
-- Insert and select for any member. Removal is restricted twice over: to
-- owner/admin, and to reasons that are reversible at all. There is deliberately
-- no path — for any role, through any policy — to un-suppress a complaint, an
-- unsubscribe, a hard bounce, or a provider suppression.
-- -----------------------------------------------------------------------------
grant select, insert, delete on suppressions to authenticated;

create policy suppressions_select on suppressions
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy suppressions_insert on suppressions
  for insert to authenticated
  with check (workspace_id in (select app.current_workspace_ids()));

create policy suppressions_delete on suppressions
  for delete to authenticated
  using (
    app.has_workspace_role(workspace_id, array['owner', 'admin'])
    and app.suppression_reason_is_reversible(reason)
  );

-- No UPDATE policy for suppressions. A suppression is created or removed; its
-- reason and subject are never rewritten, because that would let an audited
-- 'complaint' be quietly relabelled 'manually_blocked' and then deleted.
