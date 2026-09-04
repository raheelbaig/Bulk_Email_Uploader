import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seedContact, seedList, seedSuppression, testEligibilityReader } from './helpers/p1';
import {
  MemoryStorage,
  testImportRepository,
  seedProcessingImport,
  simpleMapping,
  importRow,
  jobRow,
} from './helpers/imports';
import { buildXlsx, buildXls } from './helpers/spreadsheet';
import { processImport, type RunnerPorts } from '@/lib/imports/runner';
import { ROW_BUCKETS } from '@/lib/imports/constants';

/**
 * The import runner, end to end, against a real migrated database.
 *
 * Not a mock in sight for the parts that matter: the contact upsert is the real
 * `public.import_upsert_contacts`, the reconciliation check is the real
 * `ck_rows_reconcile`, the claim is the real conditional UPDATE, and suppression
 * is the real P1 eligibility authority. A mock would agree with whatever the
 * code believes; the constraint does not.
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
  await db.raw('delete from list_members');
  await db.raw('delete from contact_lists');
});

/** Wires the real runner to the test database and an in-memory bucket. */
function ports(workspaceId: string, storage: MemoryStorage): RunnerPorts {
  return {
    repository: testImportRepository(db, workspaceId),
    storage,
    eligibility: testEligibilityReader(db),
  };
}

interface RunOptions {
  workspaceId?: string;
  actorId?: string;
  filename?: string;
  content?: string | Uint8Array;
  mapping?: unknown;
  targetListId?: string | null;
  chunkRows?: number;
  onChunk?: (index: number, firstRow: number) => void | Promise<void>;
}

/** Seeds a processing import with a staged file and runs it. */
async function runImport(options: RunOptions = {}) {
  const workspaceId = options.workspaceId ?? workspaceA;
  const actorId = options.actorId ?? userA;
  const filename = options.filename ?? 'contacts.csv';
  const content = options.content ?? 'email,first_name\nann@example.com,Ann\n';
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;

  const seeded = await seedProcessingImport(db, {
    workspaceId,
    actorId,
    filename,
    byteSize: bytes.length,
    mapping: options.mapping ?? simpleMapping(['email', 'first_name']),
    targetListId: options.targetListId ?? null,
    contentType: filename.endsWith('.csv') ? 'text/csv' : 'application/octet-stream',
  });

  const storage = new MemoryStorage(workspaceId);
  storage.put(seeded.storagePath, bytes);

  const outcome = await processImport(ports(workspaceId, storage), seeded.importId, {
    ...(options.chunkRows === undefined ? {} : { chunkRows: options.chunkRows }),
    ...(options.onChunk === undefined ? {} : { onChunk: options.onChunk }),
  });

  return { ...seeded, outcome, storage };
}

async function contactCount(workspaceId: string): Promise<number> {
  const res = await db.raw<{ count: string }>(
    `select count(*)::text as count from contacts where workspace_id = $1`,
    [workspaceId],
  );
  return Number(res.rows[0]?.count ?? 0);
}

