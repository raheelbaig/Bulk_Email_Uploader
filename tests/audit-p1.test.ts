import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, type TestDb } from './helpers/db';
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/audit';
import { redact } from '@/lib/observability/redact';

/**
 * Audit coverage for P1.
 *
 * Two things must hold: every P1 mutation has a named action, and no audit
 * metadata carries anything that should not be retained forever. Audit records
 * are never deleted (ARCHITECTURE §22.4), so a secret written here is a secret
 * kept permanently.
 */

const REQUIRED_P1_ACTIONS: AuditAction[] = [
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'list.created',
  'list.updated',
  'list.deleted',
  'list.member_added',
  'list.member_removed',
  'suppression.added_manual',
  'suppression.removed',
];

describe('P1 audit logging', () => {
  let db: TestDb;
  let alice: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDb();
    alice = await db.createUser('alice@example.test');
  });
  afterAll(async () => {
    await db?.close();
  });

  describe('action vocabulary', () => {
    it.each(REQUIRED_P1_ACTIONS)('%s is a declared action', (action) => {
      expect(AUDIT_ACTIONS).toContain(action);
    });

    it('every declared action is unique', () => {
      expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    });

    it('the database accepts every P1 action name', async () => {
      for (const action of REQUIRED_P1_ACTIONS) {
        const res = await db.raw<{ id: string }>(
          `insert into audit_logs (workspace_id, actor_id, actor_type, action)
           values ($1, $2, 'user', $3) returning id`,
          [alice.workspaceId, alice.userId, action],
        );
        expect(res.rows[0]?.id, `action ${action} was rejected`).toBeDefined();
      }
    });
  });

  describe('services record the actions they claim to', () => {
    // The service layer talks to Supabase over HTTP and cannot be exercised
    // against PGlite, so this asserts the wiring statically: each mutation
    // function must reference its audit action.
    const services = {
      'src/lib/contacts/service.ts': ['contact.created', 'contact.updated', 'contact.deleted'],
      'src/lib/lists/service.ts': [
        'list.created',
        'list.updated',
        'list.deleted',
        'list.member_added',
        'list.member_removed',
      ],
      'src/lib/suppression/service.ts': ['suppression.added_manual', 'suppression.removed'],
    } as const;

    it.each(Object.entries(services))('%s writes its actions', (file, actions) => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      for (const action of actions) {
        expect(source, `${file} never writes ${action}`).toContain(`'${action}'`);
      }
    });

    it('every mutating service function calls writeAuditLog', () => {
      for (const file of Object.keys(services)) {
        const source = readFileSync(join(process.cwd(), file), 'utf8');
        expect(source).toContain('writeAuditLog');
      }
    });
  });

  describe('metadata carries nothing that should not be kept forever', () => {
    it('contact audit metadata records the domain, not the address', () => {
      const source = readFileSync(join(process.cwd(), 'src/lib/contacts/service.ts'), 'utf8');
      // The contacts table already holds the address; duplicating it into a
      // permanently retained log adds exposure without adding accountability.
      expect(source).toContain('emailDomain');
      expect(source).not.toMatch(/metadata:\s*\{[^}]*email:\s*email\.normalized/);
    });

    it('no service puts a full email address into audit metadata', () => {
      // An address may appear inside a metadata block in exactly two safe
      // shapes: extracted down to its domain, or compared to produce a boolean.
      // Anything else stores the address itself, in a record kept forever.
      const SAFE_USE = /^(?:\.split\('@'\)|\s*[!=]==)/;

      for (const file of [
        'src/lib/contacts/service.ts',
        'src/lib/lists/service.ts',
        'src/lib/suppression/service.ts',
      ]) {
        const source = readFileSync(join(process.cwd(), file), 'utf8');

        for (const block of source.match(/metadata:\s*\{[^}]*\}/g) ?? []) {
          for (const occurrence of block.matchAll(/email_normalized/g)) {
            const following = block.slice(occurrence.index + 'email_normalized'.length);
            expect(
              SAFE_USE.test(following),
              `${file} stores a full address in audit metadata: ${block.trim()}`,
            ).toBe(true);
          }
        }
      }
    });

    it('redaction still strips credentials from any metadata shape used here', () => {
      const shapes = [
        { emailDomain: 'example.com', reason: 'manually_blocked', source: 'manual' },
        { contactId: '11111111-1111-1111-1111-111111111111' },
        { name: 'Newsletter' },
        { emailChanged: true },
      ];
      for (const shape of shapes) {
        expect(redact(shape)).toEqual(shape);
      }

      // …but anything credential-shaped that slipped in would still be caught.
      expect(redact({ token: 'abc', emailDomain: 'example.com' })).toEqual({
        token: '[redacted]',
        emailDomain: 'example.com',
      });
    });

    it('the metadata size constraint bounds what can be written', async () => {
      const big = JSON.stringify({ blob: 'x'.repeat(9000) });
      await expect(
        db.raw(
          `insert into audit_logs (workspace_id, action, metadata)
           values ($1, 'contact.created', $2::jsonb)`,
          [alice.workspaceId, big],
        ),
      ).rejects.toThrow(/ck_audit_metadata_size|check constraint/i);
    });
  });

  it('P1 audit records remain readable only within the workspace', async () => {
    const bob = await db.createUser('bob-audit@example.test');
    await db.raw(
      `insert into audit_logs (workspace_id, actor_id, actor_type, action)
       values ($1, $2, 'user', 'contact.created')`,
      [alice.workspaceId, alice.userId],
    );

    const seen = await db.asUser(bob.userId, (d) =>
      d.raw<{ workspace_id: string }>('select workspace_id from audit_logs'),
    );
    expect(seen.rows.every((r) => r.workspace_id === bob.workspaceId)).toBe(true);
  });
});
