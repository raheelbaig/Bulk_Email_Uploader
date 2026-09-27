import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { TestDb, migrationFiles } from './helpers/db';
import { seedContact, seedList, seedSuppression } from './helpers/p1';
import { seedTemplate } from './helpers/p4';
import { seedSenderDomain, seedSenderIdentity, verifiedDomainState } from './helpers/sender';
import { normalizeEmail } from '@/lib/email/normalize';

/**
 * Phase J of the second QA pass: are migrations 0011–0014 safe to apply to a
 * database in production's current state, and can they be undone?
 *
 * "Production's current state" is modelled as: migrations 0001–0010 applied
 * (what schema_migrations records in production), holding the kinds of rows the
 * product has produced so far — a signed-up owner, the QA import's contacts
 * written through the application normalizer, a list, a template, an unverified
 * sender, suppressions of every reason, and campaigns in draft and scheduled.
 *
 * Each migration is applied inside its own transaction, exactly as
 * scripts/migrate.mjs applies it.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const NEW_MIGRATIONS = ['0011_canonical_email.sql', '0012_send_approval.sql', '0013_send_limits.sql', '0014_postal_address.sql'];
const ROLLBACK = readFileSync(join(process.cwd(), 'supabase', 'ops', 'rollback_0011_0014.sql'), 'utf8');

async function databaseAt(lastMigration: string): Promise<{ pg: PGlite; db: TestDb }> {
  const pg = await new PGlite({ extensions: { pg_trgm } });
  await pg.exec(readFileSync(join(process.cwd(), 'supabase', 'testing', '0000_supabase_emulation.sql'), 'utf8'));
  for (const file of migrationFiles().filter((f) => f <= lastMigration)) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return { pg, db: new TestDb(pg) };
}

/** As scripts/migrate.mjs: one transaction per file, all or nothing. */
async function apply(pg: PGlite, file: string): Promise<void> {
  const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  await pg.transaction(async (tx) => {
    await tx.exec(body);
  });
}

/** Rows as they are in production today, written the way the product writes them. */
async function seedProductionLikeState(db: TestDb): Promise<{ workspaceId: string; scheduledId: string }> {
  const owner = await db.createUser('owner@example.test');
  const ws = owner.workspaceId;

  // The QA import: 6 valid contacts, written through the normalizer (the import
  // runner's only path), including an uppercase and a padded address and
  // Unicode names.
  const imported = [
    ['Alice@Example.com', 'Alice'],
    ['  bob@example.org ', 'Bob'],
    ['carol.smith+news@example.co.uk', 'Carol'],
    ['dave@sub.example.net', 'Dáve'],
    ["o'neil@example.ie", 'Seán'],
    ['zoë-test@example.com'.replace('ë', 'e'), 'Zoë'],
  ] as const;
  const listId = await seedList(db, ws, 'QA import');
  for (const [raw, name] of imported) {
    const n = normalizeEmail(raw);
    if (!n.ok) throw new Error(`fixture address ${raw} is not valid`);
    const id = await seedContact(db, ws, n.normalized, { firstName: name });
    await db.raw(`insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)`, [ws, listId, id]);
  }
  for (const [email, reason] of [
    ['unsub@example.com', 'unsubscribe'],
    ['bounce@example.com', 'hard_bounce'],
    ['complaint@example.com', 'complaint'],
    ['invalid@example.com', 'invalid'],
    ['blocked@example.com', 'manually_blocked'],
    ['provider@example.com', 'provider_suppressed'],
  ] as const) {
    await seedSuppression(db, ws, email, reason);
  }

  const templateId = await seedTemplate(db, ws, { name: 'QA test template' });
  const domainId = await seedSenderDomain(db, ws, 'qa-sender.example.com', verifiedDomainState());
  const identityId = await seedSenderIdentity(db, ws, domainId, 'news@qa-sender.example.com');

  await db.raw(`insert into campaigns (workspace_id, name) values ($1, 'Draft campaign')`, [ws]);
  const scheduled = await db.raw<{ id: string }>(
    `insert into campaigns (workspace_id, name) values ($1, 'Scheduled before 0012') returning id`,
    [ws],
  );
  const scheduledId = scheduled.rows[0]!.id;
  await db.raw(
    `update campaigns set list_id = $2, template_id = $3, sender_identity_id = $4,
                          scheduled_at = now() + interval '1 day' where id = $1`,
    [scheduledId, listId, templateId, identityId],
  );
  await db.raw(`update campaigns set status = 'validating' where id = $1`, [scheduledId]);
  await db.raw(`update campaigns set status = 'scheduled', template_snapshot = '{"frozen": true}'::jsonb where id = $1`, [
    scheduledId,
  ]);
  return { workspaceId: ws, scheduledId };
}