describe('a straightforward import', () => {
  it('imports every valid row and reconciles', async () => {
    const { importId, outcome } = await runImport({
      content:
        'email,first_name\n' +
        'ann@example.com,Ann\n' +
        'bob@example.com,Bob\n' +
        'carl@example.com,Carl\n',
    });

    expect(outcome.kind).toBe('completed');
    const record = await importRow(db, importId);
    expect(record.status).toBe('completed');
    expect(record.rows_total).toBe(3);
    expect(record.rows_valid).toBe(3);
    expect(await contactCount(workspaceA)).toBe(3);
  });

  it('records provenance on each contact', async () => {
    const { importId } = await runImport();
    const res = await db.raw<{ import_id: string }>(
      `select import_id from contacts where workspace_id = $1`,
      [workspaceA],
    );
    expect(res.rows[0]?.import_id).toBe(importId);
  });

  it('maps every supported field', async () => {
    await runImport({
      mapping: simpleMapping([
        'email',
        'first_name',
        'last_name',
        'company',
        'website',
        'phone',
        { custom: 'deal_size' },
      ]),
      content:
        'email,first,last,company,web,phone,deal\n' +
        'ann@example.com,Ann,Smith,Acme,acme.com,555-0100,1000\n',
    });

    const res = await db.raw<Record<string, unknown>>(
      `select first_name, last_name, company, website, phone, custom from contacts limit 1`,
    );
    expect(res.rows[0]).toMatchObject({
      first_name: 'Ann',
      last_name: 'Smith',
      company: 'Acme',
      website: 'acme.com',
      phone: '555-0100',
      custom: { deal_size: '1000' },
    });
  });

  it('imports an XLSX', async () => {
    const bytes = buildXlsx([
      ['Email', 'First Name'],
      ['ann@example.com', 'Ann'],
      ['bob@example.com', 'Bob'],
    ]);
    const { importId, outcome } = await runImport({
      filename: 'book.xlsx',
      content: bytes,
    });
    expect(outcome.kind).toBe('completed');
    expect((await importRow(db, importId)).rows_valid).toBe(2);
  });

  it('imports an XLS', async () => {
    const bytes = buildXls([
      ['Email', 'First Name'],
      ['ann@example.com', 'Ann'],
      ['bob@example.com', 'Bob'],
    ]);
    const { importId, outcome } = await runImport({
      filename: 'legacy.xls',
      content: bytes,
    });
    expect(outcome.kind).toBe('completed');
    expect((await importRow(db, importId)).rows_valid).toBe(2);
  });

  it('imports a TSV', async () => {
    const { importId } = await runImport({
      filename: 'contacts.tsv',
      content: 'email\tfirst_name\nann@example.com\tAnn\n',
    });
    expect((await importRow(db, importId)).rows_valid).toBe(1);
  });

  it('handles a header row that is not the first row', async () => {
    const { importId, outcome } = await runImport({
      mapping: simpleMapping(['email', 'first_name'], 2),
      content:
        'Contact export\n' +
        '\n' +
        'email,first_name\n' +
        'ann@example.com,Ann\n' +
        'bob@example.com,Bob\n',
    });
    expect(outcome.kind).toBe('completed');
    const record = await importRow(db, importId);
    // The title and blank row are structure, not input rows.
    expect(record.rows_total).toBe(2);
    expect(record.rows_valid).toBe(2);
  });

  it('deletes the staged file on success', async () => {
    const { storagePath, storage } = await runImport();
    expect(storage.has(storagePath)).toBe(false);
    expect(storage.removed).toContain(storagePath);
  });

  it('marks the queue job done', async () => {
    const { importId } = await runImport();
    expect((await jobRow(db, importId)).status).toBe('done');
  });
});

describe('row classification end to end', () => {
  it('sorts every row into exactly one bucket', async () => {
    await seedSuppression(db, workspaceA, 'blocked@example.com');
    await seedContact(db, workspaceA, 'existing@example.com', { firstName: 'Existing' });

    const { importId, outcome } = await runImport({
      content:
        'email,first_name\n' +
        'ann@example.com,Ann\n' + // valid
        'bob@example.com,Bob\n' + // valid
        'not-an-email,Bad\n' + // invalid
        'ann@example.com,Ann Again\n' + // duplicate in file
        'existing@example.com,Updated\n' + // duplicate in database
        'blocked@example.com,Blocked\n' + // suppressed
        ',No address\n' + // rejected
        '\n', // rejected (empty)
      chunkRows: 2,
    });

    expect(outcome.kind).toBe('completed');
    const record = await importRow(db, importId);

    expect({
      total: record.rows_total,
      valid: record.rows_valid,
      invalid: record.rows_invalid,
      duplicate: record.rows_duplicate,
      suppressed: record.rows_suppressed,
      rejected: record.rows_rejected,
    }).toEqual({
      total: 8,
      valid: 2,
      invalid: 1,
      duplicate: 2,
      suppressed: 1,
      rejected: 2,
    });
  });

  it('writes a specific, readable reason for each non-valid row', async () => {
    await seedSuppression(db, workspaceA, 'blocked@example.com');
    await seedContact(db, workspaceA, 'existing@example.com');

    const { importId } = await runImport({
      content:
        'email,first_name\n' +
        'ann@example.com,Ann\n' +
        'not-an-email,Bad\n' +
        'ann@example.com,Again\n' +
        'existing@example.com,Enriched\n' +
        'blocked@example.com,Blocked\n' +
        ',Nothing\n',
    });

    const res = await db.raw<{ row_number: number; bucket: string; reason: string }>(
      `select row_number, bucket, reason from import_rejections
        where import_id = $1 order by row_number`,
      [importId],
    );

    // Row numbers are the file's own: the header is row 1, so the first data
    // row is row 2. That is the number the user sees in their spreadsheet.
    expect(res.rows).toEqual([
      { row_number: 3, bucket: 'invalid', reason: expect.stringContaining('Invalid email format') },
      {
        row_number: 4,
        bucket: 'duplicate',
        // The winning row is named, so the user can go and look at it.
        reason: 'Duplicate email inside uploaded file; first occurrence was row 2',
      },
      {
        row_number: 5,
        bucket: 'duplicate',
        reason: 'Already a contact in this workspace; existing details were enriched',
      },
      {
        row_number: 6,
        bucket: 'suppressed',
        reason: 'Address exists in the workspace suppression list',
      },
      {
        row_number: 7,
        bucket: 'rejected',
        reason: 'No email address in the email column',
      },
    ]);
  });

  it('retains the original cells with each rejection', async () => {
    const { importId } = await runImport({
      content: 'email,first_name\nnot-an-email,Ann\n',
    });
    const res = await db.raw<{ raw_row: Record<string, string> }>(
      `select raw_row from import_rejections where import_id = $1`,
      [importId],
    );
    expect(res.rows[0]?.raw_row).toEqual({ email: 'not-an-email', first_name: 'Ann' });
  });

  it('rejects every row when the file has no usable email column', async () => {
    // A mapping whose email column points at a column of company names.
    const { importId, outcome } = await runImport({
      mapping: simpleMapping(['email', 'company']),
      content: 'company,notes\nAcme,x\nGlobex,y\n',
    });

    expect(outcome.kind).toBe('completed');
    const record = await importRow(db, importId);
    expect(record.rows_total).toBe(2);
    expect(record.rows_invalid).toBe(2);
    expect(record.rows_valid).toBe(0);
    expect(await contactCount(workspaceA)).toBe(0);
  });

  it('counts blank rows in the middle of a file rather than dropping them', async () => {
    const { importId } = await runImport({
      content: 'email\nann@example.com\n\n\nbob@example.com\n',
    });
    const record = await importRow(db, importId);
    expect(record.rows_total).toBe(4);
    expect(record.rows_valid).toBe(2);
    expect(record.rows_rejected).toBe(2);
  });
});

