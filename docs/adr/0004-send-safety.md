# ADR-0004 — Send safety: approvals, volume limits, footer, and what live sending still needs

Status: accepted for 0011–0014 (implemented, not yet applied to production); P6 and consent sections are designs only.
Date: 2026-09-25 (second pre-production QA pass)

## 1. Context

A QA review asked, before any real email is sent: can the system send something nobody meant to send, send too much, send to the wrong people, or send mail that damages the domain? Four gaps were found and fixed in code; two larger ones are designed here and remain open.

## 2. Decisions implemented

### 2.1 A campaign launches only in the mode it was approved for (migration 0012)

**Problem.** A campaign stored only a time. The worker launched any due `scheduled` campaign in whatever mode the deployment was in at that moment. Campaigns scheduled during QA while `EMAIL_SENDING_MODE=disabled` would therefore launch live when the variable was changed, provided their time was ahead or within the 120-minute grace window. A configuration change alone could send real mail.

**Decision.** Scheduling stamps `campaigns.approved_send_mode` with the deployment's mode at that moment (`disabled`, `dry_run` or `live`). A launch is permitted only when the launch mode equals the approval. Enforced three times, each sufficient alone:

1. `lib/sending/worker.ts` `promote()` holds a mismatched campaign (`paused`, reason `approved_for_<mode>` or `not_approved`) before running preflight.
2. `sending_promote_campaign` adds `approved_send_mode = p_mode` to its compare-and-set.
3. `app.guard_campaign_write` refuses a launch stamp whose `execution_mode` differs from the approval, for every role.

The approval is written only by the `validating → scheduled` statement, cleared automatically whenever a campaign returns to `draft`, and is outside the `authenticated` column grant. Existing rows get `NULL`, which matches no mode, so a campaign scheduled before 0012 is held until rescheduled (fail closed).

**Why not a separate "approved" status?** A held campaign is already `paused` (never launched), and the existing path out of that is "return to draft, schedule again", which re-runs preflight. Adding a status would have widened the state machine for no extra guarantee.

**Consequence.** Every change of `EMAIL_SENDING_MODE` requires a person to reschedule each pending campaign. That is the intended friction.

### 2.2 Daily cap (migration 0013)

`sending_reserve_budget` now takes `p_daily_cap` and grants at most `cap − (sum of today's UTC reservations)` for the workspace. It holds a per-workspace advisory transaction lock, so overlapping ticks cannot race across minute boundaries. The worker passes `SEND_DAILY_CAP` (default **200**, maximum 1,000,000).

Reserved-but-unclaimed budget is refunded (`sending_refund_budget`). Without the refund, a campaign near its end reserves a full batch each tick and uses a few; the daily cap would then be spent on nothing. Found by test.

The cap argument has no default, and the 0010 signature was dropped, so no caller can reach an uncapped version.

### 2.3 Cross-campaign contact cooldown (migration 0013)

`sending_claim_jobs` now takes `p_cooldown_minutes` (from `CONTACT_COOLDOWN_HOURS`, default **24**, `0` disables it). It skips a recipient that another campaign of the **same execution mode** claimed or sent to within the window. The skip is recorded as `skipped` / `frequency_cap`, and that campaign never retries the recipient. Claims per workspace are serialised with an advisory lock, so two campaigns reaching the same address at the same instant see each other. Dry runs only count against dry runs, so a rehearsal never blocks a real send.

Within one campaign, duplicates were already impossible (0010 G1; canonical addresses by 0011).

### 2.4 Footer postal address (migration 0014)

`workspace_settings.postal_address` is set by owners and admins under **Settings** (RLS policy from 0002 plus a column grant). The composer appends it, HTML-escaped, beside the unsubscribe link in both the HTML and the text part of every message of a campaign that requires unsubscribe. It is configuration, not template content, so no template edit can remove it. If it is missing:

- preflight blocks scheduling and launch (`postal_address_missing`),
- the worker pauses a campaign that is already sending,
- the composer refuses to build the message.

Campaigns marked as not requiring unsubscribe (transactional) are exempt, and preflight warns about that opt-out.

### 2.5 Smaller hardening in the same pass

- Canonical addresses are a CHECK constraint (0011); see that migration.
- Scheduling requires admin, matching resume.
- `campaigns.max_rate_override` is honoured, but only to slow a campaign down.
- Sign-in is limited per account (10 per 15 minutes) and per client (50 per 15 minutes); sign-up per client (10 per hour). Buckets are keyed by a hash, so no raw address or IP is stored.
- CSP (`frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`) and HSTS (2 years, no `includeSubDomains`). A script CSP needs per-request nonces and is a follow-up.

## 3. Warm-up (operational, not software)

The software guarantees the cap cannot be exceeded. Choosing the cap is an operator decision based on the domain's history and the complaint and bounce rates observed. A common conservative pattern for a domain with no sending history:

