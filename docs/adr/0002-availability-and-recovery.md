# ADR-0002 — Availability, scheduling, and the recovery model

| | |
|---|---|
| Status | **Accepted** |
| Date | 2026-09-03 |
| Amends | `ARCHITECTURE.md` §12.1, §12.5, §25.2 |
| Decision owner | Reviewer-ratified |

---

## 1. What changed

The blueprint listed, as a benefit of `pg_cron` scheduling:

> *"the per-minute activity keeps a free-tier Supabase project from auto-pausing for inactivity"*

**That claim is withdrawn.** It was an unverified assumption about how Supabase measures inactivity,
and it created a hidden dependency: the correctness of the deployment would have rested on a
side effect of the scheduler. Even if per-minute cron did prevent pausing today, relying on it would
be building on undocumented behaviour that can change without notice.

`pg_cron + pg_net` is **retained** as the scheduler — the reasoning in §12.1 (per-minute granularity on
the free tier, scheduler co-located with the queue, no Vercel plan dependency, schedules versioned in
migrations) stands on its own without the keep-alive claim.

No keep-alive mechanism is introduced. Deliberately: a synthetic heartbeat whose only purpose is to
defeat a provider's resource-reclamation policy is both fragile and the wrong kind of engineering.

---

## 2. Three separate concerns

The blueprint conflated these. They are now treated independently, with independent failure modes.

| Concern | Mechanism | Fails when | Consequence |
|---|---|---|---|
| **Scheduling** — deciding *when* work should happen | `pg_cron` | The database is unavailable | No ticks fire. Missed ticks are **not** backfilled. |
| **Queue processing** — doing the work | pgmq + worker endpoint | The database or the app is unavailable | No messages are consumed. Messages remain durable. |
| **Project availability** — whether the platform is running at all | Supabase platform | Free-tier inactivity pause; maintenance; incident | Everything above stops. |

The important structural property: **all three failures are "nothing happens", never "the wrong thing
happens".** There is no partial-progress mode.

---

## 3. Why the design is already safe

This is not a new mechanism; it is a consequence of decisions already locked in the blueprint.

| Property | Comes from | Why downtime is survivable |
|---|---|---|
| All state is in Postgres | L6 — pgmq, not Redis | The database going down cannot desynchronise two stores, because there is only one store. |
| The queue is a table | pgmq | Messages are rows. If the database is down, they are not lost — they are simply not readable, and they are still there on restart. |
| Enqueue is transactional | §11.3 | There is no state where jobs exist but are unqueued, or messages exist for rolled-back jobs — including across a crash mid-launch. |
| `pg_cron` does not backfill | pg_cron semantics | A 3-day outage does **not** produce 4,320 queued ticks on resume. Exactly one tick fires, and it finds whatever work is outstanding. |
| Launch is idempotent | L3 — `UNIQUE (campaign_id, contact_id)` | A launch interrupted mid-flight and retried produces the same job set, never a second one. |
| Transitions are guarded | §19.2 | `queued → sending` fires once. A relaunch attempt against an already-`sending` campaign affects zero rows. |
| Claiming is atomic | L4 | Workers resuming simultaneously after an outage cannot double-claim. |
| Attempt intent is durable | ADR-0001 §3.1 | A worker killed by the outage mid-send leaves a classifiable record, not an ambiguous one. |

---

## 4. Recovery sequence

```
Supabase unavailable
   │
   ├─ pg_cron does not fire            → no ticks, none queued for later
   ├─ worker endpoint returns 5xx      → pg_net requests fail, fire-and-forget, no retry storm
   ├─ pgmq messages remain durable     → rows in a table
   ├─ email_jobs remain in their state → 'pending' or 'claimed'
   └─ SNS deliveries to the webhook fail
          └─ SNS retries on its own schedule; events surviving the retry window
             are recovered by the reconciler (ADR-0001 §3.2), not lost silently
   │
Service recovers
   │
   ├─ next scheduled tick fires normally (no catch-up burst)
   ├─ reaper returns jobs stranded in 'claimed' with no attempt row → 'pending'
   ├─ reconciler resolves stranded attempts → 'accepted' or 'unknown'
   ├─ SES quota cache is stale → refused until refreshed (§5.2)
   ├─ campaigns past their schedule are gated by the grace window (§5.1)
   └─ processing resumes at the current policy-approved rate
   │
Result: no duplicate campaign launch · no lost jobs · no thundering herd
```

