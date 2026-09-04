-- =============================================================================
-- 0009 — P4: templates and campaigns
-- =============================================================================
-- The campaign *preparation* layer. Everything a message needs in order to exist
-- — its content, its audience, its sender, its schedule — and nothing that could
-- deliver one.
--
-- Four structural guarantees are worth reading before the DDL, because they are
-- the reason this schema is shaped the way it is:
--
--   1. A campaign cannot reference another tenant's list, sender or template.
--      All three foreign keys are composite — (workspace_id, x_id) → (workspace_id,
--      id) — exactly as `list_members` (0005) and `sender_identities` (0008) are.
--      An application check can be bypassed by a future code path; a foreign key
--      cannot. `sender_identities` gains the unique key that makes this possible.
--
--   2. A client cannot write a campaign's status. `authenticated` holds a
--      column-level UPDATE grant that does not include `status`,
--      `template_snapshot`, `launched_at`, `launched_by`, `pause_reason` or any
--      counter, so a status rewrite is refused by column privilege before any
--      policy is consulted — the same technique that stops a user declaring
--      their own domain verified in 0008.
--
--   3. Even holding every privilege, no role can reach a sending state. The
--      status enum carries the full P5 vocabulary because the schema is fixed
--      now rather than migrated later, but `app.campaign_transition_allowed`
--      permits only the transitions P4 can honestly perform, and a trigger
--      enforces it for every role including `service_role`. `scheduled → queued`
--      is not in that list, so a scheduled campaign is inert: there is no
--      statement, from any credential, that can move it toward delivery.
--
--   4. A frozen campaign stays frozen. `template_snapshot` may only be written
--      while the campaign is (or is becoming) editable. Editing the template a
--      scheduled campaign was built from cannot change what that campaign holds.
--
-- Neither table carries a recipient address, a message id, or anything else that
-- could address a message. tests/no-sending.test.ts asserts that column by column.
-- =============================================================================

-- Declared in ARCHITECTURE §3.7. The full vocabulary is created now so that P5
-- adds transitions rather than migrating an enum under live data. See guarantee
-- 3 above for why the later values are unreachable.
create type campaign_status as enum (
  'draft',
  'validating',
  'scheduled',
  'queued',
  'sending',
  'paused',
  'completed',
  'cancelled',
  'failed'
);

-- =============================================================================
-- templates
-- =============================================================================
create table templates (
  id           uuid not null default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,

  name         text not null check (length(trim(name)) between 1 and 120),

  -- A newline in a subject is header injection the moment P5 composes a
  -- message. Refused at the column so no future send path can be the first
  -- place that check is missed — the same reasoning as sender_identities.from_name.
  subject      text not null
                 check (length(subject) between 1 and 200)
                 check (subject !~ '[[:cntrl:]]'),

  preview_text text
                 check (preview_text is null or length(preview_text) <= 200)
                 check (preview_text is null or preview_text !~ '[[:cntrl:]]'),

  -- Stored already sanitised. The application sanitises on the way in
  -- (lib/templates/sanitize.ts); this is the size backstop only, because HTML is
  -- structure and PostgreSQL cannot judge it.
  html         text not null check (length(html) < 512000),   -- 500 KB, ARCHITECTURE §3.7
  text         text not null check (length(text) < 256000),

  -- Extracted and whitelisted at save. The character class is deliberately
  -- narrow: a variable name is `first_name` or `custom.plan`, never an
  -- expression, so nothing resembling one can be stored here at all.
  variables    text[] not null default '{}'
                 check (
                   coalesce(array_length(variables, 1), 0) <= 40
                   and (
                     coalesce(array_length(variables, 1), 0) = 0
                     or array_to_string(variables, ',') ~ '^[a-z][a-z0-9_.]*(,[a-z][a-z0-9_.]*)*$'
                   )
                 ),

  -- Incremented by trigger whenever the *content* changes. Outside the
  -- authenticated grant, so a client cannot rewind a version number and make an
  -- audited edit look like it never happened.
  version      integer not null default 1 check (version >= 1),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz,

  primary key (id),
  constraint uq_templates_ws_name unique (workspace_id, name),
  -- Target for the composite foreign key from campaigns.
  constraint uq_templates_ws_id   unique (workspace_id, id)
);

create trigger trg_templates_touch
  before update on templates
  for each row execute function app.touch_updated_at();

create index ix_templates_ws_created
  on templates (workspace_id, created_at desc, id desc);

