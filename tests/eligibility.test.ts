import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seedContact, seedSuppression, testEligibilityReader } from './helpers/p1';
import {
  checkEligibility,
  checkEligibilityBatch,
  filterEligible,
  type EligibilityReader,
} from '@/lib/eligibility';

/**
 * The eligibility authority.
 *
 * This is the single decision every future send path must route through, so it
 * is tested both in isolation (a stub reader, for the decision table) and
 * against real rows (for the interaction with suppression and contact status).
 */
describe('eligibility authority', () => {
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

  const reader = () => testEligibilityReader(db);

  describe('the decision table', () => {
    it('active contact, no suppression → eligible', async () => {
      await seedContact(db, alice.workspaceId, 'ok@example.com');
      const r = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'ok@example.com',
      });
      expect(r.eligible).toBe(true);
    });

    it('active contact, suppressed address → ineligible', async () => {
      await seedContact(db, alice.workspaceId, 'blocked@example.com');
      await seedSuppression(db, alice.workspaceId, 'blocked@example.com', 'complaint');

      const r = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'blocked@example.com',
      });
      expect(r.eligible).toBe(false);
      expect(r.eligible === false && r.reason).toBe('suppressed');
    });

    it('contact marked invalid → ineligible', async () => {
      await seedContact(db, alice.workspaceId, 'bad@example.com', { status: 'invalid' });
      const r = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'bad@example.com',
      });
      expect(r.eligible).toBe(false);
      expect(r.eligible === false && r.reason).toBe('contact_inactive');
    });

    it('address suppressed BEFORE any contact exists → ineligible', async () => {
      await seedSuppression(db, alice.workspaceId, 'preblocked@example.com', 'unsubscribe');

      const r = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'preblocked@example.com',
      });
      expect(r.eligible).toBe(false);
      expect(r.eligible === false && r.reason).toBe('suppressed');
    });

    it('no contact and no suppression → eligible unless a contact is required', async () => {
      const permissive = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'stranger@example.com',
      });
      expect(permissive.eligible).toBe(true);

      const strict = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'stranger@example.com',
        requireContact: true,
      });
      expect(strict.eligible).toBe(false);
      expect(strict.eligible === false && strict.reason).toBe('contact_missing');
    });

    it('a malformed address is ineligible without any lookup', async () => {
      const r = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'not-an-email',
      });
      expect(r.eligible).toBe(false);
      expect(r.eligible === false && r.reason).toBe('invalid_email');
      expect(r.eligible === false && r.emailNormalized).toBeNull();
    });

    it('suppression outranks contact status', async () => {
      // Both would make the recipient ineligible; the reported reason must be
      // suppression, because that is the one with compliance meaning.
      await seedContact(db, alice.workspaceId, 'both@example.com', { status: 'invalid' });
      await seedSuppression(db, alice.workspaceId, 'both@example.com', 'complaint');

      const r = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'both@example.com',
      });
      expect(r.eligible === false && r.reason).toBe('suppressed');
    });
  });

  describe('normalization is applied before lookup', () => {
    it('matches a suppression regardless of how the address is typed', async () => {
      await seedSuppression(db, alice.workspaceId, 'user@example.com');

      for (const variant of [
        'USER@EXAMPLE.COM',
        '  User@Example.Com  ',
        '​user@example.com',
        'ｕser@example.com',
      ]) {
        const r = await checkEligibility(reader(), {
          workspaceId: alice.workspaceId,
          email: variant,
        });
        expect(r.eligible, `variant: ${JSON.stringify(variant)}`).toBe(false);
      }
    });

    it('does not fold Gmail dots, so a distinct address stays eligible', async () => {
      await seedSuppression(db, alice.workspaceId, 'first.last@gmail.com');

      const folded = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'firstlast@gmail.com',
      });
      expect(folded.eligible).toBe(true);
    });
  });

  describe('workspace scoping', () => {
    it('a suppression in another workspace does not apply', async () => {
      await seedSuppression(db, bob.workspaceId, 'x@example.com');

      const forAlice = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'x@example.com',
      });
      expect(forAlice.eligible).toBe(true);
    });

    it('a contact in another workspace does not satisfy requireContact', async () => {
      await seedContact(db, bob.workspaceId, 'y@example.com');

      const forAlice = await checkEligibility(reader(), {
        workspaceId: alice.workspaceId,
        email: 'y@example.com',
        requireContact: true,
      });
      expect(forAlice.eligible === false && forAlice.reason).toBe('contact_missing');
    });
  });

  describe('batch behaviour', () => {
    it('returns one result per input, in order, including duplicates', async () => {
      await seedContact(db, alice.workspaceId, 'a@example.com');
      await seedSuppression(db, alice.workspaceId, 'b@example.com');

      const results = await checkEligibilityBatch(reader(), {
        workspaceId: alice.workspaceId,
        emails: ['a@example.com', 'b@example.com', 'a@example.com', 'garbage'],
      });

      expect(results).toHaveLength(4);
      expect(results[0]?.eligible).toBe(true);
      expect(results[1]?.eligible).toBe(false);
      expect(results[2]?.eligible).toBe(true);
      expect(results[3]?.eligible).toBe(false);
    });

    it('issues a bounded number of queries regardless of batch size', async () => {
      let calls = 0;
      const counting: EligibilityReader = {
        async findSuppressions() {
          calls += 1;
          return [];
        },
        async findContactStatuses() {
          calls += 1;
          return [];
        },
      };

      const emails = Array.from({ length: 500 }, (_, i) => `user${i}@example.com`);
      await checkEligibilityBatch(counting, { workspaceId: alice.workspaceId, emails });

      // Two queries for 500 addresses — not an N+1 on the largest operation in
      // the system.
      expect(calls).toBe(2);
    });

    it('handles an empty batch without querying', async () => {
      let calls = 0;
      const counting: EligibilityReader = {
        async findSuppressions() {
          calls += 1;
          return [];
        },
        async findContactStatuses() {
          calls += 1;
          return [];
        },
      };
      const results = await checkEligibilityBatch(counting, {
        workspaceId: alice.workspaceId,
        emails: [],
      });
      expect(results).toEqual([]);
      expect(calls).toBe(0);
    });

    it('skips lookups entirely when every address is malformed', async () => {
      let calls = 0;
      const counting: EligibilityReader = {
        async findSuppressions() {
          calls += 1;
          return [];
        },
        async findContactStatuses() {
          calls += 1;
          return [];
        },
      };
      const results = await checkEligibilityBatch(counting, {
        workspaceId: alice.workspaceId,
        emails: ['nope', '@@@', ''],
      });
      expect(results.every((r) => !r.eligible)).toBe(true);
      expect(calls).toBe(0);
    });

    it('filterEligible returns normalized sendable addresses only', async () => {
      await seedContact(db, alice.workspaceId, 'good@example.com');
      await seedSuppression(db, alice.workspaceId, 'bad@example.com');

      const eligible = await filterEligible(reader(), {
        workspaceId: alice.workspaceId,
        emails: ['GOOD@example.com', 'bad@example.com', 'broken'],
      });
      expect(eligible).toEqual(['good@example.com']);
    });
  });

  describe('centralisation', () => {
    it('is the only module that queries the suppressions table for a decision', async () => {
      const { readdirSync, readFileSync, statSync } = await import('node:fs');
      const { join, relative } = await import('node:path');

      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((entry) => {
          const full = join(dir, entry);
          return statSync(full).isDirectory()
            ? walk(full)
            : /\.tsx?$/.test(entry)
              ? [full]
              : [];
        });

      const allowed = new Set([
        'src/lib/eligibility/readers.ts',
        'src/lib/suppression/service.ts',
        'src/app/(app)/suppressions/page.tsx',
      ]);

      const offenders = walk(join(process.cwd(), 'src'))
        .filter((file) => /from\s*\(\s*['"]suppressions['"]|\.from\(['"]suppressions['"]\)/.test(readFileSync(file, 'utf8')))
        .map((file) => relative(process.cwd(), file).replace(/\\/g, '/'))
        .filter((file) => !allowed.has(file));

      expect(
        offenders,
        'these modules query suppressions directly; route the decision through lib/eligibility instead',
      ).toEqual([]);
    });
  });
});