describe('reconciliation', () => {
  /**
   * The exit criterion: every input row lands in exactly one of six buckets and
   * the counts reconcile to the row total, enforced by `ck_rows_reconcile`.
   */
  it.each([
    ['all valid', 'email\na@x.com\nb@x.com\nc@x.com\n'],
    ['all invalid', 'email\nnope\nalso-nope\n@\n'],
    ['all duplicates', 'email\na@x.com\na@x.com\na@x.com\n'],
    ['all blank', 'email\n\n\n\n'],
    ['mixed', 'email\na@x.com\nnope\na@x.com\n\nb@x.com\n'],
    ['single row', 'email\na@x.com\n'],
    ['header only', 'email\n'],
    ['whitespace cells', 'email\n   \n\t\na@x.com\n'],
  ])('reconciles for %s', async (_label, content) => {
    const { importId } = await runImport({
      content,
      mapping: simpleMapping(['email']),
      chunkRows: 2,
    });

    const record = await importRow(db, importId);
    const sum = ROW_BUCKETS.reduce((total, bucket) => {
      const key = `rows_${bucket}` as keyof typeof record;
      return total + (record[key] as number);
    }, 0);

    expect(sum, `${_label}: buckets must sum to rows_total`).toBe(record.rows_total);
  });

  it('reconciles a 5,000-row file across many chunks', async () => {
    let content = 'email,first_name\n';
    for (let i = 0; i < 5000; i += 1) {
      // Every twentieth row is unusable, and every fiftieth is a duplicate.
      if (i % 20 === 0) content += `not-an-email-${i},Bad\n`;
      else if (i % 50 === 1) content += `user1@example.com,Repeat\n`;
      else content += `user${i}@example.com,User ${i}\n`;
    }

    const { importId, outcome } = await runImport({ content, chunkRows: 500 });
    expect(outcome.kind).toBe('completed');

    const record = await importRow(db, importId);
    expect(record.rows_total).toBe(5000);
    expect(
      record.rows_valid +
        record.rows_invalid +
        record.rows_duplicate +
        record.rows_suppressed +
        record.rows_rejected,
    ).toBe(5000);
    expect(record.rows_invalid).toBe(250);
    expect(await contactCount(workspaceA)).toBe(record.rows_valid);
  });

  it('the database refuses a completed import whose counters do not reconcile', async () => {
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: 10,
      mapping: simpleMapping(['email']),
    });

    // 10 total, 3 accounted for. The constraint, not the application, refuses.
    let failed = false;
    try {
      await db.raw(
        `update imports
            set status = 'completed', finished_at = now(),
                rows_total = 10, rows_valid = 3
          where id = $1`,
        [seeded.importId],
      );
    } catch (cause) {
      failed = true;
      expect(String((cause as Error).message)).toContain('ck_rows_reconcile');
    }
    expect(failed, 'a non-reconciling completed import must be refused').toBe(true);
  });

  it('a failed import also reconciles, describing only what it attributed', async () => {
    let content = 'email\n';
    for (let i = 0; i < 20; i += 1) content += `user${i}@example.com\n`;

    const { importId, outcome } = await runImport({
      content,
      mapping: simpleMapping(['email']),
      chunkRows: 5,
      onChunk: (index) => {
        // Fail on the third chunk: rows 11-15.
        if (index === 3) throw new Error('injected storage fault');
      },
    });

    expect(outcome.kind).toBe('failed');
    const record = await importRow(db, importId);
    expect(record.status).toBe('failed');
    expect(
      record.rows_valid +
        record.rows_invalid +
        record.rows_duplicate +
        record.rows_suppressed +
        record.rows_rejected,
    ).toBe(record.rows_total);
  });
});