-- -----------------------------------------------------------------------------
-- Version maintenance
--
-- A plain (non-definer) BEFORE trigger: column privileges are checked against
-- the columns named in the UPDATE statement, not against values a trigger
-- assigns, so this works even though `version` is outside the authenticated
-- grant. Renaming a template is not a content change and does not bump it.
-- -----------------------------------------------------------------------------
create or replace function app.bump_template_version()
returns trigger
language plpgsql
as $fn$
begin
  if new.subject         is distinct from old.subject
     or new.preview_text is distinct from old.preview_text
     or new.html         is distinct from old.html
     or new.text         is distinct from old.text
     or new.variables    is distinct from old.variables
  then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$fn$;

create trigger trg_templates_version
  before update on templates
  for each row execute function app.bump_template_version();

comment on table templates is
  'Reusable message content. Stored sanitised; variables is the whitelisted set extracted at save. Carries no recipient.';

-- =============================================================================
-- Cross-workspace structural key for sender identities
-- =============================================================================
-- Needed by fk_campaigns_sender below. `contact_lists` and `templates` already
-- carry the equivalent; this brings 0008's table into line so all three campaign
-- references are guaranteed by PostgreSQL rather than checked by application code.
-- =============================================================================
alter table sender_identities
  add constraint uq_sender_identities_ws_id unique (workspace_id, id);

-- =============================================================================
-- campaigns
-- =============================================================================
create table campaigns (
  id                   uuid not null default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,

  name                 text not null check (length(trim(name)) between 1 and 160),
  status               campaign_status not null default 'draft',

  -- All three are composite (see guarantee 1). ON DELETE RESTRICT throughout:
  -- deleting a list, sender or template a campaign depends on must fail loudly
  -- rather than quietly leave a campaign that no longer means what it said.
  template_id          uuid,
  sender_identity_id   uuid,
  list_id              uuid,

  -- The frozen copy. Written when the campaign is scheduled, and unwritable
  -- thereafter (guarantee 4). ARCHITECTURE §3.7: editing a template mid-campaign
  -- must not change what the campaign holds, or the campaign is not reproducible
  -- and the audit log is a lie.
  template_snapshot    jsonb
                         check (template_snapshot is null or pg_column_size(template_snapshot) < 786432),

  scheduled_at         timestamptz,
  launched_at          timestamptz,
  completed_at         timestamptz,

  -- Marketing mail requires a working one-click unsubscribe. P6 builds it; this
  -- column records the campaign's own requirement now so the preflight can state
  -- it explicitly rather than discovering it later.
  requires_unsubscribe boolean not null default true,

  max_rate_override    integer check (max_rate_override is null or max_rate_override between 1 and 100000),
  pause_reason         text check (pause_reason is null or length(pause_reason) <= 500),
  launched_by          uuid references auth.users(id),

  -- Delivery counters. Declared now so P5 adds a worker rather than a migration
  -- under live data. Nothing in P4 writes them, and no browser session may:
  -- they are outside every UPDATE grant except the service role's.
  n_total              integer not null default 0 check (n_total        >= 0),
  n_sent               integer not null default 0 check (n_sent         >= 0),
  n_delivered          integer not null default 0 check (n_delivered    >= 0),
  n_bounced            integer not null default 0 check (n_bounced      >= 0),
  n_complained         integer not null default 0 check (n_complained   >= 0),
  n_failed             integer not null default 0 check (n_failed       >= 0),
  n_unsubscribed       integer not null default 0 check (n_unsubscribed >= 0),
  n_suppressed         integer not null default 0 check (n_suppressed   >= 0),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz,

  primary key (id),

  constraint fk_campaigns_template
    foreign key (workspace_id, template_id)
    references templates (workspace_id, id) on delete restrict,

  constraint fk_campaigns_sender
    foreign key (workspace_id, sender_identity_id)
    references sender_identities (workspace_id, id) on delete restrict,

  constraint fk_campaigns_list
    foreign key (workspace_id, list_id)
    references contact_lists (workspace_id, id) on delete restrict,

  -- A scheduled campaign is fully specified, at the database. This is what makes
  -- 'scheduled' mean something: not a status a half-built row can wear.
  constraint ck_campaigns_scheduled_complete check (
    status <> 'scheduled'
    or (
      scheduled_at           is not null
      and template_id        is not null
      and sender_identity_id is not null
      and list_id            is not null
      and template_snapshot  is not null
    )
  )
);

