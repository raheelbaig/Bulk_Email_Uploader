import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import {
  fakeProvider,
  fakeResolver,
  seedSenderDomain,
  seedSenderIdentity,
  testSenderRepository,
  txt,
  verifiedDomainState,
  type FakeProvider,
} from './helpers/sender';
import type { SenderRepository } from '@/lib/sender/ports';

/**
 * The service layer, against a real migrated database.
 *
 * Authorization, rate limiting and audit writing are stubbed — each is proven in
 * its own suite — so what is under test here is the sender logic itself: what a
 * repeated request does, which identities may exist, and what a caller is told
 * when the answer is no.
 *
 * The repository is the PGlite-backed implementation of the same port the
 * production one implements, so every constraint in migration 0008 is live.
 */

const WORKSPACES = new Map<string, SenderRepository>();
const auditWrites: Array<{ action: string; metadata: Record<string, unknown> | undefined }> = [];
const rateLimited: string[] = [];

let currentAccess = { userId: '', workspaceId: '', role: 'owner' as 'owner' | 'admin' | 'member' };

vi.mock('@/lib/auth/workspace', () => ({
  requireWorkspace: async (workspaceId: string, options?: { minimumRole?: string }) => {
    const { ForbiddenError } = await import('@/lib/errors');
    if (workspaceId !== currentAccess.workspaceId) throw new ForbiddenError();
    if (options?.minimumRole === 'admin' && currentAccess.role === 'member') {
      throw new ForbiddenError();
    }
    return currentAccess;
  },
}));