describe('partial failure is reported honestly', () => {
  it('keeps the rows already imported and names the row it stopped at', async () => {
    let content = 'email\n';
    for (let i = 0; i < 30; i += 1) content += `user${i}@example.com\n`;

    const { importId, outcome } = await runImport({
      content,
      mapping: simpleMapping(['email']),
      chunkRows: 10,
      onChunk: (index) => {
        if (index === 3) throw new Error('injected fault at the third chunk');
      },
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;

    // Two chunks committed before the fault; the third never ran.
    expect(outcome.counters.valid).toBe(20);
    expect(outcome.failedAtRow).toBe(22);
    expect(await contactCount(workspaceA)).toBe(20);

    const record = await importRow(db, importId);
    expect(record.status).toBe('failed');
    expect(record.rows_valid).toBe(20);
    expect(record.error_message).toContain('row 22');
    // Never "success", and never a rollback of the 20 committed rows.
    expect(record.error_message).not.toContain('complete');
  });

  it('does not claim the whole import succeeded', async () => {
    const { importId } = await runImport({
      content: 'email\na@x.com\nb@x.com\n',
      mapping: simpleMapping(['email']),
      chunkRows: 1,
      onChunk: (index) => {
        if (index === 2) throw new Error('fault');
      },
    });
    const record = await importRow(db, importId);
    expect(record.status).toBe('failed');
    expect(record.rows_valid).toBe(1);
  });

  it('surfaces an unreadable file as a failed import, not a silent success', async () => {
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'contacts.csv',
      byteSize: 100,
      mapping: simpleMapping(['email']),
    });

    // Nothing staged at that path.
    const storage = new MemoryStorage(workspaceA);
    const outcome = await processImport(ports(workspaceA, storage), seeded.importId);

    expect(outcome.kind).toBe('failed');
    expect(await importRow(db, seeded.importId).then((r) => r.status)).toBe('failed');
  });

  it('surfaces a file whose bytes contradict its extension', async () => {
    const { importId, outcome } = await runImport({
      filename: 'contacts.csv',
      content: buildXlsx([['Email'], ['a@b.com']]),
      mapping: simpleMapping(['email']),
    });

    expect(outcome.kind).toBe('failed');
    const record = await importRow(db, importId);
    expect(record.error_message).toContain('do not match');
    expect(await contactCount(workspaceA)).toBe(0);
  });

  it('surfaces a missing mapping as a failure rather than importing nothing quietly', async () => {
    const res = await db.raw<{ id: string }>(
      `insert into imports (workspace_id, actor_id, filename, byte_size, content_type,
                            storage_path, status, started_at)
       values ($1, $2, 'x.csv', 10, 'text/csv', 'pending', 'processing', now())
       returning id`,
      [workspaceA, userA],
    );
    const importId = res.rows[0]!.id;
    const storagePath = `${workspaceA}/${importId}/x.csv`;
    await db.raw(`update imports set storage_path = $2 where id = $1`, [importId, storagePath]);
    await db.raw(
      `insert into import_jobs (import_id, workspace_id, status) values ($1, $2, 'queued')`,
      [importId, workspaceA],
    );

    const storage = new MemoryStorage(workspaceA);
    storage.put(storagePath, 'email\na@x.com\n');

    const outcome = await processImport(ports(workspaceA, storage), importId);
    expect(outcome.kind).toBe('failed');
    expect((await importRow(db, importId)).error_message).toContain('column mapping');
  });
});

