import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';

/**
 * Tenant isolation, proven against a real PostgreSQL instance running the real
 * migration files under the real `authenticated` role.
 *
 * These are not assertions about intent. Every query below goes through
 * PostgreSQL's policy machinery exactly as a PostgREST request would.
 */
describe('RLS tenant isolation', () => {
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

  it('gives each signup its own workspace', () => {
    expect(alice.workspaceId).not.toBe(bob.workspaceId);
  });

  // ── Proof 1 — cross-tenant read ────────────────────────────────────────────
  describe('proof 1: a user cannot read another workspace', () => {
    it('sees only their own workspace row', async () => {
      const rows = await db.asUser(alice.userId, (d) =>
        d.raw<{ id: string }>('select id from workspaces'),
      );
      expect(rows.rows.map((r) => r.id)).toEqual([alice.workspaceId]);
    });

    it('returns zero rows when naming another workspace explicitly', async () => {
      const rows = await db.asUser(alice.userId, (d) =>
        d.raw('select id from workspaces where id = $1', [bob.workspaceId]),
      );
      expect(rows.rows).toHaveLength(0);
    });

    it('cannot read another workspace through workspace_members', async () => {
      const rows = await db.asUser(alice.userId, (d) =>
        d.raw<{ user_id: string }>('select user_id from workspace_members'),
      );
      expect(rows.rows.map((r) => r.user_id)).toEqual([alice.userId]);
    });

    it('cannot read another workspace through workspace_settings', async () => {
      const rows = await db.asUser(alice.userId, (d) =>
        d.raw<{ workspace_id: string }>('select workspace_id from workspace_settings'),
      );
      expect(rows.rows.map((r) => r.workspace_id)).toEqual([alice.workspaceId]);
    });

    it('cannot read another workspace through audit_logs', async () => {
      const rows = await db.asUser(alice.userId, (d) =>
        d.raw<{ workspace_id: string }>('select workspace_id from audit_logs'),
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.workspace_id === alice.workspaceId)).toBe(true);
    });

    it('an unauthenticated (anon) caller sees nothing at all', async () => {
      for (const table of ['workspaces', 'workspace_members', 'workspace_settings', 'audit_logs']) {
        const err = await db.asAnon(() => expectRejected(() => db.raw(`select * from ${table}`)));
        expect(err.message).toMatch(/permission denied/i);
      }
    });
  });

  // ── Proof 2 — cross-tenant write ───────────────────────────────────────────
  describe("proof 2: a user cannot write another workspace's data", () => {
    it('cannot rename another workspace', async () => {
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('update workspaces set name = $1 where id = $2', ['hijacked', bob.workspaceId]),
      );
      // RLS filters the row out rather than raising: zero rows affected.
      expect(res.affectedRows).toBe(0);

      const check = await db.raw<{ name: string }>('select name from workspaces where id = $1', [
        bob.workspaceId,
      ]);
      expect(check.rows[0]?.name).not.toBe('hijacked');
    });

    it("cannot update another workspace's settings", async () => {
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('update workspace_settings set display_timezone = $1 where workspace_id = $2', [
          'Etc/GMT-14',
          bob.workspaceId,
        ]),
      );
      expect(res.affectedRows).toBe(0);
    });

    it('cannot insert itself into another workspace', async () => {
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw('insert into workspace_members (workspace_id, user_id) values ($1, $2)', [
            bob.workspaceId,
            alice.userId,
          ]),
        ),
      );
      expect(err.message).toMatch(/permission denied|violates row-level security/i);
    });

    it('cannot delete another workspace', async () => {
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() => db.raw('delete from workspaces where id = $1', [bob.workspaceId])),
      );
      expect(err.message).toMatch(/permission denied|violates row-level security/i);
    });

    it('CAN update its own workspace — proving the deny is scoped, not blanket', async () => {
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('update workspaces set name = $1 where id = $2', ['Alice Co', alice.workspaceId]),
      );
      expect(res.affectedRows).toBe(1);
    });
  });

  // ── Proof 3 — tenant-column rewrite ────────────────────────────────────────
  describe('proof 3: a user cannot move a row into another workspace', () => {
    it('is blocked at the GRANT layer — workspace_id is not an updatable column', async () => {
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw('update workspace_settings set workspace_id = $1 where workspace_id = $2', [
            bob.workspaceId,
            alice.workspaceId,
          ]),
        ),
      );
      expect(err.message).toMatch(/permission denied/i);
    });

    /**
     * The GRANT above would mask a missing WITH CHECK. Granting the column
     * temporarily isolates the policy and proves it independently — so the
     * guarantee survives a future migration that widens the grant.
     */
    it('is blocked by the WITH CHECK clause even when the column grant is widened', async () => {
      await db.exec('grant update (workspace_id) on workspace_settings to authenticated;');
      try {
        const err = await db.asUser(alice.userId, () =>
          expectRejected(() =>
            db.raw('update workspace_settings set workspace_id = $1 where workspace_id = $2', [
              bob.workspaceId,
              alice.workspaceId,
            ]),
          ),
        );
        expect(err.message).toMatch(/violates row-level security/i);
      } finally {
        await db.exec('revoke update (workspace_id) on workspace_settings from authenticated;');
      }

      const settled = await db.raw<{ workspace_id: string }>(
        'select workspace_id from workspace_settings where workspace_id = $1',
        [alice.workspaceId],
      );
      expect(settled.rows).toHaveLength(1);
    });
  });

  // ── Proof 10 — audit immutability ──────────────────────────────────────────
  describe('proof 10: audit records cannot be modified by an authenticated user', () => {
    it('cannot insert', async () => {
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() =>
          db.raw('insert into audit_logs (workspace_id, action) values ($1, $2)', [
            alice.workspaceId,
            'auth.login',
          ]),
        ),
      );
      expect(err.message).toMatch(/permission denied|violates row-level security/i);
    });

    it('cannot update', async () => {
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() => db.raw("update audit_logs set action = 'tampered'")),
      );
      expect(err.message).toMatch(/permission denied|append-only/i);
    });

    it('cannot delete', async () => {
      const err = await db.asUser(alice.userId, () =>
        expectRejected(() => db.raw('delete from audit_logs')),
      );
      expect(err.message).toMatch(/permission denied|append-only/i);
    });

    it('is append-only for service_role at the GRANT layer', async () => {
      // service_role holds SELECT and INSERT only, so amendment is refused
      // before any policy or trigger is consulted.
      const update = await db.asServiceRole(() =>
        expectRejected(() => db.raw("update audit_logs set action = 'tampered'")),
      );
      expect(update.message).toMatch(/permission denied/i);

      const del = await db.asServiceRole(() =>
        expectRejected(() => db.raw('delete from audit_logs')),
      );
      expect(del.message).toMatch(/permission denied/i);
    });

    /**
     * The grant above would mask a broken trigger. Widening it temporarily
     * isolates the trigger and proves append-only survives a future migration
     * that hands service_role more than it needs.
     */
    it('is append-only by trigger even when the grant is widened', async () => {
      await db.exec('grant update, delete on audit_logs to service_role;');
      try {
        const update = await db.asServiceRole(() =>
          expectRejected(() => db.raw("update audit_logs set action = 'tampered'")),
        );
        expect(update.message).toMatch(/append-only/i);

        const del = await db.asServiceRole(() =>
          expectRejected(() => db.raw('delete from audit_logs')),
        );
        expect(del.message).toMatch(/append-only/i);
      } finally {
        await db.exec('revoke update, delete on audit_logs from service_role;');
      }
    });

    it('still cascades when a workspace is deleted', async () => {
      const temp = await db.createUser('temp@example.test');
      await db.raw('delete from workspaces where id = $1', [temp.workspaceId]);
      const left = await db.raw('select 1 from audit_logs where workspace_id = $1', [
        temp.workspaceId,
      ]);
      expect(left.rows).toHaveLength(0);
    });
  });

  // ── Proof 6 (database half) — service_role really does bypass RLS ──────────
  describe('proof 6: service_role bypasses RLS, so application-level scoping is mandatory', () => {
    it('reads every workspace when unscoped', async () => {
      const rows = await db.asServiceRole((d) => d.raw<{ id: string }>('select id from workspaces'));
      const ids = rows.rows.map((r) => r.id);
      expect(ids).toContain(alice.workspaceId);
      expect(ids).toContain(bob.workspaceId);
    });
  });

  // ── Signup bootstrap ───────────────────────────────────────────────────────
  describe('signup bootstrap', () => {
    it('creates workspace, owner membership, settings and an audit record', async () => {
      const carol = await db.createUser('carol@example.test');

      const member = await db.raw<{ role: string }>(
        'select role from workspace_members where workspace_id = $1 and user_id = $2',
        [carol.workspaceId, carol.userId],
      );
      expect(member.rows[0]?.role).toBe('owner');

      const settings = await db.raw('select 1 from workspace_settings where workspace_id = $1', [
        carol.workspaceId,
      ]);
      expect(settings.rows).toHaveLength(1);

      const audit = await db.raw<{ action: string; actor_type: string }>(
        'select action, actor_type from audit_logs where workspace_id = $1',
        [carol.workspaceId],
      );
      expect(audit.rows[0]?.action).toBe('workspace.bootstrapped');
      expect(audit.rows[0]?.actor_type).toBe('system');
    });

    it('uses the supplied workspace name, bounded', async () => {
      const res = await db.raw<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data)
         values ($1, $2::jsonb) returning id`,
        ['dave@example.test', JSON.stringify({ workspace_name: '  Dave Industries  ' })],
      );
      const userId = res.rows[0]?.id;
      const ws = await db.raw<{ name: string }>(
        `select w.name from workspaces w
         join workspace_members m on m.workspace_id = w.id
         where m.user_id = $1`,
        [userId],
      );
      expect(ws.rows[0]?.name).toBe('Dave Industries');
    });

    it('is idempotent — a second trigger run does not create a second workspace', async () => {
      const eve = await db.createUser('eve@example.test');
      await db.raw(
        `update auth.users set raw_user_meta_data = '{}'::jsonb where id = $1`,
        [eve.userId],
      );
      const count = await db.raw<{ n: string }>(
        'select count(*)::text as n from workspace_members where user_id = $1',
        [eve.userId],
      );
      expect(count.rows[0]?.n).toBe('1');
    });
  });
});