// The pages read the provider's region to build DNS record values; a test
// deployment has no real credentials, so the environment is stubbed rather than
// the provider module, keeping `isProviderConfigured` itself under test.
vi.mock('@/lib/env', () => ({
  serverEnv: () => ({
    NODE_ENV: 'test',
    NEXT_PUBLIC_SUPABASE_URL: 'https://stub.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub-anon-key-value-1234',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role-key-value',
    LOG_LEVEL: 'error',
    AWS_REGION: 'eu-west-1',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: async (action: string) => {
    rateLimited.push(action);
  },
}));

vi.mock('@/lib/audit', () => ({
  writeAuditLog: async (entry: { action: string; metadata?: Record<string, unknown> }) => {
    auditWrites.push({ action: entry.action, metadata: entry.metadata });
  },
  AUDIT_ACTIONS: [],
}));

vi.mock('@/lib/sender/repository', () => ({
  senderRepository: async (workspaceId: string) => {
    const repository = WORKSPACES.get(workspaceId);
    if (repository === undefined) throw new Error(`no test repository for ${workspaceId}`);
    return repository;
  },
  backgroundSenderRepository: async (workspaceId: string) => WORKSPACES.get(workspaceId),
}));

const { addSenderDomain, refreshSenderDomain, removeSenderDomain, listSenderDomains, getSenderDomain, parseDomainInput } =
  await import('@/lib/sender/service');
const {
  createSenderIdentity,
  updateSenderIdentity,
  deleteSenderIdentity,
  getSenderReadiness,
  listSenderIdentities,
} = await import('@/lib/sender/identities');
const { ValidationError, ConflictError, ForbiddenError } = await import('@/lib/errors');

const SPF_OK = txt('v=spf1 include:amazonses.com ~all');
const DMARC_OK = txt('v=DMARC1; p=reject');

describe('sender services', () => {
  let db: TestDb;
  let alice: { userId: string; workspaceId: string };
  let bob: { userId: string; workspaceId: string };
  let provider: FakeProvider;

  const resolver = fakeResolver({
    txt: { 'bounce.example.com': SPF_OK, '_dmarc.example.com': DMARC_OK },
  });

  beforeAll(async () => {
    db = await createTestDb();
    alice = await db.createUser('alice@example.test');
    bob = await db.createUser('bob@example.test');
    WORKSPACES.set(alice.workspaceId, testSenderRepository(db, alice.workspaceId));
    WORKSPACES.set(bob.workspaceId, testSenderRepository(db, bob.workspaceId));
  });
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.raw('delete from sender_identities');
    await db.raw('delete from sender_domains');
    auditWrites.length = 0;
    rateLimited.length = 0;
    provider = fakeProvider();
    currentAccess = { userId: alice.userId, workspaceId: alice.workspaceId, role: 'owner' };
  });

  const deps = () => ({ provider, resolver });

  // ── Adding a domain ───────────────────────────────────────────────────────

  describe('addSenderDomain', () => {
    it('normalises the domain before storing it', async () => {
      const result = await addSenderDomain(alice.workspaceId, '  HTTPS-free.Example.COM. ', deps());
      expect(result.view.record.domain).toBe('https-free.example.com');
    });

    it('provisions a provider identity and stores the DKIM tokens', async () => {
      const result = await addSenderDomain(alice.workspaceId, 'example.com', deps());
      expect(result.created).toBe(true);
      expect(result.view.record.dkim_tokens).toHaveLength(3);
      expect(provider.calls).toContain('createDomainIdentity:example.com');
    });

    it('configures a derived MAIL FROM subdomain the request cannot choose', async () => {
      const result = await addSenderDomain(alice.workspaceId, 'example.com', deps());
      expect(result.view.record.mail_from_domain).toBe('bounce.example.com');
      expect(provider.calls).toContain('configureMailFrom:example.com:bounce.example.com');
    });

    it('surfaces the DNS records the user must publish', async () => {
      const result = await addSenderDomain(alice.workspaceId, 'example.com', deps());
      const dkim = result.view.records.filter((r) => r.purpose === 'dkim');
      expect(dkim).toHaveLength(3);
      expect(dkim[0]?.host).toMatch(/\._domainkey\.example\.com$/);
      expect(result.view.records.some((r) => r.purpose === 'mail_from_mx')).toBe(true);
    });

    it('runs verification immediately, so the page shows real state', async () => {
      // The provider already holds a fully verified identity, as it would when a
      // domain is re-added after being removed.
      provider.setIdentity('example.com', {
        usableForSending: true,
        dkimStatus: 'verified',
        mailFromDomain: 'bounce.example.com',
        mailFromStatus: 'verified',
      });
      const result = await addSenderDomain(alice.workspaceId, 'example.com', deps());
      expect(result.view.record.last_checked_at).not.toBeNull();
      expect(result.view.usable).toBe(true);
      expect(result.view.readiness).toBe('VERIFIED');
    });

    it('leaves MAIL FROM pending on a first add, because SES has only just been told', async () => {
      provider.setIdentity('example.com', { usableForSending: true, dkimStatus: 'verified' });
      const result = await addSenderDomain(alice.workspaceId, 'example.com', deps());

      expect(result.view.record.mail_from_status).toBe('pending');
      expect(result.view.usable).toBe(false);
      expect(result.view.readiness).toBe('PENDING');
    });

    it('rejects a hostile domain before touching the provider', async () => {
      await expect(
        addSenderDomain(alice.workspaceId, 'https://example.com/x', deps()),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(provider.calls).toEqual([]);
    });

    it('consumes a rate-limit unit', async () => {
      await addSenderDomain(alice.workspaceId, 'example.com', deps());
      expect(rateLimited).toContain('sender.domain_add');
    });

    it('audits the addition once, with the domain and nothing else', async () => {
      await addSenderDomain(alice.workspaceId, 'example.com', deps());
      const added = auditWrites.filter((a) => a.action === 'domain.added');
      expect(added).toHaveLength(1);
      expect(added[0]?.metadata).toEqual({ domain: 'example.com' });
    });

    describe('idempotency', () => {
      it('a repeated request creates one row and one provider identity', async () => {
        const first = await addSenderDomain(alice.workspaceId, 'example.com', deps());
        const second = await addSenderDomain(alice.workspaceId, 'example.com', deps());

        expect(second.created).toBe(false);
        expect(second.view.record.id).toBe(first.view.record.id);

        const rows = await db.raw('select id from sender_domains');
        expect(rows.rows).toHaveLength(1);
      });

      it('does not re-audit an addition that already happened', async () => {
        await addSenderDomain(alice.workspaceId, 'example.com', deps());
        auditWrites.length = 0;
        await addSenderDomain(alice.workspaceId, 'example.com', deps());
        expect(auditWrites.filter((a) => a.action === 'domain.added')).toEqual([]);
      });

      it('does not reconfigure MAIL FROM that is already correct', async () => {
        await addSenderDomain(alice.workspaceId, 'example.com', deps());
        const before = provider.calls.filter((c) => c.startsWith('configureMailFrom')).length;
        await addSenderDomain(alice.workspaceId, 'example.com', deps());
        const after = provider.calls.filter((c) => c.startsWith('configureMailFrom')).length;
        expect(after).toBe(before);
      });

      it('lets two workspaces hold the same domain independently', async () => {
        await addSenderDomain(alice.workspaceId, 'example.com', deps());

        currentAccess = { userId: bob.userId, workspaceId: bob.workspaceId, role: 'owner' };
        const bobs = await addSenderDomain(bob.workspaceId, 'example.com', deps());

        expect(bobs.created).toBe(true);
        const rows = await db.raw('select id from sender_domains');
        expect(rows.rows).toHaveLength(2);
      });
    });

    it('still stores the domain when MAIL FROM configuration fails', async () => {
      const { EmailProviderError } = await import('@/lib/sender/provider/types');
      provider.failNext('configureMailFrom', new EmailProviderError('unavailable', 'ses is down'));

      const result = await addSenderDomain(alice.workspaceId, 'example.com', deps());
      // The row exists and DKIM records can be published while MAIL FROM is retried.
      expect(result.created).toBe(true);
      expect(result.view.record.dkim_tokens).toHaveLength(3);
    });
  });

  // ── Reading ───────────────────────────────────────────────────────────────

  describe('reads are workspace-scoped', () => {
    it("does not return another workspace's domain", async () => {
      const bobsDomain = await seedSenderDomain(db, bob.workspaceId, 'example.com');
      await expect(getSenderDomain(alice.workspaceId, bobsDomain)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('answers identically for a domain that does not exist', async () => {
      await expect(
        getSenderDomain(alice.workspaceId, '99999999-9999-9999-9999-999999999999'),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses a workspace the caller is not a member of', async () => {
      await expect(listSenderDomains(bob.workspaceId)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('lists only this workspace’s domains', async () => {
      await seedSenderDomain(db, alice.workspaceId, 'alice-example.com');
      await seedSenderDomain(db, bob.workspaceId, 'bob-example.com');

      const domains = await listSenderDomains(alice.workspaceId);
      expect(domains.map((d) => d.record.domain)).toEqual(['alice-example.com']);
    });

    it('validates a domain without a database round trip', () => {
      expect(parseDomainInput('Example.com')).toBe('example.com');
      expect(() => parseDomainInput('127.0.0.1')).toThrow(ValidationError);
    });
  });

  // ── Re-checking ───────────────────────────────────────────────────────────

  describe('refreshSenderDomain', () => {
    it('re-runs the checks and is safe to repeat', async () => {
      const id = await seedSenderDomain(db, alice.workspaceId, 'example.com', {
        mailFromDomain: 'bounce.example.com',
      });
      provider.setIdentity('example.com', {
        usableForSending: true,
        dkimStatus: 'verified',
        mailFromDomain: 'bounce.example.com',
        mailFromStatus: 'verified',
      });

      const first = await refreshSenderDomain(alice.workspaceId, id, deps());
      const second = await refreshSenderDomain(alice.workspaceId, id, deps());

      expect(first.usable).toBe(true);
      expect(second.usable).toBe(true);
      expect(rateLimited.filter((a) => a === 'sender.domain_verify')).toHaveLength(2);
    });

    it("refuses to check another workspace's domain", async () => {
      const bobsDomain = await seedSenderDomain(db, bob.workspaceId, 'example.com');
      await expect(
        refreshSenderDomain(alice.workspaceId, bobsDomain, deps()),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  // ── Removing ──────────────────────────────────────────────────────────────

  describe('removeSenderDomain', () => {
    it('removes a domain with no identities', async () => {
      const id = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      await removeSenderDomain(alice.workspaceId, id);

      const rows = await db.raw('select id from sender_domains');
      expect(rows.rows).toHaveLength(0);
      expect(auditWrites.map((a) => a.action)).toContain('domain.removed');
    });

    it('refuses while identities still depend on it', async () => {
      const id = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      await seedSenderIdentity(db, alice.workspaceId, id, 'hello@example.com');

      await expect(removeSenderDomain(alice.workspaceId, id)).rejects.toBeInstanceOf(ConflictError);
      const rows = await db.raw('select id from sender_domains');
      expect(rows.rows).toHaveLength(1);
    });

    it('requires at least admin', async () => {
      const id = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      currentAccess = { ...currentAccess, role: 'member' };
      await expect(removeSenderDomain(alice.workspaceId, id)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("refuses another workspace's domain", async () => {
      const bobsDomain = await seedSenderDomain(db, bob.workspaceId, 'example.com');
      await expect(removeSenderDomain(alice.workspaceId, bobsDomain)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('does not ask the provider to delete anything', async () => {
      const id = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      await removeSenderDomain(alice.workspaceId, id);
      // There is no delete method on the port, and none is called.
      expect(provider.calls).toEqual([]);
    });
  });

  // ── Identities ────────────────────────────────────────────────────────────

  describe('createSenderIdentity', () => {
    let domainId: string;

    beforeEach(async () => {
      domainId = await seedSenderDomain(
        db,
        alice.workspaceId,
        'example.com',
        verifiedDomainState(),
      );
    });

    it('creates an address under its own domain', async () => {
      const view = await createSenderIdentity(alice.workspaceId, {
        fromEmail: 'Hello@Example.com',
        fromName: '  Example Team  ',
        replyTo: 'replies@example.com',
      });

      expect(view.record.from_email).toBe('hello@example.com');
      expect(view.record.from_name).toBe('Example Team');
      expect(view.record.reply_to).toBe('replies@example.com');
      expect(view.record.domain_id).toBe(domainId);
    });

    it('rejects hello@otherdomain.com when only example.com is set up', async () => {
      await expect(
        createSenderIdentity(alice.workspaceId, {
          fromEmail: 'hello@otherdomain.com',
          fromName: 'Example',
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const rows = await db.raw('select id from sender_identities');
      expect(rows.rows).toHaveLength(0);
    });

    it("rejects an address on another workspace's domain, with no oracle", async () => {
      await seedSenderDomain(db, bob.workspaceId, 'bob-example.com', verifiedDomainState());

      const attempt = createSenderIdentity(alice.workspaceId, {
        fromEmail: 'hello@bob-example.com',
        fromName: 'Example',
      });
      await expect(attempt).rejects.toBeInstanceOf(ValidationError);
      // The same message as a domain that does not exist anywhere.
      await expect(attempt).rejects.toThrow(/Add and verify that sending domain/);
    });

    it('rejects a subdomain address under the parent domain', async () => {
      await expect(
        createSenderIdentity(alice.workspaceId, {
          fromEmail: 'hello@mail.example.com',
          fromName: 'Example',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a duplicate address', async () => {
      await createSenderIdentity(alice.workspaceId, {
        fromEmail: 'hello@example.com',
        fromName: 'Example',
      });
      await expect(
        createSenderIdentity(alice.workspaceId, {
          fromEmail: 'hello@example.com',
          fromName: 'Another',
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      const rows = await db.raw('select id from sender_identities');
      expect(rows.rows).toHaveLength(1);
    });

    it('lets two workspaces use the same address on their own domains', async () => {
      await createSenderIdentity(alice.workspaceId, {
        fromEmail: 'hello@example.com',
        fromName: 'Alice',
      });

      await seedSenderDomain(db, bob.workspaceId, 'example.com', verifiedDomainState());
      currentAccess = { userId: bob.userId, workspaceId: bob.workspaceId, role: 'owner' };
      await expect(
        createSenderIdentity(bob.workspaceId, {
          fromEmail: 'hello@example.com',
          fromName: 'Bob',
        }),
      ).resolves.toBeTruthy();
    });

    it.each([
      ['no @', 'hello'],
      ['empty', ''],
      ['a space', 'hello world@example.com'],
      ['a newline', 'hello@example.com\nbcc:x@evil.example'],
    ])('rejects a from address with %s', async (_label, fromEmail) => {
      await expect(
        createSenderIdentity(alice.workspaceId, { fromEmail, fromName: 'Example' }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a display name carrying a header injection', async () => {
      await expect(
        createSenderIdentity(alice.workspaceId, {
          fromEmail: 'hello@example.com',
          fromName: 'Evil\r\nBcc: victim@example.org',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an empty display name', async () => {
      await expect(
        createSenderIdentity(alice.workspaceId, { fromEmail: 'hello@example.com', fromName: '   ' }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an invalid reply-to while accepting an absent one', async () => {
      await expect(
        createSenderIdentity(alice.workspaceId, {
          fromEmail: 'hello@example.com',
          fromName: 'Example',
          replyTo: 'not-an-address',
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        createSenderIdentity(alice.workspaceId, {
          fromEmail: 'hello@example.com',
          fromName: 'Example',
          replyTo: '   ',
        }),
      ).resolves.toMatchObject({ record: { reply_to: null } });
    });

    it('allows a reply-to on any domain — replies are not sends', async () => {
      await expect(
        createSenderIdentity(alice.workspaceId, {
          fromEmail: 'hello@example.com',
          fromName: 'Example',
          replyTo: 'support@somewhere-else.com',
        }),
      ).resolves.toBeTruthy();
    });

    it('refuses to attach an address to a domain that failed verification', async () => {
      await db.raw(
        `update sender_domains set dkim_status = 'failed'::verification_status where id = $1`,
        [domainId],
      );
      await expect(
        createSenderIdentity(alice.workspaceId, {
          fromEmail: 'hello@example.com',
          fromName: 'Example',
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('allows an address on a domain still pending verification', async () => {
      // Preparing addresses while DNS propagates is normal; readiness, not
      // existence, is what gates sending.
      const pending = await seedSenderDomain(db, alice.workspaceId, 'pending-example.com');
      const view = await createSenderIdentity(alice.workspaceId, {
        fromEmail: 'hello@pending-example.com',
        fromName: 'Example',
      });
      expect(view.record.domain_id).toBe(pending);
      expect(view.readiness.ready).toBe(false);
    });

    it('audits the creation without leaking anything else', async () => {
      await createSenderIdentity(alice.workspaceId, {
        fromEmail: 'hello@example.com',
        fromName: 'Example',
      });
      const added = auditWrites.filter((a) => a.action === 'identity.added');
      expect(added).toHaveLength(1);
      expect(Object.keys(added[0]?.metadata ?? {}).sort()).toEqual(['domain', 'fromEmail']);
    });
  });

  describe('updateSenderIdentity', () => {
    it('updates the editable fields', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const id = await seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com');

      const view = await updateSenderIdentity(alice.workspaceId, id, {
        fromName: 'Renamed',
        replyTo: 'new@example.com',
      });
      expect(view.record.from_name).toBe('Renamed');
      expect(view.record.reply_to).toBe('new@example.com');
      expect(auditWrites.map((a) => a.action)).toContain('identity.updated');
    });

    it("refuses another workspace's identity", async () => {
      const bobsDomain = await seedSenderDomain(db, bob.workspaceId, 'bob-example.com');
      const id = await seedSenderIdentity(db, bob.workspaceId, bobsDomain, 'hello@bob-example.com');

      await expect(
        updateSenderIdentity(alice.workspaceId, id, { fromName: 'Hijacked' }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const row = await db.raw<{ from_name: string }>(
        'select from_name from sender_identities where id = $1',
        [id],
      );
      expect(row.rows[0]?.from_name).toBe('Test Sender');
    });

    it('rejects a header injection in the new name', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const id = await seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com');
      await expect(
        updateSenderIdentity(alice.workspaceId, id, { fromName: 'X\nBcc: y@example.org' }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('deleteSenderIdentity', () => {
    it('removes the identity and audits it', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const id = await seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com');

      await deleteSenderIdentity(alice.workspaceId, id);
      const rows = await db.raw('select id from sender_identities');
      expect(rows.rows).toHaveLength(0);
      expect(auditWrites.map((a) => a.action)).toContain('identity.removed');
    });

    it("refuses another workspace's identity", async () => {
      const bobsDomain = await seedSenderDomain(db, bob.workspaceId, 'bob-example.com');
      const id = await seedSenderIdentity(db, bob.workspaceId, bobsDomain, 'hello@bob-example.com');

      await expect(deleteSenderIdentity(alice.workspaceId, id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      const rows = await db.raw('select id from sender_identities');
      expect(rows.rows).toHaveLength(1);
    });
  });

  // ── The readiness authority, end to end ───────────────────────────────────

  describe('getSenderReadiness', () => {
    it('is ready for a verified domain with a stamped identity', async () => {
      const domainId = await seedSenderDomain(
        db,
        alice.workspaceId,
        'example.com',
        verifiedDomainState(),
      );
      const id = await seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com', {
        verifiedAt: new Date().toISOString(),
      });

      const readiness = await getSenderReadiness({
        workspaceId: alice.workspaceId,
        senderIdentityId: id,
      });
      expect(readiness).toMatchObject({ ready: true, blockers: [] });
    });

    it('is not ready while the domain is pending', async () => {
      const domainId = await seedSenderDomain(db, alice.workspaceId, 'example.com');
      const id = await seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com');

      const readiness = await getSenderReadiness({
        workspaceId: alice.workspaceId,
        senderIdentityId: id,
      });
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers).toContain('dkim_not_verified');
    });

    it('reports a missing identity rather than throwing', async () => {
      const readiness = await getSenderReadiness({
        workspaceId: alice.workspaceId,
        senderIdentityId: '99999999-9999-9999-9999-999999999999',
      });
      expect(readiness.blockers).toEqual(['sender_identity_missing']);
    });

    it("cannot be used to probe another workspace's identity", async () => {
      const bobsDomain = await seedSenderDomain(db, bob.workspaceId, 'bob-example.com');
      const id = await seedSenderIdentity(db, bob.workspaceId, bobsDomain, 'hello@bob-example.com');

      const readiness = await getSenderReadiness({
        workspaceId: alice.workspaceId,
        senderIdentityId: id,
      });
      // Scoped repository: the row is simply not there.
      expect(readiness.blockers).toEqual(['sender_identity_missing']);
    });

    it('is the same verdict the identities list shows', async () => {
      const domainId = await seedSenderDomain(
        db,
        alice.workspaceId,
        'example.com',
        verifiedDomainState(),
      );
      const id = await seedSenderIdentity(db, alice.workspaceId, domainId, 'hello@example.com', {
        verifiedAt: new Date().toISOString(),
      });

      const listed = await listSenderIdentities(alice.workspaceId);
      const direct = await getSenderReadiness({
        workspaceId: alice.workspaceId,
        senderIdentityId: id,
      });
      expect(listed[0]?.readiness).toEqual(direct);
    });
  });
});
