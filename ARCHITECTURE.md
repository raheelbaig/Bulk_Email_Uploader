# Sending Platform Blueprint

**Pre-implementation architecture and security design**
Multi-tenant email campaign platform — Next.js + Supabase + Amazon SES

| | |
|---|---|
| Document date | 2026-09-03 |
| Status | Design proposal, pre-implementation |
| Codebase state | Empty directory — greenfield build, nothing to audit |
| Intended audience | Architecture / security reviewer |

> **Audit finding.** The `Email-Uploader` directory contained zero files at the time of review — no `package.json`, no git repository, no source. There is no existing architecture, schema, auth, or API surface. Sections describing "current state" therefore report nothing rather than inventing findings. Everything below is target design.

> **Amendments.** Two decisions in this document have been superseded following review. Read the ADRs
> alongside the sections they amend:
>
> - [**ADR-0001 — SES send idempotency and the crash window**](docs/adr/0001-ses-send-idempotency.md)
>   supersedes §13.4. The write-ordering trade-off is replaced by a durable pre-call attempt record plus
>   event-based reconciliation, and the failure behaviour is now **fail-closed** rather than
>   accept-a-duplicate.
> - [**ADR-0002 — Availability, scheduling, and the recovery model**](docs/adr/0002-availability-and-recovery.md)
>   amends §12.1, §12.5 and §25.2. The claim that per-minute cron prevents free-tier auto-pause is
>   **withdrawn**; scheduling, queue processing and project availability are now treated as separate
>   concerns with an explicit recovery model.

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [Technology stack and reasoning](#2-technology-stack-and-reasoning)
3. [Complete database schema](#3-complete-database-schema)
4. [Tables and relationships](#4-tables-and-relationships)
5. [Indexes](#5-indexes)
6. [RLS and security model](#6-rls-and-security-model)
7. [`email_jobs` design](#7-email_jobs-design)
8. [Atomic job-claim logic](#8-atomic-job-claim-logic)
9. [Suppression race-condition handling](#9-suppression-race-condition-handling)
10. [Stateless HMAC unsubscribe tokens](#10-stateless-hmac-unsubscribe-tokens)
11. [pgmq queue architecture](#11-pgmq-queue-architecture)
12. [pg_cron + pg_net scheduling flow](#12-pg_cron--pg_net-scheduling-flow)
13. [Worker lifecycle](#13-worker-lifecycle)
14. [Retry and failure strategy](#14-retry-and-failure-strategy)
15. [Amazon SES integration](#15-amazon-ses-integration)
16. [SES event and webhook architecture](#16-ses-event-and-webhook-architecture)
17. [Sender Health Engine](#17-sender-health-engine)
18. [Adaptive throttling and rate controller](#18-adaptive-throttling-and-rate-controller)
19. [Campaign state machine](#19-campaign-state-machine)
20. [Excel / CSV import pipeline](#20-excel--csv-import-pipeline)
21. [Contact validation and deduplication](#21-contact-validation-and-deduplication)
22. [Data retention strategy](#22-data-retention-strategy)
23. [Audit logging](#23-audit-logging)
24. [Security and threat model](#24-security-and-threat-model)
25. [Cost and infrastructure assumptions](#25-cost-and-infrastructure-assumptions)
26. [Vercel deployment considerations](#26-vercel-deployment-considerations)
27. [Platform limitations and risks](#27-platform-limitations-and-risks)
28. [Locked architectural decisions](#28-locked-architectural-decisions)
29. [Flexible decisions](#29-flexible-decisions)
30. [Recommended implementation phases](#30-recommended-implementation-phases)

---

## 1. Architecture overview

### 1.1 Shape of the system

Four planes, deliberately separated:

```
┌─────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE  — Next.js on Vercel                             │
│  App Router UI · Server Actions · Route Handlers                │
│  Auth session · Campaign builder · Preflight · Dashboards       │
└────────────────────────────┬────────────────────────────────────┘
                             │ authenticated user requests (RLS on)
┌────────────────────────────▼────────────────────────────────────┐
│  STATE PLANE  — Supabase Postgres                               │
│  Tables · RLS policies · Constraints · Triggers                 │
│  pgmq queues · rate_ledger · pg_cron schedules                  │
└────────────────────────────┬────────────────────────────────────┘
                             │ pg_net HTTP (HMAC-signed)
┌────────────────────────────▼────────────────────────────────────┐
│  EXECUTION PLANE  — worker route handler (service role)         │
│  Tick → policy check → claim → render → send → record           │
└────────────────────────────┬────────────────────────────────────┘
                             │ AWS SDK (SigV4)
┌────────────────────────────▼────────────────────────────────────┐
│  DELIVERY PLANE  — Amazon SES v2 + SNS                          │
│  SendEmail · GetAccount · Configuration set → SNS → webhook     │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 The send path

```
Campaign (draft)
    ↓
Preflight Engine ──── BLOCK on any critical failure
    ↓
Materialize email_jobs   (one row per recipient, frozen merge data)
    ↓
Enqueue pgmq messages
    ↓
pg_cron tick (per minute) → pg_net → worker endpoint
    ↓
Policy Engine  → ALLOW | THROTTLE | PAUSE | BLOCK
    ↓
Rate Controller (atomic budget reservation)
    ↓
Atomic claim (suppression check inside the UPDATE)
    ↓
Render template → SES v2 SendEmail
    ↓
Record provider_message_id
    ↓
SES config set → SNS → webhook → events → suppression → health
    ↓
Health feeds back into the Policy Engine
```

The loop closes: delivery outcomes feed sender health, sender health feeds the policy engine, the policy engine governs the next tick's rate.

### 1.3 The single most important structural rule

**Exactly one function decides whether a message may be sent.** Campaign launch, worker tick, test send, and retry all call it. Nothing else queries the suppression table to make a decision.

Essentially every duplicate-send and send-to-suppressed incident in this product category traces back to a second code path that reimplemented the check slightly differently. Centralising it is the highest-leverage decision in the design.

```ts
// lib/policy/index.ts — the only sending authority in the codebase
export type PolicyDecision =
  | { action: 'ALLOW';    budget: number }
  | { action: 'THROTTLE'; budget: number; reason: string }
  | { action: 'PAUSE';    reason: string; code: PolicyCode }
  | { action: 'BLOCK';    reason: string; code: PolicyCode };

export async function evaluateSendPolicy(
  ctx: { workspaceId: string; campaignId?: string; kind: 'campaign' | 'test' },
): Promise<PolicyDecision>;
```

### 1.4 Design principle

> **Make the safe action the default action.**

Concretely: a campaign cannot leave `draft` without passing preflight; a job cannot be sent twice because a unique constraint forbids it; a suppressed recipient cannot be mailed because the check is inside the claim transaction; sending stops on its own when health degrades, and resuming never returns straight to full rate.

---

## 2. Technology stack and reasoning

| Layer | Choice | Reasoning |
|---|---|---|
| Framework | Next.js (App Router) | Server Actions and Route Handlers keep all privileged logic server-side by default. RSC keeps large contact lists off the client. |
| Language | TypeScript, `strict: true` | Plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Non-negotiable for a system where a type error can mean a double send. |
| Database | Supabase Postgres | Postgres gives the constraint primitives the idempotency model depends on: partial unique indexes, `ON CONFLICT`, advisory locks, transactional DDL. |
| ORM | Drizzle | Schema-as-TypeScript with SQL-shaped queries. It does not hide the query, which matters when the query *is* the lock. RLS policies, triggers, and functions stay in raw SQL migrations — Drizzle owns tables, not policies. |
| Auth | Supabase Auth (SSR cookies) | Sessions in httpOnly cookies, refreshed in middleware. Integrates with RLS via `auth.uid()`. |
| Authorization | RLS **plus** explicit server-side checks | Two independent layers. See §6 for why RLS alone is insufficient. |
| UI | Tailwind + shadcn/ui + Lucide | shadcn is copy-in, not a dependency — no version churn on a long-lived product. |
| Queue | pgmq | Transactional enqueue with the data write. No second datastore, no dual-write problem, no Redis. |
| Scheduler | **pg_cron + pg_net** (not Vercel Cron) | See §27 R1. Vercel Hobby cron is daily-granularity; the worker needs a ~1-minute tick. |
| Email | Amazon SES v2 | Cheapest credible provider, real quota introspection via `GetAccount`, first-class event stream via configuration sets. |
| Events | SES config set → SNS → HTTPS | Push, not poll. Signature-verifiable. |
| Validation | Zod | Parse at every trust boundary. |
| Spreadsheets | SheetJS (XLSX/XLS) + streaming CSV parser | See §27 R5 — SheetJS is the wrong tool for large CSVs. |
| Charts | Recharts | Only where a chart earns its place. |
| Package manager | pnpm | Strict node_modules layout catches phantom dependencies. |

### 2.1 Deliberate non-choices

| Rejected | Why |
|---|---|
| Redis / BullMQ | pgmq covers the requirement. Adding Redis introduces a dual-write problem between the job row and the queue message, which is exactly the class of bug this design exists to prevent. Revisit only if sustained throughput outgrows Postgres, which will not happen at the volumes in scope. |
| Prisma | Heavier runtime, and its query builder obscures the exact SQL of the atomic claim. |
| Dedicated IP | Actively harmful at low volume — a dedicated IP needs sustained daily traffic to warm, and a cold one delivers worse than the shared pool. |
| Open/click tracking pixels | Off by default. Legitimate as an opt-in analytics feature, but it is not needed for the health engine, adds privacy surface, and the brief explicitly forbids fabricated engagement. If enabled later it must be user-visible and disclosed. |
| Storing raw spreadsheets permanently | Staging only, 24h lifecycle. The database stores structured data, not files. |

---

## 3. Complete database schema

All tables live in `public`. Every workspace-scoped table carries `workspace_id uuid not null` and has RLS enabled with no permissive default.

Conventions: `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at timestamptz` maintained by trigger.

### 3.1 Enumerated types

```sql
create type campaign_status as enum (
  'draft', 'validating', 'scheduled', 'queued',
  'sending', 'paused', 'completed', 'cancelled', 'failed'
);

create type job_status as enum (
  'pending', 'claimed', 'sent', 'delivered', 'bounced',
  'complained', 'failed', 'suppressed', 'cancelled'
);

create type suppression_reason as enum (
  'unsubscribe', 'hard_bounce', 'complaint',
  'invalid', 'manually_blocked', 'provider_suppressed'
);

create type event_type as enum (
  'send', 'delivery', 'bounce', 'complaint',
  'reject', 'rendering_failure', 'delivery_delay'
);

create type health_state as enum ('healthy', 'attention', 'throttled', 'paused');

create type verification_status as enum ('pending', 'verified', 'failed', 'not_configured');

create type import_status as enum (
  'uploaded', 'mapping', 'processing', 'completed', 'failed'
);
```

### 3.2 Tenancy

```sql
create table workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- operator-set ceiling, independent of provider limits
  daily_send_cap      integer not null default 10000,
  max_rate_per_second integer not null default 5,
  created_at  timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'owner'
                 check (role in ('owner', 'admin', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
```

### 3.3 Sender configuration

```sql
create table sender_domains (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  domain            text not null,
  ses_identity_arn  text,
  dkim_tokens       text[],                    -- three CNAME hosts from Easy DKIM
  mail_from_domain  text,                      -- custom MAIL FROM subdomain
  spf_status        verification_status not null default 'pending',
  dkim_status       verification_status not null default 'pending',
  dmarc_status      verification_status not null default 'not_configured',
  dmarc_policy      text,                      -- none | quarantine | reject
  mail_from_status  verification_status not null default 'not_configured',
  last_checked_at   timestamptz,
  last_check_error  text,
  created_at        timestamptz not null default now(),
  constraint uq_domain unique (workspace_id, domain)
);

create table sender_identities (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  domain_id    uuid not null references sender_domains(id) on delete restrict,
  from_email   text not null,
  from_name    text not null,
  reply_to     text,
  verified_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint uq_identity unique (workspace_id, from_email)
);
```

> `on delete restrict` on `domain_id` is deliberate. Deleting a domain that identities depend on must fail loudly rather than cascade away sender configuration a live campaign references.

### 3.4 Contacts

```sql
create table contacts (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  email_normalized text not null,      -- canonical form, used for all matching
  email_raw        text not null,      -- exactly as supplied, for display/audit
  first_name       text,
  last_name        text,
  company          text,
  website          text,
  phone            text,
  custom           jsonb not null default '{}'::jsonb,
  status           text not null default 'active'
                     check (status in ('active', 'suppressed', 'invalid')),
  import_id        uuid references imports(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz,
  constraint uq_contact_email unique (workspace_id, email_normalized),
  constraint ck_custom_size check (pg_column_size(custom) < 4096)
);

create table contact_lists (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  contact_count integer not null default 0,   -- maintained by trigger
  created_at    timestamptz not null default now()
);

create table list_members (
  list_id    uuid not null references contact_lists(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (list_id, contact_id)
);
```

> `ck_custom_size` exists because a JSONB column with no bound is how a 500 MB database dies. 4 KB per contact is generous for custom fields and hard-caps the worst case.

### 3.5 Imports

```sql
create table imports (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  actor_id         uuid not null references auth.users(id),
  filename         text not null,
  byte_size        bigint not null,
  content_type     text not null,
  storage_path     text not null,
  status           import_status not null default 'uploaded',
  column_mapping   jsonb,               -- confirmed header → field mapping
  target_list_id   uuid references contact_lists(id) on delete set null,
  rows_total       integer not null default 0,
  rows_valid       integer not null default 0,
  rows_invalid     integer not null default 0,
  rows_duplicate   integer not null default 0,
  rows_suppressed  integer not null default 0,
  rows_rejected    integer not null default 0,
  error_message    text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  -- the six buckets must account for every input row
  constraint ck_rows_reconcile check (
    status <> 'completed' or
    rows_total = rows_valid + rows_invalid + rows_duplicate
               + rows_suppressed + rows_rejected
  )
);

create table import_rejections (
  id          uuid primary key default gen_random_uuid(),
  import_id   uuid not null references imports(id) on delete cascade,
  row_number  integer not null,
  raw_row     jsonb not null,
  bucket      text not null
                check (bucket in ('invalid','duplicate','suppressed','rejected')),
  reason      text not null,
  created_at  timestamptz not null default now()
);
```

> `ck_rows_reconcile` is the constraint that enforces "never silently discard records" at the database level rather than by convention. A completed import whose buckets do not sum to the row total cannot be written.

### 3.6 Suppression

```sql
create table suppressions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  email_normalized text not null,
  reason           suppression_reason not null,
  source           text not null,     -- 'sns_bounce' | 'unsubscribe_link' | 'manual' | ...
  campaign_id      uuid references campaigns(id) on delete set null,
  detail           text,
  created_at       timestamptz not null default now(),
  constraint uq_suppression unique (workspace_id, email_normalized)
);
```

Suppression is **workspace-scoped, not global across tenants**. Sharing suppression between unrelated tenants would leak one customer's list state to another (a probe: import an address, attempt a send, observe whether it is suppressed). A platform-level block list for abuse handling is a separate, operator-only table if ever needed.

### 3.7 Templates and campaigns

```sql
create table templates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name         text not null,
  subject      text not null,
  preview_text text,
  html         text not null,
  text         text not null,
  variables    text[] not null default '{}',   -- extracted + whitelisted at save
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  constraint ck_html_size check (length(html) < 512000)   -- 500 KB
);

create table campaigns (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references workspaces(id) on delete cascade,
  name                  text not null,
  status                campaign_status not null default 'draft',
  template_id           uuid references templates(id) on delete restrict,
  template_snapshot     jsonb,          -- frozen copy at launch
  sender_identity_id    uuid references sender_identities(id) on delete restrict,
  list_id               uuid references contact_lists(id) on delete restrict,
  scheduled_at          timestamptz,
  launched_at           timestamptz,
  completed_at          timestamptz,
  requires_unsubscribe  boolean not null default true,
  max_rate_override     integer,        -- optional per-campaign ceiling
  pause_reason          text,
  launched_by           uuid references auth.users(id),
  n_total               integer not null default 0,
  n_sent                integer not null default 0,
  n_delivered           integer not null default 0,
  n_bounced             integer not null default 0,
  n_complained          integer not null default 0,
  n_failed              integer not null default 0,
  n_unsubscribed        integer not null default 0,
  n_suppressed          integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz
);
```

`template_snapshot` freezes subject, HTML, text and the variable list at launch. Editing a template mid-campaign must not change what the remaining recipients receive — that would make the campaign non-reproducible and the audit log a lie.

### 3.8 Jobs and events

```sql
create table email_jobs (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  campaign_id         uuid not null references campaigns(id) on delete cascade,
  contact_id          uuid not null references contacts(id) on delete cascade,
  status              job_status not null default 'pending',
  to_email            text not null,          -- normalized, denormalized at launch
  merge_data          jsonb not null default '{}'::jsonb,
  scheduled_at        timestamptz not null default now(),
  claimed_at          timestamptz,
  sent_at             timestamptz,
  attempts            smallint not null default 0,
  next_attempt_at     timestamptz,
  provider_message_id text,
  last_error_code     text,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz,
  constraint uq_job_recipient unique (campaign_id, contact_id),
  constraint ck_attempts check (attempts <= 5)
);

create table email_events (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  job_id            uuid references email_jobs(id) on delete cascade,
  campaign_id       uuid references campaigns(id) on delete cascade,
  type              event_type not null,
  occurred_at       timestamptz not null,
  provider_event_id text not null,          -- SNS MessageId
  bounce_type       text,                   -- Permanent | Transient | Undetermined
  bounce_subtype    text,
  diagnostic_code   text,
  summary           jsonb not null default '{}'::jsonb,
  received_at       timestamptz not null default now(),
  constraint uq_event unique (provider_event_id)
);

-- short-retention side table; see §22
create table event_raw (
  event_id   uuid primary key references email_events(id) on delete cascade,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);
```

### 3.9 Rate, health, audit

```sql
create table rate_ledger (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  granularity  text not null check (granularity in ('second', 'day')),
  window_start timestamptz not null,
  consumed     integer not null default 0,
  primary key (workspace_id, granularity, window_start)
);

create table sender_health_daily (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  day          date not null,
  sent         integer not null default 0,
  delivered    integer not null default 0,
  hard_bounced integer not null default 0,
  soft_bounced integer not null default 0,
  complaints   integer not null default 0,
  failures     integer not null default 0,
  unsubscribed integer not null default 0,
  provider_errors integer not null default 0,
  score        smallint,
  state        health_state,
  primary key (workspace_id, day)
);

create table audit_logs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_id     uuid references auth.users(id) on delete set null,
  actor_type   text not null default 'user'
                 check (actor_type in ('user', 'system', 'provider')),
  action       text not null,
  entity_type  text,
  entity_id    uuid,
  metadata     jsonb not null default '{}'::jsonb,
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now()
);

-- API rate limiting, fixed-window
create table rate_limits (
  bucket_key   text not null,      -- e.g. 'user:<uuid>:import'
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket_key, window_start)
);
```

---

## 4. Tables and relationships

```
auth.users
    │
    └──< workspace_members >── workspaces
                                   │
    ┌──────────────┬───────────────┼──────────────┬──────────────┐
    │              │               │              │              │
sender_domains  contacts       templates      contact_lists   imports
    │              │               │              │              │
    │         list_members ────────┼──────────────┘         import_rejections
    │              │               │
sender_identities  │           campaigns
    │              │            │    │
    └──────────────┴────────────┘    │
                   │                 │
                   └──> email_jobs <─┘
                            │
                        email_events
                            │
                        event_raw

suppressions ──────── (matched by workspace_id + email_normalized,
                       intentionally NOT a foreign key to contacts)
```

### 4.1 Cardinalities

| Relationship | Cardinality | Delete behaviour |
|---|---|---|
| workspace → members | 1:N | cascade |
| workspace → contacts | 1:N | cascade |
| contact_list ↔ contacts | M:N via `list_members` | cascade both sides |
| sender_domain → identities | 1:N | **restrict** |
| campaign → email_jobs | 1:N | cascade |
| contact → email_jobs | 1:N | cascade |
| email_job → email_events | 1:N | cascade |
| email_event → event_raw | 1:1 | cascade |
| import → contacts | 1:N | set null |

### 4.2 Why suppression has no foreign key to contacts

Suppression is keyed on `(workspace_id, email_normalized)`, not `contact_id`. Three reasons:

1. An address can be suppressed **before** it is ever imported as a contact — a manual block, or a complaint arriving for an address whose contact row was deleted.
2. Deleting a contact must not delete the suppression record. That would resurrect a mailable address, which is the single worst data-integrity failure this system can have.
3. Import-time suppression checks run against addresses that have no contact row yet.

The trade-off is no referential integrity between the two, accepted deliberately. The unique constraint on `(workspace_id, email_normalized)` in both tables keeps the join key sound.

### 4.3 Why there is no `campaign_recipients` table

`email_jobs` **is** the recipient list. A separate recipients table would double the row count on the largest table in the system to store the same three columns, and would introduce a second place where "who is in this campaign" is recorded — which is a divergence bug waiting to happen. `email_jobs` holds the frozen `merge_data` snapshot and the delivery state in one row.

---

## 5. Indexes

```sql
-- ── contacts ────────────────────────────────────────────────────────────
create unique index uq_contacts_ws_email
  on contacts (workspace_id, email_normalized);
create index ix_contacts_ws_created
  on contacts (workspace_id, created_at desc);
create index ix_contacts_import
  on contacts (import_id) where import_id is not null;
-- prefix search on email/company for the contacts table UI
create index ix_contacts_email_trgm
  on contacts using gin (email_normalized gin_trgm_ops);

-- ── list membership ─────────────────────────────────────────────────────
-- PK is (list_id, contact_id); the reverse direction needs its own index
create index ix_list_members_contact on list_members (contact_id);

-- ── email_jobs ──────────────────────────────────────────────────────────
create unique index uq_jobs_campaign_contact
  on email_jobs (campaign_id, contact_id);              -- idempotency
create unique index uq_jobs_provider_msg
  on email_jobs (provider_message_id)
  where provider_message_id is not null;                -- event correlation
-- the worker's hot path: only pending rows are ever scanned
create index ix_jobs_claimable
  on email_jobs (scheduled_at)
  where status = 'pending';
create index ix_jobs_retry
  on email_jobs (next_attempt_at)
  where status = 'failed' and next_attempt_at is not null;
create index ix_jobs_campaign_status
  on email_jobs (campaign_id, status);                  -- campaign progress UI
create index ix_jobs_ws_email
  on email_jobs (workspace_id, to_email)
  where status = 'pending';                             -- suppression trigger

-- ── email_events ────────────────────────────────────────────────────────
create unique index uq_events_provider
  on email_events (provider_event_id);                  -- webhook dedupe
create index ix_events_job
  on email_events (job_id, occurred_at desc);
create index ix_events_ws_time
  on email_events (workspace_id, occurred_at desc);     -- health window scan
create index ix_events_campaign_type
  on email_events (campaign_id, type);

-- ── suppressions ────────────────────────────────────────────────────────
create unique index uq_suppressions
  on suppressions (workspace_id, email_normalized);     -- also the lookup index

-- ── campaigns ───────────────────────────────────────────────────────────
create index ix_campaigns_ws_status
  on campaigns (workspace_id, status);
create index ix_campaigns_due
  on campaigns (scheduled_at)
  where status = 'scheduled';                           -- scheduler scan

-- ── audit / imports ─────────────────────────────────────────────────────
create index ix_audit_ws_time on audit_logs (workspace_id, created_at desc);
create index ix_audit_entity  on audit_logs (entity_type, entity_id);
create index ix_imports_ws    on imports (workspace_id, created_at desc);
create index ix_rejections_import on import_rejections (import_id, bucket);
```

### 5.1 Indexing notes for the reviewer

- **`ix_jobs_claimable` is partial by design.** The pending set is small and shrinking; the sent set grows without bound. A non-partial index on `scheduled_at` would grow to hundreds of megabytes and slow every insert. The partial index stays proportional to work outstanding, and rows leave it automatically as their status changes.
- **`uq_jobs_provider_msg` is partial** because `provider_message_id` is null until send. A plain unique index would permit only one null in some engines; in Postgres nulls are distinct so it would work, but the partial form documents the intent and keeps the index smaller.
- **`ix_contacts_email_trgm` requires `pg_trgm`.** If the extension is unavailable, fall back to a plain B-tree on `email_normalized` and restrict search to prefix matching (`LIKE 'foo%'`). Do not implement contact search with unanchored `ILIKE '%foo%'` against a B-tree — that is a sequential scan per keystroke.
- **Every foreign key used in a `WHERE` gets an index.** Postgres does not index FK columns automatically, and an unindexed FK makes cascading deletes pathologically slow.

---

## 6. RLS and security model

### 6.1 Two independent layers

**RLS is the floor, not the ceiling.** The send worker runs under the **service role, which bypasses RLS entirely**. Every query on the worker path therefore carries its own explicit `workspace_id` filter. Treating RLS as sufficient is the standard way this architecture leaks.

| Path | Connection | Enforcement |
|---|---|---|
| Browser → Supabase client | anon key + user JWT | RLS |
| Next.js Server Action / RSC | anon key + user session | RLS **and** explicit workspace assertion |
| Worker / webhook / cron | service role key | **Application code only** — RLS is off |

### 6.2 Membership helper

```sql
create schema if not exists app;

create or replace function app.current_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select workspace_id
  from public.workspace_members
  where user_id = auth.uid()
$$;

revoke all on function app.current_workspace_ids() from public;
grant execute on function app.current_workspace_ids() to authenticated;
```

`security definer` here breaks the policy-recursion problem: a policy on `workspace_members` that queries `workspace_members` would recurse. Because the function is definer-rights it reads the table directly, bypassing the policy, and it is `stable` so Postgres evaluates it once per statement rather than per row.

`set search_path` is mandatory on any `security definer` function — without it, a caller can shadow `public` and hijack execution.

### 6.3 Policy pattern

Applied identically to every workspace-scoped table:

```sql
alter table contacts enable row level security;
alter table contacts force row level security;   -- applies to table owner too

create policy contacts_select on contacts for select
  to authenticated
  using (workspace_id in (select app.current_workspace_ids()));

create policy contacts_insert on contacts for insert
  to authenticated
  with check (workspace_id in (select app.current_workspace_ids()));

create policy contacts_update on contacts for update
  to authenticated
  using      (workspace_id in (select app.current_workspace_ids()))
  with check (workspace_id in (select app.current_workspace_ids()));

create policy contacts_delete on contacts for delete
  to authenticated
  using (workspace_id in (select app.current_workspace_ids()));
```

`force row level security` matters: without it, the table owner bypasses policies, and migrations run as owner.

The `UPDATE` policy needs **both** `using` and `with check`. `using` controls which rows are visible to update; `with check` prevents rewriting `workspace_id` to move a row into another tenant. Omitting `with check` is a common and severe mistake.

### 6.4 Tables with restricted write policies

Some tables must not be writable by users at all, only by the service role:

```sql
-- events, health, rate ledger, audit: read-only to users
alter table email_events enable row level security;
create policy events_select on email_events for select
  to authenticated
  using (workspace_id in (select app.current_workspace_ids()));
-- no insert/update/delete policy → all writes denied to `authenticated`

alter table audit_logs enable row level security;
create policy audit_select on audit_logs for select
  to authenticated
  using (workspace_id in (select app.current_workspace_ids()));
-- audit logs are append-only from the service role; users can never write or edit
```

`event_raw` and `rate_limits` get **no policies at all** — RLS enabled, zero policies, so `authenticated` cannot read them. Only the service role touches them.

### 6.5 The migration guard

The highest-severity RLS risk is a table added later without a policy. Enforce it in CI:

```sql
-- fails the build if any public table lacks RLS
select tablename
from pg_tables
where schemaname = 'public'
  and tablename not in ('schema_migrations')
  and not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = pg_tables.tablename
      and c.relrowsecurity
  );
-- expected: zero rows
```

Plus a second query asserting every RLS-enabled table has at least one policy *or* is on an explicit deny-all allowlist.

### 6.6 Server-side authorization

```ts
// Every privileged operation resolves the workspace from the session.
// An ID from the request body is never trusted as an authorization input.
export async function requireWorkspace(
  workspaceId: string,
): Promise<{ userId: string; workspaceId: string; role: Role }> {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new UnauthorizedError();

  const { data: member } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!member) throw new ForbiddenError();   // never 404-vs-403 leak the difference
  return { userId: user.id, workspaceId, role: member.role };
}
```

Note `getUser()`, not `getSession()`. `getSession()` returns the cookie contents without revalidating the JWT against the auth server; `getUser()` verifies it. On the server, only `getUser()` is an authorization input.

---

## 7. `email_jobs` design

### 7.1 Why one row per recipient

`email_jobs` serves three roles simultaneously, and merging them is what keeps the schema lean:

1. **The recipient list** — who is in this campaign
2. **The personalization snapshot** — what data they get, frozen at launch
3. **The delivery state machine** — what happened to their message

### 7.2 Frozen merge data

At launch, the launcher writes `merge_data` from the contact row. It is not re-read at send time. If a contact's `company` changes between launch and send, the recipient receives the value as of launch.

This is deliberate and has three justifications:
- **Reproducibility** — the audit log can state exactly what was sent.
- **No N+1 at send time** — the worker never joins to `contacts`.
- **Consistency** — recipients in the same campaign get data from the same instant, rather than data that drifts across a multi-hour send.

`to_email` is likewise denormalized. The worker needs no join at all: one row is one complete send instruction.

### 7.3 Materialization at launch

```sql
insert into email_jobs
  (workspace_id, campaign_id, contact_id, to_email, merge_data, scheduled_at)
select
  c.workspace_id,
  $1                as campaign_id,
  c.id              as contact_id,
  c.email_normalized,
  jsonb_build_object(
    'first_name', coalesce(c.first_name, ''),
    'last_name',  coalesce(c.last_name,  ''),
    'company',    coalesce(c.company,    ''),
    'website',    coalesce(c.website,    '')
  ),
  $2                as scheduled_at
from contacts c
join list_members lm on lm.contact_id = c.id
where lm.list_id      = $3
  and c.workspace_id  = $4
  and c.status        = 'active'
  and not exists (
    select 1 from suppressions s
    where s.workspace_id     = c.workspace_id
      and s.email_normalized = c.email_normalized
  )
on conflict (campaign_id, contact_id) do nothing;
```

`ON CONFLICT DO NOTHING` makes launch itself idempotent. A double-clicked launch button, a retried Server Action, or a network timeout that causes a client retry all produce the same job set. The count of rows actually inserted is written to `campaigns.n_total`.

### 7.4 Status semantics

| Status | Meaning | Terminal |
|---|---|---|
| `pending` | Enqueued, not yet claimed | No |
| `claimed` | A worker holds it; send in flight | No |
| `sent` | Accepted by SES, `provider_message_id` recorded | No |
| `delivered` | SES delivery event received | Yes |
| `bounced` | Bounce event received | Yes |
| `complained` | Complaint event received | Yes |
| `failed` | Retries exhausted, or permanent error | Yes |
| `suppressed` | Recipient suppressed before send | Yes |
| `cancelled` | Campaign cancelled before send | Yes |

`sent` is not terminal — `delivered`, `bounced`, and `complained` all arrive later via SNS. A job stuck in `sent` for more than ~72 hours with no event is an observability signal (SNS misconfiguration), surfaced on the dashboard.

### 7.5 The `claimed` reaper

A worker that crashes mid-send leaves a row in `claimed`. A reaper on the same cron reclaims them:

```sql
update email_jobs
   set status = 'pending', claimed_at = null
 where status = 'claimed'
   and claimed_at < now() - interval '10 minutes'
   and provider_message_id is null;   -- never reclaim a job that actually sent
```

The `provider_message_id is null` guard is essential. If the process crashed *after* SES accepted the message but *before* the row was updated, `provider_message_id` will have been written first (see §13.4), so the row is not reclaimed and the message is not sent twice.

---

## 8. Atomic job-claim logic

### 8.1 The claim

A worker never reads a job and then writes it. It claims atomically, and the `WHERE` clause **is** the lock:

```sql
update email_jobs
   set status     = 'claimed',
       claimed_at = now(),
       attempts   = attempts + 1
 where id     = $1
   and status = 'pending'
   and not exists (
         select 1
         from suppressions s
         where s.workspace_id     = email_jobs.workspace_id
           and s.email_normalized = email_jobs.to_email
       )
returning id, workspace_id, campaign_id, to_email, merge_data, attempts;
```

### 8.2 Interpreting zero rows

Zero rows returned means one of three things, **all of which are correct outcomes**:

| Cause | Correct response |
|---|---|
| Another worker already claimed it | Archive the queue message, move on |
| It already sent (status is past `pending`) | Archive the queue message, move on |
| Recipient became suppressed since enqueue | Mark `suppressed`, archive, move on |

The worker distinguishes the third case with a follow-up read only for bookkeeping, never for a decision:

```sql
update email_jobs
   set status = 'suppressed'
 where id = $1
   and status = 'pending';   -- guarded again; still safe if raced
```

### 8.3 Why `UPDATE ... WHERE status` and not `SELECT FOR UPDATE SKIP LOCKED`

`SELECT ... FOR UPDATE SKIP LOCKED` is the conventional Postgres queue idiom and would also work. The single-statement conditional `UPDATE` is preferred here because:

- It is **one round trip**, not two, on a path that runs once per email.
- It holds **no transaction open** across the SES network call. `SELECT FOR UPDATE` would either hold a row lock for the duration of an HTTP request to AWS — pinning a connection from Supabase's limited pool — or require committing before the send, which reintroduces the crash window.
- The `RETURNING` clause gives the claim and the payload in the same statement.

The lock duration is the duration of a single `UPDATE`, measured in microseconds, rather than the duration of an SES API call, measured in hundreds of milliseconds.

### 8.4 Concurrency proof sketch

Two workers, W1 and W2, both holding a queue message for job J in state `pending`:

1. Both issue the conditional `UPDATE`.
2. Postgres serialises them on the row lock. Say W1 goes first.
3. W1's predicate `status = 'pending'` holds → row updated to `claimed`, 1 row returned.
4. W2 blocks until W1 commits, then re-evaluates under `READ COMMITTED` semantics — Postgres re-checks the `WHERE` against the *updated* row. `status` is now `claimed`, so the predicate fails → **0 rows returned**.
5. W2 archives its message and sends nothing.

Exactly one send. This holds at the default `READ COMMITTED` isolation level; no `SERIALIZABLE` is required, and there is no retry-on-serialization-failure logic to write.

---

## 9. Suppression race-condition handling

### 9.1 The race

```
t0  Campaign launches, 10,000 jobs created, all pending
t1  Worker begins draining the queue
t2  Recipient X clicks unsubscribe        ← suppression row inserted
t3  Worker reaches X's job
```

A naïve implementation checks suppression at **enqueue** (t0) and sends at t3. X receives the email after unsubscribing. That is a compliance failure, not a bug.

### 9.2 Three independent defences

**Defence 1 — the check is inside the claim.** `NOT EXISTS (select 1 from suppressions ...)` is part of the same `UPDATE` predicate (§8.1). There is no window between checking and sending, because the check and the state transition are one statement. This is the primary defence.

**Defence 2 — a trigger cancels pending jobs on suppression insert.**

```sql
create or replace function app.cancel_pending_on_suppression()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update email_jobs
     set status     = 'suppressed',
         updated_at = now()
   where workspace_id = new.workspace_id
     and to_email     = new.email_normalized
     and status       = 'pending';
  return new;
end;
$$;

create trigger trg_suppress_pending_jobs
  after insert on suppressions
  for each row
  execute function app.cancel_pending_on_suppression();
```

This removes the jobs from the claimable set immediately rather than leaving them to be rejected one at a time. It is an optimisation and a safety net, not the primary control — Defence 1 still holds if the trigger is dropped.

**Defence 3 — the contacts status flag.** `contacts.status` is set to `'suppressed'`, which excludes the contact from *future* launches at materialization time (§7.3).

### 9.3 Why three layers rather than one

They fail independently. Defence 1 is inside the transaction and cannot be raced, but it is a line of SQL someone could edit. Defence 2 is declarative and survives application refactors. Defence 3 prevents the address re-entering the pipeline at all. A reviewer should be able to delete any one of the three and still find the system compliant.

### 9.4 The remaining, irreducible window

Between SES accepting a message (`SendEmail` returns) and the recipient clicking unsubscribe, the message is already in flight. Nothing can recall it. This window is inherent to email and is measured in the seconds between `sent` and delivery. It is documented rather than engineered against.

### 9.5 Suppression is enforced for test sends too

Test sends go through the same `evaluateSendPolicy` and the same suppression check. A test send to a suppressed address is refused with an explicit message. There is no bypass flag.

---

## 10. Stateless HMAC unsubscribe tokens

### 10.1 Construction

```
payload  = "v1" | workspace_id | campaign_id | contact_id      (joined by ".")
sig      = base64url( HMAC-SHA256( UNSUBSCRIBE_SECRET_V1, payload ) )
token    = base64url(payload) + "." + sig
```

```ts
const KEYS: Record<string, string> = {
  v1: process.env.UNSUBSCRIBE_SECRET_V1!,
};
const ACTIVE = 'v1';

export function mintUnsubscribeToken(
  workspaceId: string, campaignId: string, contactId: string,
): string {
  const payload = [ACTIVE, workspaceId, campaignId, contactId].join('.');
  const sig = createHmac('sha256', KEYS[ACTIVE]).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): UnsubClaims | null {
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;

  let payload: string;
  try { payload = Buffer.from(b64, 'base64url').toString('utf8'); }
  catch { return null; }

  const [version, workspaceId, campaignId, contactId] = payload.split('.');
  const secret = KEYS[version];
  if (!secret) return null;                       // unknown/retired key version

  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length) return null;         // timingSafeEqual throws on length mismatch
  if (!timingSafeEqual(a, b)) return null;

  return { workspaceId, campaignId, contactId };
}
```

### 10.2 Design properties

| Property | How |
|---|---|
| No storage | Nothing to grow on a 500 MB budget; no lookup on the render path |
| Not enumerable | 256-bit MAC over server-held secret; guessing is infeasible |
| Not forgeable | Attacker cannot suppress an arbitrary address without the secret |
| Idempotent | `ON CONFLICT DO NOTHING` on the suppression insert |
| Key rotation | Version prefix; add `v2`, keep `v1` verifying until old mail ages out |
| **No expiry** | **Deliberate** — an unsubscribe link must work indefinitely. Expiring it would be a compliance failure. |

The no-expiry decision is the reason key rotation retires versions slowly: a `v1` link in a two-year-old email must still work, so `v1` stays in the verify map long after it stops signing.

### 10.3 Constant-time comparison

`timingSafeEqual` throws if the buffers differ in length, so length is checked first — and that length check is *not* a timing leak, because the length of a base64url SHA-256 MAC is fixed and public.

### 10.4 One-click unsubscribe (RFC 8058)

Required by Google for bulk senders. Two headers on every applicable message:

```
List-Unsubscribe: <https://app.example.com/u/{token}>, <mailto:unsub@example.com?subject={token}>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

The POST endpoint:

```ts
// app/u/[token]/route.ts
export async function POST(req: Request, { params }: { params: { token: string } }) {
  const claims = verifyUnsubscribeToken(params.token);
  if (!claims) return new Response('Invalid link', { status: 400 });

  await suppressIdempotent({
    workspaceId: claims.workspaceId,
    email: await emailForContact(claims.contactId, claims.workspaceId),
    reason: 'unsubscribe',
    source: 'one_click',
    campaignId: claims.campaignId,
  });

  return new Response('Unsubscribed', { status: 200 });
}
```

Constraints on this endpoint, all mandated by the RFC or by operational reality:

- **No authentication.** The mail client POSTs it, not the recipient's browser session.
- **CSRF exempt.** There is no session to forge against; the token is the capability. Next.js Server Actions have CSRF protection, which is why this is a Route Handler, not an action.
- **Idempotent.** Providers retry.
- **Fast, always 200 on success.** Non-2xx makes Gmail treat one-click as unsupported.
- **Rate limited by IP** to blunt token-brute-forcing, though the MAC already makes that infeasible.

The `GET` on the same path renders a confirmation page for humans clicking the link in the body, and also suppresses on load — a two-step "click here to confirm" flow measurably reduces successful unsubscribes and invites complaints instead.

---

## 11. pgmq queue architecture

### 11.1 Queues

```sql
create extension if not exists pgmq;

select pgmq.create('email_send');    -- one message per email_job
select pgmq.create('import_parse');  -- one message per import
select pgmq.create('maintenance');   -- retention, health recompute, DNS recheck
```

### 11.2 Delivery semantics

pgmq is **at-least-once**. A message whose visibility timeout expires before the consumer archives it is redelivered. The system is built so a second delivery of the same message sends nothing (§8).

| Property | Value | Reasoning |
|---|---|---|
| Visibility timeout | 120 s | Comfortably longer than a batch's per-message budget, short enough that a crashed worker's messages return promptly |
| Max reads before DLQ | 5 | Matches `email_jobs.attempts` cap |
| Archive vs delete | **Archive** | `pgmq.archive()` moves to `<queue>_archive` for forensics; pruned by the retention job |

### 11.3 Transactional enqueue

The decisive advantage over Redis: enqueue happens **in the same transaction** as the job insert.

```sql
begin;
  insert into email_jobs (...) select ... on conflict do nothing;
  -- enqueue only the rows that were actually inserted
  select pgmq.send_batch('email_send', array_agg(jsonb_build_object('job_id', id)))
  from inserted_rows;
  update campaigns set status = 'sending', launched_at = now() where id = $1;
commit;
```

There is no window in which jobs exist but are unqueued, or messages exist for jobs that were rolled back. With an external queue this is the classic dual-write problem, usually patched with an outbox table — pgmq makes the outbox unnecessary because the queue *is* in the database.

### 11.4 Reading

```sql
-- pop up to N messages, making them invisible for 120s
select * from pgmq.read('email_send', 120, $1);
```

Because claiming is separately atomic, two workers reading overlapping message sets is harmless. The queue controls *pacing*; the `email_jobs` row controls *correctness*.

### 11.5 Dead letters

After 5 reads a message is moved to `email_send_dlq`. DLQ depth is a dashboard metric and an alert condition. Nothing is auto-replayed from the DLQ — replaying a message whose job may have partially sent is exactly the operation that causes duplicates. Replay is a manual, audited action.

---

## 12. pg_cron + pg_net scheduling flow

### 12.1 Why not Vercel Cron

The sending engine needs a tick at roughly one-minute granularity. **Vercel's Hobby plan restricts cron to daily-granularity schedules and a small job count**; sub-daily scheduling is a paid-plan feature. Confirm current limits at implementation time — they change — but the Supabase-side design is better regardless:

- The scheduler sits next to the queue it drains.
- No Vercel plan dependency for a core function.
- ~~Per-minute activity keeps a free-tier Supabase project from auto-pausing.~~ **Withdrawn — see [ADR-0002](docs/adr/0002-availability-and-recovery.md) §1.** The scheduler must not be relied on for project liveness.
- Schedules are versioned in migrations alongside the schema they drive.

### 12.2 Setup

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- secrets live in Vault, never in the cron command text
select vault.create_secret('<hmac-secret>',   'worker_hmac_secret');
select vault.create_secret('https://app.example.com', 'app_url');
```

### 12.3 The dispatcher

```sql
create or replace function app.dispatch_tick(endpoint text, body jsonb default '{}')
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  secret   text;
  base     text;
  ts       text := extract(epoch from now())::bigint::text;
  payload  text;
  sig      text;
  req_id   bigint;
begin
  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'worker_hmac_secret';
  select decrypted_secret into base
    from vault.decrypted_secrets where name = 'app_url';

  payload := ts || '.' || body::text;
  sig     := encode(hmac(payload, secret, 'sha256'), 'hex');

  select net.http_post(
    url     := base || endpoint,
    body    := body,
    headers := jsonb_build_object(
      'Content-Type',    'application/json',
      'X-Signature',     'v1=' || sig,
      'X-Timestamp',     ts
    ),
    timeout_milliseconds := 55000
  ) into req_id;

  return req_id;
end;
$$;
```

### 12.4 Schedules

```sql
-- drain the send queue
select cron.schedule('send-tick', '* * * * *',
  $$ select app.dispatch_tick('/api/internal/worker/send') $$);

-- promote due scheduled campaigns to queued
select cron.schedule('campaign-scheduler', '* * * * *',
  $$ select app.dispatch_tick('/api/internal/worker/schedule') $$);

-- reclaim jobs from crashed workers
select cron.schedule('reap-claimed', '*/5 * * * *',
  $$ update email_jobs set status = 'pending', claimed_at = null
      where status = 'claimed'
        and claimed_at < now() - interval '10 minutes'
        and provider_message_id is null $$);

-- refresh SES quota + recompute health
select cron.schedule('health-refresh', '*/10 * * * *',
  $$ select app.dispatch_tick('/api/internal/worker/health') $$);

-- DNS / DKIM re-verification
select cron.schedule('dns-recheck', '0 */6 * * *',
  $$ select app.dispatch_tick('/api/internal/worker/dns') $$);

-- retention + rate-ledger pruning
select cron.schedule('retention', '17 3 * * *',
  $$ select app.dispatch_tick('/api/internal/worker/retention') $$);
```

### 12.5 Properties and caveats

- **`pg_net` is fire-and-forget.** `http_post` returns a request id immediately; the response lands in `net._http_response`. That is correct for a tick — the scheduler does not care about the result, and a slow worker cannot block the cron.
- **Ticks can overlap.** A tick that takes 70 s overlaps the next. This is safe by design (§8.4): atomic claiming means overlapping workers cannot double-send, and the rate ledger means they cannot jointly exceed the budget.
- **`net._http_response` grows.** It must be pruned by the retention job, or it becomes a silent consumer of the 500 MB budget. This is an easy detail to miss.
- **Availability.** `pg_cron` runs on the database, so a Vercel deployment failure stops sending (the worker 500s), but no schedule is lost — the next tick simply succeeds. A paused or unavailable Supabase project stops everything; jobs stay durable and processing resumes on the next tick. Missed ticks are **not** backfilled, which is what prevents a thundering herd on recovery. Full recovery model, including the missed-schedule grace window and the stale-quota guard: **[ADR-0002](docs/adr/0002-availability-and-recovery.md)**.

### 12.6 Reviewer note

`app.dispatch_tick` is `security definer` and reads Vault. It must not be executable by `authenticated`:

```sql
revoke all on function app.dispatch_tick(text, jsonb) from public, authenticated, anon;
```

Without this, any logged-in user could call it via PostgREST and cause the server to issue signed requests to arbitrary paths on the app URL. This is the sharpest edge in the scheduling design.

---

## 13. Worker lifecycle

### 13.1 Endpoint

`POST /api/internal/worker/send` — service role, HMAC-authenticated, never user-reachable.

### 13.2 Sequence

```
1.  Verify HMAC signature and timestamp freshness (±300 s)   → 401 on failure
2.  Acquire a global advisory lock (non-blocking)            → 200 no-op if held
3.  Refresh provider quota if the cached value is stale (>10 min)
4.  For each workspace with pending jobs:
      a. evaluateSendPolicy(workspace)
         PAUSE/BLOCK → skip workspace, record reason
      b. Reserve budget atomically from rate_ledger
         reserved = 0 → skip workspace
      c. pgmq.read('email_send', 120, reserved)
      d. For each message, with bounded concurrency:
           i.   Atomic claim (§8.1)
                0 rows → classify, archive message, continue
           ii.  Render template from campaign.template_snapshot + merge_data
           iii. Build MIME: headers, List-Unsubscribe, text + html parts
           iv.  SES v2 SendEmail
           v.   On success: write provider_message_id + status='sent' FIRST
           vi.  Increment campaign counters
           vii. Archive the pgmq message
           viii.On failure: classify (§14), set retry or fail
      e. Release reserved-but-unused budget back to the ledger
5.  Release advisory lock
6.  Return {processed, sent, skipped, failed} for observability
```

### 13.3 The advisory lock

```sql
select pg_try_advisory_lock(hashtext('worker:send'));
```

Non-blocking. If a previous tick is still running, this tick returns immediately rather than piling up. It is a *pacing* control, not a correctness control — correctness comes from the atomic claim, and the system remains correct if the lock is removed entirely.

The lock is released explicitly and also drops automatically when the connection closes, so a crashed worker does not deadlock the next tick.

### 13.4 Write ordering — the crash window · **SUPERSEDED by [ADR-0001](docs/adr/0001-ses-send-idempotency.md)**

> The design below was the provisional choice. It has been **replaced**: a `send_attempts` row is now
> committed *before* the SES call, message tags carry `job_id` back through the event stream for
> reconciliation, and an unresolvable outcome is held (`send_uncertain`) rather than resent. Read
> **[ADR-0001](docs/adr/0001-ses-send-idempotency.md)** for the design that will actually be built.
> The text below is retained for the reasoning it records.


This ordering is the single most important detail in the worker:

```ts
const res = await ses.send(new SendEmailCommand(params));

// FIRST: record the provider message id.
// If the process dies after this, the reaper sees provider_message_id != null
// and refuses to reclaim the job, so it is never sent twice.
await db.update(emailJobs)
  .set({ status: 'sent', sentAt: new Date(), providerMessageId: res.MessageId })
  .where(and(eq(emailJobs.id, job.id), eq(emailJobs.status, 'claimed')));

// THEN: counters, then archive the queue message.
```

If the process dies *between* the SES call and this update, the job stays `claimed` with a null `provider_message_id` and **will** be reclaimed and resent. That is an accepted, bounded risk: the window is a single database round trip (single-digit milliseconds), and the failure mode is a duplicate to one recipient rather than a lost send. Closing it entirely would require a distributed transaction with SES, which does not exist.

The alternative ordering — write a "sending" marker before calling SES — trades duplicate-send risk for lost-send risk. Duplicates damage reputation; losses damage the customer. The judgement here is that a millisecond-wide duplicate window is preferable to a second-wide loss window, but **this is a decision a reviewer should explicitly confirm.**

### 13.5 Concurrency inside a batch

Bounded to ~10 concurrent SES calls via a small semaphore. Higher concurrency risks exceeding `MaxSendRate` between ledger reservations; lower wastes the tick's wall clock. The batch size is derived from the reserved budget, so tick duration is bounded by `batch_size / concurrency × p95_latency` and sized to finish well inside the function timeout (§26).

### 13.6 Idempotency summary

| Failure | Protection |
|---|---|
| Queue redelivers a message | Atomic claim returns 0 rows |
| Two workers, same job | Row lock serialises; one claim succeeds |
| Worker crashes before send | Reaper returns job to `pending` |
| Worker crashes after send, before write | Pre-call `send_attempts` row makes the outcome classifiable; SNS `Send` event carrying the `job_id` tag reconciles it; unresolved attempts are held, never resent ([ADR-0001](docs/adr/0001-ses-send-idempotency.md)) |
| Duplicate launch request | `ON CONFLICT (campaign_id, contact_id) DO NOTHING` |
| Duplicate SNS event | `UNIQUE (provider_event_id)` |
| Duplicate unsubscribe POST | `ON CONFLICT DO NOTHING` on suppression |

---

## 14. Retry and failure strategy

### 14.1 Classification

```ts
type FailureClass = 'transient' | 'permanent' | 'suppress' | 'halt';

function classify(err: unknown): { class: FailureClass; code: string } {
  const name = (err as { name?: string })?.name ?? 'Unknown';
  switch (name) {
    // ── transient: retry with backoff ────────────────────────────────
    case 'ThrottlingException':
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'ServiceUnavailable':
    case 'InternalFailure':
    case 'RequestTimeout':
      return { class: 'transient', code: name };

    // ── halt: the account cannot send at all; pause the workspace ────
    case 'AccountSuspendedException':
    case 'SendingPausedException':
      return { class: 'halt', code: name };

    // ── permanent: configuration is wrong; retrying cannot help ──────
    case 'MailFromDomainNotVerifiedException':
    case 'MessageRejected':
    case 'BadRequestException':
      return { class: 'permanent', code: name };

    default:
      // network-level errors are transient; unknown API errors are not
      return isNetworkError(err)
        ? { class: 'transient', code: 'NetworkError' }
        : { class: 'permanent', code: name };
  }
}
```

The default arm is deliberately conservative: an **unknown** API error is treated as permanent. Retrying an error we do not understand, five times, against a reputation-sensitive provider, is worse than failing one message and surfacing it.

### 14.2 Backoff schedule

```
attempt 1 → +1 min
attempt 2 → +4 min
attempt 3 → +15 min
attempt 4 → +1 hour
attempt 5 → failed (terminal)
```

With full jitter:

```ts
const BASE_MS = [60_000, 240_000, 900_000, 3_600_000];
function nextAttemptAt(attempts: number): Date | null {
  const base = BASE_MS[attempts - 1];
  if (base === undefined) return null;              // exhausted
  return new Date(Date.now() + Math.random() * base); // full jitter
}
```

**Jitter here is queue hygiene, not traffic disguise.** Its purpose is to stop a thousand messages that failed in the same second from retrying in the same second. Without it, a transient SES blip produces a synchronised retry storm that reproduces the outage.

### 14.3 Per-class handling

| Class | Job status | Retry | Additional effect |
|---|---|---|---|
| `transient` | `pending` with `next_attempt_at` | Yes, ≤5 | Halve the workspace's rate budget for the next window |
| `permanent` | `failed` | No | Surface on campaign detail with the error code |
| `suppress` | `failed` | No | Insert a suppression row (`reason='invalid'`) |
| `halt` | `pending` | Deferred | **Pause every campaign in the workspace**, health → `PAUSED`, alert the user |

### 14.4 Never retry forever

`ck_attempts check (attempts <= 5)` is a database constraint, not application logic. A bug that tries to write attempt 6 raises an error rather than looping.

### 14.5 Campaign completion

```sql
update campaigns
   set status = 'completed', completed_at = now()
 where id = $1
   and status = 'sending'
   and not exists (
     select 1 from email_jobs
     where campaign_id = $1
       and status in ('pending', 'claimed')
   );
```

A campaign whose jobs are all terminal (including `failed` and `suppressed`) is `completed`. `completed` does not mean "all delivered" — the UI must show the breakdown, never a bare success claim.

---

## 15. Amazon SES integration

### 15.1 Provider abstraction

SES-specific types never escape `lib/providers/ses/`. The rest of the codebase sees only:

```ts
export interface EmailProvider {
  readonly name: string;

  send(msg: OutboundMessage): Promise<SendResult>;
  getSendingLimits(): Promise<SendingLimits>;
  validateSender(domain: string): Promise<SenderValidation>;
  parseEvent(raw: unknown): NormalizedEvent | null;
}

export interface OutboundMessage {
  from: { email: string; name: string };
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;    // includes List-Unsubscribe
  tags: Record<string, string>;       // campaign_id, job_id, workspace_id
}

export interface SendResult { providerMessageId: string; }

export interface SendingLimits {
  maxSendRatePerSecond: number;
  max24HourSend: number;
  sentLast24Hours: number;
  sendingEnabled: boolean;
  fetchedAt: Date;
}

export interface NormalizedEvent {
  providerEventId: string;
  providerMessageId: string;
  type: EventType;
  occurredAt: Date;
  bounceType?: 'permanent' | 'transient' | 'undetermined';
  bounceSubtype?: string;
  diagnosticCode?: string;
  recipients: string[];
}
```

Adding a second provider means implementing this interface and nothing else. The policy engine, worker, health engine, and event processor are provider-agnostic.

### 15.2 Send call

```ts
new SendEmailCommand({
  FromEmailAddress: `${name} <${email}>`,
  Destination: { ToAddresses: [msg.to] },
  ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
  ConfigurationSetName: process.env.AWS_SES_CONFIGURATION_SET,
  EmailTags: [
    { Name: 'campaign_id',  Value: msg.tags.campaign_id },
    { Name: 'workspace_id', Value: msg.tags.workspace_id },
  ],
  Content: {
    Simple: {
      Subject: { Data: msg.subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: msg.html, Charset: 'UTF-8' },
        Text: { Data: msg.text, Charset: 'UTF-8' },
      },
      Headers: Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value })),
    },
  },
});
```

Notes:
- **`ConfigurationSetName` is mandatory on every send.** Without it, no events are emitted, and the entire feedback loop — suppression, health, analytics — goes dark. Preflight asserts it is set.
- **One recipient per call.** Never batch multiple `ToAddresses`, which would make per-recipient event correlation impossible and expose recipients to each other.
- **Both HTML and text parts always.** A text/html-only message is a spam signal.
- **`Simple` content, not `Raw`.** Raw MIME is only needed for attachments, which are out of scope; `Simple` with a `Headers` array supports `List-Unsubscribe` without hand-building MIME.

### 15.3 Quota introspection

```ts
const { SendQuota, SendingEnabled } = await sesv2.send(new GetAccountCommand({}));
return {
  maxSendRatePerSecond: SendQuota.MaxSendRate,
  max24HourSend:        SendQuota.Max24HourSend,
  sentLast24Hours:      SendQuota.SentLast24Hours,
  sendingEnabled:       SendingEnabled,
  fetchedAt:            new Date(),
};
```

Cached for 10 minutes, refreshed by the `health-refresh` cron. **No sending limit is ever hard-coded.** `SentLast24Hours` is SES's own accounting and is authoritative over the local ledger for the daily cap.

### 15.4 IAM policy

Least privilege, scoped to one configuration set:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Send",
      "Effect": "Allow",
      "Action": ["ses:SendEmail"],
      "Resource": [
        "arn:aws:ses:REGION:ACCOUNT:identity/example.com",
        "arn:aws:ses:REGION:ACCOUNT:configuration-set/app-primary"
      ]
    },
    {
      "Sid": "Introspect",
      "Effect": "Allow",
      "Action": [
        "ses:GetAccount",
        "ses:GetEmailIdentity",
        "ses:CreateEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes"
      ],
      "Resource": "*"
    }
  ]
}
```

`ses:DeleteEmailIdentity` is **not** granted. Domain removal is a manual console operation; an application bug must not be able to destroy sender configuration.

### 15.5 Sandbox

A new SES account is sandboxed — on the order of **200 messages per 24 hours, 1 per second, and only to verified recipients**. Production access must be requested and is not instant. This gates every end-to-end test and is the longest-lead-time external dependency in the project.

---

## 16. SES event and webhook architecture

### 16.1 Topology

```
SES ──> Configuration set "app-primary"
          └─> Event destination (SNS topic)
                └─> HTTPS subscription ──> POST /api/webhooks/ses
```

Event types enabled: `SEND`, `DELIVERY`, `BOUNCE`, `COMPLAINT`, `REJECT`, `RENDERING_FAILURE`, `DELIVERY_DELAY`.

`OPEN` and `CLICK` are **not** enabled by default (see §2.1).

### 16.2 Signature verification

The endpoint is public. Without verification, anyone who finds the URL can forge bounces and complaints, poisoning suppression and health for any workspace. Verification is not optional.

```ts
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

async function verifySnsSignature(msg: SnsMessage): Promise<boolean> {
  // 1. The certificate URL must be an AWS SNS endpoint over HTTPS.
  //    This check is the whole security of the scheme — without it an
  //    attacker supplies their own cert URL and signs anything.
  const url = new URL(msg.SigningCertURL);
  if (url.protocol !== 'https:' || !SNS_HOST.test(url.hostname)) return false;

  // 2. Canonical string: specific fields, in a specific order,
  //    determined by message Type. Never JSON.stringify the payload.
  const fields = msg.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

  const canonical = fields
    .filter((f) => msg[f] !== undefined)
    .map((f) => `${f}\n${msg[f]}\n`)
    .join('');

  // 3. Verify with the cert's public key.
  const algo = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  const cert = await fetchCertCached(msg.SigningCertURL);
  return createVerify(algo)
    .update(canonical, 'utf8')
    .verify(cert, msg.Signature, 'base64');
}
```

Additional controls:
- **`TopicArn` allowlist.** Even a validly-signed message from a *different* SNS topic is rejected.
- **Timestamp freshness.** Messages older than 1 hour are rejected as replays.
- **Certificate cache.** Keyed by URL, bounded in size, TTL'd — so an attacker cannot use the endpoint to make the server fetch arbitrary URLs repeatedly. Combined with the host regex, this closes the SSRF vector.
- **`SubscriptionConfirmation` handled explicitly** — confirm only for allowlisted topic ARNs. Auto-confirming any subscription request lets an attacker attach their own topic.

### 16.3 Idempotent ingestion

```sql
insert into email_events (
  workspace_id, job_id, campaign_id, type, occurred_at,
  provider_event_id, bounce_type, bounce_subtype, diagnostic_code, summary
)
values (...)
on conflict (provider_event_id) do nothing
returning id;
```

Zero rows returned → duplicate → the handler returns 200 and does nothing else. **No counter is incremented, no suppression is written, no health signal moves.** SNS retries aggressively; without this, a retried complaint would be counted several times and could trip the throttle on phantom data.

Counter updates happen in the same transaction as the event insert, gated on the insert having actually happened.

### 16.4 Correlation

```
SNS message
   └─ mail.messageId  ──>  email_jobs.provider_message_id  (unique index)
                              └─ campaign_id ──> campaigns
                              └─ contact_id  ──> contacts
```

An event whose `messageId` matches no job is stored with `job_id = null` and logged as an orphan. Orphan rate is a dashboard metric — a nonzero rate means events from another application share the configuration set, or jobs were deleted by retention while events were still arriving.

### 16.5 Bounce and complaint handling

```ts
switch (event.type) {
  case 'bounce':
    if (event.bounceType === 'permanent') {
      await suppress(ws, email, 'hard_bounce', event.diagnosticCode);
      await setJobStatus(job, 'bounced');
      await bumpHealth(ws, 'hard_bounced');
    } else {
      // transient: record, do NOT suppress
      await setJobStatus(job, 'bounced');
      await bumpHealth(ws, 'soft_bounced');
    }
    break;

  case 'complaint':
    // always suppress, always, regardless of subtype
    await suppress(ws, email, 'complaint', event.complaintFeedbackType);
    await setJobStatus(job, 'complained');
    await bumpHealth(ws, 'complaints');
    await reevaluateCampaignHealth(ws, job.campaignId);
    break;
}
```

SES `bounceType` values: `Permanent` (subtypes `General`, `NoEmail`, `Suppressed`, `OnAccountSuppressionList`), `Transient` (`General`, `MailboxFull`, `MessageTooLarge`, `ContentRejected`, `AttachmentRejected`), `Undetermined`.

`Undetermined` is treated as transient — suppressing on an ambiguous signal destroys deliverable addresses.

`Permanent/Suppressed` and `OnAccountSuppressionList` mean the address is on SES's *own* suppression list. These are recorded with `reason = 'provider_suppressed'` to distinguish them from bounces we observed directly.

### 16.6 Endpoint hardening

- Respond **200 quickly**. Do the work synchronously only if it is short; otherwise insert the event and enqueue follow-up processing. SNS treats a slow endpoint as failed and retries, amplifying load.
- **Body size cap** before parsing.
- **Rate limit by source IP** as a blunt DoS guard, set well above SNS's real burst rate.
- **Never echo request content in the response.**

---

## 17. Sender Health Engine

### 17.1 Framing

This is an **internal operational health score**. It is computed entirely from the workspace's own send outcomes. It says nothing about inbox placement, and it is not a Gmail or provider reputation score. The UI must label it as such everywhere it appears.

Forbidden UI claims, explicitly: "100% inbox", "spam-proof", "guaranteed delivery", or any phrasing implying provider detection is being circumvented.

### 17.2 Components

Rolling 7-day window with a 24-hour recency weighting. Recomputed after each event batch and on the 10-minute cron.

| Component | Weight | Signal | Good | Attention | Critical |
|---|---:|---|---|---|---|
| Authentication | 25 | SPF, DKIM, DMARC present and aligned; MAIL FROM set | all present | any missing | DKIM missing |
| Complaint rate | 25 | complaints ÷ delivered | < 0.05% | ≥ 0.10% | ≥ 0.30% |
| Bounce health | 20 | hard bounces ÷ sent | < 1% | ≥ 2% | ≥ 5% |
| Suppression hygiene | 10 | sends attempted to already-suppressed addresses | 0 | any | > 10 |
| Provider health | 10 | throttling + 5xx ÷ attempts; `SendingEnabled` | < 0.1% | ≥ 1% | disabled |
| Sending pattern | 10 | volume vs trailing 7-day baseline | < 3× | > 5× | > 10× |

### 17.3 Scoring

```ts
// piecewise linear: 1.0 at or below `good`, 0.0 at or above `critical`
function componentScore(value: number, good: number, critical: number): number {
  if (value <= good) return 1;
  if (value >= critical) return 0;
  return 1 - (value - good) / (critical - good);
}

const score = Math.round(
  COMPONENTS.reduce((acc, c) => acc + c.weight * componentScore(
    metrics[c.key], c.good, c.critical,
  ), 0),
);
```

Every threshold is configuration, and every component is rendered **with its current value beside its threshold**, so a degraded score is always explainable. A score with no explanation is a number users learn to ignore.

### 17.4 Threshold reasoning

The complaint "attention" threshold sits at **0.10%, one third of Google's stated 0.30% limit.** The system reacts while there is still room to recover. Reacting at 0.30% means reacting after the damage.

The bounce threshold of 2% is below the ~5% level at which SES itself begins account review, for the same reason.

These are conservative operational limits derived from published provider guidance. They are not tuned against any provider's enforcement behaviour, and there is no configuration for "how close to the limit to run."

### 17.5 States

| State | Score | Effect |
|---|---:|---|
| `HEALTHY` | ≥ 85 | Full rate, capped at the provider limit |
| `ATTENTION` | 70–84 | Full rate; dashboard names the cause and the metric that moved |
| `THROTTLED` | 50–69 | Rate × 0.4; new launches blocked; running campaigns continue slowly |
| `PAUSED` | < 50 | All sending halted; resume is manual and re-enters throttled for 24 h |

### 17.6 Asymmetric recovery

Degradation applies immediately. Recovery requires the improved metrics to hold for a **minimum dwell time** (default 6 hours), and resuming from `PAUSED` always re-enters at the throttled multiplier for 24 hours regardless of score.

Without hysteresis, a workspace oscillating around a threshold would flap between full rate and paused, which is worse for reputation than either state.

### 17.7 Minimum volume

Below 100 delivered messages in the window, rates are statistically meaningless — two bounces out of ten is not a 20% bounce rate in any useful sense. Below that threshold the engine reports `HEALTHY` with an explicit "insufficient volume to assess" note rather than a misleading score.

### 17.8 Google Postmaster Tools

There is a natural place for a seventh component sourced from Postmaster Tools once a domain carries enough volume to populate it. It would be **clearly labelled as an external, provider-reported signal**, separate from the internal score. Not in the initial scope.

---

## 18. Adaptive throttling and rate controller

### 18.1 Effective rate

```ts
function effectiveRate(
  provider: SendingLimits,
  workspace: WorkspaceLimits,
  health: HealthState,
  campaign?: CampaignLimits,
): { perSecond: number; dailyRemaining: number } {

  const healthMultiplier =
    health === 'healthy'   ? 1.0
    : health === 'attention' ? 1.0
    : health === 'throttled' ? 0.4
    : 0;   // paused

  const perSecond = Math.floor(Math.min(
    provider.maxSendRatePerSecond * PROVIDER_SAFETY_FACTOR,  // 0.8
    workspace.maxRatePerSecond,
    campaign?.maxRateOverride ?? Infinity,
  ) * healthMultiplier);

  const dailyRemaining = Math.max(0, Math.min(
    provider.max24HourSend - provider.sentLast24Hours,
    workspace.dailySendCap - consumedToday(workspace.id),
  ));

  return { perSecond, dailyRemaining };
}
```

### 18.2 On `PROVIDER_SAFETY_FACTOR = 0.8`

This exists for three concrete engineering reasons, none of which is evasion:

1. **Clock skew.** Our per-second window and SES's rate accounting are not synchronised. Sending at exactly the limit produces throttling errors at window boundaries.
2. **Headroom for out-of-band sends.** Test sends and any future transactional mail share the account rate.
3. **Concurrency overshoot.** With ~10 concurrent in-flight calls, actual instantaneous rate can briefly exceed the reserved rate.

It is a stability margin, and it is a named, documented constant rather than a magic number.

### 18.3 Atomic budget reservation

Concurrent ticks cannot jointly exceed the cap:

```sql
insert into rate_ledger (workspace_id, granularity, window_start, consumed)
values ($1, 'second', date_trunc('second', now()), $2)
on conflict (workspace_id, granularity, window_start)
do update set consumed = rate_ledger.consumed + excluded.consumed
      where rate_ledger.consumed + excluded.consumed <= $3
returning consumed;
```

Zero rows returned means the budget is exhausted for this window; the worker skips the workspace. The `WHERE` on the `DO UPDATE` is what makes this atomic — it is a compare-and-swap, not a read-then-write.

Unused reservations are returned at the end of the tick so a partial batch does not waste budget.

### 18.4 Reactive throttle

On any `ThrottlingException`, the worker halves the workspace's rate for the next window and records a provider-error signal. Recovery is by additive increase (+10% per clean window, capped at the computed effective rate) rather than an immediate jump — classic AIMD, which converges without oscillating.

### 18.5 What the controller does *not* do

- It does not increase rate because the queue is deep. Queue depth is not a health signal.
- It does not model, infer, or respond to any provider's detection or classification behaviour.
- It has no fixed inter-message interval. Pacing is derived from measured limits, so there is no "25 seconds between sends" style constant anywhere.

### 18.6 Dashboard disclosure

```
Provider limit      50 /sec · 200,000 /day     (from SES GetAccount)
Application limit    5 /sec ·  10,000 /day     (workspace policy)
Health multiplier              1.0×            (Healthy)
Effective rate       5 /sec
Used today                      1,240
Remaining                       8,760
```

Every number is sourced and labelled. No blended or invented figures.

---

## 19. Campaign state machine

```
  draft ──> validating ──> scheduled ──> queued ──> sending ──> completed
    │            │              │                      │  ▲
    │            │              │                      │  │ resume
    │            └──> failed    │                      ▼  │
    │                           │                    paused
    │                           │                      │
    └───────────────────────────┴──────────────────────┴──> cancelled
```

### 19.1 Transitions

| From | To | Trigger | Guard |
|---|---|---|---|
| `draft` | `validating` | Launch requested | User has `admin`+ role |
| `validating` | `scheduled` | Preflight passed, future date | All critical checks pass |
| `validating` | `queued` | Preflight passed, send now | All critical checks pass |
| `validating` | `draft` | Preflight failed | — |
| `scheduled` | `queued` | Scheduler cron, time reached | Preflight **re-run** |
| `queued` | `sending` | Jobs materialized and enqueued | Transaction committed |
| `sending` | `paused` | User action, or health → PAUSED | — |
| `sending` | `completed` | No non-terminal jobs remain | — |
| `paused` | `sending` | User resume | Preflight re-run; health ≥ THROTTLED |
| any pre-terminal | `cancelled` | User action | Pending jobs → `cancelled` |
| `validating` | `failed` | Materialization error | — |

**Preflight runs three times**: at launch, again when a scheduled campaign becomes due, and again on resume. A domain can lose verification between scheduling and sending; a template can be edited; health can degrade. Checking only at launch is a real gap.

### 19.2 Guarded transitions

Every transition is a conditional update. No code path issues a bare `UPDATE campaigns SET status = ...`.

```sql
update campaigns
   set status = 'paused', pause_reason = $2, updated_at = now()
 where id = $1
   and status = 'sending'      -- guard: only sending campaigns can pause
returning *;
```

Zero rows means the transition was invalid — typically because it already happened — and the caller reports the current state rather than forcing it.

This closes the pause/tick race: a user clicking pause while a tick is mid-batch either wins (the tick's next policy check sees `paused` and stops) or loses harmlessly (the campaign was already completing). Messages already handed to SES cannot be recalled; the UI says so.

### 19.3 Terminal states

`completed`, `cancelled`, `failed`. No transitions out. Re-sending means creating a new campaign — which is correct, because it produces a new audit trail and a new job set rather than mutating history.

---

## 20. Excel / CSV import pipeline

### 20.1 Pipeline

```
Upload (signed URL, private bucket)
   ↓
File validation      — size, declared type, magic bytes
   ↓
Enqueue import_parse
   ↓
Header detection     — first non-empty row, deduped, trimmed
   ↓
Column mapping       — fuzzy proposal, USER CONFIRMS  ← two-phase boundary
   ↓
Streaming parse      — chunked, never fully materialized for CSV
   ↓
Email normalization
   ↓
Syntax validation
   ↓
In-file duplicate detection
   ↓
Database duplicate detection
   ↓
Suppression check
   ↓
Chunked insert (batched transactions)
   ↓
Rejection records + reconciled result
   ↓
Delete staged file (24h lifecycle, or immediately on success)
```

### 20.2 Two-phase design

Parsing stops after the header row and returns a **proposed** mapping. The user confirms or corrects it before any data is imported. This prevents the most common import disaster — a file whose columns are in an unexpected order silently importing surnames into the company field.

### 20.3 File validation

```ts
const MAX_BYTES = 25 * 1024 * 1024;
const SIGNATURES: Array<{ magic: Buffer; kind: 'xlsx' | 'xls' }> = [
  { magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]), kind: 'xlsx' },  // ZIP
  { magic: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), kind: 'xls'  },  // OLE2
];
```

- **Magic bytes, not extension.** The declared content type and the filename are attacker-controlled.
- **Size cap enforced twice** — at the signed-URL policy and again on the server before parse.
- **All uploads are untrusted.** Macros, embedded objects, external links, and formulas are never evaluated. SheetJS is configured to read values only.
- **Storage path is `imports/{workspace_id}/{import_id}/{filename}`** with a bucket policy scoping access by workspace prefix.
- **Zip-bomb guard.** XLSX is a zip archive; the uncompressed size is checked against a ratio limit before parsing.

### 20.4 Parser routing

| Format | Parser | Reason |
|---|---|---|
| CSV / TSV | Streaming parser (row callback) | Constant memory regardless of file size |
| XLSX | SheetJS | No meaningful streaming story — the format is zipped XML |
| XLS | SheetJS | Legacy OLE2; same constraint |

XLSX and XLS carry a **documented row cap** (~100,000) with an actionable error: *"This spreadsheet has 240,000 rows. Spreadsheet files are limited to 100,000 rows because they must be loaded into memory. Export as CSV to import the full file."* CSV has no such cap.

### 20.5 Result reporting

```
Import Complete

Total rows       10,000
Valid             9,421
Invalid             241     ← failed email validation
Duplicates          198     ← already present, in file or database
Suppressed           82     ← on the suppression list
Rejected             58     ← structurally unusable rows

Download rejected rows (CSV)
```

The five outcome buckets plus valid must sum to `rows_total`, enforced by `ck_rows_reconcile` (§3.5). Every rejected row is retained for 30 days with its original content and a specific reason, downloadable as CSV.

**CSV export escaping.** Exported cells beginning with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`. Without this, a malicious contact name is a formula-injection payload that executes when the user opens the export in Excel.

### 20.6 Chunked insert

Rows are inserted in batches of ~500 inside their own transactions. A failure at row 40,000 does not roll back the first 39,999 — the import is marked `failed` with the row number, and the partial result is reported honestly rather than silently discarded.

---

## 21. Contact validation and deduplication

### 21.1 Normalization

```ts
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/[​-‍﻿]/g, '')      // zero-width characters
    .normalize('NFKC');                          // Unicode canonicalization

  if (/[ -]/.test(trimmed)) return null;   // control chars

  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;

  const local  = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();

  // Local part is case-sensitive per RFC 5321, but universally treated
  // case-insensitively in practice. Lowercasing prevents the same person
  // being imported twice as Bob@ and bob@. email_raw preserves the original.
  return `${local.toLowerCase()}@${domain}`;
}
```

**What is deliberately NOT done:** Gmail dot-stripping (`j.smith@` → `jsmith@`) and plus-address stripping (`bob+news@` → `bob@`) are **not** applied by default. They are Gmail-specific behaviours; applying them universally merges genuinely distinct addresses at other providers. Available as an explicit, per-workspace opt-in setting with a clear warning.

### 21.2 Validation rules

| Rule | Limit | Source |
|---|---|---|
| Exactly one `@` (last one wins) | — | Structural |
| Local part length | ≤ 64 octets | RFC 5321 |
| Total length | ≤ 254 octets | RFC 5321 |
| Domain has ≥ 1 dot | — | Practical |
| Domain labels 1–63 chars, no leading/trailing hyphen | — | RFC 1035 |
| TLD is alphabetic, ≥ 2 chars | — | Practical |
| No consecutive dots, no leading/trailing dot in local | — | RFC 5322 |
| Not a known disposable domain | configurable list | Optional |

**MX record checking is deliberately deferred.** It costs a DNS lookup per unique domain, is cacheable but slow on first import, and produces false negatives for domains with transient DNS issues. Available as an optional post-import background pass, not a blocking import step.

### 21.3 Deduplication

Three layers, in order:

**1. Within the file.** A `Set` of normalized addresses over the streaming parse. First occurrence wins; later ones are counted as `duplicate` with the winning row number in the reason.

**2. Against the database.** Handled by the unique constraint, not a pre-check:

```sql
insert into contacts (workspace_id, email_normalized, email_raw, first_name, ...)
values (...)
on conflict (workspace_id, email_normalized) do update
  set first_name = coalesce(excluded.first_name, contacts.first_name),
      last_name  = coalesce(excluded.last_name,  contacts.last_name),
      company    = coalesce(excluded.company,    contacts.company),
      website    = coalesce(excluded.website,    contacts.website),
      phone      = coalesce(excluded.phone,      contacts.phone),
      custom     = contacts.custom || excluded.custom,
      updated_at = now()
returning (xmax = 0) as inserted;   -- true = new row, false = updated
```

`xmax = 0` distinguishes insert from update in the same statement, so the counters are exact without a second query. The `coalesce` policy means an import **enriches** existing contacts but never blanks a populated field with an empty cell — which is the behaviour users expect and rarely get.

Pre-checking with a `SELECT` would be both slower and racy under concurrent imports.

**3. Against suppression.** Checked before insert; suppressed addresses are counted in their own bucket and are still imported as contacts with `status = 'suppressed'`, so the user can see them rather than having them vanish.

### 21.4 Case sensitivity note for the reviewer

`email_normalized` is stored lowercased, and the unique index is on the raw column, not `lower(email)`. This is intentional: normalization happens once, at the boundary, in one function. A functional index on `lower()` would invite code elsewhere to query with unnormalized input and silently match. Having exactly one normalization function, applied at every entry point, is more robust than pushing case handling into the index.

---

## 22. Data retention strategy

### 22.1 Policy

| Data | Retention | Then | Rationale |
|---|---|---|---|
| `event_raw` | 14 days | Deleted; normalized event survives | Debugging window; the largest single consumer of space |
| `email_events` | 90 days | Folded into `sender_health_daily`, rows deleted | Health window is 7 days; 90 gives generous analytics headroom |
| `email_jobs` | 180 days | Deleted once campaign counters are final | Campaign counters persist; per-recipient detail expires |
| `import_rejections` | 30 days | Deleted; import counters survive | Long enough to fix and re-import |
| `pgmq` archives | 30 days | Pruned | Forensics only |
| `net._http_response` | 7 days | Pruned | **Easy to miss; grows silently** |
| `rate_ledger` | 2 days | Pruned | Only current windows matter |
| `rate_limits` | 1 day | Pruned | Fixed-window counters |
| Storage uploads | 24 hours | Deleted by lifecycle job | Deleted immediately on successful parse |
| `contacts` | Indefinite | — | User data |
| `suppressions` | **Never** | — | **Compliance record** |
| `audit_logs` | **Never** | — | **Compliance record** |

### 22.2 Space arithmetic

At **50,000 sends per month**:

| Table | Rows/month | Bytes/row (incl. indexes) | MB/month |
|---|---:|---:|---:|
| `email_jobs` | 50,000 | ~350 | ~17 |
| `email_events` | ~125,000 (2.5/send) | ~300 | ~37 |
| **Total** | | | **~55** |

Against a **500 MB** ceiling shared with contacts, indexes, WAL and Postgres overhead: roughly **seven to eight months** of runway with the retention policy in force.

Storing raw SNS payloads inline at 2–4 KB each instead: **~430 MB/month**, exhausting the tier in **under two months.** This is precisely why `event_raw` is a separate short-retention table.

At steady state with retention active, size is **bounded rather than monotonically growing**: 14 days of raw payloads plus 90 days of events plus 180 days of jobs converges to a fixed working set.

### 22.3 Execution

Nightly `retention` cron, deleting in bounded batches to avoid long locks:

```sql
-- batched delete; repeat until affected = 0, bounded per run
delete from event_raw
 where ctid in (
   select ctid from event_raw
   where created_at < now() - interval '14 days'
   limit 5000
 );
```

Aggregation into `sender_health_daily` runs **before** the corresponding event deletion, in the same transaction where practical, so no signal is lost.

### 22.4 What is never deleted

Suppressions and audit logs. Deleting a suppression makes a suppressed address mailable again — the worst possible data loss in this system. Deleting audit logs destroys the compliance record. Both are small and both are permanent.

---

## 23. Audit logging

### 23.1 Recorded actions

| Category | Actions |
|---|---|
| Auth | `auth.login`, `auth.logout`, `auth.password_reset` |
| Import | `import.started`, `import.mapped`, `import.completed`, `import.failed` |
| Contacts | `contact.deleted`, `contact.bulk_deleted`, `list.created`, `list.deleted` |
| Campaigns | `campaign.created`, `campaign.updated`, `campaign.launched`, `campaign.paused`, `campaign.resumed`, `campaign.cancelled` |
| Sending | `test_send.dispatched` |
| Sender config | `domain.added`, `domain.verified`, `domain.removed`, `identity.added`, `identity.removed` |
| Suppression | `suppression.added_manual`, `suppression.removed`, `suppression.auto` (system actor) |
| Policy | `policy.rate_changed`, `policy.health_state_changed`, `policy.auto_paused` |
| Settings | `settings.updated` |

### 23.2 Record shape

```json
{
  "workspace_id": "…",
  "actor_id": "…",
  "actor_type": "user",
  "action": "campaign.launched",
  "entity_type": "campaign",
  "entity_id": "…",
  "metadata": {
    "campaign_name": "September Update",
    "recipient_count": 8412,
    "sender_identity": "hello@example.com",
    "preflight_warnings": ["dmarc_policy_none"],
    "health_state": "healthy",
    "health_score": 91
  },
  "ip": "203.0.113.4",
  "user_agent": "Mozilla/5.0 …",
  "created_at": "2026-09-03T09:14:22Z"
}
```

`actor_type = 'system'` for automated actions — auto-suppression from a bounce, auto-pause from health. These matter most: when a user asks why their campaign stopped, the audit log is the answer.

### 23.3 Rules

- **Append-only.** No update or delete policy exists for `authenticated`. Writes come from the service role.
- **Never log secrets.** No tokens, no AWS keys, no session identifiers, no unsubscribe tokens, no full recipient lists. A schema-level allowlist of permitted `metadata` keys per action prevents drift.
- **Written in the same transaction as the action** where the action is transactional. An audit log that can silently fail while the action succeeds is worse than none.
- **IP and user-agent are recorded for user actions only.** For system actions they are null rather than the worker's address.

---

## 24. Security and threat model

### 24.1 Threat table

| # | Threat | Vector | Impact | Control |
|---|---|---|---|---|
| T1 | Cross-tenant data read | Missing RLS policy on a new table | Critical | RLS + `force`; CI migration guard (§6.5); explicit filters on service-role queries |
| T2 | Cross-tenant write | Update rewriting `workspace_id` | Critical | `WITH CHECK` on every update policy |
| T3 | Forged delivery events | Unverified SNS endpoint | Critical | Signature verification; cert-URL host allowlist; `TopicArn` allowlist; timestamp freshness (§16.2) |
| T4 | Duplicate send | Queue redelivery, worker crash | Critical | Atomic claim; unique constraints; `provider_message_id` write ordering (§13.4) |
| T5 | Send to suppressed | Mid-campaign unsubscribe | Critical | Suppression check inside the claim; trigger; contact status (§9) |
| T6 | Service-role key exposure | Import into a client component | Critical | Server-only module boundary; lint rule; build-time bundle scan |
| T7 | SSRF via cert fetch | Attacker-supplied `SigningCertURL` | High | Host regex `^sns\.[a-z0-9-]+\.amazonaws\.com$`; HTTPS only; bounded cache |
| T8 | SSRF via `dispatch_tick` | PostgREST-exposed definer function | High | `REVOKE EXECUTE` from `anon`/`authenticated` (§12.6) |
| T9 | Stored XSS | Unsanitised template HTML in preview | High | Sanitize on save and on render; preview in a sandboxed iframe with CSP |
| T10 | Unsubscribe forgery | Guessed token | High | HMAC-SHA256; constant-time compare; no enumerable IDs |
| T11 | Malicious spreadsheet | Macros, zip bomb, formula injection | High | Values-only parsing; magic bytes; ratio limit; `'` prefix on CSV export |
| T12 | Auth bypass via `getSession` | Trusting unverified cookie contents | High | `getUser()` only, server-side (§6.6) |
| T13 | IDOR | Trusting a body-supplied `workspace_id` | High | `requireWorkspace()` on every privileged path; RLS as backstop |
| T14 | Import DoS | Huge or many files | Medium | Size cap; per-user rate limit; row caps; background processing |
| T15 | Webhook replay | Re-POSTing a captured event | Medium | `UNIQUE(provider_event_id)`; timestamp window |
| T16 | Enumeration | 404 vs 403 distinction | Medium | Uniform 403 for cross-tenant reads |
| T17 | Rate-limit bypass | Concurrent requests | Medium | Atomic `INSERT … ON CONFLICT` counters, not read-then-write |
| T18 | Error leakage | Stack traces to the client | Medium | Typed errors with user-safe messages; correlation IDs; details logged only |
| T19 | Log leakage | Secrets in structured logs | Medium | Redaction allowlist; never log headers or env |
| T20 | DNS rebinding on verification | User-controlled domain input | Low | Verification reads DNS and SES only; makes no HTTP request to user domains |

### 24.2 Secret handling

| Secret | Location | Never |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Server env | Any client bundle |
| `AWS_SECRET_ACCESS_KEY` | Server env | Any client bundle |
| `WORKER_HMAC_SECRET` | Server env + Supabase Vault | Cron command text |
| `UNSUBSCRIBE_SECRET_V1` | Server env | Anywhere else |

Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` may carry the `NEXT_PUBLIC_` prefix. A CI step greps the built client bundle for known secret prefixes and fails the build on a hit.

### 24.3 Error handling

```ts
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,   // safe to display
    readonly httpStatus: number,
    readonly cause?: unknown,       // logged, never serialized to the client
  ) { super(userMessage); }
}
```

Bad: `PrismaClientKnownRequestError: Unique constraint failed on the fields: (...)`

Good: *"This campaign could not start because the sender domain example.com is not fully verified. DKIM is still pending — add the three CNAME records shown on the Sender Domains page."*

Every response carries a correlation ID; the technical detail is in the server log under that ID.

### 24.4 Observability

Structured JSON logs with: `request_id`, `workspace_id`, `user_id`, `campaign_id`, `job_id`, `provider_message_id`, `event_id`.

Never logged: passwords, tokens, session cookies, AWS keys, unsubscribe tokens, full recipient lists, raw template HTML.

### 24.5 Environment variables

```bash
# ── Public (client-visible) ────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_APP_URL=

# ── Server only ───────────────────────────────────────────
SUPABASE_SERVICE_ROLE_KEY=

AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SES_CONFIGURATION_SET=
AWS_SNS_TOPIC_ARN=

WORKER_HMAC_SECRET=
UNSUBSCRIBE_SECRET_V1=

# ── Operational policy (documented, not magic numbers) ────
PROVIDER_SAFETY_FACTOR=0.8
DEFAULT_WORKSPACE_DAILY_CAP=10000
DEFAULT_WORKSPACE_RATE_PER_SECOND=5
HEALTH_MIN_VOLUME=100
LARGE_CAMPAIGN_CONFIRM_THRESHOLD=1000
```

---

## 25. Cost and infrastructure assumptions

### 25.1 Target

```
Next.js → Vercel
Supabase → Postgres, Auth, Storage, pgmq, pg_cron
Amazon SES → delivery
Amazon SNS → events
```

| Service | Tier | Cost | Upgrade trigger |
|---|---|---:|---|
| Supabase | Free | $0 | Database approaching 500 MB (§27 R4) |
| Vercel | Hobby | $0 | **Immediately, if commercial** (§27 R3) |
| Amazon SES | Pay-as-you-go | ~$0.10 / 1,000 | None |
| Amazon SNS | Free tier | ~$0 | Past 1M notifications/month |

**Verify all tier limits at implementation time** — free-tier allowances change.

### 25.2 Supabase Free assumptions

- ~500 MB database
- ~1 GB file storage (staging only, 24h lifecycle)
- ~5 GB egress
- `pg_cron`, `pg_net`, `pgmq`, `pgcrypto`, `pg_trgm` available
- Projects pause after inactivity and must be resumed by a human — **not mitigated in-system; see [ADR-0002](docs/adr/0002-availability-and-recovery.md) §6.** Data and jobs survive intact; sending simply stops until resumed.

### 25.3 When to upgrade, and what happens if we don't

| Upgrade | Solves | If we don't |
|---|---|---|
| Supabase Pro (~$25/mo) | 8 GB database, no auto-pause, PITR | Writes fail once the 500 MB ceiling is hit — mid-campaign. Retention delays this to a bounded steady state, but real volume will eventually exceed it. |
| Vercel Pro (~$20/mo) | Commercial licence, longer function duration, minute-granularity cron | **Licence violation** if commercial. Not a technical failure — a contractual one. |

### 25.4 Not required

Redis, BullMQ, Kafka, Kubernetes, dedicated servers, dedicated IPs. A dedicated IP is actively the wrong choice at low volume: it needs sustained daily traffic to warm, and a cold dedicated IP delivers worse than the shared pool.

---

## 26. Vercel deployment considerations

### 26.1 Function duration

Serverless function execution is time-bounded, and the exact ceiling varies by plan and runtime. The worker is designed around this rather than against it:

- Batch size derives from the reserved rate budget, not from queue depth.
- Bounded concurrency (~10) inside a batch.
- Tick duration ≈ `batch_size / concurrency × p95_SES_latency`, sized to finish well inside the limit with margin.
- **Overlapping ticks are safe** (§8.4), so throughput is bounded by the rate limit, not the function timeout.

If sustained volume ever outgrows this, the same worker code moves to a Supabase Edge Function or a small container **without touching the queue, the policy layer, or the schema.** That portability is the point of the provider and policy abstractions.

### 26.2 Cron

Not used. See §12.1 and §27 R1.

### 26.3 Runtime selection

| Route | Runtime | Reason |
|---|---|---|
| Worker `/api/internal/worker/*` | Node.js | AWS SDK; longer duration |
| SNS webhook | Node.js | `crypto` for certificate verification |
| Unsubscribe `/u/[token]` | Edge | Low latency, high availability, no AWS SDK needed |
| App pages | Node.js | Supabase SSR |

### 26.4 Regions

Deploy Vercel functions in the same region as the Supabase project and the SES region. Cross-region round trips on a per-message path are the dominant latency cost and directly reduce per-tick throughput.

### 26.5 Middleware

Session refresh runs in middleware. It must **not** contain authorization logic — matcher config is easy to get subtly wrong, and a route excluded from the matcher would be unprotected. Authorization lives in the route handlers and in RLS.

### 26.6 Build-time checks

- Typecheck and lint fail the build.
- Client bundle scanned for secret prefixes.
- Migration guard asserting RLS coverage (§6.5) runs against a preview database.

---

## 27. Platform limitations and risks

### R1 — Vercel Cron cannot drive a per-minute worker on the free plan · **High**

**Conflict.** The sending engine needs a ~1-minute tick. Vercel's Hobby plan restricts cron to daily-granularity schedules and a small job count; sub-daily scheduling is a paid feature.

**Resolution.** Schedule from Supabase. `pg_cron` runs per-minute on the free tier; `pg_net` issues the HTTP request. Scheduler sits next to the queue and there is no Vercel plan dependency. (The earlier claim that this also prevents free-tier auto-pause is withdrawn — [ADR-0002](docs/adr/0002-availability-and-recovery.md).) Confirm current Vercel limits at build time — they change — but the Supabase-side design is better regardless.

### R2 — Serverless execution limits bound batch size · **Medium**

**Conflict.** A tick sending 500 messages sequentially exceeds the function ceiling. Supabase Edge Functions have their own wall-clock and CPU limits.

**Resolution.** Small frequent ticks rather than large rare ones; bounded concurrency; atomic claiming makes overlap safe. Worker code is portable to an Edge Function or container without schema changes.

### R3 — Vercel Hobby prohibits commercial use · **High · Requires your decision**

**Conflict.** The brief describes something that may become a real production SaaS. Vercel's Hobby plan is licensed for non-commercial use only. This is a **licensing** constraint; no engineering resolves it.

**Resolution.** Hobby is fine for building and evaluating. The day there is a paying customer, Vercel Pro is required — which also resolves R1. Budget for it at launch, not before.

### R4 — Event volume outgrows the 500 MB free database · **High**

**Conflict.** ~55 MB/month at 50,000 sends/month against a 500 MB ceiling shared with everything else — seven to eight months of runway. Storing raw SNS payloads inline instead: under two months.

**Resolution.** Raw payloads in a separate 14-day table; events fold into daily rollups; steady-state size is bounded, not monotonic. Dashboard warning at 70% of ceiling. Supabase Pro when real volume arrives.

### R5 — SheetJS is the wrong tool for large CSVs · **Medium**

**Conflict.** SheetJS materialises a workbook in memory. Unavoidable for XLSX (zipped XML, no streaming story); a needless memory ceiling for CSV.

**Resolution.** Route by type — streaming parser for CSV, SheetJS for XLSX/XLS, documented row cap on spreadsheet formats with an actionable error. Chunked inserts either way, so the write path is identical.

### R6 — SES sandbox gates all end-to-end testing · **Medium · Longest lead time**

**Conflict.** A new SES account sends ~200 messages/24 h at 1/sec, to verified recipients only. Production access requires a request and is not instant.

**Resolution.** Request production access on day one, in parallel with Phase 0. Until then, phases 0–4 are fully testable (nothing sends before Phase 5), and Phase 5 is testable within sandbox limits using verified addresses. **This is the critical-path external dependency.**

### R7 — Deliverability outcomes are not controllable by this system · **Informational**

The system can protect authentication, suppression hygiene, complaint rates, and sending patterns. It cannot control inbox placement, and no honest system can. The UI must never claim otherwise (§17.1).

### R8 — Restating one tension in the brief

The brief asks for adaptive throttling and dynamic intervals, and separately forbids anything designed to evade provider detection. These are compatible; the distinction is **what the control reads from.**

Every pacing decision here reads an observable operational signal: the provider's published rate limit, the account's remaining daily quota, a measured bounce or complaint rate, an actual throttling error. None reads from, or reasons about, a provider's detection behaviour.

That is why the rate controller is built on `GetAccount` and the health window rather than a tuned interval, and why there is **no configuration anywhere for "how close to the limit to run."** `PROVIDER_SAFETY_FACTOR` moves *away* from the limit, for stability (§18.2).

---

## 28. Locked architectural decisions

Changing these after implementation begins requires a data migration, so they are settled first.

| # | Decision | Rationale | Cost of changing later |
|---|---|---|---|
| L1 | Workspace tenancy from commit one | Retrofitting a tenant column across every table and rewriting every policy | Very high |
| L2 | `email_jobs` is the recipient list | Halves the largest table; single source of truth | High |
| L3 | `UNIQUE(campaign_id, contact_id)` | Structural idempotency | High — requires deduplicating live data |
| L4 | Suppression check inside the atomic claim | Only way to close the mid-campaign race | High |
| L5 | Suppression keyed on email, not `contact_id` | Survives contact deletion; works pre-import | High |
| L6 | pgmq, not Redis | Transactional enqueue; no dual-write | High |
| L7 | Stateless HMAC unsubscribe tokens, no expiry | No storage growth; compliance requires permanence | Medium — old links break |
| L8 | Provider abstraction from the first SES call | Prevents SES types leaking through the codebase | High |
| L9 | Frozen `merge_data` and `template_snapshot` | Reproducibility; no N+1 at send | Medium |
| L10 | Counters as columns, not `COUNT(*)` | Dashboard latency independent of volume | Medium |
| L11 | Raw payloads in a separate short-retention table | 8 months of runway instead of 2 | Medium |
| L12 | Provider-derived rate limits, never hard-coded | Correctness against real quotas | Medium |
| L13 | RLS + explicit server-side authorization, both | Service role bypasses RLS | High |
| L14 | Centralized policy engine as the sole send authority | The core safety property | High |
| L15 | `pg_cron` scheduling | Platform limitation R1 | Low — swappable |

---

## 29. Flexible decisions

Deferrable or reversible without structural change.

| # | Decision | Current choice | Alternatives | When to revisit |
|---|---|---|---|---|
| F1 | Package manager | pnpm | npm, bun | Your preference — say so now |
| F2 | Worker host | Vercel route handler | Supabase Edge Function, container | If R2 binds |
| F3 | Health weights and thresholds | §17.2 | Any | After observing real data |
| F4 | Retention windows | §22.1 | Any | Per customer requirements |
| F5 | Batch size and concurrency | ~10 concurrent | Tunable | Load testing |
| F6 | Backoff schedule | 1m/4m/15m/1h | Any | Observed transient patterns |
| F7 | `PROVIDER_SAFETY_FACTOR` | 0.8 | 0.7–0.9 | If throttling errors appear |
| F8 | Contact search | pg_trgm GIN | Postgres FTS, external | If search feels slow |
| F9 | Open/click tracking | Off | Opt-in per workspace | If users request it |
| F10 | Gmail dot/plus normalization | Off | Opt-in per workspace | If duplicates are a real complaint |
| F11 | MX validation | Off | Background pass | If invalid rates are high |
| F12 | Chart library | Recharts | Visx, Chart.js | Trivially swappable |
| F13 | Roles | owner/admin/member | Finer-grained | When teams need it |
| F14 | Postmaster Tools integration | Not in scope | Seventh health component | Once volume justifies it |
| F15 | Second email provider | SES only | Postmark, Resend | Interface already exists |

---

## 30. Recommended implementation phases

Ordered so dangerous parts are built behind safety rails that already exist. **Nothing can send until Phase 5**, and Phase 5 cannot ship until Phase 4's tests pass.

### P0 — Foundation

Next.js with strict TypeScript, Tailwind, shadcn/ui. Supabase project, Drizzle, migration pipeline. Auth with SSR sessions, protected routes, workspace bootstrap on signup. Audit log writer. Typed error hierarchy. Structured logger with request correlation. CI: lint, typecheck, tests, RLS migration guard, client-bundle secret scan.

**Exit:** A test proves user B receives zero rows from every one of user A's tables — through both a client query *and* a service-role query missing its filter.

**In parallel, day one:** request SES production access (R6).

### P1 — Contacts and suppression

Contact CRUD with server-side pagination, search, filtering. Suppression table, reasons, manual add/remove. The single shared eligibility function every later phase calls.

**Exit:** Suppression is enforced through a database constraint path, not only application code. A test deletes a contact and proves the suppression survives.

### P2 — Import engine

Signed upload to a private bucket. Background parse job. Header detection, column-mapping UI, normalization, syntax validation, in-file and cross-file dedupe, suppression cross-check, chunked insert, rejection records, results summary. Storage lifecycle job.

**Exit:** A 50,000-row file imports without timeout, and every input row lands in exactly one of the six buckets — counts reconcile to the row total, enforced by `ck_rows_reconcile`.

### P3 — Sender domains

Domain creation, SES identity provisioning, DNS record display with copy affordances, real verification polling against SES *and* DNS, DMARC parsing, MAIL FROM configuration, status surfacing, 6-hourly recheck.

**Exit:** A domain cannot reach verified status without the provider confirming it. No self-attestation path exists in the code.

### P4 — Templates, campaigns, preflight

Template editor with sanitisation, whitelisted variables, live preview against a real contact in a sandboxed iframe, plain-text generation. Campaign builder as the seven-step flow. Guarded state machine. Full preflight engine with remediation copy. **Still no send path.**

**Exit:** Every critical preflight check has a test proving launch is refused when that check fails.

### P5 — Sending engine

Provider interface and SES implementation. pgmq queue, pg_cron tick, atomic claim, rate ledger, provider-derived limits, retry with backoff and jitter, claimed-job reaper, test-send path isolated from campaign execution.

**Exit:** Concurrent workers racing the same job produce exactly one send; a re-delivered queue message produces zero. Both proven under test, not by inspection.

### P6 — Events, bounces, unsubscribe

SNS endpoint with signature verification and subscription handling. Idempotent event ingestion. Hard-bounce and complaint auto-suppression. Unsubscribe pages, HMAC tokens, one-click `List-Unsubscribe-Post`. Incremental counter updates.

**Exit:** The same SNS payload delivered five times moves every counter exactly once. An unsigned payload is rejected. A forged `SigningCertURL` is rejected.

### P7 — Health, analytics, hardening

Health engine and dashboard. Adaptive throttle wired into the policy engine. Campaign analytics. Retention jobs (including `net._http_response` and pgmq archives). Rate limiting across all mutating routes. Full security review against §24.

**Exit:** A simulated complaint spike measurably throttles the send rate, and the dashboard names the specific metric that caused it.

### 30.1 Test coverage per phase

Failure paths, not only happy paths:

| Area | Must-have tests |
|---|---|
| Authorization | Cross-tenant read/write denied via both RLS and service role |
| RLS | Every table has a policy; `WITH CHECK` prevents tenant rewrite |
| Import | Malformed files, zip bomb, wrong types, oversize, bucket reconciliation |
| Normalization | Unicode, zero-width, case, length limits, edge-case addresses |
| Dedupe | In-file, cross-file, concurrent imports of the same address |
| Suppression | Mid-campaign unsubscribe race; trigger behaviour; test-send enforcement |
| Preflight | Each critical check blocks launch |
| Queue | Redelivery, concurrent claim, crash recovery, DLQ |
| Retry | Classification, backoff, attempt cap, halt on account suspension |
| Webhook | Valid, invalid signature, hostile cert URL, replay, wrong topic, duplicate |
| Rate | Concurrent reservation cannot exceed cap |
| Health | Score computation, state transitions, hysteresis, minimum-volume guard |
| Unsubscribe | Valid, forged, tampered, replayed, one-click POST |

---

## Open questions

1. **Is `Email-Uploader` the intended directory?** It was empty; every sibling under `Nextjs Project/` contains real code. Confirm before scaffolding.
2. **R3 — Hobby or Pro?** Determines the deployment target and whether R1's resolution is strictly necessary.
3. **F1 — package manager preference?** Defaulting to pnpm.
4. **Has SES production access been requested?** Longest lead time in the project.
5. ~~**§13.4 — confirm the write-ordering trade-off.**~~ **Resolved.** Reviewed and reversed: see [ADR-0001](docs/adr/0001-ses-send-idempotency.md). The system now fails closed on an uncertain send outcome.

---

*End of blueprint.*
