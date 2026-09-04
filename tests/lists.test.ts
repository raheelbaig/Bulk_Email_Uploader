import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedContact, seedList } from './helpers/p1';

describe('contact lists and membership', () => {
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
    await db.raw('delete from contact_lists');
    await db.raw('delete from contacts');
  });

  describe('lists', () => {
    it('creates a list starting at zero contacts', async () => {
      const id = await seedList(db, alice.workspaceId, 'Newsletter');
      const row = await db.raw<{ contact_count: number }>(
        'select contact_count from contact_lists where id = $1',
        [id],
      );
      expect(row.rows[0]?.contact_count).toBe(0);
    });

    it('rejects a duplicate name within a workspace', async () => {
      await seedList(db, alice.workspaceId, 'Newsletter');
      const err = await expectRejected(() => seedList(db, alice.workspaceId, 'Newsletter'));
      expect(err.message).toMatch(/duplicate key|unique/i);
    });

    it('allows the same name in a different workspace', async () => {
      await seedList(db, alice.workspaceId, 'Newsletter');
      await expect(seedList(db, bob.workspaceId, 'Newsletter')).resolves.toBeTruthy();
    });

    it('renames through an authenticated update', async () => {
      const id = await seedList(db, alice.workspaceId, 'Old name');
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('update contact_lists set name = $1 where id = $2', ['New name', id]),
      );
      expect(res.affectedRows).toBe(1);
    });

    it('does not let a client write contact_count', async () => {
      const id = await seedList(db, alice.workspaceId, 'Counted');
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw('update contact_lists set contact_count = 9999 where id = $1', [id]),
        ),
      );
      expect(err.message).toMatch(/permission denied/i);
    });

    it('rejects a negative count even from a privileged writer', async () => {
      const id = await seedList(db, alice.workspaceId, 'Negative');
      const err = await expectRejected(() =>
        db.raw('update contact_lists set contact_count = -1 where id = $1', [id]),
      );
      expect(err.message).toMatch(/check constraint/i);
    });
  });

  describe('membership', () => {
    it('adds a member and increments the count', async () => {
      const listId = await seedList(db, alice.workspaceId, 'List');
      const contactId = await seedContact(db, alice.workspaceId, 'member@example.com');

      await db.raw(
        'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
        [alice.workspaceId, listId, contactId],
      );

      const row = await db.raw<{ contact_count: number }>(
        'select contact_count from contact_lists where id = $1',
        [listId],
      );
      expect(row.rows[0]?.contact_count).toBe(1);
    });

    it('removes a member and decrements the count', async () => {
      const listId = await seedList(db, alice.workspaceId, 'List');
      const contactId = await seedContact(db, alice.workspaceId, 'member@example.com');
      await db.raw(
        'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
        [alice.workspaceId, listId, contactId],
      );

      await db.raw('delete from list_members where list_id = $1 and contact_id = $2', [
        listId,
        contactId,
      ]);

      const row = await db.raw<{ contact_count: number }>(
        'select contact_count from contact_lists where id = $1',
        [listId],
      );
      expect(row.rows[0]?.contact_count).toBe(0);
    });

    it('rejects duplicate membership via the composite primary key', async () => {
      const listId = await seedList(db, alice.workspaceId, 'List');
      const contactId = await seedContact(db, alice.workspaceId, 'member@example.com');
      const insert = () =>
        db.raw('insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)', [
          alice.workspaceId,
          listId,
          contactId,
        ]);

      await insert();
      const err = await expectRejected(insert);
      expect(err.message).toMatch(/duplicate key|unique/i);

      const row = await db.raw<{ contact_count: number }>(
        'select contact_count from contact_lists where id = $1',
        [listId],
      );
      expect(row.rows[0]?.contact_count).toBe(1);
    });

    it('deleting a contact removes its memberships and fixes the count', async () => {
      const listId = await seedList(db, alice.workspaceId, 'List');
      const contactId = await seedContact(db, alice.workspaceId, 'leaving@example.com');
      await db.raw(
        'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
        [alice.workspaceId, listId, contactId],
      );

      await db.raw('delete from contacts where id = $1', [contactId]);

      const members = await db.raw('select 1 from list_members where list_id = $1', [listId]);
      expect(members.rows).toHaveLength(0);

      const row = await db.raw<{ contact_count: number }>(
        'select contact_count from contact_lists where id = $1',
        [listId],
      );
      expect(row.rows[0]?.contact_count).toBe(0);
    });

    it('deleting a list removes memberships but keeps the contacts', async () => {
      const listId = await seedList(db, alice.workspaceId, 'Doomed');
      const contactId = await seedContact(db, alice.workspaceId, 'survivor@example.com');
      await db.raw(
        'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
        [alice.workspaceId, listId, contactId],
      );

      await db.raw('delete from contact_lists where id = $1', [listId]);

      expect((await db.raw('select 1 from list_members')).rows).toHaveLength(0);
      expect((await db.raw('select 1 from contacts where id = $1', [contactId])).rows).toHaveLength(
        1,
      );
    });
  });

  // ── The cross-workspace attack ────────────────────────────────────────────
  describe('cross-workspace membership is structurally impossible', () => {
    it("refuses Alice's contact on Bob's list, even from a privileged writer", async () => {
      const bobList = await seedList(db, bob.workspaceId, 'Bob list');
      const aliceContact = await seedContact(db, alice.workspaceId, 'alice-contact@example.com');

      // Claiming Bob's workspace: the contact FK fails, because that contact is
      // not (bob.workspaceId, id).
      const err1 = await expectRejected(() =>
        db.raw('insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)', [
          bob.workspaceId,
          bobList,
          aliceContact,
        ]),
      );
      expect(err1.message).toMatch(/foreign key|violates/i);

      // Claiming Alice's workspace: the list FK fails instead. There is no
      // workspace_id value for which both foreign keys are satisfiable.
      const err2 = await expectRejected(() =>
        db.raw('insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)', [
          alice.workspaceId,
          bobList,
          aliceContact,
        ]),
      );
      expect(err2.message).toMatch(/foreign key|violates/i);
    });

    it("refuses Bob's contact on Alice's list", async () => {
      const aliceList = await seedList(db, alice.workspaceId, 'Alice list');
      const bobContact = await seedContact(db, bob.workspaceId, 'bob-contact@example.com');

      const err = await expectRejected(() =>
        db.raw('insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)', [
          alice.workspaceId,
          aliceList,
          bobContact,
        ]),
      );
      expect(err.message).toMatch(/foreign key|violates/i);
    });

    it('blocks an authenticated attacker at the RLS layer too', async () => {
      const bobList = await seedList(db, bob.workspaceId, 'Bob private');
      const aliceContact = await seedContact(db, alice.workspaceId, 'alice2@example.com');

      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw(
            'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
            [bob.workspaceId, bobList, aliceContact],
          ),
        ),
      );
      // RLS rejects the row before the foreign keys are even reached.
      expect(err.message).toMatch(/row-level security|foreign key|permission denied/i);
    });

    it('cannot read another workspace membership', async () => {
      const bobList = await seedList(db, bob.workspaceId, 'Bob list');
      const bobContact = await seedContact(db, bob.workspaceId, 'bobc@example.com');
      await db.raw(
        'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
        [bob.workspaceId, bobList, bobContact],
      );

      const seen = await db.asUser(alice.userId, (d) => d.raw('select * from list_members'));
      expect(seen.rows).toHaveLength(0);
    });

    it('cannot remove another workspace membership', async () => {
      const bobList = await seedList(db, bob.workspaceId, 'Bob list');
      const bobContact = await seedContact(db, bob.workspaceId, 'bobc@example.com');
      await db.raw(
        'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
        [bob.workspaceId, bobList, bobContact],
      );

      const res = await db.asUser(alice.userId, (d) =>
        d.raw('delete from list_members where list_id = $1 and contact_id = $2', [
          bobList,
          bobContact,
        ]),
      );
      expect(res.affectedRows).toBe(0);
      expect((await db.raw('select 1 from list_members')).rows).toHaveLength(1);
    });

    it('cannot read or rename another workspace list', async () => {
      const bobList = await seedList(db, bob.workspaceId, 'Bob only');

      const seen = await db.asUser(alice.userId, (d) => d.raw('select * from contact_lists'));
      expect(seen.rows).toHaveLength(0);

      const res = await db.asUser(alice.userId, (d) =>
        d.raw('update contact_lists set name = $1 where id = $2', ['stolen', bobList]),
      );
      expect(res.affectedRows).toBe(0);
    });

    it('membership rows have no UPDATE path at all', async () => {
      const listId = await seedList(db, alice.workspaceId, 'List');
      const contactId = await seedContact(db, alice.workspaceId, 'm@example.com');
      await db.raw(
        'insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)',
        [alice.workspaceId, listId, contactId],
      );

      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw('update list_members set workspace_id = $1 where list_id = $2', [
            bob.workspaceId,
            listId,
          ]),
        ),
      );
      expect(err.message).toMatch(/permission denied|row-level security/i);
    });
  });
});