create trigger trg_campaigns_touch
  before update on campaigns
  for each row execute function app.touch_updated_at();

-- "Which campaigns are in this state" — the campaign list page and, later, the
-- promotion sweep.
create index ix_campaigns_ws_status  on campaigns (workspace_id, status);
create index ix_campaigns_ws_created on campaigns (workspace_id, created_at desc, id desc);
create index ix_campaigns_template   on campaigns (template_id) where template_id is not null;
create index ix_campaigns_sender     on campaigns (sender_identity_id) where sender_identity_id is not null;
create index ix_campaigns_list       on campaigns (list_id) where list_id is not null;

-- ARCHITECTURE §3.7. Partial, so it holds only rows a future promotion sweep
-- would look at. No such sweep exists in P4, and the transition rules below make
-- one impossible to write without a migration that says so out loud.
create index ix_campaigns_due on campaigns (scheduled_at) where status = 'scheduled';

comment on table campaigns is
  'Prepared campaigns. Carries no recipient and no message id; status is unwritable by clients and cannot reach a sending state (migration 0009).';

-- =============================================================================
-- The state machine
-- =============================================================================
-- The complete set of transitions this deployment can perform. P5 extends this
-- function — and the reachable states change only when someone edits it in a
-- migration, which is a reviewable event rather than an emergent property of
-- application code.
--
-- Absent, deliberately: every transition that leads toward delivery.
--   scheduled → queued    (the promotion sweep — P5)
--   queued    → sending   (the worker claim — P5)
--   sending   → paused / completed / failed, paused → sending  (P5)
-- =============================================================================
create or replace function app.campaign_transition_allowed(
  old_status campaign_status,
  new_status campaign_status
)
returns boolean
language sql
immutable
as $fn$
  select case old_status
    -- Preflight moves a draft into validation; a draft may also be abandoned.
    when 'draft'      then new_status in ('validating', 'cancelled')
    -- Preflight passed → scheduled. Preflight failed → back to draft.
    when 'validating' then new_status in ('scheduled', 'draft', 'cancelled')
    -- A scheduled campaign may be unscheduled for editing, or abandoned. It may
    -- NOT advance: there is no send path to advance into.
    when 'scheduled'  then new_status in ('draft', 'cancelled')
    else false
  end
$fn$;

comment on function app.campaign_transition_allowed(campaign_status, campaign_status) is
  'The complete campaign state machine. No transition here leads toward delivery; P5 must edit this function to add one.';

create or replace function app.guard_campaign_write()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'INSERT' then
    -- A campaign is always born a draft. Without this, INSERT would be a way
    -- around the transition table for any role holding the privilege.
    if new.status <> 'draft' then
      raise exception 'a campaign may only be created in the draft state'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'a campaign cannot move between workspaces'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status
     and not app.campaign_transition_allowed(old.status, new.status) then
    raise exception 'campaign transition % to % is not permitted', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Guarantee 4. The snapshot may be written while the campaign is editable, or
  -- as part of the statement that makes it editable again. A scheduled campaign
  -- whose status is not changing cannot have its frozen content rewritten, and
  -- nothing downstream of 'scheduled' can touch it at all.
  if new.template_snapshot is distinct from old.template_snapshot
     and old.status not in ('draft', 'validating')
     and new.status not in ('draft', 'validating') then
    raise exception 'the template snapshot of a % campaign cannot be changed', old.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger trg_campaigns_guard
  before insert or update on campaigns
  for each row execute function app.guard_campaign_write();

