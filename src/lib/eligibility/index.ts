/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RECIPIENT ELIGIBILITY AUTHORITY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module is the single source of truth for whether an address may be sent
 * to. Nothing else in the codebase may query the `suppressions` table to make a
 * decision.
 *
 * ── Who must call this ────────────────────────────────────────────────────
 *
 *   P4  campaign preflight        — before a campaign may leave `draft`
 *   P4  recipient materialisation — filtering contacts into email_jobs
 *   P5  the atomic job claim      — the suppression predicate inside the
 *                                   claiming UPDATE (ARCHITECTURE §8.1) is the
 *                                   SQL expression of this same rule, and must
 *                                   stay in step with it
 *   P5  test sends                — no bypass flag exists, deliberately
 *   P6  unsubscribe handling      — writes suppressions this reads
 *   P6  bounce/complaint handling — likewise
 *
 * Essentially every send-to-suppressed incident in this product category traces
 * back to a second code path that reimplemented the check slightly differently
 * (ARCHITECTURE §1.3, §D). Adding a new caller means calling this function, not
 * writing another one.
 *
 * ── Why a reader port ─────────────────────────────────────────────────────
 *
 * User-facing requests must keep RLS as their second layer of defence, while
 * background workers necessarily run under the service role, which bypasses RLS.
 * Both need the identical decision, so the decision lives in `evaluate()` and
 * only the data access differs. There is one rule and two ways to read it —
 * never two rules.
 */

import { normalizeEmail } from '@/lib/email/normalize';

export type IneligibilityReason =
  | 'invalid_email'
  | 'suppressed'
  | 'contact_inactive'
  | 'contact_missing';

export interface EligibilityInput {
  workspaceId: string;
  email: string;
  /**
   * When true, an address with no contact row is ineligible.
   *
   * Campaign sending selects from contacts, so a missing contact means the
   * recipient is not in the audience. Manual and transactional paths may
   * legitimately target an address that has no contact row, so this defaults to
   * false.
   */
  requireContact?: boolean;
}

export type EligibilityResult =
  | { eligible: true; emailNormalized: string }
  | { eligible: false; emailNormalized: string | null; reason: IneligibilityReason; detail?: string };

export interface SuppressionRecord {
  emailNormalized: string;
  reason: string;
}

export interface ContactStatusRecord {
  emailNormalized: string;
  status: string;
}

/**
 * The data the decision needs, abstracted from how it is fetched.
 *
 * Implementations must be workspace-scoped. `findSuppressions` and
 * `findContactStatuses` take already-normalized addresses.
 */
export interface EligibilityReader {
  findSuppressions(workspaceId: string, emailsNormalized: string[]): Promise<SuppressionRecord[]>;
  findContactStatuses(workspaceId: string, emailsNormalized: string[]): Promise<ContactStatusRecord[]>;
}

/** Contact statuses that may be sent to. */
const SENDABLE_CONTACT_STATUS = new Set(['active']);

/**
 * The decision. Pure, given the two lookups — which is what makes it testable
 * without a database and identical on every call path.
 */
function decide(args: {
  emailNormalized: string | null;
  suppression: SuppressionRecord | undefined;
  contact: ContactStatusRecord | undefined;
  requireContact: boolean;
}): EligibilityResult {
  const { emailNormalized, suppression, contact, requireContact } = args;

  if (emailNormalized === null) {
    return { eligible: false, emailNormalized: null, reason: 'invalid_email' };
  }

  // Suppression is checked first and wins over everything. An address the
  // recipient asked us to stop using is not sendable regardless of contact
  // state, campaign, or caller.
  if (suppression !== undefined) {
    return {
      eligible: false,
      emailNormalized,
      reason: 'suppressed',
      detail: suppression.reason,
    };
  }

  if (contact === undefined) {
    return requireContact
      ? { eligible: false, emailNormalized, reason: 'contact_missing' }
      : { eligible: true, emailNormalized };
  }

  if (!SENDABLE_CONTACT_STATUS.has(contact.status)) {
    return {
      eligible: false,
      emailNormalized,
      reason: 'contact_inactive',
      detail: contact.status,
    };
  }

  return { eligible: true, emailNormalized };
}

/** Eligibility for one address. */
export async function checkEligibility(
  reader: EligibilityReader,
  input: EligibilityInput,
): Promise<EligibilityResult> {
  const [result] = await checkEligibilityBatch(reader, {
    workspaceId: input.workspaceId,
    emails: [input.email],
    ...(input.requireContact === undefined ? {} : { requireContact: input.requireContact }),
  });
  // The batch always returns one entry per input.
  return result ?? { eligible: false, emailNormalized: null, reason: 'invalid_email' };
}

