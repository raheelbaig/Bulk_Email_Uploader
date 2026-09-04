# Email Uploader

Email campaign and bulk sending platform.

> ## There is no live sending path.
>
> This deployment is at **P3 — sender domains and identities**. There is an
> audience, a suppression list, a way to fill both from a spreadsheet, and now
> verified sending domains — the *permission* to send, with still no way to act
> on it. There is no send call, no SMTP, no email queue, no worker, no send
> endpoint and no campaign model.
>
> P3 talks to Amazon SES for the first time, for identity configuration only.
> The AWS SDK is deliberately not installed (it ships `SendEmailCommand` beside
> the identity APIs); four requests are signed by hand against a closed
> operation allowlist, and the documented IAM policy denies `ses:SendEmail`
> outright. No code path in this repository can put a message into anyone's
> inbox, and `tests/no-sending.test.ts` fails the build if that changes.
> See [Why sending is impossible](#why-sending-is-impossible-right-now).

## Documents

| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The blueprint. Source of truth for schema and design decisions. |
| [`docs/adr/0001-ses-send-idempotency.md`](docs/adr/0001-ses-send-idempotency.md) | The SES crash window: what is and is not guaranteed, and why the system fails closed. Supersedes §13.4. |
| [`docs/adr/0002-availability-and-recovery.md`](docs/adr/0002-availability-and-recovery.md) | Scheduling, availability and recovery. Withdraws the free-tier keep-alive claim. |

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

`pnpm db:migrate` needs `DATABASE_URL`. Migrations are plain SQL applied in
filename order and recorded with a checksum; editing an applied migration is a
hard error, because it would let two environments diverge silently.

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

## Why sending is impossible right now

Not by configuration or a feature flag. P3 introduced an `EmailProvider` port
and an SES adapter, so "no provider exists" is no longer the reason — these
four are:

1. **No SDK.** `@aws-sdk/client-sesv2` ships `SendEmailCommand` in the same
   package as the identity APIs. The four requests P3 needs are signed by hand
   (`src/lib/sender/provider/ses/sigv4.ts`, ~100 lines of SigV4 over
   `node:crypto`), so no send-capable code is present to be called.
2. **A closed operation allowlist.** The SES client can issue exactly four
   requests — create identity, get identity, put MAIL FROM attributes, get
   account. SESv2's send operation, `POST /v2/email/outbound-emails`, is absent,
   and a test enumerates every path literal in the file to prove it.
3. **A port with nowhere to put a message.** `EmailProvider` declares four
   configuration methods. A test asserts no type in it mentions a recipient, a
   subject or a body.
4. **An IAM policy that denies it.** `docs/ses-iam-policy.json` grants three
   identity actions and `ses:GetAccount`, and explicitly denies `ses:SendEmail`,
   `ses:SendRawEmail` and `ses:DeleteEmailIdentity`. A leaked P3 credential
   cannot send, and cannot destroy an identity either.

And, as before, by absence:

- No mail library or queue dependency is installed.
- No email queue: pgmq is not enabled. The one queue that exists, `import_jobs`,
  carries an import id and nothing that could address a recipient — no message,
  no subject, no destination — and a test asserts those columns stay absent.
- No scheduler: `pg_cron` and `pg_net` are not enabled. The only extension is
  `pg_trgm`, for contact search.
- No `email_jobs`, `send_attempts`, `campaigns`, `templates` or `email_events`
  tables exist.
- No worker route, and no internal endpoint of any kind. Periodic
  re-verification exists as a *service* (`verifyDueSenderDomains`) with no HTTP
  entry point: the authenticated worker surface it would need belongs to P5.
- Exactly one source file calls `fetch()` — the SES configuration client —
  against a fixed `email.<region>.amazonaws.com` host, with redirects refused.
  A second call site anywhere fails the build.
- Domain ownership is proven by DNS lookups and by asking SES. Nothing requests
  a user-supplied domain over HTTP, so there is no SSRF surface; no module under
  `src/lib/sender/` may even construct a URL.
- Two API routes exist: `/api/health`, which returns `{"status":"ok"}`, and
  `/api/imports/[id]/rejections`, which is `GET`-only and returns a CSV of rows
  that failed to import. Both are asserted by name.
- Nothing under `src/lib/imports/` calls a function named `send*` or
  `dispatch*`, or mentions SMTP or SES.

AWS credentials are optional: with none set the application runs normally and
the sender pages report that the provider is not configured. They are named in
exactly two modules — `lib/env.ts`, which validates them, and
`lib/sender/provider/index.ts`, which turns them into a provider — both
`server-only`, neither of which logs. The later-phase secrets
(`AWS_SES_CONFIGURATION_SET`, `AWS_SNS_TOPIC_ARN`, `WORKER_HMAC_SECRET`,
`UNSUBSCRIBE_SECRET_V1`) are still read by nothing.

Every one of these statements is asserted by `tests/no-sending.test.ts`, so the
guarantee is checked on each build rather than restated here by hand.

## Project state

| Phase | Status |
|---|---|
| P0 — Foundation | Complete |
| P1 — Contacts, lists and suppression | Complete |
| P2 — Import engine | Complete |
| P3 — Sender domains, identities and email authentication | Complete, pending review |
| P4 — Templates, campaigns, preflight | Not started |
| P5 — Sending engine | Not started |
| P6 — Events, bounces, unsubscribe | Not started |
| P7 — Health, analytics, hardening | Not started |