/** Every business row that must survive, in a stable form. */
async function dataSnapshot(db: TestDb): Promise<string> {
  const parts: unknown[] = [];
  for (const sql of [
    `select id, workspace_id, email_normalized, email_raw, first_name, status from contacts order by id`,
    `select workspace_id, email_normalized, reason::text from suppressions order by email_normalized`,
    `select list_id, contact_id from list_members order by list_id, contact_id`,
    `select id, name, status::text, list_id, template_id, sender_identity_id, template_snapshot, scheduled_at from campaigns order by id`,
    `select id, name, version, subject, html from templates order by id`,
    `select workspace_id, display_timezone from workspace_settings order by workspace_id`,
  ]) {
    parts.push((await db.raw(sql)).rows);
  }
  return JSON.stringify(parts);
}

/** The shape of the schema: columns, constraints, indexes, functions and privileges. */
async function schemaFingerprint(db: TestDb): Promise<string> {
  const parts: unknown[] = [];
  for (const sql of [
    `select table_schema, table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns where table_schema in ('public', 'app') order by 1, 2, 3`,
    `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(c.oid) as def
       from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname in ('public', 'app') order by 1, 2`,
    `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ('public', 'app') order by 1, 2, 3`,
    `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(replace(p.prosrc, chr(13), '')) as body,
            coalesce(p.proacl::text, '') as acl, p.prosecdef
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'app') order by 1, 2, 3`,
    `select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
      where table_schema = 'public' and grantee in ('authenticated', 'anon', 'service_role') order by 1, 2, 3, 4`,
  ]) {
    parts.push((await db.raw(sql)).rows);
  }
  // Function bodies are compared without carriage returns: a Windows working
  // copy can hold CRLF migrations (git stores them LF — .gitattributes), and a
  // CR is not meaningful in SQL.
  return JSON.stringify(parts);
}