describe('deduplication', () => {
  it('the first occurrence in a file wins', async () => {
    await runImport({
      mapping: simpleMapping(['email', 'first_name']),
      content:
        'email,first_name\n' +
        'ann@example.com,First\n' +
        'ann@example.com,Second\n' +
        'ANN@EXAMPLE.COM,Third\n',
    });

    expect(await contactCount(workspaceA)).toBe(1);
    const res = await db.raw<{ first_name: string }>(`select first_name from contacts`);
    expect(res.rows[0]?.first_name).toBe('First');
  });

  it('treats differently-cased addresses as the same contact', async () => {
    const { importId } = await runImport({
      content: 'email\nAnn@Example.com\nann@example.com\nANN@EXAMPLE.COM\n',
      mapping: simpleMapping(['email']),
    });
    const record = await importRow(db, importId);
    expect(record.rows_valid).toBe(1);
    expect(record.rows_duplicate).toBe(2);
  });

  it('does not treat a plus-address as a duplicate of its base', async () => {
    // The P1 normalizer deliberately does not strip plus-addressing.
    const { importId } = await runImport({
      content: 'email\nann@example.com\nann+news@example.com\n',
      mapping: simpleMapping(['email']),
    });
    expect((await importRow(db, importId)).rows_valid).toBe(2);
  });

  it('does not treat a dotted Gmail local part as a duplicate', async () => {
    const { importId } = await runImport({
      content: 'email\nann.smith@gmail.com\nannsmith@gmail.com\n',
      mapping: simpleMapping(['email']),
    });
    expect((await importRow(db, importId)).rows_valid).toBe(2);
  });

  it('counts a row already in the database as a duplicate, and enriches it', async () => {
    await seedContact(db, workspaceA, 'ann@example.com', { firstName: 'Ann' });

    const { importId } = await runImport({
      mapping: simpleMapping(['email', 'first_name', 'company']),
      content: 'email,first_name,company\nann@example.com,,Acme\n',
    });

    const record = await importRow(db, importId);
    expect(record.rows_duplicate).toBe(1);
    expect(record.rows_valid).toBe(0);

    const res = await db.raw<{ first_name: string; company: string }>(
      `select first_name, company from contacts where email_normalized = 'ann@example.com'`,
    );
    // Enriched: company filled in, existing first name preserved.
    expect(res.rows[0]).toEqual({ first_name: 'Ann', company: 'Acme' });
  });

  it('never blanks a populated field with an empty cell', async () => {
    await seedContact(db, workspaceA, 'ann@example.com', {
      firstName: 'Ann',
      lastName: 'Smith',
      company: 'Acme',
    });

    await runImport({
      mapping: simpleMapping(['email', 'first_name', 'last_name', 'company', 'website', 'phone']),
      content: 'email,f,l,c,w,p\nann@example.com,,,,new.example.com,\n',
    });

    const res = await db.raw<Record<string, string | null>>(
      `select first_name, last_name, company, website, phone from contacts`,
    );
    expect(res.rows[0]).toEqual({
      first_name: 'Ann',
      last_name: 'Smith',
      company: 'Acme',
      website: 'new.example.com',
      phone: null,
    });
  });

  it('merges custom data rather than replacing it', async () => {
    await db.raw(
      `insert into contacts (workspace_id, email_normalized, email_raw, custom)
       values ($1, 'ann@example.com', 'ann@example.com', '{"existing":"keep","shared":"old"}'::jsonb)`,
      [workspaceA],
    );

    await runImport({
      mapping: simpleMapping(['email', { custom: 'shared' }, { custom: 'added' }]),
      content: 'email,shared,added\nann@example.com,new,value\n',
    });

    const res = await db.raw<{ custom: Record<string, string> }>(`select custom from contacts`);
    expect(res.rows[0]?.custom).toEqual({ existing: 'keep', shared: 'new', added: 'value' });
  });

  it('re-importing the same file is idempotent', async () => {
    const content = 'email,first_name\nann@example.com,Ann\nbob@example.com,Bob\n';

    const first = await runImport({ content });
    expect((await importRow(db, first.importId)).rows_valid).toBe(2);

    const second = await runImport({ content });
    const record = await importRow(db, second.importId);
    expect(record.rows_valid).toBe(0);
    expect(record.rows_duplicate).toBe(2);
    expect(await contactCount(workspaceA)).toBe(2);
  });

  it('two imports of the same address racing produce one contact', async () => {
    const content = 'email,first_name\nrace@example.com,Racer\n';
    const bytes = new TextEncoder().encode(content);

    const seedOne = async () => {
      const seeded = await seedProcessingImport(db, {
        workspaceId: workspaceA,
        actorId: userA,
        filename: 'race.csv',
        byteSize: bytes.length,
        mapping: simpleMapping(['email', 'first_name']),
      });
      const storage = new MemoryStorage(workspaceA);
      storage.put(seeded.storagePath, bytes);
      return { seeded, storage };
    };

    const one = await seedOne();
    const two = await seedOne();

    // The unique constraint and `on conflict do update` are what make this safe,
    // not a pre-check: a SELECT-then-INSERT would race here.
    const [outcomeOne, outcomeTwo] = await Promise.all([
      processImport(ports(workspaceA, one.storage), one.seeded.importId),
      processImport(ports(workspaceA, two.storage), two.seeded.importId),
    ]);

    expect(outcomeOne.kind).toBe('completed');
    expect(outcomeTwo.kind).toBe('completed');
    expect(await contactCount(workspaceA)).toBe(1);

    // Exactly one import created it; the other counted it as a duplicate.
    const recordOne = await importRow(db, one.seeded.importId);
    const recordTwo = await importRow(db, two.seeded.importId);
    expect(recordOne.rows_valid + recordTwo.rows_valid).toBe(1);
    expect(recordOne.rows_duplicate + recordTwo.rows_duplicate).toBe(1);
  });

  it('the same address may exist independently in two workspaces', async () => {
    await runImport({ content: 'email\nshared@example.com\n', mapping: simpleMapping(['email']) });
    await runImport({
      workspaceId: workspaceB,
      actorId: userB,
      content: 'email\nshared@example.com\n',
      mapping: simpleMapping(['email']),
    });

    expect(await contactCount(workspaceA)).toBe(1);
    expect(await contactCount(workspaceB)).toBe(1);
  });
});

