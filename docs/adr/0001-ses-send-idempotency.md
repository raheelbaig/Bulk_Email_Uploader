# ADR-0001 — SES send idempotency and the crash window

| | |
|---|---|
| Status | **Accepted** |
| Date | 2026-09-03 |
| Supersedes | `ARCHITECTURE.md` §13.4 (provisional write-ordering decision) |
| Blocks | P5 — Sending engine |
| Decision owner | Reviewer-ratified |

---

## 1. The problem, stated precisely

```
t0   Worker claims job J atomically              (Postgres commit)
t1   Worker calls ses:SendEmail                  (network)
t2   SES accepts, returns MessageId              (message is now unrecallable)
t3   Worker writes provider_message_id           (Postgres commit)
```

A crash between **t2** and **t3** leaves a job whose real-world outcome is *unknown to us*: the
message may or may not have been accepted. The blueprint's original mitigation — a reaper that
refuses to reclaim jobs with a non-null `provider_message_id` — does not help here, because at t2→t3
that column is precisely what failed to be written.

There is no shared transaction between SES and Postgres. **This is a two-phase-commit problem with a
participant that does not support two-phase commit.**

---

## 2. Provider capabilities — what SES actually offers

Investigated before choosing a design. Nothing here is assumed; anything uncertain is flagged.

| Capability | Available? | Consequence |
|---|---|---|
| Idempotency / client-request token on `SendEmail` | **No.** SESv2 `SendEmail` has no `ClientToken`-style parameter, unlike several other AWS APIs. | We cannot ask SES to deduplicate for us. |
| Caller-supplied `Message-ID` header | **No.** SES generates and assigns `Message-ID` itself; a supplied value is not honoured. | We cannot make the provider's identifier deterministic from our side. |
| Query "was a message with my key sent?" | **No.** SES exposes no message-lookup or search API. | No *synchronous* reconciliation is possible. |
| `EmailTags` (message tags) propagated to event notifications | **Yes.** Tags set on the send appear in the event payload under `mail.tags`. Values are restricted to alphanumerics, `-` and `_` — a UUID qualifies. | **This is the reconciliation channel.** |
| `SEND` event type on a configuration set | **Yes.** SES emits an event when it *accepts* a message, not only on delivery. | Acceptance is observable asynchronously. |

> **Verify at implementation time.** The first three rows are the load-bearing negatives. Confirm each
> against the current SESv2 API reference before writing P5; if AWS has since added an idempotency
> token, this ADR should be revisited, because it would allow a strictly better design.

### 2.1 The consequence

SES gives us **no synchronous** way to make the send idempotent, but it does give us an **asynchronous**
way to learn what happened — provided we put our own identifier into the message *before* sending, so
the event that comes back is self-identifying.

That single fact is what the design below is built on.

---

## 3. Design

### 3.1 A durable record of intent, written before the call

```sql
create table send_attempts (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references email_jobs(id) on delete cascade,
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  attempt_no          smallint not null,
  state               attempt_state not null default 'dispatched',
  dispatched_at       timestamptz not null default now(),
  resolved_at         timestamptz,
  provider_message_id text,
  error_code          text,
  constraint uq_attempt unique (job_id, attempt_no)
);

create type attempt_state as enum ('dispatched', 'accepted', 'rejected', 'unknown');
```

Revised worker ordering:

```
1. Claim job atomically                            → status = 'claimed'
2. INSERT send_attempts (state='dispatched')       ← COMMITTED BEFORE THE NETWORK CALL
3. ses:SendEmail  with EmailTags { job_id, attempt_no, workspace_id }
4. UPDATE send_attempts state='accepted', provider_message_id
   UPDATE email_jobs status='sent', provider_message_id
```

The step-2 row is the whole point. After a crash we can always distinguish:

| Observed state | What we know |
|---|---|
| No attempt row | We crashed **before** calling SES. Nothing was sent. **Safe to retry.** |
| Attempt row `dispatched` | We crashed **around** the call. Outcome **unknown**. |
| Attempt row `accepted` | SES accepted. Never retry. |
| Attempt row `rejected` | SES refused. Retry per §14 classification. |

The previous design could not tell row 1 from row 2. That distinction is the entire improvement:
it converts an *undetectable* risk into a *detectable* one.

### 3.2 The reconciliation channel

Because every send carries `EmailTags: { job_id, attempt_no }`, and because the configuration set emits
a `SEND` event on acceptance, an accepted message announces itself — **even if the process that sent it
no longer exists.**

