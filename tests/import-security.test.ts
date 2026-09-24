import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedList, seedSuppression, testEligibilityReader } from './helpers/p1';
import {
  MemoryStorage,
  testImportRepository,
  seedProcessingImport,
  simpleMapping,
  importRow,
} from './helpers/imports';
import { processImport } from '@/lib/imports/runner';
import { escapeCsvCell, isFormulaInjection, toCsv, contentDisposition } from '@/lib/imports/csv-export';
import { canTransition, isTerminalStatus, IMPORT_TRANSITIONS } from '@/lib/imports/constants';
import { bucketKey, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * P2 security.
 *
 * Workspace isolation across every new surface — the import row, its rejections,
 * its staged file, its target list — plus the two things a rejected-row export
 * can be turned into if it is built carelessly: a formula-injection payload and
 * a header-injection payload.
 */

let db: TestDb;
let workspaceA: string;
let workspaceB: string;
let userA: string;
let userB: string;

beforeAll(async () => {
  db = await createTestDb();
  const a = await db.createUser('a@example.com');
  const b = await db.createUser('b@example.com');
  workspaceA = a.workspaceId;
  workspaceB = b.workspaceId;
  userA = a.userId;
  userB = b.userId;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.raw('delete from import_rejections');
  await db.raw('delete from import_jobs');
  await db.raw('delete from list_members');
  await db.raw('update contacts set import_id = null');
  await db.raw('delete from imports');
  await db.raw('delete from contacts');
  await db.raw('delete from suppressions');
  await db.raw('delete from contact_lists');
  await db.raw(`delete from storage.objects`);
});

async function seedImportFor(workspaceId: string, actorId: string, status = 'completed') {
  const res = await db.raw<{ id: string }>(
    `insert into imports (workspace_id, actor_id, filename, byte_size, content_type,
                          storage_path, status, finished_at, rows_total, rows_invalid)
     values ($1, $2, 'contacts.csv', 100, 'text/csv', 'pending', $3::import_status,
             case when $3 in ('completed','failed') then now() else null end, 1, 1)
     returning id`,
    [workspaceId, actorId, status],
  );
  const importId = res.rows[0]!.id;
  await db.raw(`update imports set storage_path = $2 where id = $1`, [
    importId,
    `${workspaceId}/${importId}/contacts.csv`,
  ]);
  await db.raw(
    `insert into import_rejections (import_id, row_number, raw_row, bucket, reason)
     values ($1, 2, '{"email":"bad"}'::jsonb, 'invalid', 'Invalid email format')`,
    [importId],
  );
  return importId;
}

describe('workspace isolation — the imports table', () => {
  it('a member sees only their own workspace’s imports', async () => {
    const mine = await seedImportFor(workspaceA, userA);
    const theirs = await seedImportFor(workspaceB, userB);

    const visible = await db.asUser(userA, async (scoped) =>
      scoped.raw<{ id: string }>(`select id from imports`),
    );

    expect(visible.rows.map((r) => r.id)).toEqual([mine]);
    expect(visible.rows.map((r) => r.id)).not.toContain(theirs);
  });

  it('a targeted read of another workspace’s import returns nothing', async () => {
    const theirs = await seedImportFor(workspaceB, userB);
    const result = await db.asUser(userA, async (scoped) =>
      scoped.raw(`select id from imports where id = $1`, [theirs]),
    );
    expect(result.rows).toEqual([]);
  });

  it('a client cannot insert an import at all — every write is server-side', async () => {
    await db.asUser(userA, async (scoped) => {
      const error = await expectRejected(() =>
        scoped.raw(
          `insert into imports (workspace_id, actor_id, filename, byte_size, content_type, storage_path)
           values ($1, $2, 'x.csv', 1, 'text/csv', 'p')`,
          [workspaceA, userA],
        ),
      );
      expect(error.message).toMatch(/permission denied|policy/i);
    });
  });

  it('a client cannot rewrite an import’s status', async () => {
    const mine = await seedImportFor(workspaceA, userA, 'processing');
    await db.asUser(userA, async (scoped) => {
      const error = await expectRejected(() =>
        scoped.raw(`update imports set status = 'completed' where id = $1`, [mine]),
      );
      expect(error.message).toMatch(/permission denied|policy/i);
    });
    // Unchanged.
    expect((await importRow(db, mine)).status).toBe('processing');
  });

  it('a client cannot forge counters', async () => {
    const mine = await seedImportFor(workspaceA, userA);
    await db.asUser(userA, async (scoped) => {
      await expectRejected(() =>
        scoped.raw(`update imports set rows_valid = 99999 where id = $1`, [mine]),
      );
    });
  });

  it('a client cannot delete an import to hide it', async () => {
    const mine = await seedImportFor(workspaceA, userA);
    await db.asUser(userA, async (scoped) => {
      await expectRejected(() => scoped.raw(`delete from imports where id = $1`, [mine]));
    });
  });

  it('an anonymous caller sees nothing', async () => {
    await seedImportFor(workspaceA, userA);
    const result = await db.asAnon(async (scoped) =>
      scoped.raw(`select id from imports`).catch(() => ({ rows: [] })),
    );
    expect(result.rows).toEqual([]);
  });
});

describe('workspace isolation — rejection data', () => {
  it('rejections are reachable only through an owned import', async () => {
    await seedImportFor(workspaceA, userA);
    const theirs = await seedImportFor(workspaceB, userB);

    const visible = await db.asUser(userA, async (scoped) =>
      scoped.raw<{ import_id: string }>(`select import_id from import_rejections`),
    );

    expect(visible.rows).toHaveLength(1);
    expect(visible.rows[0]?.import_id).not.toBe(theirs);
  });

  it('naming another workspace’s import id directly still returns nothing', async () => {
    const theirs = await seedImportFor(workspaceB, userB);
    const result = await db.asUser(userA, async (scoped) =>
      scoped.raw(`select id from import_rejections where import_id = $1`, [theirs]),
    );
    expect(result.rows).toEqual([]);
  });

  it('a client cannot write or delete rejection rows', async () => {
    const mine = await seedImportFor(workspaceA, userA);
    await db.asUser(userA, async (scoped) => {
      await expectRejected(() =>
        scoped.raw(
          `insert into import_rejections (import_id, row_number, raw_row, bucket, reason)
           values ($1, 1, '{}'::jsonb, 'invalid', 'forged')`,
          [mine],
        ),
      );
      await expectRejected(() =>
        scoped.raw(`delete from import_rejections where import_id = $1`, [mine]),
      );
    });
  });
});

describe('workspace isolation — staged files', () => {
  beforeEach(async () => {
    await db.raw(
      `insert into storage.objects (bucket_id, name) values
        ('imports', $1), ('imports', $2)`,
      [`${workspaceA}/import-a/contacts.csv`, `${workspaceB}/import-b/contacts.csv`],
    );
  });

  it('the bucket is private', async () => {
    const res = await db.raw<{ public: boolean; file_size_limit: string }>(
      `select public, file_size_limit::text as file_size_limit from storage.buckets where id = 'imports'`,
    );
    expect(res.rows[0]?.public).toBe(false);
    expect(Number(res.rows[0]?.file_size_limit)).toBe(25 * 1024 * 1024);
  });

  it('a member reads only objects under their own workspace prefix', async () => {
    const visible = await db.asUser(userA, async (scoped) =>
      scoped.raw<{ name: string }>(`select name from storage.objects`),
    );
    expect(visible.rows.map((r) => r.name)).toEqual([`${workspaceA}/import-a/contacts.csv`]);
  });

  it('naming another workspace’s object path directly returns nothing', async () => {
    const result = await db.asUser(userA, async (scoped) =>
      scoped.raw(`select name from storage.objects where name = $1`, [
        `${workspaceB}/import-b/contacts.csv`,
      ]),
    );
    expect(result.rows).toEqual([]);
  });

  it('a member cannot upload into another workspace’s prefix', async () => {
    await db.asUser(userA, async (scoped) => {
      const error = await expectRejected(() =>
        scoped.raw(`insert into storage.objects (bucket_id, name) values ('imports', $1)`, [
          `${workspaceB}/smuggled/contacts.csv`,
        ]),
      );
      expect(error.message).toMatch(/policy|permission/i);
    });
  });

  it('a member can upload into their own prefix', async () => {
    await db.asUser(userA, async (scoped) => {
      await scoped.raw(`insert into storage.objects (bucket_id, name) values ('imports', $1)`, [
        `${workspaceA}/new-import/contacts.csv`,
      ]);
    });
    const res = await db.raw<{ count: string }>(
      `select count(*)::text as count from storage.objects where name like $1`,
      [`${workspaceA}/%`],
    );
    expect(Number(res.rows[0]?.count)).toBe(2);
  });

  it('a member cannot delete another workspace’s staged file', async () => {
    await db.asUser(userA, async (scoped) => {
      const result = await scoped.raw(`delete from storage.objects where name = $1`, [
        `${workspaceB}/import-b/contacts.csv`,
      ]);
      expect(result.affectedRows).toBe(0);
    });
    const res = await db.raw<{ count: string }>(
      `select count(*)::text as count from storage.objects where name = $1`,
      [`${workspaceB}/import-b/contacts.csv`],
    );
    expect(Number(res.rows[0]?.count)).toBe(1);
  });

  it('an object cannot be overwritten in place — there is no UPDATE policy', async () => {
    const policies = await db.raw<{ cmd: string }>(
      `select p.polcmd::text as cmd
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relname = 'objects'`,
    );
    // 'w' is UPDATE. Allowing one would let a validated file be swapped for a
    // different one between inspection and parsing.
    expect(policies.rows.map((r) => r.cmd)).not.toContain('w');
  });
});

describe('the scoped storage accessor refuses a foreign path', () => {
  it('rejects a path outside its workspace prefix', async () => {
    const storage = new MemoryStorage(workspaceA);
    await expect(storage.download(`${workspaceB}/x/contacts.csv`)).rejects.toThrow(
      /does not belong to this workspace/,
    );
  });

  it('rejects traversal that would otherwise satisfy the prefix', async () => {
    const storage = new MemoryStorage(workspaceA);
    await expect(storage.download(`${workspaceA}/../${workspaceB}/x.csv`)).rejects.toThrow(
      /not well formed/,
    );
  });

  it('rejects an absolute path and a backslash path', async () => {
    const storage = new MemoryStorage(workspaceA);
    await expect(storage.download(`/${workspaceA}/x.csv`)).rejects.toThrow(/not well formed/);
    await expect(storage.download(`${workspaceA}\\x.csv`)).rejects.toThrow(/not well formed/);
  });

  it('refuses to remove a foreign path', async () => {
    const storage = new MemoryStorage(workspaceA);
    await expect(storage.remove([`${workspaceB}/x/contacts.csv`])).rejects.toThrow();
  });
});

describe('cross-workspace import execution', () => {
  it('a repository bound to one workspace cannot read another’s import', async () => {
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceB,
      actorId: userB,
      filename: 'x.csv',
      byteSize: 20,
      mapping: simpleMapping(['email']),
    });

    const foreign = testImportRepository(db, workspaceA);
    expect(await foreign.get(seeded.importId)).toBeNull();
    expect(await foreign.claim(seeded.importId)).toBeNull();
  });

  it('a runner bound to the wrong workspace imports nothing', async () => {
    const bytes = new TextEncoder().encode('email\nann@example.com\n');
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceB,
      actorId: userB,
      filename: 'x.csv',
      byteSize: bytes.length,
      mapping: simpleMapping(['email']),
    });
    const storage = new MemoryStorage(workspaceB);
    storage.put(seeded.storagePath, bytes);

    const outcome = await processImport(
      {
        repository: testImportRepository(db, workspaceA),
        storage,
        eligibility: testEligibilityReader(db),
      },
      seeded.importId,
    );

    expect(outcome).toEqual({ kind: 'skipped', reason: 'not_claimed' });
    const contacts = await db.raw<{ count: string }>(
      `select count(*)::text as count from contacts`,
    );
    expect(Number(contacts.rows[0]?.count)).toBe(0);
  });

  it('the upsert function refuses an import that is not in the given workspace', async () => {
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceB,
      actorId: userB,
      filename: 'x.csv',
      byteSize: 20,
      mapping: simpleMapping(['email']),
    });

    // Even called directly with a mismatched pair, the database refuses.
    const error = await expectRejected(() =>
      db.raw(
        `select * from public.import_upsert_contacts($1, $2, $3::jsonb, null)`,
        [
          workspaceA,
          seeded.importId,
          JSON.stringify([
            {
              email_normalized: 'x@y.com',
              email_raw: 'x@y.com',
              custom: {},
              status: 'active',
            },
          ]),
        ],
      ),
    );
    expect(error.message).toContain('does not belong to this workspace');
  });

  it('the upsert function refuses a target list from another workspace', async () => {
    const foreignList = await seedList(db, workspaceB, 'Theirs');
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: 20,
      mapping: simpleMapping(['email']),
    });

    const error = await expectRejected(() =>
      db.raw(`select * from public.import_upsert_contacts($1, $2, $3::jsonb, $4)`, [
        workspaceA,
        seeded.importId,
        JSON.stringify([
          { email_normalized: 'x@y.com', email_raw: 'x@y.com', custom: {}, status: 'active' },
        ]),
        foreignList,
      ]),
    );
    expect(error.message).toContain('target list does not belong to this workspace');
  });

  it('a suppression in one workspace does not leak into another’s import', async () => {
    await seedSuppression(db, workspaceB, 'shared@example.com');
    const bytes = new TextEncoder().encode('email\nshared@example.com\n');
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: bytes.length,
      mapping: simpleMapping(['email']),
    });
    const storage = new MemoryStorage(workspaceA);
    storage.put(seeded.storagePath, bytes);

    await processImport(
      {
        repository: testImportRepository(db, workspaceA),
        storage,
        eligibility: testEligibilityReader(db),
      },
      seeded.importId,
    );

    const record = await importRow(db, seeded.importId);
    expect(record.rows_suppressed).toBe(0);
    expect(record.rows_valid).toBe(1);
  });
});

