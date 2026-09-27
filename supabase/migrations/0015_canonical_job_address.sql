-- =============================================================================
-- 0015 — A job's address is canonical, so one recipient is one job per campaign
-- =============================================================================
-- Found by the phase 3 real-database QA (2026-09-26).
--
-- 0010 (G1) guarantees one job per recipient per campaign with
-- UNIQUE (campaign_id, to_email). That comparison is on the stored text, so it
-- is only case-insensitive if every stored address is spelled one way. 0011
-- made contacts and suppressions canonical; email_jobs was left out, and the QA
-- probe inserted `x@example.com` and `X@EXAMPLE.COM` into the same campaign as
-- two jobs. The same gap affected every exact-match predicate on to_email: the
-- suppression check in sending_claim_jobs, the cross-campaign cooldown (0013)
-- and the unsubscribe lookup all compare `to_email` with a canonical column.
--
-- It was not reachable through the application — only service_role inserts
-- jobs, and sending_materialize_campaign copies `contacts.email_normalized`,
-- which 0011 already constrains — but "only the current write path is careful"
-- is the situation 0011 was written to end. The same constraint, stated here,
-- makes UNIQUE (campaign_id, to_email) case-insensitive for every role and every
-- future write path: a second spelling of an address cannot be stored at all.
--
-- Safety: a CHECK added in place validates every existing row. Any job written
-- by sending_materialize_campaign already satisfies it. If some row does not,
-- this migration fails as a whole and changes nothing — that row is the defect.
-- =============================================================================

alter table email_jobs
  add constraint ck_email_jobs_to_email_canonical check (app.is_canonical_email(to_email));

comment on constraint ck_email_jobs_to_email_canonical on email_jobs is
  'Only the canonical spelling of an address can be stored, so UNIQUE (campaign_id, to_email) is case-insensitive (0015).';
