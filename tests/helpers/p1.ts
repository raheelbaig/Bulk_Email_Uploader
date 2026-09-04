import type { TestDb } from './db';
import type { EligibilityReader } from '@/lib/eligibility';

/** Seeds a contact directly, bypassing the service layer. */
export async function seedContact(
  db: TestDb,
  workspaceId: string,
  email: string,
  extra: { firstName?: string; lastName?: string; company?: string; status?: string } = {},
): Promise<string> {
  const res = await db.raw<{ id: string }>(
    `insert into contacts
       (workspace_id, email_normalized, email_raw, first_name, last_name, company, status)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, 'active'))
     returning id`,
    [
      workspaceId,
      email.toLowerCase(),
      email,
      extra.firstName ?? null,
      extra.lastName ?? null,
      extra.company ?? null,
      extra.status ?? null,
    ],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error(`failed to seed contact ${email}`);
  return id;
}

export async function seedList(db: TestDb, workspaceId: string, name: string): Promise<string> {
  const res = await db.raw<{ id: string }>(
    `insert into contact_lists (workspace_id, name) values ($1, $2) returning id`,
    [workspaceId, name],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error(`failed to seed list ${name}`);
  return id;
}

export async function seedSuppression(
  db: TestDb,
  workspaceId: string,
  email: string,
  reason = 'manually_blocked',
  source = 'test',
): Promise<string> {
  const res = await db.raw<{ id: string }>(
    `insert into suppressions (workspace_id, email_normalized, reason, source)
     values ($1, $2, $3::suppression_reason, $4) returning id`,
    [workspaceId, email.toLowerCase(), reason, source],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error(`failed to seed suppression ${email}`);
  return id;
}

/**
 * An EligibilityReader backed by the test database.
 *
 * Exercises the real decision logic in `lib/eligibility` against real rows,
 * without needing a Supabase HTTP client. The production readers issue the
 * equivalent queries.
 */
export function testEligibilityReader(db: TestDb): EligibilityReader {
  return {
    async findSuppressions(workspaceId, emails) {
      const res = await db.raw<{ email_normalized: string; reason: string }>(
        `select email_normalized, reason::text as reason
           from suppressions
          where workspace_id = $1 and email_normalized = any($2::text[])`,
        [workspaceId, emails],
      );
      return res.rows.map((r) => ({ emailNormalized: r.email_normalized, reason: r.reason }));
    },
    async findContactStatuses(workspaceId, emails) {
      const res = await db.raw<{ email_normalized: string; status: string }>(
        `select email_normalized, status
           from contacts
          where workspace_id = $1 and email_normalized = any($2::text[])`,
        [workspaceId, emails],
      );
      return res.rows.map((r) => ({ emailNormalized: r.email_normalized, status: r.status }));
    },
  };
}