---

## 5. New controls this ADR requires

Downtime is survivable, but two things would be *wrong on resume* without explicit handling. These are
the substantive additions.

### 5.1 Missed-schedule grace window

Without this, a campaign scheduled for 02:00 during a three-day outage launches the moment the service
returns — at whatever hour that is, with content that may now be stale, alongside every other campaign
that came due meanwhile. Firing a "Tuesday morning" campaign on Friday night is a real harm, and the
recipient experiences it as spam.

```sql
-- scheduler tick
update campaigns set status = 'queued'
 where status = 'scheduled'
   and scheduled_at <= now()
   and scheduled_at >  now() - (interval '1 minute' * $SCHEDULE_GRACE_MINUTES);

-- anything older is held, never auto-launched
update campaigns
   set status = 'paused', pause_reason = 'missed_schedule'
 where status = 'scheduled'
   and scheduled_at <= now() - (interval '1 minute' * $SCHEDULE_GRACE_MINUTES);
```

`SCHEDULE_GRACE_MINUTES` defaults to **120**. Beyond it, the campaign requires an explicit human
relaunch, which re-runs preflight (§19.1). The audit log records `campaign.missed_schedule` with the
delay, and the UI states plainly: *"This campaign was scheduled for 02:00 on 3 September but the
service was unavailable. It has not been sent. Review and relaunch when ready."*

### 5.2 Stale-quota guard

`SendingLimits` carries `fetchedAt` (§15.3). After an outage the cached value may be hours old, and
`SentLast24Hours` in particular will be badly wrong.

The policy engine returns `BLOCK` when the cached quota is older than `QUOTA_MAX_AGE_MINUTES`
(default 30). The first tick after recovery therefore refreshes quota before it sends anything, rather
than sending against a stale budget.

### 5.3 Rate-ledger windows do not accrue

`rate_ledger` rows are keyed by `window_start`. Old windows are irrelevant rather than a credit
balance — there is no "banked" allowance to burn on resume. Already true by construction (§18.3); it is
recorded here because it is the property that prevents a post-outage burst, and a future refactor
must not break it.

### 5.4 Worker guards its own preconditions

The tick already re-evaluates the policy engine per workspace. Restated as a recovery requirement: the
worker must **never** assume that state observed before an outage is still valid. Quota, health state,
domain verification, and campaign status are all re-read on each tick, not cached across ticks.

---

## 6. Free-tier auto-pause — stated honestly

On Supabase Free, a project that has been inactive pauses and **must be resumed by a human through the
dashboard**. There is no supported API for automatic resumption, and no keep-alive is being built.

| | |
|---|---|
| **Effect if it happens** | All sending stops. Jobs, queue messages and campaigns are durable and intact. |
| **Data loss** | None. |
| **Correctness impact** | None — §3 and §4 cover it. |
| **Recovery** | A human resumes the project; the next tick continues. §5.1 prevents a stale campaign blast. |
| **Detection** | Not solved on the free tier. There is no in-system way to detect the pause, because the system that would detect it is the one that is paused. |
| **Mitigation** | External uptime monitoring, if wanted, or Supabase Pro, which does not auto-pause. |

**This is an accepted limitation of a free-tier deployment, not an engineering problem to solve.** It is
one of the concrete triggers for the Pro upgrade recorded in §25.3, alongside the 500 MB ceiling.

The product must not promise scheduled delivery it cannot keep. Any UI that lets a user schedule a
campaign for a future time on a free-tier deployment carries a plain statement that delivery depends on
the service being available at that time.

---

## 7. New configuration

```bash
SCHEDULE_GRACE_MINUTES=120        # beyond this, a missed campaign is held, not launched
QUOTA_MAX_AGE_MINUTES=30          # stale provider quota blocks sending
```

---

## 8. Test obligations for P5

1. Simulated outage across a scheduled launch time → campaign is **not** sent; it lands in `paused`
   with `pause_reason='missed_schedule'`.
2. Outage shorter than the grace window → campaign launches normally on recovery.
3. Interrupted launch, then retried → identical job set, no duplicates (`ON CONFLICT` proof).
4. Worker killed mid-tick → jobs return to `pending` via the reaper, exactly once each.
5. Stale quota cache → policy engine returns `BLOCK` until refreshed.
6. No accrued rate budget after an idle period — the first post-outage tick sends at the normal rate,
   not a burst.
7. Two workers starting simultaneously after recovery → no double-claim.