describe('suppression', () => {
  it('classifies a suppressed address in its own bucket', async () => {
    await seedSuppression(db, workspaceA, 'blocked@example.com', 'unsubscribe');

    const { importId } = await runImport({
      content: 'email,first_name\nblocked@example.com,Blocked\nok@example.com,Fine\n',
    });

    const record = await importRow(db, importId);
    expect(record.rows_suppressed).toBe(1);
    expect(record.rows_valid).toBe(1);
  });

  it('still imports the contact, marked suppressed, so the user can see it', async () => {
    await seedSuppression(db, workspaceA, 'blocked@example.com', 'complaint');

    await runImport({
      content: 'email,first_name\nblocked@example.com,Blocked\n',
    });

    const res = await db.raw<{ status: string; first_name: string }>(
      `select status, first_name from contacts where email_normalized = 'blocked@example.com'`,
    );
    expect(res.rows[0]).toEqual({ status: 'suppressed', first_name: 'Blocked' });
  });

  it('leaves the suppression record untouched', async () => {
    await seedSuppression(db, workspaceA, 'blocked@example.com', 'hard_bounce');
    await runImport({ content: 'email\nblocked@example.com\n', mapping: simpleMapping(['email']) });

    const res = await db.raw<{ reason: string; count: string }>(
      `select reason::text as reason, count(*) over ()::text as count
         from suppressions where workspace_id = $1`,
      [workspaceA],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.reason).toBe('hard_bounce');
  });

  it('an import cannot un-suppress an address', async () => {
    await seedContact(db, workspaceA, 'blocked@example.com');
    await seedSuppression(db, workspaceA, 'blocked@example.com');

    // The trigger has already flipped the contact to suppressed.
    expect(
      (
        await db.raw<{ status: string }>(
          `select status from contacts where email_normalized = 'blocked@example.com'`,
        )
      ).rows[0]?.status,
    ).toBe('suppressed');

    await runImport({ content: 'email\nblocked@example.com\n', mapping: simpleMapping(['email']) });

    const res = await db.raw<{ status: string }>(
      `select status from contacts where email_normalized = 'blocked@example.com'`,
    );
    expect(res.rows[0]?.status).toBe('suppressed');
  });

  it('re-importing a suppressed address keeps it suppressed', async () => {
    await seedSuppression(db, workspaceA, 'blocked@example.com');
    await runImport({ content: 'email\nblocked@example.com\n', mapping: simpleMapping(['email']) });
    const second = await runImport({
      content: 'email\nblocked@example.com\n',
      mapping: simpleMapping(['email']),
    });

    // Suppression wins over the duplicate classification: it is the more
    // important fact about the row.
    expect((await importRow(db, second.importId)).rows_suppressed).toBe(1);
    const res = await db.raw<{ status: string }>(`select status from contacts`);
    expect(res.rows[0]?.status).toBe('suppressed');
  });

  it('a suppression in another workspace does not affect this one', async () => {
    await seedSuppression(db, workspaceB, 'blocked@example.com');

    const { importId } = await runImport({
      content: 'email\nblocked@example.com\n',
      mapping: simpleMapping(['email']),
    });

    const record = await importRow(db, importId);
    expect(record.rows_suppressed).toBe(0);
    expect(record.rows_valid).toBe(1);
  });

  it('normalises before checking suppression', async () => {
    await seedSuppression(db, workspaceA, 'blocked@example.com');
    const { importId } = await runImport({
      content: 'email\n  BLOCKED@Example.COM  \n',
      mapping: simpleMapping(['email']),
    });
    expect((await importRow(db, importId)).rows_suppressed).toBe(1);
  });
});