/**
 * Eligibility for many addresses, in two queries regardless of batch size.
 *
 * P4 materialises campaign recipients through this; a per-address round trip
 * would be an N+1 on the largest operation in the system.
 */
export async function checkEligibilityBatch(
  reader: EligibilityReader,
  input: { workspaceId: string; emails: string[]; requireContact?: boolean },
): Promise<EligibilityResult[]> {
  const requireContact = input.requireContact ?? false;

  const normalized = input.emails.map((email) => {
    const result = normalizeEmail(email);
    return result.ok ? result.normalized : null;
  });

  const lookups = [...new Set(normalized.filter((e): e is string => e !== null))];

  if (lookups.length === 0) {
    return normalized.map((emailNormalized) =>
      decide({ emailNormalized, suppression: undefined, contact: undefined, requireContact }),
    );
  }

  const [suppressions, contacts] = await Promise.all([
    reader.findSuppressions(input.workspaceId, lookups),
    reader.findContactStatuses(input.workspaceId, lookups),
  ]);

  const suppressionByEmail = new Map(suppressions.map((s) => [s.emailNormalized, s]));
  const contactByEmail = new Map(contacts.map((c) => [c.emailNormalized, c]));

  return normalized.map((emailNormalized) =>
    decide({
      emailNormalized,
      suppression: emailNormalized === null ? undefined : suppressionByEmail.get(emailNormalized),
      contact: emailNormalized === null ? undefined : contactByEmail.get(emailNormalized),
      requireContact,
    }),
  );
}

/** Convenience for callers that only want the sendable subset. */
export async function filterEligible(
  reader: EligibilityReader,
  input: { workspaceId: string; emails: string[]; requireContact?: boolean },
): Promise<string[]> {
  const results = await checkEligibilityBatch(reader, input);
  return results.flatMap((r) => (r.eligible ? [r.emailNormalized] : []));
}

/** User-safe explanations. */
export const INELIGIBILITY_MESSAGE: Record<IneligibilityReason, string> = {
  invalid_email: 'That email address is not valid.',
  suppressed: 'This address is on the suppression list and cannot be emailed.',
  contact_inactive: 'This contact is not active.',
  contact_missing: 'There is no contact for this address in this workspace.',
};

// ─────────────────────────────────────────────────────────────────────────────
// Audience summaries (P4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bucket one audience member falls into.
 *
 * `decide()` above answers for one address, given two lookups. A campaign needs
 * the same answer for a whole list, as counts — and it must be the *same*
 * answer, or the number shown before a send and the rows selected during one
 * would disagree.
 *
 * So the rule is stated once more here, in the form counting needs, and the SQL
 * in `public.campaign_audience_counts` (migration 0009) is the SQL form of this
 * function. Three statements of one rule is two too many in general; the
 * alternative here is worse, because the count has to happen in the database —
 * shipping a list to the application to count it is the scan this design exists
 * to avoid. `tests/campaign-audience.test.ts` asserts all three agree on the
 * same rows, so a change to one that is not made to the others fails the build.
 */
export type AudienceBucket = 'eligible' | 'suppressed' | 'inactive';

export function classifyAudienceMember(member: {
  suppressed: boolean;
  status: string;
}): AudienceBucket {
  // Suppression first, and it wins — exactly as in `decide()`.
  if (member.suppressed) return 'suppressed';
  return SENDABLE_CONTACT_STATUS.has(member.status) ? 'eligible' : 'inactive';
}

export interface AudienceCounts {
  total: number;
  eligible: number;
  suppressed: number;
  inactive: number;
  /** True when the count hit its bound and is therefore a floor, not a total. */
  capped: boolean;
}

export function summarizeAudience(
  members: Array<{ suppressed: boolean; status: string }>,
  capped = false,
): AudienceCounts {
  const counts: AudienceCounts = { total: members.length, eligible: 0, suppressed: 0, inactive: 0, capped };
  for (const member of members) counts[classifyAudienceMember(member)] += 1;
  return counts;
}

/** An empty audience — a list with no members, or no list chosen at all. */
export const EMPTY_AUDIENCE: AudienceCounts = {
  total: 0,
  eligible: 0,
  suppressed: 0,
  inactive: 0,
  capped: false,
};

/** True when the three buckets account for every member. A disagreement is a bug. */
export function audienceCountsBalance(counts: AudienceCounts): boolean {
  return counts.eligible + counts.suppressed + counts.inactive === counts.total;
}