describe('the queue and limiter are invisible to clients', () => {
  it('import_jobs is deny-all to authenticated', async () => {
    await db.asUser(userA, async (scoped) => {
      const error = await expectRejected(() => scoped.raw(`select * from import_jobs`));
      expect(error.message).toMatch(/permission denied/i);
    });
  });

  it('rate_limits is deny-all to authenticated', async () => {
    await db.asUser(userA, async (scoped) => {
      const error = await expectRejected(() => scoped.raw(`select * from rate_limits`));
      expect(error.message).toMatch(/permission denied/i);
    });
  });

  it('both are registered as deliberate policy exceptions, with reasons', async () => {
    const res = await db.raw<{ table_name: string; reason: string }>(
      `select table_name, reason from app.rls_policy_exceptions order by table_name`,
    );
    // rate_ledger (P5) is registered alongside, for the same reason as rate_limits.
    expect(res.rows.map((r) => r.table_name)).toEqual(['import_jobs', 'rate_ledger', 'rate_limits']);
    for (const row of res.rows) expect(row.reason.length).toBeGreaterThan(30);
  });

  it('a client cannot call the privileged import functions', async () => {
    await db.asUser(userA, async (scoped) => {
      const upsert = await expectRejected(() =>
        scoped.raw(`select * from public.import_upsert_contacts($1, $1, '[]'::jsonb, null)`, [
          workspaceA,
        ]),
      );
      expect(upsert.message).toMatch(/permission denied/i);

      const limiter = await expectRejected(() =>
        scoped.raw(`select public.consume_rate_limit('k', 1, 60)`),
      );
      expect(limiter.message).toMatch(/permission denied/i);
    });
  });
});