```
SES accepts  →  SNS "Send" event  →  webhook
                     │
                     └─ mail.tags.job_id + mail.tags.attempt_no
                            │
                            └─ UPDATE send_attempts
                                 SET state='accepted', provider_message_id = mail.messageId
                               WHERE job_id=$1 AND attempt_no=$2 AND state='dispatched'
                            └─ UPDATE email_jobs
                                 SET status='sent', provider_message_id=…
                               WHERE id=$1 AND status='claimed'
```

Typical Send-event latency is seconds. The reaper's window is 15 minutes. In the overwhelming majority
of crash cases the event resolves the attempt long before the reaper looks at it, and no human ever
sees the incident.

### 3.3 The reaper, corrected

```sql
-- reclaim ONLY jobs that provably never reached SES
update email_jobs j
   set status = 'pending', claimed_at = null
 where j.status = 'claimed'
   and j.claimed_at < now() - interval '15 minutes'
   and not exists (
     select 1 from send_attempts a
      where a.job_id = j.id
        and a.state in ('dispatched', 'accepted')
   );
```

The guard is now the *existence of an attempt record*, not the nullness of a column that the crash
prevented us from writing. This is the correctness fix.

### 3.4 The residue: `send_uncertain`

An attempt still in `dispatched` after `RECONCILE_GRACE_MINUTES` (default 30) with no corresponding
event is marked `unknown`, and its job moves to a new terminal-ish state `send_uncertain`.

```sql
-- reconciler, on the maintenance cron
update send_attempts set state = 'unknown', resolved_at = now()
 where state = 'dispatched'
   and dispatched_at < now() - (interval '1 minute' * $RECONCILE_GRACE_MINUTES);

update email_jobs j set status = 'send_uncertain'
 where j.status = 'claimed'
   and exists (select 1 from send_attempts a
                where a.job_id = j.id and a.state = 'unknown');
```

**`send_uncertain` jobs are never automatically re-dispatched.** See §5.

---

## 4. The five required statements

### 4.1 What can be guaranteed

1. **At most one automatic SES acceptance per `email_jobs` row, for the lifetime of that row.**
   Automatic retries occur only after a *known* rejection — a classified error proving SES did not
   accept the message. An unknown outcome never produces another automatic send.
2. **No job is silently lost.** Every job ends in a state that is either terminal-and-known, or
   explicitly `send_uncertain` and surfaced in the UI and the audit log.
3. **Every crash is classifiable** into "never called SES" / "outcome unknown" / "known outcome",
   because intent is committed before the network call.
4. **Duplicate provider events cannot double-count**, via `UNIQUE (provider_event_id)`.
5. **Duplicate launches cannot create duplicate jobs**, via `UNIQUE (campaign_id, contact_id)`.

### 4.2 What cannot be guaranteed

1. **Exactly-once delivery is impossible.** SES acceptance and the Postgres commit cannot be made
   atomic, and SES offers no idempotency token. This is irreducible, not an implementation gap.
2. **Absence of a Send event is not proof that nothing was sent.** SNS could drop or delay a message,
   or the event destination could be misconfigured. We can never *prove* a `dispatched` attempt did
   not reach a mailbox. This is why §5 is fail-closed.
3. **We cannot guarantee every intended recipient is mailed.** A job may terminate in
   `send_uncertain` and require a human decision.
4. **Below our layer, SES may itself retry SMTP delivery.** Duplicates arising there are provider
   semantics and outside this system's control.

### 4.3 Chosen failure behaviour

> **Fail closed. On an unknown outcome, do not send. Record, surface, and require an explicit human
> decision to re-dispatch.**

This **reverses** the provisional choice in `ARCHITECTURE.md` §13.4, which preferred a possible
duplicate over a possible loss.

Configurable as `UNCERTAIN_ATTEMPT_POLICY` (`hold` | `redispatch`), defaulting to `hold`. Changing it
is an audited settings change, not a code change.

### 4.4 Why this trade-off is preferred

The original reasoning — "duplicates damage reputation, losses damage the customer, prefer the
millisecond-wide duplicate window" — was made under the assumption that the loss would be *silent*.
The reconciliation channel removes that assumption, and with it the reasoning.

Once uncertain outcomes are **detectable and enumerable**, the calculus inverts:

| | Duplicate send | Held send |
|---|---|---|
| Reversible? | **No.** The message is in a mailbox. | **Yes.** One click re-dispatches. |
| Feeds complaint rate? | **Yes** — the metric the entire system exists to protect, and the one Google gates on at 0.3%. | No. |
| Visible to the operator? | Only via a recipient complaint. | Immediately, on the dashboard. |
| Expected frequency | Product of two rare events | Product of two rare events |
| Cost when it happens | Reputation damage across the shared IP pool | One recipient, one click |

