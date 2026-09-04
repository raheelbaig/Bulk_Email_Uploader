import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedContact, seedSuppression, testEligibilityReader } from './helpers/p1';
import { checkEligibility } from '@/lib/eligibility';
import { REVERSIBLE_REASONS, SUPPRESSION_REASONS } from '@/lib/suppression/service';

/**
 * The seven suppression safety guarantees, each proven against a real database.
 *
 * These are the guarantees the whole product rests on: everything else can be
 * rebuilt, but mailing someone who asked not to be mailed cannot be undone.
 */
describe('suppression safety', () => {
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
    await db.raw('delete from suppressions');
    await db.raw('delete from contacts');
  });

  // ── Guarantee 1 ───────────────────────────────────────────────────────────
  it('1. a suppressed address is never eligible', async () => {
    await seedContact(db, alice.workspaceId, 'target@example.com');
    await seedSuppression(db, alice.workspaceId, 'target@example.com');

    const result = await checkEligibility(testEligibilityReader(db), {
      workspaceId: alice.workspaceId,
      email: 'target@example.com',
    });

    expect(result.eligible).toBe(false);
    expect(result.eligible === false && result.reason).toBe('suppressed');
  });

  // ── Guarantee 2 ───────────────────────────────────────────────────────────
  it('2. a suppression can exist with no contact at all', async () => {
    await seedSuppression(db, alice.workspaceId, 'ghost@example.com');

    const contacts = await db.raw('select 1 from contacts where email_normalized = $1', [
      'ghost@example.com',
    ]);
    expect(contacts.rows).toHaveLength(0);

    const result = await checkEligibility(testEligibilityReader(db), {
      workspaceId: alice.workspaceId,
      email: 'ghost@example.com',
    });
    expect(result.eligible).toBe(false);
  });

  // ── Guarantee 3 ───────────────────────────────────────────────────────────
  it('3. deleting a contact does not delete its suppression', async () => {
    const contactId = await seedContact(db, alice.workspaceId, 'leaver@example.com');
    await seedSuppression(db, alice.workspaceId, 'leaver@example.com', 'unsubscribe');

    await db.raw('delete from contacts where id = $1', [contactId]);

    const remaining = await db.raw<{ reason: string }>(
      'select reason::text as reason from suppressions where workspace_id = $1 and email_normalized = $2',
      [alice.workspaceId, 'leaver@example.com'],
    );
    expect(remaining.rows).toHaveLength(1);
    expect(remaining.rows[0]?.reason).toBe('unsubscribe');
  });

  // ── Guarantee 4 ───────────────────────────────────────────────────────────
  it('4. re-creating the contact later still finds the suppression', async () => {
    const contactId = await seedContact(db, alice.workspaceId, 'returner@example.com');
    await seedSuppression(db, alice.workspaceId, 'returner@example.com', 'complaint');
    await db.raw('delete from contacts where id = $1', [contactId]);

    // Imported again months later, as P2 will do.
    await seedContact(db, alice.workspaceId, 'returner@example.com');

    const result = await checkEligibility(testEligibilityReader(db), {
      workspaceId: alice.workspaceId,
      email: 'returner@example.com',
    });
    expect(result.eligible).toBe(false);
    expect(result.eligible === false && result.detail).toBe('complaint');
  });

  // ── Guarantee 5 ───────────────────────────────────────────────────────────
  it('5. a duplicate suppression insert is rejected by the unique constraint', async () => {
    await seedSuppression(db, alice.workspaceId, 'dupe@example.com');

    const err = await expectRejected(() =>
      seedSuppression(db, alice.workspaceId, 'dupe@example.com'),
    );
    expect(err.message).toMatch(/duplicate key|unique/i);

    const count = await db.raw<{ n: string }>(
      'select count(*)::text as n from suppressions where email_normalized = $1',
      ['dupe@example.com'],
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('5b. the same address may be suppressed independently in each workspace', async () => {
    await seedSuppression(db, alice.workspaceId, 'shared@example.com');
    await seedSuppression(db, bob.workspaceId, 'shared@example.com');

    const rows = await db.raw('select workspace_id from suppressions where email_normalized = $1', [
      'shared@example.com',
    ]);
    expect(rows.rows).toHaveLength(2);
  });

  // ── Guarantee 6 ───────────────────────────────────────────────────────────
  describe('6. cross-workspace suppression is invisible and untouchable', () => {
    it('cannot be read', async () => {
      await seedSuppression(db, bob.workspaceId, 'bobs-blocked@example.com');

      const rows = await db.asUser(alice.userId, (d) =>
        d.raw('select email_normalized from suppressions'),
      );
      expect(rows.rows).toHaveLength(0);
    });

    it('cannot be deleted', async () => {
      const id = await seedSuppression(db, bob.workspaceId, 'bobs-other@example.com');

      const res = await db.asUser(alice.userId, (d) =>
        d.raw('delete from suppressions where id = $1', [id]),
      );
      expect(res.affectedRows).toBe(0);

      const survives = await db.raw('select 1 from suppressions where id = $1', [id]);
      expect(survives.rows).toHaveLength(1);
    });

    it('is not eligible-checked across workspaces', async () => {
      await seedSuppression(db, bob.workspaceId, 'only-bob-blocked@example.com');

      // Suppressed for Bob…
      const forBob = await checkEligibility(testEligibilityReader(db), {
        workspaceId: bob.workspaceId,
        email: 'only-bob-blocked@example.com',
      });
      expect(forBob.eligible).toBe(false);

      // …but Alice's workspace is unaffected. Sharing suppression across tenants
      // would leak one customer's list state to another.
      const forAlice = await checkEligibility(testEligibilityReader(db), {
        workspaceId: alice.workspaceId,
        email: 'only-bob-blocked@example.com',
      });
      expect(forAlice.eligible).toBe(true);
    });
  });

  // ── Guarantee 7 ───────────────────────────────────────────────────────────
  it('7. removing a contact never makes a suppressed address eligible again', async () => {
    const contactId = await seedContact(db, alice.workspaceId, 'gone@example.com');
    await seedSuppression(db, alice.workspaceId, 'gone@example.com', 'hard_bounce');

    await db.raw('delete from contacts where id = $1', [contactId]);

    const result = await checkEligibility(testEligibilityReader(db), {
      workspaceId: alice.workspaceId,
      email: 'gone@example.com',
    });
    expect(result.eligible).toBe(false);
    expect(result.eligible === false && result.reason).toBe('suppressed');
  });

  // ── Reversibility ─────────────────────────────────────────────────────────
  describe('irreversible reasons cannot be removed by anyone', () => {
    it.each(['unsubscribe', 'complaint', 'hard_bounce', 'provider_suppressed'])(
      'a %s suppression cannot be deleted even by the workspace owner',
      async (reason) => {
        const id = await seedSuppression(db, alice.workspaceId, `${reason}@example.com`, reason);

        const res = await db.asUser(alice.userId, (d) =>
          d.raw('delete from suppressions where id = $1', [id]),
        );
        expect(res.affectedRows).toBe(0);

        const survives = await db.raw('select 1 from suppressions where id = $1', [id]);
        expect(survives.rows).toHaveLength(1);
      },
    );

    it.each(['manually_blocked', 'invalid'])(
      'a %s suppression can be removed by an owner',
      async (reason) => {
        const id = await seedSuppression(db, alice.workspaceId, `${reason}@example.com`, reason);

        const res = await db.asUser(alice.userId, (d) =>
          d.raw('delete from suppressions where id = $1', [id]),
        );
        expect(res.affectedRows).toBe(1);
      },
    );

    it('a member cannot remove even a reversible suppression', async () => {
      const carol = await db.createUser('carol@example.test');
      // Demote Carol to `member` in her own workspace.
      await db.raw(
        `update workspace_members set role = 'member' where user_id = $1`,
        [carol.userId],
      );
      const id = await seedSuppression(db, carol.workspaceId, 'member-try@example.com');

      const res = await db.asUser(carol.userId, (d) =>
        d.raw('delete from suppressions where id = $1', [id]),
      );
      expect(res.affectedRows).toBe(0);
    });

    it('the TypeScript reversible list matches the database function', async () => {
      for (const reason of SUPPRESSION_REASONS) {
        const res = await db.raw<{ reversible: boolean }>(
          'select app.suppression_reason_is_reversible($1::suppression_reason) as reversible',
          [reason],
        );
        expect(
          res.rows[0]?.reversible,
          `${reason}: TypeScript and SQL disagree about reversibility`,
        ).toBe((REVERSIBLE_REASONS as readonly string[]).includes(reason));
      }
    });

    it('a suppression cannot be relabelled to escape irreversibility', async () => {
      const id = await seedSuppression(db, alice.workspaceId, 'relabel@example.com', 'complaint');

      // No UPDATE policy and no UPDATE grant exist for suppressions.
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw(`update suppressions set reason = 'manually_blocked' where id = $1`, [id]),
        ),
      );
      expect(err.message).toMatch(/permission denied|row-level security/i);
    });
  });

  // ── Contact status synchronisation ────────────────────────────────────────
  describe('contact status tracks suppression', () => {
    it('flips an active contact to suppressed when the address is suppressed', async () => {
      await seedContact(db, alice.workspaceId, 'sync@example.com');
      await seedSuppression(db, alice.workspaceId, 'sync@example.com');

      const row = await db.raw<{ status: string }>(
        'select status from contacts where email_normalized = $1',
        ['sync@example.com'],
      );
      expect(row.rows[0]?.status).toBe('suppressed');
    });

    it('restores active status when a reversible suppression is lifted', async () => {
      await seedContact(db, alice.workspaceId, 'restore@example.com');
      const id = await seedSuppression(db, alice.workspaceId, 'restore@example.com');
      await db.raw('delete from suppressions where id = $1', [id]);

      const row = await db.raw<{ status: string }>(
        'select status from contacts where email_normalized = $1',
        ['restore@example.com'],
      );
      expect(row.rows[0]?.status).toBe('active');
    });

    it('does not vouch for a contact previously marked invalid', async () => {
      await seedContact(db, alice.workspaceId, 'bad@example.com', { status: 'invalid' });
      const id = await seedSuppression(db, alice.workspaceId, 'bad@example.com');
      await db.raw('delete from suppressions where id = $1', [id]);

      const row = await db.raw<{ status: string }>(
        'select status from contacts where email_normalized = $1',
        ['bad@example.com'],
      );
      expect(row.rows[0]?.status).toBe('invalid');
    });
  });
});
