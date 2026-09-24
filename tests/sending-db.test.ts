import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedLaunchableCampaign, jobsFor, campaignRow, type LaunchableCampaign } from './helpers/p5';

/**
 * Migration 0010, proven at the database.
 *
 * The worker tests show the engine behaves. These show that the guarantees
 * hold even against code that misbehaves — a buggy worker, a forged PostgREST
 * request, a second code path someone adds later — because they are
 * constraints, triggers, grants and policies rather than application logic.
 */

describe('the sending schema', () => {
  let db: TestDb;
  let alice: { userId: string; workspaceId: string };
  let bob: { userId: string; workspaceId: string };
  let c: LaunchableCampaign;

  const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    db.asServiceRole(async (as) => (await as.raw<T>(sql, params)).rows);

  /** Launches `c` and claims one job, returning its id. */
  async function claimOne(campaign: LaunchableCampaign): Promise<string> {
    const [row] = await svc<{ id: string }>(`select id from sending_claim_jobs($1, $2, 1)`, [
      campaign.workspaceId,
      campaign.campaignId,
    ]);
    if (row === undefined) throw new Error('nothing claimed');
    return row.id;
  }

  async function launched(recipients = 3): Promise<LaunchableCampaign> {
    const campaign = await seedLaunchableCampaign(db, alice.workspaceId, { recipients });
    await svc(`select sending_promote_campaign($1, $2, 'dry_run')`, [campaign.workspaceId, campaign.campaignId]);
    await svc(`select sending_materialize_campaign($1, $2)`, [campaign.workspaceId, campaign.campaignId]);
    return campaign;
  }

  beforeAll(async () => {
    db = await createTestDb();
    alice = await db.createUser('alice@example.test');
    bob = await db.createUser('bob@example.test');
    c = await launched(3);
  });
  afterAll(async () => {
    await db?.close();
  });

  // ── Who may do what ────────────────────────────────────────────────────────

  describe('privileges', () => {
    const WORKER_FUNCTIONS = [
      `sending_reap_claimed(15)`,
      `sending_reconcile_attempts(30, 'hold')`,
      `sending_hold_missed_campaigns(120)`,
      `sending_due_campaigns(120, 10)`,
      `sending_active_campaigns(10)`,
      `sending_promote_campaign('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'live')`,
      `sending_materialize_campaign('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')`,
      `sending_claim_jobs('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 10)`,
      `sending_record_accepted('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'x')`,
      `sending_resolve_uncertain('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'redispatch')`,
      `sending_record_unsubscribe('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')`,
      `sending_pause_workspace('00000000-0000-0000-0000-000000000000', 'x')`,
    ];

    it.each(WORKER_FUNCTIONS)('a signed-in user cannot call %s', async (call) => {
      const err = await db.asUser(alice.userId, async (as) => expectRejected(() => as.raw(`select * from ${call}`)));
      expect(err.message).toMatch(/permission denied/i);
    });

    it.each(WORKER_FUNCTIONS)('an anonymous caller cannot call %s', async (call) => {
      const err = await db.asAnon(async (as) => expectRejected(() => as.raw(`select * from ${call}`)));
      expect(err.message).toMatch(/permission denied/i);
    });

    it('every sending_* function is executable by service_role and nobody else', async () => {
      const rows = await db.raw<{ proname: string; auth: boolean; anon: boolean; svc: boolean }>(
        `select p.proname,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('service_role', p.oid, 'execute') as svc
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'sending\\_%'`,
      );
      expect(rows.rows.length).toBe(18);
      for (const row of rows.rows) {
        expect(row, row.proname).toMatchObject({ auth: false, anon: false, svc: true });
      }
    });

    it('a member reads their own delivery state, and nobody else’s', async () => {
      const own = await db.asUser(alice.userId, (as) =>
        as.raw(`select id from email_jobs where campaign_id = $1`, [c.campaignId]),
      );
      expect(own.rows).toHaveLength(3);

      const foreign = await db.asUser(bob.userId, (as) =>
        as.raw(`select id from email_jobs where campaign_id = $1`, [c.campaignId]),
      );
      expect(foreign.rows).toEqual([]);

      const counts = await db.asUser(bob.userId, (as) =>
        as.raw(`select * from campaign_delivery_counts($1, $2)`, [alice.workspaceId, c.campaignId]),
      );
      expect(counts.rows).toEqual([]);
    });

    it('a member cannot write delivery state at all', async () => {
      await db.asUser(alice.userId, async (as) => {
        for (const sql of [
          `update email_jobs set status = 'sent', provider_message_id = 'forged' where campaign_id = '${c.campaignId}'`,
          `insert into email_jobs (workspace_id, campaign_id, to_email) values ('${alice.workspaceId}', '${c.campaignId}', 'x@y.test')`,
          `delete from email_jobs where campaign_id = '${c.campaignId}'`,
          `update send_attempts set state = 'accepted'`,
          `select * from rate_ledger`,
        ]) {
          const err = await expectRejected(() => as.raw(sql));
          expect(err.message, sql).toMatch(/permission denied/i);
        }
      });
    });

    it('a member cannot rewrite a campaign’s launch stamp or counters', async () => {
      await db.asUser(alice.userId, async (as) => {
        for (const sql of [
          `update campaigns set execution_mode = 'live' where id = '${c.campaignId}'`,
          `update campaigns set n_sent = 0 where id = '${c.campaignId}'`,
          `update campaigns set status = 'sending' where id = '${c.campaignId}'`,
        ]) {
          const err = await expectRejected(() => as.raw(sql));
          expect(err.message, sql).toMatch(/permission denied/i);
        }
      });
    });

    it('the service role cannot delete delivery history', async () => {
      const err = await db.asServiceRole((as) =>
        expectRejected(() => as.raw(`delete from email_jobs where campaign_id = $1`, [c.campaignId])),
      );
      expect(err.message).toMatch(/permission denied/i);
    });

    it('a launched campaign cannot be deleted, even once cancelled', async () => {
      const campaign = await launched(1);
      await db.raw(`update campaigns set status = 'cancelled' where id = $1`, [campaign.campaignId]);
      const deleted = await db.asUser(alice.userId, (as) =>
        as.raw(`delete from campaigns where id = $1 returning id`, [campaign.campaignId]),
      );
      expect(deleted.rows).toEqual([]);
    });
  });

  // ── Idempotency, as constraints ────────────────────────────────────────────

  describe('idempotency constraints', () => {
    it('G1: a recipient cannot be added to a campaign twice', async () => {
      const [job] = await jobsFor(db, c.campaignId);
      const err = await expectRejected(() =>
        db.raw(
          `insert into email_jobs (workspace_id, campaign_id, contact_id, to_email)
           select workspace_id, campaign_id, contact_id, to_email || '.x' from email_jobs where id = $1`,
          [job!.id],
        ),
      );
      expect(err.message).toMatch(/uq_email_jobs_campaign_contact/);
    });

    it('G2: a job cannot have two accepted attempts', async () => {
      const campaign = await launched(1);
      const jobId = await claimOne(campaign);
      const [attempt] = await svc<{ attempt_id: string }>(`select * from sending_begin_attempt($1, $2, 'dry_run')`, [
        campaign.workspaceId,
        jobId,
      ]);
      await svc(`select sending_record_accepted($1, $2, 'm-1')`, [campaign.workspaceId, attempt!.attempt_id]);

      // Forge a second attempt directly, bypassing the job-state guard, and try
      // to accept it too.
      await db.exec(`set session_replication_role = replica`);
      try {
        await db.raw(
          `insert into send_attempts (workspace_id, job_id, attempt_no, mode) values ($1, $2, 2, 'dry_run')`,
          [campaign.workspaceId, jobId],
        );
      } finally {
        await db.exec(`set session_replication_role = origin`);
      }
      const err = await expectRejected(() =>
        db.raw(
          `update send_attempts set state = 'accepted', provider_message_id = 'm-2', resolved_at = now()
            where job_id = $1 and attempt_no = 2`,
          [jobId],
        ),
      );
      expect(err.message).toMatch(/uq_attempts_one_accepted/);
    });

    it('G3: a second attempt cannot open while one is in flight', async () => {
      const campaign = await launched(1);
      const jobId = await claimOne(campaign);
      await svc(`select * from sending_begin_attempt($1, $2, 'dry_run')`, [campaign.workspaceId, jobId]);

      const err = await expectRejected(() =>
        db.raw(`insert into send_attempts (workspace_id, job_id, attempt_no, mode) values ($1, $2, 2, 'dry_run')`, [
          campaign.workspaceId,
          jobId,
        ]),
      );
      expect(err.message).toMatch(/open or accepted attempt/);
    });

    it('ADR-0001 obligation 6: two workers beginning the same attempt get one row', async () => {
      const campaign = await launched(1);
      const jobId = await claimOne(campaign);
      const results = await Promise.allSettled([
        svc(`select * from sending_begin_attempt($1, $2, 'dry_run')`, [campaign.workspaceId, jobId]),
        svc(`select * from sending_begin_attempt($1, $2, 'dry_run')`, [campaign.workspaceId, jobId]),
      ]);
      const rows = await db.raw(`select 1 from send_attempts where job_id = $1`, [jobId]);
      expect(rows.rows).toHaveLength(1);
      expect(results.filter((r) => r.status === 'fulfilled' && r.value.length === 1)).toHaveLength(1);
    });

    it('an attempt cannot be made for a job that is not claimed', async () => {
      const campaign = await launched(1);
      const [job] = await jobsFor(db, campaign.campaignId);
      const rows = await svc(`select * from sending_begin_attempt($1, $2, 'dry_run')`, [campaign.workspaceId, job!.id]);
      expect(rows).toEqual([]);
    });

    it('two claims take disjoint jobs', async () => {
      const campaign = await launched(6);
      const [a, b] = await Promise.all([
        svc<{ id: string }>(`select id from sending_claim_jobs($1, $2, 3)`, [campaign.workspaceId, campaign.campaignId]),
        svc<{ id: string }>(`select id from sending_claim_jobs($1, $2, 3)`, [campaign.workspaceId, campaign.campaignId]),
      ]);
      const ids = [...a!, ...b!].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(6);
    });

    it('nothing is claimed for a campaign that is not sending', async () => {
      const campaign = await launched(2);
      await svc(`select sending_pause_campaign($1, $2, array['sending'], 'paused_by_user')`, [
        campaign.workspaceId,
        campaign.campaignId,
      ]);
      const rows = await svc(`select * from sending_claim_jobs($1, $2, 10)`, [campaign.workspaceId, campaign.campaignId]);
      expect(rows).toEqual([]);
    });

    it('the workspace argument is checked against the row, not trusted', async () => {
      const campaign = await launched(1);
      const rows = await svc(`select * from sending_claim_jobs($1, $2, 10)`, [bob.workspaceId, campaign.campaignId]);
      expect(rows).toEqual([]);
      expect(
        (await svc<{ ok: boolean | null }>(`select sending_record_unsubscribe($1, (select id from email_jobs where campaign_id = $2 limit 1)) as ok`, [
          bob.workspaceId,
          campaign.campaignId,
        ]))[0]?.ok,
      ).toBeNull();
    });

    it('a job cannot point at another workspace’s campaign', async () => {
      const err = await expectRejected(() =>
        db.raw(`insert into email_jobs (workspace_id, campaign_id, to_email) values ($1, $2, 'x@y.test')`, [
          bob.workspaceId,
          c.campaignId,
        ]),
      );
      expect(err.message).toMatch(/fk_email_jobs_campaign/);
    });
  });

  // ── The job state machine ──────────────────────────────────────────────────

  describe('job guards', () => {
    it('a job is born pending and unattempted', async () => {
      const err = await expectRejected(() =>
        db.raw(
          `insert into email_jobs (workspace_id, campaign_id, to_email, status) values ($1, $2, 'z@y.test', 'sent')`,
          [alice.workspaceId, c.campaignId],
        ),
      );
      expect(err.message).toMatch(/created pending/);
    });

    it('recipient and merge data are frozen', async () => {
      const [job] = await jobsFor(db, c.campaignId);
      for (const sql of [
        `update email_jobs set to_email = 'other@example.org' where id = $1`,
        `update email_jobs set merge_data = '{"first_name": "Mallory"}' where id = $1`,
      ]) {
        const err = await expectRejected(() => db.raw(sql, [job!.id]));
        expect(err.message).toMatch(/frozen/);
      }
    });

    it.each([
      ['pending', 'sent'],
      ['pending', 'failed'],
      ['pending', 'send_uncertain'],
    ])('refuses %s to %s', async (_from, to) => {
      const campaign = await launched(1);
      const [job] = await jobsFor(db, campaign.campaignId);
      const err = await expectRejected(() =>
        db.raw(`update email_jobs set status = $2::job_status, provider_message_id = 'x' where id = $1`, [job!.id, to]),
      );
      expect(err.message).toMatch(/not permitted/);
    });

    it('a sent job cannot go back to the queue', async () => {
      const campaign = await launched(1);
      const jobId = await claimOne(campaign);
      const [attempt] = await svc<{ attempt_id: string }>(`select * from sending_begin_attempt($1, $2, 'dry_run')`, [
        campaign.workspaceId,
        jobId,
      ]);
      await svc(`select sending_record_accepted($1, $2, 'm-x')`, [campaign.workspaceId, attempt!.attempt_id]);

      const err = await expectRejected(() => db.raw(`update email_jobs set status = 'pending' where id = $1`, [jobId]));
      expect(err.message).toMatch(/not permitted/);
      const idErr = await expectRejected(() =>
        db.raw(`update email_jobs set provider_message_id = 'other' where id = $1`, [jobId]),
      );
      expect(idErr.message).toMatch(/cannot be changed/);
    });

    it('G6: the attempt cap is a constraint', async () => {
      const [job] = await jobsFor(db, c.campaignId);
      const err = await expectRejected(() => db.raw(`update email_jobs set attempts = 6 where id = $1`, [job!.id]));
      expect(err.message).toMatch(/check constraint/);
    });

    it('a claim with an open attempt cannot be released, reaped or failed by a side door', async () => {
      const campaign = await launched(1);
      const jobId = await claimOne(campaign);
      await svc(`select * from sending_begin_attempt($1, $2, 'dry_run')`, [campaign.workspaceId, jobId]);

      for (const outcome of ['pending', 'failed', 'suppressed']) {
        const [row] = await svc<{ ok: boolean }>(`select sending_release_job($1, $2, $3, 'x') as ok`, [
          campaign.workspaceId,
          jobId,
          outcome,
        ]);
        expect(row?.ok, outcome).toBe(false);
      }
      await db.raw(`update email_jobs set claimed_at = now() - interval '1 hour' where id = $1`, [jobId]);
      const [reaped] = await svc<{ n: number }>(`select sending_reap_claimed(15) as n`);
      expect(reaped?.n).toBe(0);
    });

    it('an attempt’s identity is immutable', async () => {
      const campaign = await launched(1);
      const jobId = await claimOne(campaign);
      await svc(`select * from sending_begin_attempt($1, $2, 'dry_run')`, [campaign.workspaceId, jobId]);
      const err = await expectRejected(() => db.raw(`update send_attempts set mode = 'live' where job_id = $1`, [jobId]));
      expect(err.message).toMatch(/immutable/);
    });
  });

  // ── Materialisation, budgets, completion ───────────────────────────────────

  describe('materialisation', () => {
    it('excludes suppressed and inactive contacts, and counts what it created', async () => {
      const campaign = await seedLaunchableCampaign(db, alice.workspaceId, { recipients: 4 });
      await db.raw(
        `insert into suppressions (workspace_id, email_normalized, reason, source) values ($1, $2, 'complaint', 'test')`,
        [alice.workspaceId, campaign.emails[0]],
      );
      await db.raw(`update contacts set status = 'invalid' where id = $1`, [campaign.contactIds[1]]);

      await svc(`select sending_promote_campaign($1, $2, 'dry_run')`, [campaign.workspaceId, campaign.campaignId]);
      const [n] = await svc<{ n: number }>(`select sending_materialize_campaign($1, $2) as n`, [
        campaign.workspaceId,
        campaign.campaignId,
      ]);
      expect(n?.n).toBe(2);
      expect((await jobsFor(db, campaign.campaignId)).map((j) => j.to_email).sort()).toEqual(
        [campaign.emails[2], campaign.emails[3]].sort(),
      );
      expect(await campaignRow(db, campaign.campaignId)).toMatchObject({ status: 'sending', n_total: 2 });
    });

    it('will not promote a campaign that is not yet due', async () => {
      const campaign = await seedLaunchableCampaign(db, alice.workspaceId, { scheduledInMinutes: 60 });
      const [row] = await svc<{ ok: boolean }>(`select sending_promote_campaign($1, $2, 'dry_run') as ok`, [
        campaign.workspaceId,
        campaign.campaignId,
      ]);
      expect(row?.ok).toBe(false);
    });
  });

  describe('the send budget', () => {
    it('never grants more than the per-minute limit, however it is asked', async () => {
      const ws = bob.workspaceId;
      const grants = await Promise.all(
        [4, 4, 4, 4].map((n) => svc<{ g: number }>(`select sending_reserve_budget($1, 10, $2) as g`, [ws, n])),
      );
      const total = grants.reduce((sum, rows) => sum + (rows[0]?.g ?? 0), 0);
      expect(total).toBe(10);
      const [after] = await svc<{ g: number }>(`select sending_reserve_budget($1, 10, 5) as g`, [ws]);
      expect(after?.g).toBe(0);
    });
  });

  describe('completion', () => {
    it('does not complete while a job is pending, claimed or uncertain', async () => {
      const campaign = await launched(1);
      const [none] = await svc<{ s: string | null }>(`select sending_finish_campaign($1, $2) as s`, [
        campaign.workspaceId,
        campaign.campaignId,
      ]);
      expect(none?.s).toBeNull();
    });

    it('completes an emptied campaign, and says failed only when nothing was accepted', async () => {
      const campaign = await launched(1);
      const jobId = await claimOne(campaign);
      await svc(`select sending_release_job($1, $2, 'failed', 'render_failed')`, [campaign.workspaceId, jobId]);
      const [done] = await svc<{ s: string }>(`select sending_finish_campaign($1, $2) as s`, [
        campaign.workspaceId,
        campaign.campaignId,
      ]);
      expect(done?.s).toBe('failed');
      expect(await campaignRow(db, campaign.campaignId)).toMatchObject({ status: 'failed', n_failed: 1 });
    });
  });
});
