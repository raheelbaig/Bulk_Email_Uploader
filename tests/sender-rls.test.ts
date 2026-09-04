import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedSenderDomain, seedSenderIdentity, verifiedDomainState } from './helpers/sender';

/**
 * Tenant isolation and structural guarantees for sender configuration, proven
 * against a real PostgreSQL instance running the real migration files under the
 * real `authenticated` role.
 *
 * The two claims that matter most here cannot be made by application code:
 *
 *   1. A user cannot mark their own domain verified — there is no UPDATE
 *      privilege on `sender_domains` for `authenticated` at all.
 *   2. An identity cannot exist under a domain it is not part of, or under
 *      another workspace's domain — the composite foreign key refuses it.
 */
describe('sender domains and identities', () => {
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
    await db.raw('delete from sender_identities');
    await db.raw('delete from sender_domains');
  });

  // ── Schema-level guarantees ───────────────────────────────────────────────

  describe('column constraints', () => {
    it('accepts a normalised domain', async () => {
      await expect(seedSenderDomain(db, alice.workspaceId, 'example.com')).resolves.toBeTruthy();
    });

    it.each([
      ['uppercase', 'Example.com'],
      ['a scheme', 'https://example.com'],
      ['a path', 'example.com/x'],
      ['a port', 'example.com:25'],
      ['a single label', 'localhost'],
      ['a trailing dot', 'example.com.'],
      ['a leading dot', '.example.com'],
      ['an underscore', 'exa_mple.com'],
      ['a space', 'exa mple.com'],
      ['a numeric tld', 'example.123'],
    ])('refuses a domain with %s even when written directly', async (_label, domain) => {
      // The application normalises; the database refuses to hold anything that
      // is not already normalised, so no code path can store a bad value.
      const err = await expectRejected(() => seedSenderDomain(db, alice.workspaceId, domain));
      expect(err.message).toMatch(/violates check constraint|value too long/i);
    });

    it('refuses a duplicate domain within one workspace', async () => {
      await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const err = await expectRejected(() =>
        seedSenderDomain(db, alice.workspaceId, 'example.com'),
      );
      expect(err.message).toMatch(/duplicate key|unique/i);
    });

    it('allows the same domain in a different workspace', async () => {
      await seedSenderDomain(db, alice.workspaceId, 'example.com');
      await expect(seedSenderDomain(db, bob.workspaceId, 'example.com')).resolves.toBeTruthy();
    });

    it('refuses a MAIL FROM domain that is not under the sending domain', async () => {
      const err = await expectRejected(() =>
        seedSenderDomain(db, alice.workspaceId, 'example.com', {
          mailFromDomain: 'bounce.attacker.example',
        }),
      );
      expect(err.message).toMatch(/violates check constraint/i);
    });

    it('accepts a MAIL FROM subdomain of the sending domain', async () => {
      await expect(
        seedSenderDomain(db, alice.workspaceId, 'example.com', {
          mailFromDomain: 'bounce.example.com',
        }),
      ).resolves.toBeTruthy();
    });

    it('refuses a DMARC policy outside the closed set', async () => {
      const err = await expectRejected(() =>
        seedSenderDomain(db, alice.workspaceId, 'example.com', { dmarcPolicy: 'destroy' }),
      );
      expect(err.message).toMatch(/violates check constraint/i);
    });

    it('refuses DKIM tokens that are not provider-shaped', async () => {
      const err = await expectRejected(() =>
        seedSenderDomain(db, alice.workspaceId, 'example.com', {
          dkimTokens: ['../../etc/passwd'],
        }),
      );
      expect(err.message).toMatch(/violates check constraint/i);
    });

    it('bounds the stored check error, so no row grows without limit', async () => {
      const id = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const err = await expectRejected(() =>
        db.raw('update sender_domains set last_check_error = $2 where id = $1', [
          id,
          'x'.repeat(501),
        ]),
      );
      expect(err.message).toMatch(/violates check constraint/i);
    });
  });

  describe('identity ↔ domain integrity', () => {
    it('accepts an address under its own domain', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      await expect(
        seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com'),
      ).resolves.toBeTruthy();
    });

    it('refuses hello@otherdomain.com under example.com', async () => {
      // The rule from the brief, enforced by the database rather than the form.
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const err = await expectRejected(() =>
        seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@otherdomain.com'),
      );
      expect(err.message).toMatch(/foreign key constraint/i);
    });

    it('refuses a subdomain address under the parent domain', async () => {
      // mail.example.com is a different DNS name with different DKIM records.
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const err = await expectRejected(() =>
        seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@mail.example.com'),
      );
      expect(err.message).toMatch(/foreign key constraint/i);
    });

    it("refuses an identity attached to another workspace's domain", async () => {
      const bobsDomain = await seedSenderDomain(db, bob.workspaceId, 'example.com');
      const err = await expectRejected(() =>
        seedSenderIdentity(db, alice.workspaceId, bobsDomain, 'hello@example.com'),
      );
      expect(err.message).toMatch(/foreign key constraint/i);
    });

    it('refuses a duplicate address within one workspace', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      await seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com');
      const err = await expectRejected(() =>
        seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com'),
      );
      expect(err.message).toMatch(/duplicate key|unique/i);
    });

    it('refuses a control character in the sender name', async () => {
      // Header injection, refused at the column, long before any send path.
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const err = await expectRejected(() =>
        seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com', {
          fromName: 'Evil\r\nBcc: victim@example.org',
        }),
      );
      expect(err.message).toMatch(/violates check constraint/i);
    });

    it('refuses a non-normalised from address', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const err = await expectRejected(() =>
        seedSenderIdentity(db, alice.workspaceId, domainId, 'Hello@Example.com'),
      );
      expect(err.message).toMatch(/violates check constraint/i);
    });

    it('refuses to delete a domain that still has identities', async () => {
      // ON DELETE RESTRICT: sender configuration a campaign references must not
      // cascade away silently.
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      await seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com');

      const err = await expectRejected(() =>
        db.raw('delete from sender_domains where id = $1', [domainId]),
      );
      expect(err.message).toMatch(/foreign key constraint|violates/i);
    });

    it('allows the delete once the identities are gone', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const identityId = await seedSenderIdentity(
        db,
        alice.workspaceId,
        domainId,
        'hello@example.com',
      );
      await db.raw('delete from sender_identities where id = $1', [identityId]);
      await expect(
        db.raw('delete from sender_domains where id = $1', [domainId]),
      ).resolves.toBeTruthy();
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────

  describe('read isolation', () => {
    beforeEach(async () => {
      const aliceDomain = await seedSenderDomain(db, alice.workspaceId, 'alice-example.com');
      const bobDomain = await seedSenderDomain(db, bob.workspaceId, 'bob-example.com');
      await seedSenderIdentity(db, alice.workspaceId, aliceDomain, 'hello@alice-example.com');
      await seedSenderIdentity(db, bob.workspaceId, bobDomain, 'hello@bob-example.com');
    });

    it('a user sees only their own domains', async () => {
      const rows = await db.asUser(alice.userId, (d) =>
        d.raw<{ domain: string }>('select domain from sender_domains'),
      );
      expect(rows.rows.map((r) => r.domain)).toEqual(['alice-example.com']);
    });

    it('a user sees only their own identities', async () => {
      const rows = await db.asUser(alice.userId, (d) =>
        d.raw<{ from_email: string }>('select from_email from sender_identities'),
      );
      expect(rows.rows.map((r) => r.from_email)).toEqual(['hello@alice-example.com']);
    });

    it('naming another workspace’s row explicitly returns nothing', async () => {
      const rows = await db.asUser(alice.userId, (d) =>
        d.raw('select id from sender_domains where workspace_id = $1', [bob.workspaceId]),
      );
      expect(rows.rows).toHaveLength(0);
    });

    it('an unauthenticated caller sees nothing at all', async () => {
      for (const table of ['sender_domains', 'sender_identities']) {
        const err = await db.asAnon(() => expectRejected(() => db.raw(`select * from ${table}`)));
        expect(err.message).toMatch(/permission denied/i);
      }
    });
  });

  describe('write isolation', () => {
    it('a user cannot insert a domain into another workspace', async () => {
      const err = await db.asUser(alice.userId, (d) =>
        expectRejected(() =>
          d.raw('insert into sender_domains (workspace_id, domain) values ($1, $2)', [
            bob.workspaceId,
            'hijack.example.com',
          ]),
        ),
      );
      expect(err.message).toMatch(/row-level security|permission denied/i);
    });

    it("a user cannot delete another workspace's domain", async () => {
      const bobDomain = await seedSenderDomain(db, bob.workspaceId, 'bob-example.com');
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('delete from sender_domains where id = $1', [bobDomain]),
      );
      expect(res.affectedRows).toBe(0);

      const still = await db.raw('select id from sender_domains where id = $1', [bobDomain]);
      expect(still.rows).toHaveLength(1);
    });

    it("a user cannot delete another workspace's identity", async () => {
      const bobDomain = await seedSenderDomain(db, bob.workspaceId, 'bob-example.com');
      const identityId = await seedSenderIdentity(
        db,
        bob.workspaceId,
        bobDomain,
        'hello@bob-example.com',
      );
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('delete from sender_identities where id = $1', [identityId]),
      );
      expect(res.affectedRows).toBe(0);
    });

    it("a user cannot rename another workspace's identity", async () => {
      const bobDomain = await seedSenderDomain(db, bob.workspaceId, 'bob-example.com');
      const identityId = await seedSenderIdentity(
        db,
        bob.workspaceId,
        bobDomain,
        'hello@bob-example.com',
      );
      const res = await db.asUser(alice.userId, (d) =>
        d.raw('update sender_identities set from_name = $2 where id = $1', [identityId, 'Hijacked']),
      );
      expect(res.affectedRows).toBe(0);
    });

    it('a member cannot delete a domain at all — owner or admin only', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      await db.raw(`update workspace_members set role = 'member' where user_id = $1`, [
        alice.userId,
      ]);
      try {
        const res = await db.asUser(alice.userId, (d) =>
          d.raw('delete from sender_domains where id = $1', [domainId]),
        );
        expect(res.affectedRows).toBe(0);
      } finally {
        await db.raw(`update workspace_members set role = 'owner' where user_id = $1`, [
          alice.userId,
        ]);
      }
    });
  });

  // ── The verification-status guarantee ────────────────────────────────────

  describe('a user cannot declare their own domain verified', () => {
    it('has no UPDATE privilege on sender_domains for authenticated', async () => {
      const grants = await db.raw<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
          where table_name = 'sender_domains' and grantee = 'authenticated'
          order by privilege_type`,
      );
      expect(grants.rows.map((r) => r.privilege_type).sort()).toEqual([
        'DELETE',
        'INSERT',
        'SELECT',
      ]);
    });

    it.each([
      'spf_status',
      'dkim_status',
      'dmarc_status',
      'mail_from_status',
    ])('refuses an update to %s', async (column) => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const err = await db.asUser(alice.userId, (d) =>
        expectRejected(() =>
          d.raw(
            `update sender_domains set ${column} = 'verified'::verification_status where id = $1`,
            [domainId],
          ),
        ),
      );
      expect(err.message).toMatch(/permission denied/i);
    });

    it('refuses an update to the DKIM tokens or the identity reference', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      for (const statement of [
        `update sender_domains set dkim_tokens = array['aaaa'] where id = $1`,
        `update sender_domains set ses_identity_arn = 'arn:forged' where id = $1`,
        `update sender_domains set last_checked_at = now() where id = $1`,
      ]) {
        const err = await db.asUser(alice.userId, (d) =>
          expectRejected(() => d.raw(statement, [domainId])),
        );
        expect(err.message).toMatch(/permission denied/i);
      }
    });

    it('refuses to let a user stamp an identity as verified', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const identityId = await seedSenderIdentity(
        db,
        alice.workspaceId,
        domainId,
        'hello@example.com',
      );
      const err = await db.asUser(alice.userId, (d) =>
        expectRejected(() =>
          d.raw('update sender_identities set verified_at = now() where id = $1', [identityId]),
        ),
      );
      expect(err.message).toMatch(/permission denied/i);
    });

    it('refuses to let a user re-point an identity at another domain', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const other = await seedSenderDomain(db, alice.workspaceId, 'other-example.com');
      const identityId = await seedSenderIdentity(
        db,
        alice.workspaceId,
        domainId,
        'hello@example.com',
      );
      const err = await db.asUser(alice.userId, (d) =>
        expectRejected(() =>
          d.raw('update sender_identities set domain_id = $2 where id = $1', [identityId, other]),
        ),
      );
      expect(err.message).toMatch(/permission denied/i);
    });

    it('allows the fields a user is meant to edit', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const identityId = await seedSenderIdentity(
        db,
        alice.workspaceId,
        domainId,
        'hello@example.com',
      );
      const res = await db.asUser(alice.userId, (d) =>
        d.raw(
          `update sender_identities set from_name = $2, reply_to = $3 where id = $1`,
          [identityId, 'New Name', 'replies@example.com'],
        ),
      );
      expect(res.affectedRows).toBe(1);
    });

    it('the service role, which the verifier uses, can write status', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const res = await db.asServiceRole((d) =>
        d.raw(
          `update sender_domains set dkim_status = 'verified'::verification_status where id = $1`,
          [domainId],
        ),
      );
      expect(res.affectedRows).toBe(1);
    });

    it('the service role cannot create or delete identities', async () => {
      // Least privilege: a background job has no reason to do either.
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const identityId = await seedSenderIdentity(
        db,
        alice.workspaceId,
        domainId,
        'hello@example.com',
      );

      const insertErr = await db.asServiceRole((d) =>
        expectRejected(() =>
          d.raw(
            `insert into sender_identities (workspace_id, domain_id, from_email, from_name)
             values ($1, $2, 'new@example.com', 'X')`,
            [alice.workspaceId, domainId],
          ),
        ),
      );
      expect(insertErr.message).toMatch(/permission denied/i);

      const deleteErr = await db.asServiceRole((d) =>
        expectRejected(() => d.raw('delete from sender_identities where id = $1', [identityId])),
      );
      expect(deleteErr.message).toMatch(/permission denied/i);
    });
  });

  describe('a verified domain still isolates', () => {
    it('does not leak a verified domain across workspaces', async () => {
      await seedSenderDomain(db, bob.workspaceId, 'verified-example.com', verifiedDomainState());
      const rows = await db.asUser(alice.userId, (d) =>
        d.raw('select id from sender_domains'),
      );
      expect(rows.rows).toHaveLength(0);
    });
  });
});
