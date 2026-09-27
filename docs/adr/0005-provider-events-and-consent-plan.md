# ADR-0005 — Implementation plan: SES bounce/complaint ingestion (P6) and consent tracking

Status: **proposed**. Nothing here is built or enabled. It expands ADR-0004 §4–§5 into work items.
Date: 2026-09-26

---

## Part 1 — Bounce and complaint ingestion (P6)

### 1.1 Why it blocks live sending

SES expects senders to stop mailing addresses that hard-bounce or complain. An account whose bounce rate passes about 5%, or whose complaint rate passes about 0.1%, is reviewed and can be paused. Today the application never learns about either event, so a bad address would be mailed by every future campaign. The SES account-level suppression list (§1.3) stops the *delivery*, but the application would still count, schedule and report those recipients as sendable.

### 1.2 Architecture

```
SES send (ConfigurationSetName + EmailTags: workspace_id, campaign_id, job_id, attempt_no, mode)
  └─ configuration set event destination ──► SNS topic ──► HTTPS subscription
                                                            POST /api/webhooks/ses
                                                              1. size cap, JSON parse of the SNS envelope only
                                                              2. SNS signature + topic + freshness checks
                                                              3. insert provider_events (sns_message_id PK) — duplicate ⇒ 200, stop
                                                              4. correlate: tags → job, cross-checked by provider message id
                                                              5. one SQL function per event type (one transaction)
                                                              6. 200
```

Choosing SNS over EventBridge: SNS delivers straight to an HTTPS endpoint and signs every message with a verifiable certificate. EventBridge API destinations would need a shared secret and more AWS resources. Either would work; SNS is the smaller surface.

### 1.3 AWS configuration required (operator, per environment; production only after approval)

**SES (in the sending region):**
1. The domain identity, verified with Easy DKIM (2048-bit) and a custom MAIL FROM (`bounce.<domain>` with MX to `feedback-smtp.<region>.amazonses.com` and SPF `v=spf1 include:amazonses.com ~all`). The app already provisions and checks these.
2. A DMARC record at `_dmarc.<domain>`: start at `p=none` with a `rua` mailbox you read, then move to `quarantine`.
3. The configuration set named by `AWS_SES_CONFIGURATION_SET`, with reputation metrics on.
4. An event destination on that configuration set: type **SNS**; events **SEND, REJECT, BOUNCE, COMPLAINT, DELIVERY, DELIVERY_DELAY, RENDERING_FAILURE**.
5. The **account-level suppression list** turned on for BOUNCE and COMPLAINT (`PutAccountSuppressionAttributes`). Do this **before the first live send, even before P6 ships**.
6. Production access (out of the sandbox), requested with the answers this design gives: how bounces, complaints and unsubscribes are handled.

**SNS:**
1. A standard topic, e.g. `email-uploader-ses-events-production`, in the same region.
2. A topic policy allowing `ses.amazonaws.com` to `sns:Publish`, conditioned on `aws:SourceAccount = <account>` and `aws:SourceArn = <configuration set ARN>`.
3. An HTTPS subscription to `https://<app host>/api/webhooks/ses`, with **raw message delivery OFF** (the signed envelope is needed).
4. An optional SQS dead-letter queue on the subscription, so events are not lost while the app is down.
5. If SSE-KMS is used, the key policy must allow SES and SNS.

**IAM:** the app needs **no** SNS permission, because it only receives. The live send policy stays `docs/ses-iam-policy-live.json`. Resources are created by an operator identity, never by the app.

**App environment:** `AWS_SNS_TOPIC_ARN` (already reserved in `.env.example`).

### 1.4 Database (migration 0015)

- `provider_events`:
  - columns: `sns_message_id text primary key`, `event_type text`, `provider_message_id text`, `workspace_id uuid null`, `job_id uuid null`, `received_at`, `processed_at`, `outcome text` (`applied`, `duplicate`, `unmatched`, `ignored`), `payload jsonb` (bounded, with the recipient address redacted to a hash);
  - service role only; RLS on with no policy (registered exception); retention handled by a reviewed prune function.