describe('list membership', () => {
  it('adds imported contacts to the target list', async () => {
    const listId = await seedList(db, workspaceA, 'Newsletter');

    await runImport({
      targetListId: listId,
      content: 'email,first_name\nann@example.com,Ann\nbob@example.com,Bob\n',
    });

    const res = await db.raw<{ count: string }>(
      `select count(*)::text as count from list_members where list_id = $1`,
      [listId],
    );
    expect(Number(res.rows[0]?.count)).toBe(2);
  });

  it('adds an enriched existing contact to the list too', async () => {
    const listId = await seedList(db, workspaceA, 'Newsletter');
    await seedContact(db, workspaceA, 'ann@example.com');

    await runImport({ targetListId: listId, content: 'email\nann@example.com\n', mapping: simpleMapping(['email']) });

    const res = await db.raw<{ count: string }>(
      `select count(*)::text as count from list_members where list_id = $1`,
      [listId],
    );
    expect(Number(res.rows[0]?.count)).toBe(1);
  });

  it('maintains the list counter', async () => {
    const listId = await seedList(db, workspaceA, 'Newsletter');
    await runImport({
      targetListId: listId,
      content: 'email\na@x.com\nb@x.com\nc@x.com\n',
      mapping: simpleMapping(['email']),
    });

    const res = await db.raw<{ contact_count: number }>(
      `select contact_count from contact_lists where id = $1`,
      [listId],
    );
    expect(res.rows[0]?.contact_count).toBe(3);
  });

  it('does not add a contact to a list twice', async () => {
    const listId = await seedList(db, workspaceA, 'Newsletter');
    const content = 'email\nann@example.com\n';

    await runImport({ targetListId: listId, content, mapping: simpleMapping(['email']) });
    await runImport({ targetListId: listId, content, mapping: simpleMapping(['email']) });

    const res = await db.raw<{ count: string }>(
      `select count(*)::text as count from list_members where list_id = $1`,
      [listId],
    );
    expect(Number(res.rows[0]?.count)).toBe(1);
  });

  it('refuses a target list belonging to another workspace', async () => {
    const foreignList = await seedList(db, workspaceB, 'Theirs');

    // The upsert function checks workspace ownership itself, so even a runner
    // handed a foreign list id cannot write into it.
    const { importId, outcome } = await runImport({
      targetListId: foreignList,
      content: 'email\nann@example.com\n',
      mapping: simpleMapping(['email']),
    });

    expect(outcome.kind).toBe('failed');
    expect((await importRow(db, importId)).status).toBe('failed');

    const res = await db.raw<{ count: string }>(
      `select count(*)::text as count from list_members where list_id = $1`,
      [foreignList],
    );
    expect(Number(res.rows[0]?.count)).toBe(0);
  });

  it('imports contacts without a list when none is chosen', async () => {
    const { outcome } = await runImport({ targetListId: null });
    expect(outcome.kind).toBe('completed');
    const res = await db.raw<{ count: string }>(
      `select count(*)::text as count from list_members`,
    );
    expect(Number(res.rows[0]?.count)).toBe(0);
  });
});