describe('the rate limiter', () => {
  it('admits exactly `limit` calls per window, then refuses', async () => {
    const key = 'test:bucket';
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await db.raw<{ consume_rate_limit: boolean }>(
        `select public.consume_rate_limit($1, 3, 60) as consume_rate_limit`,
        [key],
      );
      results.push(res.rows[0]?.consume_rate_limit === true);
    }
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('counts separate buckets separately', async () => {
    for (let i = 0; i < 3; i += 1) {
      await db.raw(`select public.consume_rate_limit('bucket:one', 3, 60)`);
    }
    const other = await db.raw<{ consume_rate_limit: boolean }>(
      `select public.consume_rate_limit('bucket:two', 3, 60) as consume_rate_limit`,
    );
    expect(other.rows[0]?.consume_rate_limit).toBe(true);
  });

  it('does not admit more than the cap under concurrency', async () => {
    // The check and the increment are one statement, so this cannot over-admit.
    const calls = Array.from({ length: 20 }, () =>
      db.raw<{ consume_rate_limit: boolean }>(
        `select public.consume_rate_limit('bucket:race', 5, 60) as consume_rate_limit`,
      ),
    );
    const settled = await Promise.all(calls);
    const admitted = settled.filter((r) => r.rows[0]?.consume_rate_limit === true).length;
    expect(admitted).toBe(5);
  });

  it('refuses a nonsensical configuration rather than admitting everything', async () => {
    await expectRejected(() => db.raw(`select public.consume_rate_limit('k', 0, 60)`));
    await expectRejected(() => db.raw(`select public.consume_rate_limit('k', 5, 0)`));
  });

  it('keys buckets by user and workspace together', () => {
    const one = bucketKey('import.create', 'user-1', 'ws-1');
    expect(one).toContain('user-1');
    expect(one).toContain('ws-1');
    expect(bucketKey('import.create', 'user-2', 'ws-1')).not.toBe(one);
    expect(bucketKey('import.create', 'user-1', 'ws-2')).not.toBe(one);
    expect(bucketKey('import.export', 'user-1', 'ws-1')).not.toBe(one);
  });

  it('covers every import endpoint that mutates or exports', () => {
    expect(Object.keys(RATE_LIMITS).filter((k) => k.startsWith('import.')).sort()).toEqual([
      'import.confirm',
      'import.create',
      'import.export',
      'import.inspect',
      'import.process',
    ]);

    // The full set is asserted too, so a limiter added by a later phase is a
    // deliberate edit here rather than something that appears unreviewed.
    expect(Object.keys(RATE_LIMITS).sort()).toEqual([
      // P4 — campaign preparation. Preflight is the tightest of the three
      // because each run counts a whole audience; editing content is loose,
      // because it exists to bound a script, not to interrupt a person writing.
      'campaign.preflight',
      'campaign.write',
      'import.confirm',
      'import.create',
      'import.export',
      'import.inspect',
      'import.process',
      // P3 — sender configuration. Each of these costs a provider call, a DNS
      // query, or both.
      'sender.domain_add',
      'sender.domain_verify',
      'sender.identity_write',
      'template.write',
    ]);
    for (const rule of Object.values(RATE_LIMITS)) {
      expect(rule.limit).toBeGreaterThan(0);
      expect(rule.windowSeconds).toBeGreaterThan(0);
      expect(rule.message.length).toBeGreaterThan(10);
    }
  });

  it('prunes expired windows', async () => {
    await db.raw(
      `insert into rate_limits (bucket_key, window_start, count)
       values ('old', now() - interval '3 days', 5)`,
    );
    const deleted = await db.raw<{ prune_rate_limits: number }>(
      `select app.prune_rate_limits() as prune_rate_limits`,
    );
    expect(deleted.rows[0]?.prune_rate_limits).toBeGreaterThanOrEqual(1);
  });
});

describe('CSV export safety', () => {
  it.each([
    ['=cmd|\'/c calc\'!A1', "'=cmd|'/c calc'!A1"],
    ['+1234', "'+1234"],
    ['-1+2', "'-1+2"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['=HYPERLINK("http://evil","click")', '\'=HYPERLINK("http://evil","click")'],
  ])('neutralises %j', (input, expectedInner) => {
    const escaped = escapeCsvCell(input);
    // Always quoted, and always prefixed with an apostrophe.
    expect(escaped.startsWith('"\'')).toBe(true);
    expect(escaped).toBe(`"${expectedInner.replace(/"/g, '""')}"`);
  });

  it('neutralises a payload hidden behind a leading tab or carriage return', () => {
    const tab = escapeCsvCell(`${String.fromCharCode(9)}=1+1`);
    const cr = escapeCsvCell(`${String.fromCharCode(13)}=1+1`);
    expect(tab).toContain("'=1+1");
    expect(cr).toContain("'=1+1");
    // The whitespace itself is gone, so nothing is left for a reader to strip.
    expect(tab).not.toContain(String.fromCharCode(9));
  });

  it('recognises each dangerous leading character', () => {
    for (const value of ['=x', '+x', '-x', '@x', '\tx', '\rx']) {
      expect(isFormulaInjection(value), value).toBe(true);
    }
    // A leading space is not a vector: a spreadsheet does not strip it.
    for (const value of ['x=1', 'Ann', '  Ann', '1234', '"quoted"']) {
      expect(isFormulaInjection(value), value).toBe(false);
    }
  });

  it('leaves ordinary values alone', () => {
    expect(escapeCsvCell('Ann Smith')).toBe('Ann Smith');
    expect(escapeCsvCell('ann@example.com')).toBe('ann@example.com');
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('quotes and escapes per RFC 4180', () => {
    expect(escapeCsvCell('Smith, Ann')).toBe('"Smith, Ann"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('strips control characters that would corrupt the file', () => {
    const value = `a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`;
    expect(escapeCsvCell(value)).toBe('abc');
  });

  it('builds a whole file with a header and stable column order', () => {
    const csv = toCsv(
      [
        { key: 'row', label: 'Row' },
        { key: 'email', label: 'Email' },
      ],
      [
        { row: 2, email: 'bad@' },
        { row: 3 },
      ],
      { byteOrderMark: false },
    );
    expect(csv).toBe('Row,Email\r\n2,bad@\r\n3,\r\n');
  });

  it('escapes a hostile value inside a whole file', () => {
    const csv = toCsv([{ key: 'name', label: 'Name' }], [{ name: '=1+1' }], {
      byteOrderMark: false,
    });
    expect(csv).toBe('Name\r\n"\'=1+1"\r\n');
    // Nothing in the file begins a formula.
    for (const line of csv.trim().split('\r\n')) expect(line.startsWith('=')).toBe(false);
  });

  it('escapes a hostile column label as well as hostile data', () => {
    const csv = toCsv([{ key: 'x', label: '=EVIL()' }], [], { byteOrderMark: false });
    expect(csv.startsWith('"\'=EVIL()"')).toBe(true);
  });

  it('prefixes a BOM by default so Excel reads UTF-8 correctly', () => {
    const csv = toCsv([{ key: 'a', label: 'A' }], []);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('never lets a filename inject a response header', () => {
    expect(contentDisposition('normal.csv')).toBe('attachment; filename="normal.csv"');
    const hostile = contentDisposition('a"\r\nSet-Cookie: x=1.csv');
    expect(hostile).not.toContain('\r');
    expect(hostile).not.toContain('\n');
    // Every character outside [A-Za-z0-9._-] becomes an underscore, so the CR,
    // the LF and the quote cannot terminate or extend the header.
    expect(hostile).toBe('attachment; filename="a___Set-Cookie__x_1.csv"');
  });
});

describe('the import state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('uploaded', 'mapping')).toBe(true);
    expect(canTransition('mapping', 'processing')).toBe(true);
    expect(canTransition('processing', 'completed')).toBe(true);
    expect(canTransition('processing', 'failed')).toBe(true);
    expect(canTransition('uploaded', 'failed')).toBe(true);
  });

  it('refuses every transition that would skip or reverse the flow', () => {
    expect(canTransition('uploaded', 'processing')).toBe(false);
    expect(canTransition('uploaded', 'completed')).toBe(false);
    expect(canTransition('mapping', 'completed')).toBe(false);
    expect(canTransition('completed', 'processing')).toBe(false);
    expect(canTransition('failed', 'processing')).toBe(false);
    expect(canTransition('completed', 'failed')).toBe(false);
  });

  it('treats completed and failed as terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('processing')).toBe(false);
  });

  it('declares a transition set for every status', () => {
    expect(Object.keys(IMPORT_TRANSITIONS).sort()).toEqual([
      'completed',
      'failed',
      'mapping',
      'processing',
      'uploaded',
    ]);
  });

  it('the database enum matches the declared statuses', async () => {
    const res = await db.raw<{ label: string }>(
      `select unnest(enum_range(null::import_status))::text as label`,
    );
    expect(res.rows.map((r) => r.label).sort()).toEqual([
      'completed',
      'failed',
      'mapping',
      'processing',
      'uploaded',
    ]);
  });

  it('the database refuses a terminal status with no finished_at', async () => {
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: 10,
      mapping: simpleMapping(['email']),
    });
    const error = await expectRejected(() =>
      db.raw(`update imports set status = 'completed' where id = $1`, [seeded.importId]),
    );
    expect(error.message).toContain('ck_import_finished');
  });

  it('the database refuses an error message on a non-failed import', async () => {
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: 10,
      mapping: simpleMapping(['email']),
    });
    const error = await expectRejected(() =>
      db.raw(`update imports set error_message = 'something' where id = $1`, [seeded.importId]),
    );
    expect(error.message).toContain('ck_error_only_when_failed');
  });
});