- SQL functions (service role only, one transaction each, every one idempotent):
  - `events_record_bounce(p_sns_id, p_workspace, p_job, p_message_id, p_permanent bool, p_subtype text)`. Permanent: suppression `hard_bounce` (source `ses_event`), job `sent/delivered → bounced`, `n_bounced + 1`. Transient: record only.
  - `events_record_complaint(...)`: suppression `complaint`, job `→ complained`, `n_complained + 1`.
  - `events_record_delivery(...)`: job `sent → delivered`, `n_delivered + 1`.
  - `events_record_send(...)`: resolves a `dispatched`/`unknown` attempt to `accepted` (ADR-0001 §3.4; the transition already exists).
  - `events_record_reject(...)`: attempt `rejected`/permanent; the job fails.
  - Each function first checks that the job exists **in p_workspace** and that its `provider_message_id` equals `p_message_id`, otherwise it returns `unmatched`. The existing suppression trigger then cancels the address's pending jobs in every campaign.
- `workspace_send_health` view: rolling bounce and complaint rates over the last 500 sends.

### 1.5 Code

| Module | Responsibility |
|---|---|
| `lib/provider-events/sns-verify.ts` (pure; certificate fetch injected) | `SignatureVersion` must be `2` (SHA256withRSA; refuse `1`). `SigningCertURL` must be `https:` with a host matching `^sns\.[a-z0-9-]+\.amazonaws\.com$` and a path ending `.pem`. Certificates are cached by URL with a size cap. Canonical string per SNS spec for `Notification` / `SubscriptionConfirmation`. `TopicArn` must equal `AWS_SNS_TOPIC_ARN`. `Timestamp` must be within 1 hour. |
| `lib/provider-events/parse.ts` | Zod schemas for the SES event JSON. Unknown event types → `ignored`. |
| `lib/provider-events/apply.ts` | Maps a parsed event to one SQL function; audit `suppression.auto` with codes only; never logs an address. |
| `app/api/webhooks/ses/route.ts` | POST only; body cap 256 KB; always a bare status; `SubscriptionConfirmation` → GET the validated `SubscribeURL` only after signature and topic checks pass. |
| `lib/sending/gate.ts` | New live requirement `event_pipeline`: `AWS_SNS_TOPIC_ARN` set. Live sending cannot open without it. |
| `lib/sending/worker.ts` | Before sending, pause every sending campaign in a workspace whose health view exceeds 4% bounces or 0.08% complaints (`policy.auto_paused`). |
| Suppressions page | Show `hard_bounce` / `complaint` with the source `ses_event`. |

### 1.6 Tests required before enabling

- A signature made with a test key pair verifies.
- A tampered field, SignatureVersion 1, a certificate URL on `http:`, on `sns.evil.com`, on `sns.us-east-1.amazonaws.com.evil.com`, or with a non-`.pem` path, a wrong topic, or a stale timestamp → 400, nothing written.
- The same SNS message twice → one effect.
- Tags naming workspace B for a job in A → `unmatched`, nothing suppressed.
- Permanent bounce → suppression, job and counter; transient → record only.
- Complaint → suppression.
- A suppression from an event cancels pending jobs in other campaigns.
- Crossing the health threshold → auto-pause.
- The live gate stays closed without `AWS_SNS_TOPIC_ARN`.
- `sending-gates` allowlist updated for the new route.

### 1.7 Rollout

1. Build and test locally (PGlite).
2. There is no staging environment. The webhook needs a public HTTPS URL (a Vercel deployment, or a tunnel) — `localhost` cannot receive SNS. Exercising it end to end without real recipients means SES **sandbox** credentials and **live** mode against the SES mailbox simulator (`bounce@simulator.amazonses.com`, `complaint@simulator.amazonses.com`, `success@simulator.amazonses.com`). That is an explicit decision for you: it is the first time live mode would be used anywhere.
3. Production: SES account-level suppression list on first; then the topic and subscription; then deploy; then confirm events arrive (Send events from a small test to your own addresses) before any real campaign.