| Days | `SEND_DAILY_CAP` | Advance only if (previous days) |
|---|---|---|
| 1–3 | 50 | bounces < 2%, complaints < 0.1% |
| 4–7 | 100 | same |
| 8–14 | 250 | same |
| 15–21 | 500 | same |
| then | roughly double weekly | same; stop and investigate on any breach |

Send to the most engaged, most recently opted-in contacts first. No schedule guarantees inbox placement.

## 4. Design — bounce and complaint ingestion (P6, NOT IMPLEMENTED)

**What exists today.**
- Every live message carries `ConfigurationSetName` and `EmailTags` (`workspace_id`, `campaign_id`, `job_id`, `attempt_no`, `mode`).
- Suppression reasons `hard_bounce`, `complaint` and `provider_suppressed` exist and are irreversible.
- Job states `bounced`/`complained` and campaign counters exist.
- **Nothing receives provider events.**

**Minimum production-safe design:**

1. **Transport.** An SES configuration set event destination publishes to an SNS topic (Bounce, Complaint, Delivery, Send, Reject, RenderingFailure). An HTTPS subscription points at `POST /api/webhooks/ses`.
2. **Authenticity**, checked before any parsing beyond the envelope:
   - verify SignatureVersion 2 (SHA-256) against the certificate at `SigningCertURL`;
   - accept that URL only if it is `https://sns.<region>.amazonaws.com/...pem`; cache the certificate by URL;
   - require `TopicArn` to equal the configured `AWS_SNS_TOPIC_ARN`;
   - reject messages whose `Timestamp` is more than 1 hour old;
   - handle `SubscriptionConfirmation` only through the validated `SubscribeURL` host.
3. **Idempotency and replay.** A new table `provider_events (sns_message_id text primary key, type, workspace_id, job_id, received_at, processed_at, outcome)`. The handler inserts with `on conflict do nothing`, so a replayed or re-delivered notification is a no-op. Service role only, with no client grant.
4. **Workspace association.** Taken from the message tags, then **cross-checked**: the job must exist in that workspace and its `provider_message_id` must equal `mail.messageId`. On any mismatch the event is stored with `outcome = 'unmatched'` and nothing else happens. Tags are sender-controlled data, so they are never trusted on their own.
5. **Effects**, each one SQL function and one transaction:
   - **Permanent bounce:** suppression `hard_bounce` (source `ses_event`); job `sent → bounced`; `n_bounced + 1`.
   - **Transient bounce:** record only. A later policy may suppress after N transient bounces in M days.
   - **Complaint:** suppression `complaint`; job `→ complained`; `n_complained + 1`.
   - **Send:** resolves `dispatched`/`unknown` attempts (ADR-0001 §3.4).
   - **Reject / RenderingFailure:** the job fails.
   - The existing suppression trigger cancels the address's pending jobs in every campaign.
6. **Health auto-pause.** Rolling per-workspace rates. Pause every sending campaign (`policy.auto_paused`) above 4% bounces or 0.08% complaints over the last 500 sends, below SES's review thresholds (5% / 0.1%).
7. **Gate.** Add a live-gate requirement that `AWS_SNS_TOPIC_ARN` is set and an event has been received in the last N days, so live sending cannot open with the pipeline dark.

**Interim mitigation before P6 exists:** enable the SES *account-level suppression list* for BOUNCE and COMPLAINT. SES will then refuse to deliver to those addresses again. It does not update this application's suppression list or counters.

## 5. Design — consent and opt-in (NOT IMPLEMENTED)

**What is recorded today.**
- `contacts.import_id`: the first import that created the contact.
- `imports.actor_id`, filename and time.
- `list_members.added_at`, with no source or actor.
- Unsubscribes, as suppressions with their campaign.
- Audit logs of imports and membership changes.

**Nothing** records whether, when or how a person agreed to receive email.

| Kind | Minimum |
|---|---|
| Technical | `contacts.consent_status` (`unknown`, `opted_in`, `double_opted_in`, `existing_customer`, `withdrawn`); `consent_at`; `consent_source` (e.g. `import:<id>`, `form`, `manual`); `consent_method`. `withdrawn` is set by unsubscribe and can never be reversed by an import (same rule as suppression). `list_members.source` and `added_by`. |
| Product | The import wizard asks the uploader to state the consent basis for the file and records `imports.consent_basis`, `attested_by` and `attested_at` on every contact it creates. Preflight shows how many recipients have `unknown` consent, and a workspace setting decides whether that warns or blocks. |
| Compliance consideration | Which consent basis is required depends on the recipients' jurisdictions (for example, GDPR/PECR in the UK and EU, CASL in Canada, CAN-SPAM in the US). That is a legal decision for the business, not something the software can infer. The software's job is to record the basis and make it visible. |