describe('migrations 0011–0014 against a production-like database', () => {
  it('apply cleanly, one transaction each, and change no existing row', async () => {
    const { pg, db } = await databaseAt('0010_sending_engine.sql');
    const { workspaceId, scheduledId } = await seedProductionLikeState(db);
    const before = await dataSnapshot(db);

    for (const file of NEW_MIGRATIONS) await apply(pg, file);

    expect(await dataSnapshot(db)).toBe(before);

    const constraints = await db.raw<{ conname: string }>(
      `select conname from pg_constraint where conname in ('ck_contacts_email_canonical', 'ck_suppressions_email_canonical')
        order by conname`,
    );
    expect(constraints.rows.map((r) => r.conname)).toEqual(['ck_contacts_email_canonical', 'ck_suppressions_email_canonical']);

    // New columns start empty: nothing is approved and no footer is configured.
    const campaign = await db.raw<{ approved_send_mode: string | null; status: string }>(
      `select approved_send_mode, status::text as status from campaigns where id = $1`,
      [scheduledId],
    );
    expect(campaign.rows[0]).toEqual({ approved_send_mode: null, status: 'scheduled' });
    const settings = await db.raw<{ postal_address: string | null }>(
      `select postal_address from workspace_settings where workspace_id = $1`,
      [workspaceId],
    );
    expect(settings.rows[0]?.postal_address).toBeNull();

    // A campaign scheduled before 0012 can no longer launch in any mode: held,
    // not sent, until a person schedules it again. Its due time is moved to now
    // so that only the approval stands in the way.
    await db.raw(`update campaigns set scheduled_at = now() - interval '1 minute' where id = $1`, [scheduledId]);
    for (const mode of ['dry_run', 'live']) {
      const promoted = await db.asServiceRole((svc) =>
        svc.raw<{ ok: boolean }>(`select sending_promote_campaign($1, $2, $3) as ok`, [workspaceId, scheduledId, mode]),
      );
      expect(promoted.rows[0]?.ok).toBe(false);
    }

    await pg.close();
  });

  it('a production row that violated 0011 would fail it atomically, changing nothing', async () => {
    const { pg, db } = await databaseAt('0010_sending_engine.sql');
    const owner = await db.createUser('owner2@example.test');
    // Only possible before 0011: a member writing through the API directly.
    await db.raw(`insert into contacts (workspace_id, email_normalized, email_raw) values ($1, 'Mixed@Example.com', 'x@y.zz')`, [
      owner.workspaceId,
    ]);
    const before = await schemaFingerprint(db);

    await expect(apply(pg, '0011_canonical_email.sql')).rejects.toThrow(/ck_contacts_email_canonical|check constraint/i);

    expect(await schemaFingerprint(db)).toBe(before);
    const row = await db.raw(`select 1 from contacts where email_normalized = 'Mixed@Example.com'`);
    expect(row.rows).toHaveLength(1);
    await pg.close();
  });

  it('the rollback script returns the schema exactly to 0010 and keeps every row; re-applying works', async () => {
    const reference = await databaseAt('0010_sending_engine.sql');
    const expected = await schemaFingerprint(reference.db);
    await reference.pg.close();

    const { pg, db } = await databaseAt('0010_sending_engine.sql');
    const { workspaceId } = await seedProductionLikeState(db);
    const before = await dataSnapshot(db);

    for (const file of NEW_MIGRATIONS) await apply(pg, file);
    // Use the new columns, so the rollback has data to drop.
    await db.raw(`update workspace_settings set postal_address = 'QA Test Co., 1 Example Street' where workspace_id = $1`, [
      workspaceId,
    ]);

    await pg.exec(ROLLBACK);

    expect(await schemaFingerprint(db)).toBe(expected);
    expect(await dataSnapshot(db)).toBe(before);

    // Rolling forward again is the recovery path, and it works from here.
    for (const file of NEW_MIGRATIONS) await apply(pg, file);
    const claim = await db.raw<{ args: string }>(
      `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p where p.proname = 'sending_claim_jobs'`,
    );
    expect(claim.rows.map((r) => r.args)).toEqual(['p_workspace_id uuid, p_campaign_id uuid, p_limit integer, p_cooldown_minutes integer']);
    await pg.close();
  });

  it('the migration set on disk is exactly 0001–0015, with 0011–0014 then 0015 last', () => {
    const files = migrationFiles();
    expect(files.slice(-5, -1)).toEqual(NEW_MIGRATIONS);
    expect(files.at(-1)).toBe(M0015);
    expect(files).toHaveLength(15);
  });
});

// ── 0015: a job's address is canonical (phase 3 real-database QA) ──────────
//
// UNIQUE (campaign_id, to_email) compared stored text, so `x@example.com` and
// `X@EXAMPLE.COM` could be two jobs of one campaign. 0015 constrains to_email
// the way 0011 constrains contacts, which makes that uniqueness case-insensitive.

const M0015 = '0015_canonical_job_address.sql';
const ROLLBACK_0015 = readFileSync(join(process.cwd(), 'supabase', 'ops', 'rollback_0015.sql'), 'utf8');

async function seedJob(db: TestDb, workspaceId: string, campaignId: string, toEmail: string): Promise<void> {
  const contactId = await seedContact(db, workspaceId, toEmail.toLowerCase().trim());
  await db.raw(`insert into email_jobs (workspace_id, campaign_id, contact_id, to_email) values ($1, $2, $3, $4)`, [
    workspaceId,
    campaignId,
    contactId,
    toEmail,
  ]);
}

