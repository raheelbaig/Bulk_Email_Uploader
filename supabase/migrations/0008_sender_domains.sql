-- =============================================================================
-- 0008 — P3: sender domains and sender identities
-- =============================================================================
-- The trusted-sender foundation. Nothing here can send email: these tables hold
-- *configuration* and *verification state* for domains the workspace has proven
-- it controls, and the addresses it may later send from.
--
-- Two structural guarantees are worth reading before the DDL, because they are
-- the reason this schema is shaped the way it is:
--
--   1. A user can never self-declare a domain verified. `authenticated` holds
--      SELECT, INSERT and DELETE on sender_domains and no UPDATE grant at all,
--      so every status column is unwritable from a browser session by column
--      privilege, before any policy is consulted. Verification state is written
--      only by the server after it has asked SES and the DNS system.
--
--   2. An identity cannot belong to a domain it is not part of. `from_domain`
--      is a generated column and the foreign key is composite —
--      (workspace_id, domain_id, from_domain) → (workspace_id, id, domain) —
--      so `hello@otherdomain.com` under `example.com`, or under another
--      workspace's domain, is refused by PostgreSQL itself. Same reasoning as
--      `list_members` in 0005: an application check can be bypassed by a future
--      code path, a foreign key cannot.
-- =============================================================================

-- Declared in ARCHITECTURE §3.1. First used here; P5/P6 reuse it.
create type verification_status as enum ('pending', 'verified', 'failed', 'not_configured');

-- =============================================================================
-- sender_domains
-- =============================================================================
create table sender_domains (
  id                uuid not null default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,

  -- Stored already normalised: lowercase, no scheme, no port, no trailing dot.
  -- The application normalises (lib/sender/domain-name.ts); these checks make it
  -- impossible for an un-normalised value to be stored by any path at all.
  domain            text not null
                      check (length(domain) between 4 and 253)
                      check (domain = lower(domain))
                      check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
                      check (domain ~ '\.[a-z]{2,}$'),

  -- Provider identity reference. Nullable: the row exists from the moment the
  -- domain is added, and provisioning may fail or be retried.
  ses_identity_arn  text check (ses_identity_arn is null or length(ses_identity_arn) <= 300),

  -- The three Easy DKIM selectors SES returns. Tokens only — the DNS record
  -- host and value are derived from them (lib/sender/records.ts) rather than
  -- stored, so there is one place that knows SES's record format.
  dkim_tokens       text[]
                      check (
                        dkim_tokens is null
                        or (
                          array_length(dkim_tokens, 1) between 1 and 3
                          and array_to_string(dkim_tokens, ',') ~ '^[a-z0-9,]+$'
                        )
                      ),

  -- Custom MAIL FROM subdomain, e.g. bounce.example.com. Constrained to be a
  -- subdomain of `domain`: a MAIL FROM pointing anywhere else would be either a
  -- misconfiguration or an attempt to have SES publish records under a domain
  -- this workspace does not control.
  mail_from_domain  text
                      check (mail_from_domain is null or mail_from_domain = lower(mail_from_domain))
                      check (mail_from_domain is null or length(mail_from_domain) <= 253)
                      check (mail_from_domain is null or mail_from_domain like ('%.' || domain)),

  spf_status        verification_status not null default 'pending',
  dkim_status       verification_status not null default 'pending',
  dmarc_status      verification_status not null default 'not_configured',
  dmarc_policy      text check (dmarc_policy is null or dmarc_policy in ('none', 'quarantine', 'reject')),
  mail_from_status  verification_status not null default 'not_configured',

  last_checked_at   timestamptz,
  -- A short, human-readable summary of the most recent failure. Bounded on
  -- purpose: ARCHITECTURE §22 — the database stores current state, never a
  -- history of raw DNS or provider payloads.
  last_check_error  text check (last_check_error is null or length(last_check_error) <= 500),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz,

  primary key (id),
  constraint uq_sender_domains_ws_domain unique (workspace_id, domain),
  -- Target for the composite foreign key from sender_identities. This is what
  -- makes a cross-workspace or wrong-domain identity structurally impossible.
  constraint uq_sender_domains_ws_id_domain unique (workspace_id, id, domain)
);

create trigger trg_sender_domains_touch
  before update on sender_domains
  for each row execute function app.touch_updated_at();

create index ix_sender_domains_ws_created
  on sender_domains (workspace_id, created_at desc, id desc);

-- The periodic re-verification sweep (lib/sender/verification.ts) orders by
-- least-recently-checked, nulls first, so a newly added domain is picked up
-- before anything already checked. A future pg_cron schedule calls that sweep;
-- this index is what keeps it from scanning the table.
create index ix_sender_domains_recheck
  on sender_domains (last_checked_at nulls first);