---

## Part 2 — Consent and opt-in tracking

### 2.1 What exists today (verified 2026-09-26)

- `contacts.import_id`: the first import that created the contact.
- `imports.actor_id`, `filename`, `created_at`: who uploaded what, and when.
- `list_members.added_at`, with no actor or source.
- Suppressions record unsubscribes (reason, source `unsubscribe_link`, campaign).
- Audit logs record imports and membership changes.
- **No consent fields anywhere.**

### 2.2 Technical implementation (migration 0016)

```sql
create type consent_status as enum
  ('unknown', 'opted_in', 'double_opted_in', 'existing_relationship', 'withdrawn');

alter table contacts
  add column consent_status   consent_status not null default 'unknown',
  add column consent_at       timestamptz,
  add column consent_source   text check (consent_source in ('import', 'manual', 'form', 'api')),
  add column consent_evidence text check (length(consent_evidence) <= 500),
  add column consent_import_id uuid;

alter table imports
  add column consent_basis    consent_status,
  add column consent_evidence text check (length(consent_evidence) <= 500),
  add column attested_by      uuid references auth.users(id),
  add column attested_at      timestamptz;

alter table list_members
  add column added_by uuid,
  add column source   text check (source in ('import', 'manual'));
```

Rules enforced in the database, not only in code:

- **`withdrawn` is terminal.** A trigger refuses any change away from it, for every role.
- An `unsubscribe` or `complaint` suppression sets `withdrawn` (extend `sync_contact_status_on_suppress`).
- The consent columns are outside the `authenticated` UPDATE grant. They are changed only through a `contacts_set_consent` function that records the actor and time and writes the audit log.
- The import upsert sets consent only where the contact is `unknown`, and never overwrites existing evidence. *Whether a later, stronger attestation should replace an earlier one is a product decision (§2.4).*

### 2.3 Import workflow

1. After mapping and before confirm, a new **Consent** step. The uploader must choose the basis that applies to **every row in this file**, one of `opted_in`, `double_opted_in`, `existing_relationship`, or `unknown / not sure`. For anything but `unknown`, a short evidence note is required (e.g. "Newsletter form on example.com, 2025–2026").
2. The attestation is saved on the import (`consent_basis`, `consent_evidence`, `attested_by`, `attested_at`) and copied to each contact the import creates. Audit: `import.consent_attested`.
3. The import summary shows the basis next to the counts, and a file cannot be confirmed without the step.
4. Contact pages show consent status, source, date and evidence; the contacts list can be filtered by consent status.
5. Preflight adds an info line with recipient counts by consent status. A workspace setting `consent_policy` (`inform` | `warn` | `block_unknown`) decides whether `unknown` recipients are only shown, warned about, or excluded. Exclusion lives in the eligibility authority, so the claim, audience counts and final check stay one rule.

### 2.4 Decisions that belong to the business (not made here)

- Which consent statuses may receive which kinds of email. The software can enforce any mapping; it cannot choose one.
- Whether double opt-in is required, and for which recipients or regions.
- What counts as sufficient evidence, and how long it is retained.
- Whether a later attestation may upgrade an earlier one.
- Which jurisdictions' rules apply (for example CAN-SPAM, GDPR/PECR, CASL). That depends on where recipients are, and is a question for legal advice.
- The default `consent_policy` for new workspaces.

### 2.5 Tests required

- `withdrawn` cannot be reversed by import, update or any role.
- An unsubscribe sets `withdrawn`.
- An import cannot be confirmed without an attestation.
- The attestation is copied to new contacts only.
- `block_unknown` excludes unknown recipients consistently in the audience count, the claim and the final check.
- Consent columns cannot be written through the API.