A held send is a recoverable, visible, one-click problem. A duplicate is an unrecoverable, invisible
problem that damages the asset the product is built to protect. With detection in place, holding is
strictly better.

Secondary argument: `send_uncertain` count is a **leading indicator of misconfiguration**. A nonzero
count almost always means the SNS event destination is broken — which is a far more serious latent
fault than one unsent email, and one that fail-open behaviour would mask by quietly resending.

### 4.5 How uncertain outcomes are detected and reconciled

| Mechanism | Timing | Resolves |
|---|---|---|
| `send_attempts` row committed pre-call | Synchronous | Distinguishes "never called" from "unknown" |
| SNS `Send` event carrying `job_id` + `attempt_no` tags | Seconds | `dispatched` → `accepted`, back-fills `provider_message_id` |
| Reaper existence-guard | 15 min | Prevents reclaim of any job with a live attempt |
| Reconciler | 30 min | `dispatched` → `unknown`, job → `send_uncertain` |
| Dashboard counter + alert | Continuous | Surfaces the residue |
| Provider-health component degradation | Continuous | Nonzero uncertain count reduces the health score, because it usually indicates a broken event destination |
| Manual re-dispatch action | Human | Audited, warns explicitly that a duplicate may result |

Operator-facing copy for the residual case, in the product's plain-language register:

> **1 message could not be confirmed.**
> We asked Amazon SES to send this message but lost the connection before it confirmed. It may or may
> not have been delivered. Sending it again could mean this person receives it twice.
> `[ Leave it ]  [ Send again anyway ]`

---

## 5. Schema and state-machine amendments

Additions to `ARCHITECTURE.md`, to be applied in P4/P5:

```sql
-- new enum
create type attempt_state as enum ('dispatched', 'accepted', 'rejected', 'unknown');

-- job_status gains one member
alter type job_status add value 'send_uncertain';

-- new table (§3.1 above)
create table send_attempts (…);
create index ix_attempts_open on send_attempts (dispatched_at) where state = 'dispatched';
create index ix_attempts_job  on send_attempts (job_id);
```

State machine:

```
pending ──claim──> claimed ──attempt──> [dispatched]
                      │                      │
                      │                      ├─ event 'Send'  ──> sent ──> delivered|bounced|complained
                      │                      ├─ known error   ──> pending (retry) | failed
                      │                      └─ grace expiry  ──> send_uncertain ──(human)──> pending
                      │
                      └─ crash before attempt row ──reaper──> pending
```

New configuration:

```bash
RECONCILE_GRACE_MINUTES=30
REAPER_CLAIM_TIMEOUT_MINUTES=15
UNCERTAIN_ATTEMPT_POLICY=hold        # hold | redispatch
```

---

## 6. Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Write a `sending` marker *before* the SES call, treat as sent on crash | Cannot distinguish "crashed before the call" from "crashed after". Converts every pre-call crash into a permanent loss — strictly worse than the attempt-row design, which distinguishes them. |
| Keep the original ordering, accept the duplicate window | Leaves the risk undetectable. The attempt row costs one INSERT per send and removes that. |
| Two-phase commit / XA with SES | SES does not participate in distributed transactions. Not available. |
| Deterministic `Message-ID` supplied by us | SES does not honour a caller-supplied `Message-ID`. Not available. |
| Poll SES to check whether a message was sent | No message-lookup API exists. Not available. |
| Outbox pattern with a separate dispatcher | Exactly what `send_attempts` is. Adopted, not rejected. |
| Auto-resend after a long delay if no event arrives | Absence of an event is not proof of non-send (§4.2.2). This would reintroduce silent duplicates precisely when the event pipeline is broken — the worst possible moment. |

---

## 7. Test obligations for P5 / P6

Cannot ship without:

1. Crash injected **between** the attempt INSERT and the SES call → job is **not** auto-resent.
2. Crash injected **before** the attempt INSERT → job **is** reclaimed and sent exactly once.
3. Send event arriving for a job whose worker died → attempt resolves to `accepted`, job to `sent`, no resend.
4. Send event **never** arriving → attempt `unknown`, job `send_uncertain`, no automatic resend, dashboard count increments.
5. Reaper does **not** reclaim a job with a `dispatched` attempt.
6. Two concurrent workers on one job → exactly one `send_attempts` row (enforced by `UNIQUE (job_id, attempt_no)`).
7. Duplicate Send events for one attempt → counters move exactly once.
8. `UNCERTAIN_ATTEMPT_POLICY=redispatch` → resend occurs, and the audit log records it as a deliberate policy choice.
