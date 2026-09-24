# ADR-0003 — Sending engine (P5): implementation decisions

| | |
|---|---|
| Status | **Accepted** |
| Date | 2026-09-24 |
| Implements | `ARCHITECTURE.md` §7–§15, §19; ADR-0001; ADR-0002 |
| Amends | §10.4 (GET unsubscribe), §11 (pgmq), §12.4 (schedules in migrations), §13.3 (advisory lock), §14.1 (error classes), §14.5 (completion) |

P5 builds the sending engine the blueprint describes. This ADR records where the
implementation departs from the blueprint, why, and what is deliberately left
for later. Anything not listed here was built as specified.

---

## 1. Scope

**In:** an outbound provider port with a dry-run sink and an Amazon SES adapter;
per-recipient jobs; ADR-0001's attempt records, reaper and reconciler; retry with
backoff; the scheduler → queued → sending → completed/failed lifecycle;
ADR-0002's missed-schedule grace window and stale-quota guard; signed
unsubscribe links, one-click headers and the unsubscribe endpoint; pause, resume
and cancel; the human decision on uncertain sends.

**Out:** the SNS event webhook (P6), so bounces, complaints and delivery events
are not ingested yet and unconfirmed attempts can only be resolved by the
reconciler or a person; the health engine and adaptive throttle (P7); test sends.

This is a single-company deployment. The existing workspace model is kept
unchanged — P5 adds no tenancy features.

---

## 2. Decisions

### 2.1 Sending is off unless deliberately switched on

`EMAIL_SENDING_MODE` is `disabled | dry_run | live`, default **`disabled`**, in
which the worker reads and writes nothing. `live` additionally requires, all at
once: AWS credentials, `AWS_SES_CONFIGURATION_SET`, `UNSUBSCRIBE_SECRET_V1`,
`WORKER_HMAC_SECRET` and an https `NEXT_PUBLIC_APP_URL` (`lib/sending/gate.ts`).
Independently of all of that, the IAM policy in `docs/ses-iam-policy.json` still
**denies** `ses:SendEmail`; `docs/ses-iam-policy-live.json` is a separate file an
operator attaches once DNS and domain verification are confirmed.

`execution_mode` is stamped on the campaign at launch and cannot change. A dry
run stays a dry run even if the deployment later goes live.

### 2.2 The queue is `email_jobs`, not pgmq

Same reason, same shape as P2's `import_jobs`: the WASM Postgres the test suite
runs real migrations against cannot load pgmq, and the correctness argument
never depended on pgmq — it depends on the conditional-UPDATE claim (§8). The
claim uses `FOR UPDATE SKIP LOCKED` to pick candidates, so overlapping ticks take
disjoint batches, and a status-guarded UPDATE to claim them.

### 2.3 The schedule is an operator-applied script, not a migration

`supabase/ops/p5_schedule.sql` creates `app.dispatch_tick` and the pg_cron jobs.
It is not in `supabase/migrations`, so deploying the application never starts
the clock. Applying it is the deliberate act that begins ticking; even then,
`disabled` mode makes each tick a no-op.

### 2.4 Every state change is one SQL function

The worker reaches Postgres over PostgREST, which cannot hold a transaction
across calls. So every multi-row change (promote, materialise, claim, begin
attempt, record outcome, reap, reconcile, finish) is a single `sending_*`
function, executable by `service_role` only, that re-checks every precondition
itself. Both the production store and the test store call the same functions.

### 2.5 No advisory lock

§13.3 already called the lock a pacing control, not a correctness control, and
a session-level lock cannot be held across PostgREST calls anyway. Pacing comes
from `sending_reserve_budget`, which serialises reservations under a row lock so
concurrent ticks cannot jointly exceed the per-minute limit.

### 2.6 Failure classes: account-level errors halt, they do not fail jobs

`MailFromDomainNotVerifiedException`, `NotFoundException` (typically the
configuration set) and authorization failures — including the IAM policy's
explicit Deny — are **halt**, not permanent (§14.1 listed the first as permanent).
They are properties of the account, so failing each job would burn the whole
list into `failed`. Halting pauses every sending campaign in the workspace with
its jobs intact, to resume once the configuration is fixed.

A timeout, a connection reset mid-request, or a 200 without a `MessageId` is
**unknown**, never a retryable rejection (ADR-0001). A connection that provably
never opened (DNS failure, connection refused) is a transient rejection, because
nothing can have been sent.

### 2.7 Completion waits for uncertain jobs

§14.5 completed a campaign when no job was `pending` or `claimed`. A
`send_uncertain` job is waiting for a person, so it now holds completion open
too. `failed` means no message was accepted and at least one failed; anything
else that finishes is `completed`, and the UI always shows the breakdown.

### 2.8 `skipped` joins the job states

A contact deactivated, deleted or re-addressed between launch and send is
`skipped` (distinct from `suppressed`, so the report can say which). Both count
towards `campaigns.n_suppressed`, "not contacted".

### 2.9 Unsubscribe: GET confirms, POST unsubscribes; tokens name the job

§10.4 suppressed on GET. Corporate mail filters (Safe Links, Mimecast,
Proofpoint) fetch every link in incoming mail, so a GET that unsubscribes
silently removes people who never clicked. GET now shows a one-button page;
POST — including RFC 8058 one-click — performs the unsubscribe.

Tokens carry the **job** id rather than the contact id (§10.1). The job holds the
address frozen at launch, so the link keeps working after the contact is deleted.

Unsubscribe is enforced: `UNSUBSCRIBE_ENFORCED = true`. A campaign that requires
it cannot be scheduled or launched without a signing key, and the composer
refuses to build a message without a link.

### 2.10 Non-ASCII headers are RFC 2047-encoded

Verified against the SESv2 reference while building: `Subject` must be 7-bit
ASCII. Subjects and display names outside ASCII are sent as encoded-words
(`lib/sending/mime.ts`).

---

## 3. Verified at implementation time (ADR-0001 §2)

Checked against the current SESv2 `SendEmail` reference on 2026-09-24:

- There is still **no idempotency or client token** parameter.
- The response is `{ MessageId }`, generated by SES.
- `Content.Simple.Headers` exists (up to 15), which carries `List-Unsubscribe`.
- `EmailTags` exist and are the reconciliation channel for P6.

ADR-0001's design therefore stands unchanged.

---

## 4. What still requires external configuration

None of this is done by the application, and none of it should be done before
the DNS confirmation from the domain host:

1. Verify the sending domain in SES (the P3 sender pages do this) and confirm its
   DKIM, SPF-alignment (custom MAIL FROM) and DMARC records at the DNS host.
   These are **additions** — no existing record, and in particular no MX record
   for the domain's inbound mail, is changed.
2. Create an SES configuration set; P6 will attach its SNS event destination.
3. Request SES production access (the sandbox allows ~200 messages/day, only to
   verified recipients).
4. Attach `docs/ses-iam-policy-live.json` in place of `docs/ses-iam-policy.json`.
5. Store `worker_hmac_secret` and `app_url` in Supabase Vault and apply
   `supabase/ops/p5_schedule.sql`.
6. Run in `dry_run`, review the result, then switch to `live`.
