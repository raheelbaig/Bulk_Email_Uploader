-- =============================================================================
-- 0011 — Canonical addresses are a database guarantee
-- =============================================================================
-- Found by the pre-production QA pass (2026-09-25).
--
-- Every application write path runs an address through `lib/email/normalize`
-- before storing it. The database did not insist on it: `authenticated` holds
-- INSERT on contacts and UPDATE on `contacts.email_normalized` (0005), so a
-- member holding the anon key could store `Dup@Example.com` beside
-- `dup@example.com`. Both then became jobs of the same campaign — the uniqueness
-- guarantees in 0010 (G1) compare the stored text — and the recipient received
-- the campaign twice. The SQL eligibility predicate (an exact match against
-- `suppressions.email_normalized`) likewise did not see a case variant of a
-- suppressed address as suppressed; only the final in-process eligibility check
-- stopped that one.
--
-- The fix is the one this schema already uses for every other invariant: state
-- it as a constraint, so it holds for every role and every future write path.
--
-- The pattern is the output alphabet of `normalizeEmail`, exactly:
--   local   RFC 5322 dot-atom, lowercase ASCII, no leading/trailing/double dot
--   domain  lowercase ASCII labels of [a-z0-9-], at least two, alphabetic TLD
-- Label-level rules the normalizer also applies (no leading or trailing hyphen,
-- 63-octet labels) are not repeated here: they cannot create a second spelling
-- of the same address, which is what this constraint exists to prevent.
-- `tests/qa-hardening.test.ts` inserts the normalizer's own output to prove the
-- two agree.
--
-- Existing rows were all written by the normalizer, so both constraints validate
-- in place. If one does not, this migration fails as a whole and changes nothing
-- — which is the correct outcome: that row is the defect.
-- =============================================================================

create or replace function app.is_canonical_email(value text)
returns boolean
language sql
immutable
parallel safe
as $fn$
  select value ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'
$fn$;

comment on function app.is_canonical_email(text) is
  'True when the value is in the exact form lib/email/normalize produces (0011).';

alter table contacts
  add constraint ck_contacts_email_canonical check (app.is_canonical_email(email_normalized));

alter table suppressions
  add constraint ck_suppressions_email_canonical check (app.is_canonical_email(email_normalized));