comment on table sender_domains is
  'Sending domains and their verification state. Status columns are derived from SES and DNS and are outside the authenticated grant.';

-- =============================================================================
-- sender_identities
-- =============================================================================
create table sender_identities (
  id           uuid not null default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  domain_id    uuid not null,

  from_email   text not null
                 check (length(from_email) between 6 and 254)
                 check (from_email = lower(from_email))
                 check (from_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'),

  -- Control characters are rejected here, not only in the application. A
  -- newline in a display name is header injection the moment P5 builds a
  -- message; refusing it at the column means no future send path can be the
  -- first place that check is missed.
  from_name    text not null
                 check (length(trim(from_name)) between 1 and 120)
                 check (from_name !~ '[[:cntrl:]]'),

  reply_to     text
                 check (reply_to is null or length(reply_to) between 6 and 254)
                 check (reply_to is null or reply_to = lower(reply_to))
                 check (reply_to is null or reply_to ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'),

  -- Derived, never supplied. Exists so the foreign key below can compare it
  -- against the parent domain's name.
  from_domain  text not null generated always as (split_part(from_email, '@', 2)) stored,

  -- Stamped by the server when the parent domain reaches a usable verification
  -- state, cleared when it leaves one. Outside the authenticated update grant.
  verified_at  timestamptz,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz,

  primary key (id),
  constraint uq_sender_identities_ws_email unique (workspace_id, from_email),

  -- The whole guarantee, in one constraint. All three columns must match a
  -- single sender_domains row, so the identity is in the same workspace as its
  -- domain AND its address sits under that exact domain name.
  --
  -- ON DELETE RESTRICT is deliberate (ARCHITECTURE §3.3): deleting a domain that
  -- identities depend on must fail loudly rather than cascade away sender
  -- configuration that a campaign references.
  constraint fk_sender_identities_domain
    foreign key (workspace_id, domain_id, from_domain)
    references sender_domains (workspace_id, id, domain)
    on delete restrict
);

create trigger trg_sender_identities_touch
  before update on sender_identities
  for each row execute function app.touch_updated_at();

create index ix_sender_identities_ws_created
  on sender_identities (workspace_id, created_at desc, id desc);

-- "Which identities does this domain have" — asked on every domain detail page
-- and by the delete path before it attempts a removal.
create index ix_sender_identities_domain on sender_identities (domain_id);

comment on table sender_identities is
  'Addresses a workspace may send from. The composite foreign key guarantees the address sits under a sender domain owned by the same workspace.';

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table sender_domains    enable row level security;
alter table sender_domains    force  row level security;
alter table sender_identities enable row level security;
alter table sender_identities force  row level security;

revoke all on sender_domains    from anon, authenticated;
revoke all on sender_identities from anon, authenticated;

-- The service role writes verification state and stamps identity verification.
-- It deliberately holds no INSERT or DELETE on sender_identities: creating and
-- removing identities is a user action, authorised in the request path, and a
-- background job has no reason to do either.
grant select, insert, update, delete on sender_domains    to service_role;
grant select, update                 on sender_identities to service_role;

-- -----------------------------------------------------------------------------
-- sender_domains
--
-- No UPDATE grant, for any column, for `authenticated`. That is the enforcement
-- of "the user can never self-declare a domain as verified": there is no policy
-- to get wrong, because there is no privilege to policy.
-- -----------------------------------------------------------------------------
grant select, insert, delete on sender_domains to authenticated;

create policy sender_domains_select on sender_domains
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy sender_domains_insert on sender_domains
  for insert to authenticated
  with check (workspace_id in (select app.current_workspace_ids()));

-- Removing a sending domain invalidates every identity under it and is not an
-- ordinary member action.
create policy sender_domains_delete on sender_domains
  for delete to authenticated
  using (app.has_workspace_role(workspace_id, array['owner', 'admin']));

-- -----------------------------------------------------------------------------
-- sender_identities
--
-- Column-level UPDATE: `from_email`, `domain_id`, `workspace_id` and
-- `verified_at` are all absent. Changing the address of an existing identity
-- would be a re-point at a different domain; that is a delete and a create, both
-- of which are audited.
-- -----------------------------------------------------------------------------
grant select, insert, delete on sender_identities to authenticated;
grant update (from_name, reply_to, updated_at) on sender_identities to authenticated;

create policy sender_identities_select on sender_identities
  for select to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy sender_identities_insert on sender_identities
  for insert to authenticated
  with check (workspace_id in (select app.current_workspace_ids()));

create policy sender_identities_update on sender_identities
  for update to authenticated
  using      (workspace_id in (select app.current_workspace_ids()))
  with check (workspace_id in (select app.current_workspace_ids()));

create policy sender_identities_delete on sender_identities
  for delete to authenticated
  using (workspace_id in (select app.current_workspace_ids()));
