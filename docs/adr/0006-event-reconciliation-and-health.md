# ADR-0006 — Send/Delivery/Reject events, reconciliation, sending health and event retention

Status: **implemented** in migration `0017_event_reconciliation.sql` (2026-10-01). It completes ADR-0005 Part 1. It is not yet applied to production.
Date: 2026-10-01

## Context

Migration 0016 acted only on Bounce and Complaint events. ADR-0005 §1.8 recorded what was still missing:

1. **Reconciliation (ADR-0001 §3.2).** The sending design relies on SES's `Send` event to confirm an attempt that the worker could not record. That covers a crash mid-call, or a timeout after SES accepted the message. Without it, every such attempt became `send_uncertain` and needed a person to decide.
2. **A race.** A bounce that arrived before the worker committed the provider message id was recorded as `unmatched`, and the address was never suppressed in the app.
3. **Delivery and Reject.** `n_delivered` never moved. A message SES accepted and then refused (for example, it found a virus) still counted as sent.
4. **Health.** Nothing paused sending when bounce or complaint rates approached the levels at which SES reviews an account.
5. **Retention.** `provider_events` grows with every message, and no role may delete from it.

## Decision

### Reconciliation is the first step of every correlated event

`app.events_resolve_attempt(workspace, job, attempt_no, message_id, recipients)` runs before matching for Send, Delivery, Reject, Bounce and Complaint. All of these events prove that SES accepted the attempt. The function moves a `dispatched` or `unknown` attempt to `accepted`, and its job from `claimed` or `send_uncertain` to `sent` (`n_sent + 1`), only when **all** of these hold:

- the `workspace_id`, `job_id` and `attempt_no` tags name an existing attempt of that job in that workspace;
- the attempt is `live`;
- the job's frozen address is among the event's recipients;
- the attempt is the job's current one. A later attempt exists only after a person chose "send again", and confirming an older attempt would collide with the new one;
- neither the attempt nor the job already carries a different message id;
- the job is still `claimed` or `send_uncertain`. A job a person already decided about is never moved.

The lock order is the same as in `sending_record_accepted` (attempt, then job), so the worker and the webhook cannot deadlock on the same attempt. Whichever commits second finds the attempt accepted and does nothing. The worker already ignores a `false` from `recordAccepted`.

A resolution writes `send.confirmed_by_provider` to the audit log. The outcome (`resolved`, `already` or a refusal reason) is stored on the event row as `detail.reconcile`.

### Delivery, Reject

- **Delivery:** `sent → delivered`, `n_delivered + 1`. No audit row: one per message would bury the audit log, and the event row records the job it moved.
- **Reject:** `sent → failed` (a new transition), `n_sent − 1`, `n_failed + 1`, audited, and no suppression, because a content refusal says nothing about the address. The reason is kept only if it is a short plain phrase.

### Sending health and auto-pause

`workspace_send_health(workspace)` reads the last 500 live messages that reached SES and returns `(sample, bounced, complained)`. It is `SECURITY INVOKER` and granted to `authenticated`, so members can read their own workspace through RLS. The dashboard shows it.

`app.events_health_guard` runs when a permanent bounce or a complaint has moved a job. With a sample of at least 100 messages, it pauses every `sending` campaign in the workspace when bounces reach **4%** or complaints reach **0.08%** (ADR-0005 §1.5). The pause reason is `bounce_rate_high` or `complaint_rate_high`, and the guard writes a `policy.auto_paused` audit row in the same transaction.

The guard is **edge-triggered**, never level-triggered. A paused workspace sends nothing, so its rate cannot recover, and a level check would hold it forever. A person may resume, which is an audited decision, and the next bad event pauses again.

### Retention

`events_prune(retain_days, limit)` is `SECURITY DEFINER`, executable by `service_role` only. It deletes whole rows older than the window, never less than 30 days, in batches of at most 50,000. The operator schedule (`supabase/ops/p5_schedule.sql`) calls it daily with 90 days.

### The live gate

`event_pipeline` now also requires the SNS topic ARN's region to equal `AWS_REGION`, because SES publishes only to a topic in its own region. When `AWS_ACCOUNT_ID` is set, the ARN's account must match it too.

## Consequences

- An attempt is held as `send_uncertain` only when SES really never confirmed it. The fail-closed guarantee of ADR-0001 §4.3 is unchanged: an event can only ever *confirm* an acceptance, never cause a send.
- The event destination must publish **Send, Reject, Bounce, Complaint and Delivery** (plus DeliveryDelay and RenderingFailure, which are recorded as `ignored`).
- Rollback: `supabase/ops/rollback_0017.sql` restores the 0016 functions verbatim. It keeps every row and every job state an event moved.