-- =============================================================================
-- Audience counts
-- =============================================================================
-- The campaign builder needs three numbers for a list: how many contacts it
-- holds, how many are sendable, and how many are held back. Computing them in
-- the browser would mean shipping the audience to it; computing them per contact
-- would be an N+1 over the largest object in the system.
--
-- The bucket expression below is the SQL form of `decide()` in
-- lib/eligibility/index.ts, in the same precedence order — suppression first,
-- then contact status — exactly as ARCHITECTURE §8.1 describes for the P5 claim.
-- tests/campaign-audience.test.ts asserts the two agree row for row against the
-- eligibility authority itself, so they cannot drift silently.
--
-- SECURITY INVOKER: RLS applies to the caller, so this cannot be used to read
-- another tenant's list even with a forged workspace id.
-- =============================================================================
create or replace function public.campaign_audience_counts(
  p_workspace_id uuid,
  p_list_id uuid,
  p_limit integer default 200000
)
returns table (total bigint, eligible bigint, suppressed bigint, inactive bigint, capped boolean)
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  with bounded as (
    select c.status,
           (s.email_normalized is not null) as is_suppressed
      from list_members lm
      join contacts c
        on c.workspace_id = lm.workspace_id
       and c.id = lm.contact_id
      left join suppressions s
        on s.workspace_id = c.workspace_id
       and s.email_normalized = c.email_normalized
     where lm.workspace_id = p_workspace_id
       and lm.list_id = p_list_id
     limit greatest(1, least(coalesce(p_limit, 200000), 1000000))
  )
  select count(*)::bigint,
         count(*) filter (where not is_suppressed and status = 'active')::bigint,
         count(*) filter (where is_suppressed)::bigint,
         count(*) filter (where not is_suppressed and status <> 'active')::bigint,
         (count(*) >= greatest(1, least(coalesce(p_limit, 200000), 1000000)))
    from bounded
$fn$;

revoke all on function public.campaign_audience_counts(uuid, uuid, integer) from public;
grant execute on function public.campaign_audience_counts(uuid, uuid, integer)
  to authenticated, service_role;


-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table templates enable row level security;
alter table templates force  row level security;
alter table campaigns enable row level security;
alter table campaigns force  row level security;

revoke all on templates from anon, authenticated;
revoke all on campaigns from anon, authenticated;

grant select, insert, update, delete on templates to service_role;
grant select, insert, update, delete on campaigns to service_role;

-- -----------------------------------------------------------------------------
-- templates
--
-- Column-level UPDATE: `version` is absent, so a client cannot rewind it, and
-- `workspace_id`/`id` are absent, so a tenant rewrite is refused before any
-- policy runs.
-- -----------------------------------------------------------------------------
grant select, delete on templates to authenticated;
grant insert (workspace_id, name, subject, preview_text, html, text, variables)
  on templates to authenticated;
grant update (name, subject, preview_text, html, text, variables, updated_at)
  on templates to authenticated;

create policy templates_select on templates
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy templates_insert on templates
  for insert to authenticated
  with check (workspace_id in (select app.current_workspace_ids()));

create policy templates_update on templates
  for update to authenticated
  using      (workspace_id in (select app.current_workspace_ids()))
  with check (workspace_id in (select app.current_workspace_ids()));

-- ON DELETE RESTRICT on fk_campaigns_template means a template a campaign
-- references cannot be deleted at all — the database refuses it, so a scheduled
-- campaign can never lose the row its snapshot was taken from.
create policy templates_delete on templates
  for delete to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

-- -----------------------------------------------------------------------------
-- campaigns
--
-- The important line in this section is the UPDATE grant. `status`,
-- `template_snapshot`, `launched_at`, `launched_by`, `completed_at`,
-- `pause_reason` and every counter are absent from it. A browser session holds
-- no privilege on those columns, so `update campaigns set status = 'sending'`
-- is refused by PostgreSQL before RLS is consulted — and would then be refused
-- again by the transition trigger, for every role.
-- -----------------------------------------------------------------------------
grant select on campaigns to authenticated;
grant insert (workspace_id, name, requires_unsubscribe) on campaigns to authenticated;
grant update (
  name,
  template_id,
  sender_identity_id,
  list_id,
  scheduled_at,
  requires_unsubscribe,
  max_rate_override,
  updated_at
) on campaigns to authenticated;
grant delete on campaigns to authenticated;

create policy campaigns_select on campaigns
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy campaigns_insert on campaigns
  for insert to authenticated
  with check (workspace_id in (select app.current_workspace_ids()));

-- Both clauses carry the state predicate: a campaign may only be edited while it
-- is editable, and the edit may not leave it in a non-editable state. The status
-- column itself is unreachable here, so this policy governs content only.
create policy campaigns_update on campaigns
  for update to authenticated
  using      (
    workspace_id in (select app.current_workspace_ids())
    and status in ('draft', 'validating')
  )
  with check (
    workspace_id in (select app.current_workspace_ids())
    and status in ('draft', 'validating')
  );

-- A campaign that was never scheduled, or was abandoned, may be removed. One
-- that reached any other state is history and stays.
create policy campaigns_delete on campaigns
  for delete to authenticated
  using (
    workspace_id in (select app.current_workspace_ids())
    and status in ('draft', 'cancelled')
  );
