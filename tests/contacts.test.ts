import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedContact } from './helpers/p1';

describe('contacts', () => {
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
    await db.raw('delete from contacts');
  });

  describe('duplicate protection', () => {
    it('rejects a second contact with the same address in one workspace', async () => {
      await seedContact(db, alice.workspaceId, 'dupe@example.com');
      const err = await expectRejected(() =>
        seedContact(db, alice.workspaceId, 'dupe@example.com'),
      );
      expect(err.message).toMatch(/duplicate key|unique/i);
    });

    it('allows the same address in a different workspace', async () => {
      await seedContact(db, alice.workspaceId, 'shared@example.com');
      await expect(seedContact(db, bob.workspaceId, 'shared@example.com')).resolves.toBeTruthy();
    });

    it('the constraint is on the normalized column, so case cannot smuggle a duplicate', async () => {
      await seedContact(db, alice.workspaceId, 'Case@Example.com');
      // seedContact lowercases, mirroring what normalizeEmail produces.
      const err = await expectRejected(() =>
        seedContact(db, alice.workspaceId, 'CASE@EXAMPLE.COM'),
      );
      expect(err.message).toMatch(/duplicate key|unique/i);
    });
  });

  describe('workspace isolation', () => {
    it('a user reads only their own contacts', async () => {
      await seedContact(db, alice.workspaceId, 'a@example.com');
      await seedContact(db, bob.workspaceId, 'b@example.com');

      const seen = await db.asUser(alice.userId, (d) =>
        d.raw<{ email_normalized: string }>('select email_normalized from contacts'),
      );
      expect(seen.rows.map((r) => r.email_normalized)).toEqual(['a@example.com']);
    });

    it('a user cannot update another workspace contact', async () => {
      const id = await seedContact(db, bob.workspaceId, 'bobs@example.com');
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('update contacts set company = $1 where id = $2', ['hijacked', id]),
      );
      expect(res.affectedRows).toBe(0);
    });

    it('a user cannot delete another workspace contact', async () => {
      const id = await seedContact(db, bob.workspaceId, 'bobs2@example.com');
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('delete from contacts where id = $1', [id]),
      );
      expect(res.affectedRows).toBe(0);

      const survives = await db.raw('select 1 from contacts where id = $1', [id]);
      expect(survives.rows).toHaveLength(1);
    });

    it('a user cannot insert into another workspace', async () => {
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw(
            `insert into contacts (workspace_id, email_normalized, email_raw)
             values ($1, $2, $2)`,
            [bob.workspaceId, 'sneaky@example.com'],
          ),
        ),
      );
      expect(err.message).toMatch(/row-level security|permission denied/i);
    });

    it('an anon caller sees nothing', async () => {
      await seedContact(db, alice.workspaceId, 'private@example.com');
      const err = await db.asAnon(() => expectRejected(() => db.raw('select * from contacts')));
      expect(err.message).toMatch(/permission denied/i);
    });
  });

  describe('workspace_id rewrite protection', () => {
    it('is blocked at the GRANT layer — workspace_id is not updatable', async () => {
      const id = await seedContact(db, alice.workspaceId, 'move@example.com');
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw('update contacts set workspace_id = $1 where id = $2', [bob.workspaceId, id]),
        ),
      );
      expect(err.message).toMatch(/permission denied/i);
    });

    it('is blocked by WITH CHECK even when the column grant is widened', async () => {
      const id = await seedContact(db, alice.workspaceId, 'move2@example.com');
      await db.exec('grant update (workspace_id) on contacts to authenticated;');
      try {
        const err = await db.asUser(alice.userId, () =>
          expectRejected(() =>
            db.raw('update contacts set workspace_id = $1 where id = $2', [bob.workspaceId, id]),
          ),
        );
        expect(err.message).toMatch(/violates row-level security/i);
      } finally {
        await db.exec('revoke update (workspace_id) on contacts from authenticated;');
      }

      const row = await db.raw<{ workspace_id: string }>(
        'select workspace_id from contacts where id = $1',
        [id],
      );
      expect(row.rows[0]?.workspace_id).toBe(alice.workspaceId);
    });

    it('status is not client-writable — it is derived from suppression', async () => {
      const id = await seedContact(db, alice.workspaceId, 'status@example.com');
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw(`update contacts set status = 'active' where id = $1`, [id]),
        ),
      );
      expect(err.message).toMatch(/permission denied/i);
    });

    it('search_text is generated and cannot be written directly', async () => {
      const id = await seedContact(db, alice.workspaceId, 'gen@example.com');
      const err = await expectRejected(() =>
        db.raw(`update contacts set search_text = 'spoofed' where id = $1`, [id]),
      );
      expect(err.message).toMatch(/generated|cannot be used|column/i);
    });
  });

  describe('update and delete', () => {
    it('updates fields and maintains updated_at', async () => {
      const id = await seedContact(db, alice.workspaceId, 'edit@example.com');

      const before = await db.raw<{ updated_at: string | null }>(
        'select updated_at from contacts where id = $1',
        [id],
      );
      expect(before.rows[0]?.updated_at).toBeNull();

      await db.asUser(alice.userId, (d) =>
        d.raw('update contacts set company = $1 where id = $2', ['Acme', id]),
      );

      const after = await db.raw<{ company: string; updated_at: string | null }>(
        'select company, updated_at from contacts where id = $1',
        [id],
      );
      expect(after.rows[0]?.company).toBe('Acme');
      expect(after.rows[0]?.updated_at).not.toBeNull();
    });

    it('regenerates search_text when a searchable field changes', async () => {
      const id = await seedContact(db, alice.workspaceId, 'search@example.com');
      await db.asUser(alice.userId, (d) =>
        d.raw('update contacts set company = $1 where id = $2', ['Northwind', id]),
      );

      const row = await db.raw<{ search_text: string }>(
        'select search_text from contacts where id = $1',
        [id],
      );
      expect(row.rows[0]?.search_text).toContain('Northwind');
      expect(row.rows[0]?.search_text).toContain('search@example.com');
    });

    it('deletes a contact in the caller workspace', async () => {
      const id = await seedContact(db, alice.workspaceId, 'delete@example.com');
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('delete from contacts where id = $1', [id]),
      );
      expect(res.affectedRows).toBe(1);
    });

    it('cascades when the workspace is deleted', async () => {
      const carol = await db.createUser('carol-cascade@example.test');
      await seedContact(db, carol.workspaceId, 'cascade@example.com');
      await db.raw('delete from workspaces where id = $1', [carol.workspaceId]);

      const left = await db.raw('select 1 from contacts where workspace_id = $1', [
        carol.workspaceId,
      ]);
      expect(left.rows).toHaveLength(0);
    });
  });

  describe('constraints', () => {
    it('bounds the custom jsonb blob', async () => {
      const big = JSON.stringify({ note: 'x'.repeat(5000) });
      const err = await expectRejected(() =>
        db.raw(
          `insert into contacts (workspace_id, email_normalized, email_raw, custom)
           values ($1, $2, $2, $3::jsonb)`,
          [alice.workspaceId, 'big@example.com', big],
        ),
      );
      expect(err.message).toMatch(/ck_contacts_custom_size|check constraint/i);
    });

    it('rejects an out-of-range status', async () => {
      const err = await expectRejected(() =>
        seedContact(db, alice.workspaceId, 'weird@example.com', { status: 'wizard' }),
      );
      expect(err.message).toMatch(/check constraint/i);
    });
  });

  describe('pagination ordering', () => {
    it('is total and deterministic even when timestamps collide', async () => {
      const fixed = '2026-01-01T00:00:00Z';
      for (let i = 0; i < 10; i += 1) {
        await db.raw(
          `insert into contacts (workspace_id, email_normalized, email_raw, created_at)
           values ($1, $2, $2, $3)`,
          [alice.workspaceId, `page${i}@example.com`, fixed],
        );
      }

      const order = async () =>
        (
          await db.raw<{ id: string }>(
            `select id from contacts where workspace_id = $1
              order by created_at desc, id desc`,
            [alice.workspaceId],
          )
        ).rows.map((r) => r.id);

      // Identical timestamps: without the id tiebreaker the order would be
      // arbitrary and keyset pagination would skip or repeat rows.
      expect(await order()).toEqual(await order());
    });

    it('a keyset page walk visits every row exactly once', async () => {
      const created: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        created.push(await seedContact(db, alice.workspaceId, `walk${i}@example.com`));
      }

      const pageSize = 5;
      const seen: string[] = [];
      let cursor: { created_at: string; id: string } | null = null;

      for (let guard = 0; guard < 10; guard += 1) {
        const rows: { id: string; created_at: string }[] = cursor === null
          ? (
              await db.raw<{ id: string; created_at: string }>(
                `select id, created_at from contacts where workspace_id = $1
                  order by created_at desc, id desc limit $2`,
                [alice.workspaceId, pageSize],
              )
            ).rows
          : (
              await db.raw<{ id: string; created_at: string }>(
                `select id, created_at from contacts
                  where workspace_id = $1
                    and (created_at, id) < ($2::timestamptz, $3::uuid)
                  order by created_at desc, id desc limit $4`,
                [alice.workspaceId, cursor.created_at, cursor.id, pageSize],
              )
            ).rows;

        if (rows.length === 0) break;
        seen.push(...rows.map((r) => r.id));
        cursor = rows[rows.length - 1] ?? null;
      }

      expect(seen).toHaveLength(created.length);
      expect(new Set(seen).size).toBe(created.length);
      expect([...seen].sort()).toEqual([...created].sort());
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await seedContact(db, alice.workspaceId, 'jane.doe@northwind.com', {
        firstName: 'Jane',
        lastName: 'Doe',
        company: 'Northwind Traders',
      });
      await seedContact(db, alice.workspaceId, 'bob@contoso.com', {
        firstName: 'Bob',
        company: 'Contoso',
      });
      await seedContact(db, bob.workspaceId, 'jane.other@northwind.com', {
        company: 'Northwind Traders',
      });
    });

    it('matches on email, name and company through one generated column', async () => {
      for (const term of ['northwind', 'Jane', 'Doe', 'jane.doe']) {
        const res = await db.asUser(alice.userId, (d) =>
          d.raw<{ email_normalized: string }>(
            `select email_normalized from contacts where search_text ilike $1`,
            [`%${term}%`],
          ),
        );
        expect(res.rows.map((r) => r.email_normalized), `term: ${term}`).toContain(
          'jane.doe@northwind.com',
        );
      }
    });

    it('never crosses a workspace boundary', async () => {
      const res = await db.asUser(alice.userId, (d) =>
        d.raw<{ email_normalized: string }>(
          `select email_normalized from contacts where search_text ilike $1`,
          ['%northwind%'],
        ),
      );
      expect(res.rows.map((r) => r.email_normalized)).toEqual(['jane.doe@northwind.com']);
    });

    it('treats an injected wildcard literally once escaped', async () => {
      const raw = '%';
      const escaped = raw.replace(/[\\%_]/g, (c) => `\\${c}`);
      const res = await db.asUser(alice.userId, (d) =>
        d.raw<{ email_normalized: string }>(
          `select email_normalized from contacts where search_text ilike $1`,
          [`%${escaped}%`],
        ),
      );
      // No contact contains a literal '%', so an escaped wildcard matches nothing
      // rather than returning the whole table.
      expect(res.rows).toHaveLength(0);
    });
  });
});