describe('migration 0015 against a production-like database', () => {
  it('applies cleanly over 0014 with existing canonical jobs, changing no row', async () => {
    const { pg, db } = await databaseAt('0014_postal_address.sql');
    const { workspaceId, scheduledId } = await seedProductionLikeState(db);
    await seedJob(db, workspaceId, scheduledId, 'kept@example.com');
    const before = await dataSnapshot(db);
    const jobsBefore = (await db.raw(`select id, to_email from email_jobs order by id`)).rows;

    await apply(pg, M0015);

    expect(await dataSnapshot(db)).toBe(before);
    expect((await db.raw(`select id, to_email from email_jobs order by id`)).rows).toEqual(jobsBefore);
    const constraint = await db.raw(`select 1 from pg_constraint where conname = 'ck_email_jobs_to_email_canonical'`);
    expect(constraint.rows).toHaveLength(1);
    await pg.close();
  });

  it('a non-canonical job row would fail it atomically, changing nothing', async () => {
    const { pg, db } = await databaseAt('0014_postal_address.sql');
    const { workspaceId, scheduledId } = await seedProductionLikeState(db);
    await seedJob(db, workspaceId, scheduledId, 'Mixed@Example.com');
    const before = await schemaFingerprint(db);

    await expect(apply(pg, M0015)).rejects.toThrow(/ck_email_jobs_to_email_canonical|check constraint/i);

    expect(await schemaFingerprint(db)).toBe(before);
    await pg.close();
  });

  it('after 0015, a case variant of an address already in a campaign cannot become a second job — for any role', async () => {
    const { pg, db } = await databaseAt(M0015);
    const { workspaceId, scheduledId } = await seedProductionLikeState(db);
    await seedJob(db, workspaceId, scheduledId, 'dup@example.com');
    const other = await seedContact(db, workspaceId, 'other@example.com');

    for (const variant of ['DUP@EXAMPLE.COM', 'Dup@example.com', ' dup@example.com']) {
      await expect(
        db.asServiceRole((svc) =>
          svc.raw(`insert into email_jobs (workspace_id, campaign_id, contact_id, to_email) values ($1, $2, $3, $4)`, [
            workspaceId,
            scheduledId,
            other,
            variant,
          ]),
        ),
      ).rejects.toThrow(/ck_email_jobs_to_email_canonical|check constraint/i);
    }
    // The exact duplicate is still refused by the 0010 unique constraint.
    await expect(
      db.asServiceRole((svc) =>
        svc.raw(`insert into email_jobs (workspace_id, campaign_id, contact_id, to_email) values ($1, $2, $3, 'dup@example.com')`, [
          workspaceId,
          scheduledId,
          other,
        ]),
      ),
    ).rejects.toThrow(/uq_email_jobs_campaign_email|unique/i);
    const jobs = await db.raw<{ n: number }>(`select count(*)::int as n from email_jobs where campaign_id = $1`, [scheduledId]);
    expect(jobs.rows[0]?.n).toBe(1);
    await pg.close();
  });

  it('rollback_0015 returns the schema exactly to 0014 and keeps every row', async () => {
    const reference = await databaseAt('0014_postal_address.sql');
    const expected = await schemaFingerprint(reference.db);
    await reference.pg.close();

    const { pg, db } = await databaseAt('0014_postal_address.sql');
    const { workspaceId, scheduledId } = await seedProductionLikeState(db);
    await seedJob(db, workspaceId, scheduledId, 'kept@example.com');
    const before = await dataSnapshot(db);
    await apply(pg, M0015);

    await pg.exec(ROLLBACK_0015);

    expect(await schemaFingerprint(db)).toBe(expected);
    expect(await dataSnapshot(db)).toBe(before);
    await apply(pg, M0015);
    await pg.close();
  });
});