describe('the queue', () => {
  it('claims a job exactly once', async () => {
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: 20,
      mapping: simpleMapping(['email']),
    });
    const repository = testImportRepository(db, workspaceA);

    expect(await repository.claim(seeded.importId)).not.toBeNull();
    // A second claim finds the job taken. This is what stops a redelivered
    // message or a double click processing the same file twice.
    expect(await repository.claim(seeded.importId)).toBeNull();
  });

  it('does not process the same import twice', async () => {
    const bytes = new TextEncoder().encode('email\nann@example.com\n');
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: bytes.length,
      mapping: simpleMapping(['email']),
    });
    const storage = new MemoryStorage(workspaceA);
    storage.put(seeded.storagePath, bytes);

    const first = await processImport(ports(workspaceA, storage), seeded.importId);
    const second = await processImport(ports(workspaceA, storage), seeded.importId);

    expect(first.kind).toBe('completed');
    expect(second).toEqual({ kind: 'skipped', reason: 'not_claimed' });
    expect(await contactCount(workspaceA)).toBe(1);
  });

  it('two concurrent runners produce one processing pass', async () => {
    const bytes = new TextEncoder().encode('email\na@x.com\nb@x.com\n');
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: bytes.length,
      mapping: simpleMapping(['email']),
    });
    const storage = new MemoryStorage(workspaceA);
    storage.put(seeded.storagePath, bytes);

    const outcomes = await Promise.all([
      processImport(ports(workspaceA, storage), seeded.importId),
      processImport(ports(workspaceA, storage), seeded.importId),
    ]);

    expect(outcomes.filter((o) => o.kind === 'completed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'skipped')).toHaveLength(1);
    expect(await contactCount(workspaceA)).toBe(2);
  });

  it('requeues a failed job until the attempt cap, then marks it dead', async () => {
    const bytes = new TextEncoder().encode('email\na@x.com\n');
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'contacts.csv',
      byteSize: bytes.length,
      mapping: simpleMapping(['email']),
    });

    // Nothing staged, so every pass fails.
    const storage = new MemoryStorage(workspaceA);

    await processImport(ports(workspaceA, storage), seeded.importId);
    let job = await jobRow(db, seeded.importId);
    expect(job.attempts).toBe(1);
    expect(job.status).toBe('queued');
    expect(job.last_error).not.toBeNull();

    // The import is terminal now, so later passes decline to write contacts
    // even though the job is claimable — the state machine, not the queue, is
    // what protects the data.
    await db.raw(
      `update imports set status = 'processing', finished_at = null, error_message = null
        where id = $1`,
      [seeded.importId],
    );
    await processImport(ports(workspaceA, storage), seeded.importId);
    job = await jobRow(db, seeded.importId);
    expect(job.attempts).toBe(2);
    expect(job.status).toBe('queued');

    await db.raw(
      `update imports set status = 'processing', finished_at = null, error_message = null
        where id = $1`,
      [seeded.importId],
    );
    await processImport(ports(workspaceA, storage), seeded.importId);
    job = await jobRow(db, seeded.importId);
    expect(job.attempts).toBe(3);
    // Never retried forever.
    expect(job.status).toBe('dead');
  });

  it('a retried import does not double-count its rejections', async () => {
    const bytes = new TextEncoder().encode('email\nnot-an-email\nalso-bad\n');
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'contacts.csv',
      byteSize: bytes.length,
      mapping: simpleMapping(['email']),
    });
    const storage = new MemoryStorage(workspaceA);
    storage.put(seeded.storagePath, bytes, new Date().toISOString());

    await processImport(ports(workspaceA, storage), seeded.importId, {
      deleteStagedFile: false,
    });

    // Re-run from the top, as a retry does.
    await db.raw(
      `update imports set status = 'processing', finished_at = null, error_message = null
        where id = $1`,
      [seeded.importId],
    );
    await db.raw(`update import_jobs set status = 'queued' where import_id = $1`, [
      seeded.importId,
    ]);

    await processImport(ports(workspaceA, storage), seeded.importId, { deleteStagedFile: false });

    const res = await db.raw<{ count: string }>(
      `select count(*)::text as count from import_rejections where import_id = $1`,
      [seeded.importId],
    );
    expect(Number(res.rows[0]?.count)).toBe(2);
    const record = await importRow(db, seeded.importId);
    expect(record.rows_total).toBe(2);
    expect(record.rows_invalid).toBe(2);
  });

  it('declines to write contacts for an import that is not processing', async () => {
    const bytes = new TextEncoder().encode('email\na@x.com\n');
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: bytes.length,
      mapping: simpleMapping(['email']),
    });
    await db.raw(`update imports set status = 'mapping' where id = $1`, [seeded.importId]);

    const storage = new MemoryStorage(workspaceA);
    storage.put(seeded.storagePath, bytes);

    const outcome = await processImport(ports(workspaceA, storage), seeded.importId);
    expect(outcome).toEqual({ kind: 'skipped', reason: 'not_processing' });
    expect(await contactCount(workspaceA)).toBe(0);
  });
});

describe('the state machine', () => {
  it('refuses a transition from a status that is not the expected one', async () => {
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceA,
      actorId: userA,
      filename: 'x.csv',
      byteSize: 10,
      mapping: simpleMapping(['email']),
    });
    const repository = testImportRepository(db, workspaceA);

    // Already `processing`, so a transition guarded on `uploaded` must not apply.
    expect(await repository.transition(seeded.importId, ['uploaded'], 'mapping')).toBe(false);
    expect((await importRow(db, seeded.importId)).status).toBe('processing');

    expect(
      await repository.transition(seeded.importId, ['processing'], 'completed', {
        finished_at: new Date().toISOString(),
      }),
    ).toBe(true);
    expect((await importRow(db, seeded.importId)).status).toBe('completed');
  });

  it('cannot transition an import belonging to another workspace', async () => {
    const seeded = await seedProcessingImport(db, {
      workspaceId: workspaceB,
      actorId: userB,
      filename: 'x.csv',
      byteSize: 10,
      mapping: simpleMapping(['email']),
    });

    // A repository bound to workspace A, handed workspace B's import id.
    const repository = testImportRepository(db, workspaceA);
    expect(await repository.get(seeded.importId)).toBeNull();
    expect(await repository.transition(seeded.importId, ['processing'], 'failed', {
      finished_at: new Date().toISOString(),
    })).toBe(false);
    expect((await importRow(db, seeded.importId)).status).toBe('processing');
  });
});
