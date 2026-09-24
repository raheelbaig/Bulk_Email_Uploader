# Email Uploader

Email campaign and bulk sending platform.

> ## Sending is built, and off by default.
>
> This deployment is at **P5 — the sending engine**. Campaigns can be delivered
> through Amazon SES (outbound only), but nothing is sent unless an operator
> deliberately turns it on:
>
> - `EMAIL_SENDING_MODE` defaults to `disabled`, in which the worker does nothing.
> - `dry_run` runs the entire pipeline against a sink that delivers nothing.
> - `live` also needs a configuration set, signing secrets and an https app URL,
>   and the documented IAM policy still **denies** `ses:SendEmail` until the
>   separate live policy is attached.
>
> The application never reads or changes MX records; inbound mail stays with
> its existing provider. `tests/sending-gates.test.ts` fails the build if any of
> this changes. See [How sending is gated](#how-sending-is-gated).

## Documents

| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The blueprint. Source of truth for schema and design decisions. |
| [`docs/adr/0001-ses-send-idempotency.md`](docs/adr/0001-ses-send-idempotency.md) | The SES crash window: what is and is not guaranteed, and why the system fails closed. Supersedes §13.4. |
| [`docs/adr/0002-availability-and-recovery.md`](docs/adr/0002-availability-and-recovery.md) | Scheduling, availability and recovery. Withdraws the free-tier keep-alive claim. |
| [`docs/adr/0003-sending-engine-implementation.md`](docs/adr/0003-sending-engine-implementation.md) | P5: where the sending engine departs from the blueprint, and what still needs external configuration. |

## Stack

Next.js (App Router) · TypeScript strict · Tailwind v4 · shadcn-style components ·
Supabase (Auth, Postgres, RLS) · Drizzle · Zod · Vitest · pnpm

## Local setup

```bash
pnpm install
cp .env.example .env.local     # fill in your Supabase project values
pnpm db:migrate                # applies supabase/migrations in order
pnpm dev
```

`pnpm db:migrate` needs `DATABASE_URL` (from the environment, else `.env.local`).
Migrations are plain SQL applied in filename order, one transaction each, and
recorded with a checksum in `public.schema_migrations` (RLS on, no API-role
privileges); editing an applied migration is a hard error, because it would let
two environments diverge silently. Checksums ignore CRLF vs LF.

```bash
pnpm db:migrate --dry-run          # list pending migrations; read-only, changes nothing
pnpm db:migrate --yes-production   # required for any non-localhost database
```

Only the host, port and database name are printed. Concurrent runs are
serialised with a Postgres advisory lock.

## Commands

```bash
pnpm verify          # lint + typecheck + test + build + secret scan
pnpm test            # full suite (RLS tests included — no database needed)
pnpm test:security   # just the security proofs
pnpm scan:secrets    # scan .next/static for leaked credentials (build first)
```

## How the tests reach a real database

The RLS suite runs the **real migration files** against PostgreSQL 17 compiled to
WebAssembly ([PGlite](https://pglite.dev)), under the real `authenticated` role,
with `auth.uid()` driven by the same `request.jwt.claims` GUC that Supabase uses.

Only the Supabase-provided surface — the `anon` / `authenticated` / `service_role`
roles and the `auth` schema — is emulated, in `supabase/testing/`. `service_role`
is created with `BYPASSRLS` exactly as on Supabase, so "the worker is not
protected by RLS" is a tested condition rather than a comment.

No Docker, no external database, no CI service container.

## Security model

Two independent layers, neither trusted alone.

| Layer | Mechanism | Covers |
|---|---|---|
| Database | RLS with `FORCE`, `USING` + `WITH CHECK`, column-level grants, deny-by-default | Every query under the anon key |
| Application | `requireUser` / `requireWorkspace`, `serviceForWorkspace` | The service-role path, where RLS is inert |

**`service_role` bypasses RLS.** That is why `lib/db/service.ts` refuses to build
an unfiltered query, stamps the tenant column on insert, and strips it from
update patches. The one escape hatch demands a written reason and logs it.

**Authorization never uses `getSession()`.** It decodes the cookie without
verifying the JWT. Only `getUser()` is an authorization input, and a test fails
the build if `getSession` appears anywhere in `src/`.

### The eligibility authority

`src/lib/eligibility` is the **single source of truth** for whether an address may
be emailed. Nothing else queries the `suppressions` table to make a decision, and
a test fails the build if that changes.

It takes a reader port, so a request path can read under the caller's JWT (RLS
applies) while a future background worker reads under the service role — one
rule, two ways to fetch, never two rules. Every send path added from P4 onward
must call it: preflight, recipient materialisation, the atomic job claim, test
sends, unsubscribe and provider-event handling.

### The migration guard

The highest-severity mistake available in this schema is adding a table without
RLS. `tests/rls-coverage.test.ts` fails the build when any `public` table:

- has RLS disabled, or
- has RLS but no policies and no entry in `app.rls_policy_exceptions`, or
- has RLS but not `FORCE`, or
- has an `UPDATE` policy without `WITH CHECK`, or
- (for functions) is `SECURITY DEFINER` without a pinned `search_path`.

A deliberately deny-all table is legitimate — it must just be declared, in a
migration, with a reason. Silence is not allowed to mean either "intended" or
"forgotten". The guard has negative-control tests proving it catches each case.

## The import engine (P2)

Upload → inspect → **confirm the mapping** → chunked processing → a result whose
counts reconcile.

| Concern | How |
|---|---|
| Upload | Signed, path-bound URL straight to a **private** bucket. 25 MB cap, enforced at the bucket policy and again on the server. |
| Routing | Magic bytes, never the extension or the declared type — both are attacker-controlled. A `.csv` containing a ZIP header is refused, not re-routed. |
| CSV / TSV | An incremental parser fed from the download stream. Constant memory regardless of file size; no row cap. |
| XLSX / XLS | Read in-repo, values only. Formulas contribute their cached result and are never evaluated; macros, external links and embedded objects are never opened. Documented ~100,000-row cap with an actionable error — never a silent truncation. |
| Zip bombs | Declared size, actual inflate size, total across entries and compression ratio are all bounded, with the real guard inside the decompressor. |
| Mapping | Two-phase. Parsing stops after the header row and *proposes*; a person confirms before any contact is written. Re-validated server-side against the file's real headers. |
| Normalization | `lib/email/normalize` — the P1 function, not a second one. A test fails the build if the importer defines its own or lowercases an address itself. |
| Duplicates | In-file via a streaming index (first occurrence wins, and the winning row is named); in-database via `on conflict do update`, never a racy pre-check. Enrichment fills gaps and never blanks a populated field. |
| Suppression | Through the P1 eligibility authority. A suppressed address is still imported, with `status = 'suppressed'`, so it is visible rather than vanished. The suppression record is untouched. |
| Chunking | 500 rows per transaction. A failure at row 40,001 keeps the first 40,000 and says so. |
| Reconciliation | Every row lands in exactly one of five buckets, and `ck_rows_reconcile` refuses to record a completed import whose counts do not sum to the total. |
| Rejections | Row number, original cells and an exact reason, downloadable as CSV. |
| Export safety | Cells beginning `=`, `+`, `-`, `@`, tab or CR are prefixed and quoted, so a contact's name cannot be a formula-injection payload. |
| Background work | `after()` plus a claimable `import_jobs` row. The claim is one conditional UPDATE, so a redelivered message or a double click produces exactly one pass. |
| Lifecycle | The staged file is deleted the moment the import succeeds; a 24-hour sweep clears anything left behind. Never the browser's job. |
| Rate limiting | A fixed-window counter in PostgreSQL, incremented by a single atomic statement. In-memory limiters are wrong on a platform with per-request instances. |

**Neither parser is a dependency.** The only npm-published SheetJS release is a
version with known prototype-pollution and ReDoS advisories, and no maintained
package reads legacy `.xls` at all. Both readers are therefore in-repo, under
`src/lib/imports/`, values-only, and bounded at every step — which also puts the
zip-bomb guard *inside* the extraction rather than wrapped around a black box.

## Sender domains and identities (P3)

Add a domain → an SES identity is created (or adopted) → the DKIM, MAIL FROM and
DMARC records are displayed → you publish them → the application asks SES and
DNS what is actually true.

| | |
|---|---|
| Who decides | Not the browser. `authenticated` holds **no UPDATE grant on `sender_domains`**, so every status column is unwritable from a session by column privilege, before any policy is consulted. Only the verifier writes them, from SES's own verdict and DNS answers. |
| DKIM | SES's `DkimAttributes.Status` **and** `VerifiedForSendingStatus`. Seeing the CNAMEs resolve is not the same as SES having accepted them. |
| SPF | Checked at the *envelope* domain — the custom MAIL FROM subdomain when one is configured, since that is what SPF authorises. Tokenised, not substring-matched: `include:amazonses.com.evil.example` is not authorization, and `+all` is reported as malformed. |
| DMARC | `_dmarc.<domain>` is parsed properly: missing, malformed, several records, and the policy value. `p=none` is *monitoring*, not protection, and shows as **Attention** rather than a tick. |
| MAIL FROM | A derived `bounce.<domain>`, never chosen by a request, and constrained by the schema to be a subdomain of the sending domain. |
| Usable | DKIM + SPF + MAIL FROM, all verified. DMARC is assessed and reported but does not gate sending — a domain with no DMARC record still authenticates. |
| Wrong-domain identities | Impossible, not merely checked: `from_domain` is a generated column and the foreign key is composite — `(workspace_id, domain_id, from_domain)` → `(workspace_id, id, domain)`. `hello@otherdomain.com` under `example.com`, or under another workspace's domain, is refused by PostgreSQL. |
| Readiness | One authority, `lib/sender/readiness.ts`. P4's campaign preflight must call it rather than reading status columns, for the same reason nothing but `lib/eligibility` may query `suppressions`. |
| Transient faults | A DNS lookup that fails carries the previous status forward; a lookup that succeeds and finds nothing downgrades it. A resolver timeout must not take a verified domain out of service. |

## How sending is gated

P5 adds exactly one way for a message to leave: the worker endpoint
(`POST /api/internal/worker/tick`, HMAC-signed, called by pg_cron) runs
`lib/sending/worker.ts`, which hands messages to the provider chosen by
`lib/sending/provider/index.ts`. Each of these layers is independently
sufficient to stop a send:

1. **Mode.** `EMAIL_SENDING_MODE=disabled` (the default) makes every tick a
   no-op. `dry_run` uses a provider that performs no I/O at all.
2. **The live gate.** `live` also requires AWS credentials,
   `AWS_SES_CONFIGURATION_SET`, `UNSUBSCRIBE_SECRET_V1`, `WORKER_HMAC_SECRET`
   and an https `NEXT_PUBLIC_APP_URL`, re-checked on every tick.
3. **IAM.** `docs/ses-iam-policy.json` still explicitly denies `ses:SendEmail`.
   `docs/ses-iam-policy-live.json` — SendEmail only, one identity, one
   configuration set — is attached by an operator once DNS is confirmed.
4. **No clock by default.** The pg_cron schedule is
   `supabase/ops/p5_schedule.sql`, applied by hand; no migration schedules
   anything.
5. **Per campaign.** Preflight runs again when a campaign becomes due and on
   resume; sender readiness and the unsubscribe mechanism are re-checked on
   every tick. An unverified sender cannot launch.

Still true from earlier phases: no email SDK, SMTP library or external queue is
installed. `SendEmail` is one hand-signed request in one file
(`lib/sending/provider/ses-send-client.ts`); P3's configuration client keeps its
closed four-operation allowlist. Exactly two modules make outbound calls, both to
the fixed regional SES host with redirects refused.

**Idempotency** (ADR-0001) is enforced by the database, not by the worker: one
job per recipient per campaign, at most one accepted attempt per job, at most
one attempt in flight, an attempt row committed before every provider call, and
unconfirmed outcomes held as `send_uncertain` — never retried automatically.

Every statement above is asserted by `tests/sending-gates.test.ts`,
`tests/sending-worker.test.ts` and `tests/sending-db.test.ts`.

## Project state

| Phase | Status |
|---|---|
| P0 — Foundation | Complete |
| P1 — Contacts, lists and suppression | Complete |
| P2 — Import engine | Complete |
| P3 — Sender domains, identities and email authentication | Complete |
| P4 — Templates, campaigns, preflight | Complete |
| P5 — Sending engine | Complete, pending review. Off by default; see ADR-0003 §4 for the external setup before live use |
| P6 — Events, bounces, unsubscribe | Not started (unsubscribe links and one-click were built in P5) |
| P7 — Health, analytics, hardening | Not started |
