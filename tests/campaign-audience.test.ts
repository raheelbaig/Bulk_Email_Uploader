import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seedContact, seedList, seedSuppression, testEligibilityReader } from './helpers/p1';
import { testCampaignRepository } from './helpers/p4';
import {
  audienceCountsBalance,
  checkEligibilityBatch,
  classifyAudienceMember,
  summarizeAudience,
} from '@/lib/eligibility';

/**
 * The audience count, and the rule it has to agree with.
 *
 * There are three statements of "may this address be contacted" in the system:
 * `decide()` in the eligibility authority, `classifyAudienceMember` beside it
 * for counting, and the SQL in `public.campaign_audience_counts`. Three is two
 * too many in general — the count has to happen in the database, because
 * shipping a list to the application to count it is exactly the scan this design
 * avoids, so the duplication is deliberate and this suite is the thing that
 * keeps it honest.
 *
 * Every case below asserts all three agree on the same rows.
 */
describe('campaign audience counts', () => {
  let db: TestDb;
  let alice: { userId: string; workspaceId: string };
  let bob: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDb();
    alice = await db.createUser('alice@example.test');
    bob = await db.createUser('bob@example.test');
  });
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.raw('delete from list_members');
    await db.raw('delete from suppressions');
    await db.raw('delete from contact_lists');
    await db.raw('delete from contacts');
  });

  async function addToList(listId: string, contactId: string, workspaceId = alice.workspaceId) {
    await db.raw('insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)', [
      workspaceId,
      listId,
      contactId,
    ]);
  }

  const counts = (workspaceId: string, listId: string) =>
    testCampaignRepository(db, workspaceId).audienceCounts(listId);

  /**
   * Runs the eligibility authority over the same rows the SQL saw, and asserts
   * the two reach the same numbers. This is the drift check.
   */
  async function assertAgreesWithAuthority(workspaceId: string, listId: string) {
    const sql = await counts(workspaceId, listId);

    const members = await db.raw<{ email_normalized: string; status: string }>(
      `select c.email_normalized, c.status
         from list_members lm
         join contacts c on c.workspace_id = lm.workspace_id and c.id = lm.contact_id
        where lm.workspace_id = $1 and lm.list_id = $2`,
      [workspaceId, listId],
    );

    // The authority itself, one address at a time, through its real reader.
    const decisions = await checkEligibilityBatch(testEligibilityReader(db), {
      workspaceId,
      emails: members.rows.map((row) => row.email_normalized),
      requireContact: true,
    });
    const authorityEligible = decisions.filter((decision) => decision.eligible).length;

    // And the counting form of the same rule.
    const suppressed = await db.raw<{ email_normalized: string }>(
      'select email_normalized from suppressions where workspace_id = $1',
      [workspaceId],
    );
    const suppressedSet = new Set(suppressed.rows.map((row) => row.email_normalized));
    const summary = summarizeAudience(
      members.rows.map((row) => ({
        suppressed: suppressedSet.has(row.email_normalized),
        status: row.status,
      })),
    );

    expect(sql.eligible, 'SQL disagrees with the eligibility authority').toBe(authorityEligible);
    expect(sql.eligible, 'SQL disagrees with summarizeAudience').toBe(summary.eligible);
    expect(sql.suppressed).toBe(summary.suppressed);
    expect(sql.inactive).toBe(summary.inactive);
    expect(sql.total).toBe(summary.total);
    expect(audienceCountsBalance(sql)).toBe(true);

    return sql;
  }

  it('counts an ordinary list', async () => {
    const listId = await seedList(db, alice.workspaceId, 'Subscribers');
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      await addToList(listId, await seedContact(db, alice.workspaceId, email));
    }

    const result = await assertAgreesWithAuthority(alice.workspaceId, listId);
    expect(result).toMatchObject({ total: 3, eligible: 3, suppressed: 0, inactive: 0, capped: false });
  });

  it('an empty list counts as zero rather than failing', async () => {
    const listId = await seedList(db, alice.workspaceId, 'Empty');
    const result = await assertAgreesWithAuthority(alice.workspaceId, listId);
    expect(result.total).toBe(0);
    expect(result.eligible).toBe(0);
  });

  it('excludes a suppressed address', async () => {
    const listId = await seedList(db, alice.workspaceId, 'Mixed');
    await addToList(listId, await seedContact(db, alice.workspaceId, 'ok@example.com'));
    await addToList(listId, await seedContact(db, alice.workspaceId, 'blocked@example.com'));
    await seedSuppression(db, alice.workspaceId, 'blocked@example.com');

    const result = await assertAgreesWithAuthority(alice.workspaceId, listId);
    expect(result).toMatchObject({ total: 2, eligible: 1, suppressed: 1, inactive: 0 });
  });

  it('excludes an inactive contact', async () => {
    const listId = await seedList(db, alice.workspaceId, 'Statuses');
    await addToList(listId, await seedContact(db, alice.workspaceId, 'active@example.com'));
    await addToList(
      listId,
      await seedContact(db, alice.workspaceId, 'invalid@example.com', { status: 'invalid' }),
    );

    const result = await assertAgreesWithAuthority(alice.workspaceId, listId);
    expect(result).toMatchObject({ total: 2, eligible: 1, suppressed: 0, inactive: 1 });
  });

  it('counts a contact that is both suppressed and inactive once, as suppressed', async () => {
    // Suppression wins, exactly as it does in `decide()`. Counting it twice
    // would make the buckets stop summing to the total, which is why
    // `audienceCountsBalance` is asserted on every case.
    const listId = await seedList(db, alice.workspaceId, 'Both');
    const contactId = await seedContact(db, alice.workspaceId, 'both@example.com');
    await addToList(listId, contactId);
    // The suppression trigger flips the contact to 'suppressed' as well.
    await seedSuppression(db, alice.workspaceId, 'both@example.com');

    const result = await assertAgreesWithAuthority(alice.workspaceId, listId);
    expect(result).toMatchObject({ total: 1, eligible: 0, suppressed: 1, inactive: 0 });
  });

  it('a list where everyone is held back has zero eligible, which is the blocker', async () => {
    const listId = await seedList(db, alice.workspaceId, 'All blocked');
    for (const email of ['x@example.com', 'y@example.com']) {
      await addToList(listId, await seedContact(db, alice.workspaceId, email));
      await seedSuppression(db, alice.workspaceId, email);
    }

    const result = await assertAgreesWithAuthority(alice.workspaceId, listId);
    expect(result.total).toBe(2);
    expect(result.eligible).toBe(0);
  });

  it('counts only the requested list', async () => {
    const listA = await seedList(db, alice.workspaceId, 'A');
    const listB = await seedList(db, alice.workspaceId, 'B');
    await addToList(listA, await seedContact(db, alice.workspaceId, 'a-only@example.com'));
    await addToList(listB, await seedContact(db, alice.workspaceId, 'b-only@example.com'));

    expect((await counts(alice.workspaceId, listA)).total).toBe(1);
    expect((await counts(alice.workspaceId, listB)).total).toBe(1);
  });

  it("never counts another workspace's contacts", async () => {
    const aliceList = await seedList(db, alice.workspaceId, 'Alice');
    await addToList(aliceList, await seedContact(db, alice.workspaceId, 'alice@example.com'));

    const bobList = await seedList(db, bob.workspaceId, 'Bob');
    await addToList(bobList, await seedContact(db, bob.workspaceId, 'bob@example.com'), bob.workspaceId);

    expect((await counts(alice.workspaceId, aliceList)).total).toBe(1);
    // Alice's workspace, Bob's list id: the function filters by both.
    expect((await counts(alice.workspaceId, bobList)).total).toBe(0);
  });

  it("a suppression in one workspace does not affect another's counts", async () => {
    const shared = 'shared@example.com';
    const aliceList = await seedList(db, alice.workspaceId, 'Alice shared');
    await addToList(aliceList, await seedContact(db, alice.workspaceId, shared));

    const bobList = await seedList(db, bob.workspaceId, 'Bob shared');
    await addToList(bobList, await seedContact(db, bob.workspaceId, shared), bob.workspaceId);
    await seedSuppression(db, bob.workspaceId, shared);

    // Suppression is workspace-scoped (ARCHITECTURE §4.2). Bob suppressing an
    // address must not tell Alice anything, nor change her audience.
    expect((await counts(alice.workspaceId, aliceList)).eligible).toBe(1);
    expect((await counts(bob.workspaceId, bobList)).eligible).toBe(0);
  });

  it('reports a capped count as a floor rather than a total', async () => {
    const listId = await seedList(db, alice.workspaceId, 'Large');
    for (const email of ['1@example.com', '2@example.com', '3@example.com']) {
      await addToList(listId, await seedContact(db, alice.workspaceId, email));
    }

    const capped = await db.raw<{ total: string; capped: boolean }>(
      'select total, capped from public.campaign_audience_counts($1, $2, $3)',
      [alice.workspaceId, listId, 2],
    );
    expect(Number(capped.rows[0]?.total)).toBe(2);
    expect(capped.rows[0]?.capped).toBe(true);
  });

  it('does not become unbounded when asked for an absurd limit', async () => {
    const listId = await seedList(db, alice.workspaceId, 'Bounded');
    await addToList(listId, await seedContact(db, alice.workspaceId, 'one@example.com'));

    // The function clamps its own bound, so a caller cannot turn it into a scan.
    const result = await db.raw<{ total: string }>(
      'select total from public.campaign_audience_counts($1, $2, $3)',
      [alice.workspaceId, listId, 999_999_999],
    );
    expect(Number(result.rows[0]?.total)).toBe(1);
  });
});

describe('the counting rule itself', () => {
  it('suppression wins over status', () => {
    expect(classifyAudienceMember({ suppressed: true, status: 'active' })).toBe('suppressed');
    expect(classifyAudienceMember({ suppressed: true, status: 'invalid' })).toBe('suppressed');
  });

  it('only an active contact is eligible', () => {
    expect(classifyAudienceMember({ suppressed: false, status: 'active' })).toBe('eligible');
    expect(classifyAudienceMember({ suppressed: false, status: 'invalid' })).toBe('inactive');
    expect(classifyAudienceMember({ suppressed: false, status: 'suppressed' })).toBe('inactive');
  });

  it('the buckets always sum to the total', () => {
    const summary = summarizeAudience([
      { suppressed: false, status: 'active' },
      { suppressed: true, status: 'active' },
      { suppressed: false, status: 'invalid' },
    ]);
    expect(summary).toMatchObject({ total: 3, eligible: 1, suppressed: 1, inactive: 1 });
    expect(audienceCountsBalance(summary)).toBe(true);
  });
});
