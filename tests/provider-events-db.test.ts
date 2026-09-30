import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedContact, seedSuppression, testEligibilityReader } from './helpers/p1';
import { seedLaunchableCampaign, jobsFor } from './helpers/p5';
import { bounceEvent, complaintEvent, snsMessageId, type EventTarget } from './helpers/sns';
import { applyProviderEvent, type ProviderEventStore } from '@/lib/provider-events/apply';
import { parseSesEvent } from '@/lib/provider-events/parse';
import { checkEligibility } from '@/lib/eligibility';

/**
 * P6, the database half (migration 0016).
 *
 * Every event goes the production way: SES JSON → `parseSesEvent` →
 * `applyProviderEvent` → the `events_record_*` function, called as
 * `service_role` exactly as the production store calls it through PostgREST.
 *
 * Jobs reach "sent, live" only through the real P5 functions (promote,
 * materialise, claim, begin attempt, record accepted) with a made-up message
 * id. Nothing here talks to a network; no provider object exists in this file.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

function testStore(): ProviderEventStore {
  const call = async (sql: string, params: unknown[]) =>
    db.asServiceRole(async (as) => (await as.raw<{ outcome: string }>(sql, params)).rows[0]?.outcome);
  return {
    async recordBounce(i) {
      return (await call(
        `select events_record_bounce($1, $2, $3, $4, $5, $6, $7::text[], $8, $9) as outcome`,
        [i.snsMessageId, i.snsTimestamp, i.occurredAt, i.providerMessageId, i.workspaceId, i.jobId, i.recipients, i.bounceType, i.bounceSubType],
      )) as 'applied' | 'duplicate' | 'unmatched';
    },
    async recordComplaint(i) {
      return (await call(
        `select events_record_complaint($1, $2, $3, $4, $5, $6, $7::text[], $8) as outcome`,
        [i.snsMessageId, i.snsTimestamp, i.occurredAt, i.providerMessageId, i.workspaceId, i.jobId, i.recipients, i.feedbackType],
      )) as 'applied' | 'duplicate' | 'unmatched';
    },
    async recordIgnored(i) {
      return (await call(`select events_record_ignored($1, $2, $3, $4) as outcome`, [
        i.snsMessageId,
        i.snsTimestamp,
        i.eventType,
        i.providerMessageId,
      ])) as 'ignored' | 'duplicate';
    },
  };
}

/** The whole application path for one SES event JSON. */
async function deliver(event: unknown, snsId = snsMessageId()) {
  const parsed = parseSesEvent(JSON.stringify(event));
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.reason}`);
  return applyProviderEvent(testStore(), { snsMessageId: snsId, snsTimestamp: new Date().toISOString() }, parsed.event);
}

interface SentJob {
  workspaceId: string;
  campaignId: string;
  jobId: string;
  email: string;
  messageId: string;
  target: EventTarget;
}

let seq = 0;
/** A campaign launched in `mode`, every job accepted by the (imaginary) provider. */
async function sentCampaign(
  workspaceId: string,
  options: { emails?: string[]; mode?: 'live' | 'dry_run' } = {},
): Promise<SentJob[]> {
  const mode = options.mode ?? 'live';
  const c = await seedLaunchableCampaign(db, workspaceId, {
    approvedMode: mode,
    ...(options.emails === undefined ? { recipients: 2 } : { emails: options.emails }),
  });
  await db.asServiceRole(async (as) => {
    await as.raw(`select sending_promote_campaign($1, $2, $3)`, [workspaceId, c.campaignId, mode]);
    await as.raw(`select sending_materialize_campaign($1, $2)`, [workspaceId, c.campaignId]);
    const claimed = await as.raw<{ id: string; to_email: string }>(
      `select id, to_email from sending_claim_jobs($1, $2, 100, 0)`,
      [workspaceId, c.campaignId],
    );
    for (const job of claimed.rows) {
      const attempt = await as.raw<{ attempt_id: string }>(`select attempt_id from sending_begin_attempt($1, $2, $3)`, [
        workspaceId,
        job.id,
        mode,
      ]);
      seq += 1;
      await as.raw(`select sending_record_accepted($1, $2, $3)`, [
        workspaceId,
        attempt.rows[0]?.attempt_id,
        `0102018f${String(seq).padStart(8, '0')}-test-message-000000`,
      ]);
    }
  });
  const jobs = await jobsFor(db, c.campaignId);
  return jobs.map((j) => ({
    workspaceId,
    campaignId: c.campaignId,
    jobId: j.id,
    email: j.to_email,
    messageId: j.provider_message_id ?? '',
    target: { messageId: j.provider_message_id ?? '', workspaceId, jobId: j.id, recipients: [j.to_email] },
  }));
}

async function suppressionFor(workspaceId: string, email: string) {
  return (
    await db.raw<{ reason: string; source: string; campaign_id: string | null; detail: string | null }>(
      `select reason::text as reason, source, campaign_id, detail from suppressions where workspace_id = $1 and email_normalized = $2`,
      [workspaceId, email],
    )
  ).rows;
}

async function jobStatus(jobId: string): Promise<string | undefined> {
  return (await db.raw<{ status: string }>(`select status::text as status from email_jobs where id = $1`, [jobId])).rows[0]?.status;
}

async function counters(campaignId: string) {
  return (
    await db.raw<{ n_sent: number; n_bounced: number; n_complained: number }>(
      `select n_sent, n_bounced, n_complained from campaigns where id = $1`,
      [campaignId],
    )
  ).rows[0];
}

async function eventRow(snsId: string) {
  return (
    await db.raw<{
      outcome: string;
      event_type: string;
      workspace_id: string | null;
      job_id: string | null;
      suppression_action: string | null;
      detail: Record<string, unknown>;
    }>(`select outcome, event_type, workspace_id, job_id, suppression_action, detail from provider_events where sns_message_id = $1`, [snsId])
  ).rows;
}

async function auditFor(jobId: string) {
  return (
    await db.raw<{ action: string; actor_type: string; entity_type: string; metadata: Record<string, unknown> }>(
      `select action, actor_type, entity_type, metadata from audit_logs where entity_id = $1 order by created_at`,
      [jobId],
    )
  ).rows;
}

describe('bounces', () => {
  it('a permanent bounce suppresses the address, marks the job bounced, counts once and is audited', async () => {
    const { workspaceId } = await db.createUser('bounce-owner@example.test');
    const [job] = await sentCampaign(workspaceId);
    const snsId = snsMessageId();

    expect(await deliver(bounceEvent(job!.target), snsId)).toBe('applied');

    expect(await suppressionFor(workspaceId, job!.email)).toEqual([
      { reason: 'hard_bounce', source: 'ses_event', campaign_id: job!.campaignId, detail: 'ses bounce: Permanent/General' },
    ]);
    expect(await jobStatus(job!.jobId)).toBe('bounced');
    expect(await counters(job!.campaignId)).toMatchObject({ n_sent: 2, n_bounced: 1, n_complained: 0 });
    const contact = await db.raw<{ status: string }>(`select status from contacts where workspace_id = $1 and email_normalized = $2`, [
      workspaceId,
      job!.email,
    ]);
    expect(contact.rows[0]?.status).toBe('suppressed');

    const [row] = await eventRow(snsId);
    expect(row).toMatchObject({
      outcome: 'applied',
      event_type: 'bounce',
      workspace_id: workspaceId,
      job_id: job!.jobId,
      suppression_action: 'created',
      detail: { bounceType: 'Permanent', bounceSubType: 'General', recipientCount: 1 },
    });

    const audit = await auditFor(job!.jobId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'suppression.auto',
      actor_type: 'provider',
      entity_type: 'email_job',
      metadata: {
        provider: 'ses',
        eventType: 'bounce',
        snsMessageId: snsId,
        providerMessageId: job!.messageId,
        campaignId: job!.campaignId,
        suppressionAction: 'created',
        suppressionReason: 'hard_bounce',
        jobTransition: 'sent->bounced',
        bounceType: 'Permanent',
      },
    });
    // No address anywhere in the event ledger or the audit row.
    expect(JSON.stringify(row)).not.toContain(job!.email);
    expect(JSON.stringify(audit)).not.toContain(job!.email);
  });

  it("a bounce from SES's own suppression list is recorded as provider_suppressed", async () => {
    const { workspaceId } = await db.createUser('bounce-provider@example.test');
    const [job] = await sentCampaign(workspaceId);
    expect(await deliver(bounceEvent(job!.target, { bounceSubType: 'OnAccountSuppressionList' }))).toBe('applied');
    expect((await suppressionFor(workspaceId, job!.email))[0]?.reason).toBe('provider_suppressed');
    expect(await jobStatus(job!.jobId)).toBe('bounced');
  });

  it.each(['Transient', 'Undetermined'])('a %s bounce is recorded and audited, but suppresses nothing', async (bounceType) => {
    const { workspaceId } = await db.createUser(`bounce-${bounceType.toLowerCase()}@example.test`);
    const [job] = await sentCampaign(workspaceId);
    const snsId = snsMessageId();
    expect(await deliver(bounceEvent(job!.target, { bounceType, bounceSubType: 'MailboxFull' }), snsId)).toBe('applied');

    expect(await suppressionFor(workspaceId, job!.email)).toEqual([]);
    expect(await jobStatus(job!.jobId)).toBe('sent');
    expect(await counters(job!.campaignId)).toMatchObject({ n_bounced: 0 });
    expect((await eventRow(snsId))[0]).toMatchObject({ outcome: 'applied', suppression_action: 'none' });
    expect((await auditFor(job!.jobId))[0]).toMatchObject({
      action: 'provider_event.recorded',
      metadata: { suppressionAction: 'none', jobTransition: null, bounceType },
    });
    const eligibility = await checkEligibility(testEligibilityReader(db), { workspaceId, email: job!.email });
    expect(eligibility.eligible).toBe(true);
  });
});

describe('complaints', () => {
  it('a complaint suppresses the address, marks the job complained and counts once', async () => {
    const { workspaceId } = await db.createUser('complaint-owner@example.test');
    const [job] = await sentCampaign(workspaceId);
    const snsId = snsMessageId();
    expect(await deliver(complaintEvent(job!.target, 'abuse'), snsId)).toBe('applied');

    expect(await suppressionFor(workspaceId, job!.email)).toEqual([
      { reason: 'complaint', source: 'ses_event', campaign_id: job!.campaignId, detail: 'ses complaint: abuse' },
    ]);
    expect(await jobStatus(job!.jobId)).toBe('complained');
    expect(await counters(job!.campaignId)).toMatchObject({ n_complained: 1, n_bounced: 0 });
    expect((await auditFor(job!.jobId))[0]).toMatchObject({
      action: 'suppression.auto',
      metadata: { eventType: 'complaint', suppressionReason: 'complaint', feedbackType: 'abuse', jobTransition: 'sent->complained' },
    });
  });

  it('a complaint with no feedback type (or "not-spam") still suppresses — conservatively', async () => {
    const { workspaceId } = await db.createUser('complaint-nofeedback@example.test');
    const [a, b] = await sentCampaign(workspaceId);
    const noType = complaintEvent(a!.target) as { complaint: Record<string, unknown> };
    delete noType.complaint['complaintFeedbackType'];
    expect(await deliver(noType)).toBe('applied');
    expect(await deliver(complaintEvent(b!.target, 'not-spam'))).toBe('applied');
    expect((await suppressionFor(workspaceId, a!.email))[0]?.reason).toBe('complaint');
    expect((await suppressionFor(workspaceId, b!.email))[0]?.reason).toBe('complaint');
  });
});

describe('idempotency and ordering', () => {
  it('the same SNS message twice has one effect: one row, one suppression, one count, one audit', async () => {
    const { workspaceId } = await db.createUser('dup-owner@example.test');
    const [job] = await sentCampaign(workspaceId);
    const snsId = snsMessageId();

    expect(await deliver(bounceEvent(job!.target), snsId)).toBe('applied');
    expect(await deliver(bounceEvent(job!.target), snsId)).toBe('duplicate');
    // A replay long after the fact, even with a different body, is still the same message.
    expect(await deliver(complaintEvent(job!.target), snsId)).toBe('duplicate');

    expect(await eventRow(snsId)).toHaveLength(1);
    expect(await suppressionFor(workspaceId, job!.email)).toHaveLength(1);
    expect((await suppressionFor(workspaceId, job!.email))[0]?.reason).toBe('hard_bounce');
    expect(await counters(job!.campaignId)).toMatchObject({ n_bounced: 1, n_complained: 0 });
    expect(await auditFor(job!.jobId)).toHaveLength(1);
  });

  it('concurrent deliveries of one message: exactly one applies', async () => {
    // PGlite runs these on one connection, so they interleave rather than run
    // in parallel. In Postgres the second INSERT on the same primary key waits
    // for the first transaction, then conflicts — the same single outcome.
    const { workspaceId } = await db.createUser('concurrent-owner@example.test');
    const [job] = await sentCampaign(workspaceId);
    const snsId = snsMessageId();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => deliver(complaintEvent(job!.target), snsId)));
    expect(outcomes.filter((o) => o === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(5);
    expect(await counters(job!.campaignId)).toMatchObject({ n_complained: 1 });
    expect(await auditFor(job!.jobId)).toHaveLength(1);
  });

  it('different events for one recipient: transient then permanent suppresses once and counts once', async () => {
    const { workspaceId } = await db.createUser('multi-owner@example.test');
    const [job] = await sentCampaign(workspaceId);
    expect(await deliver(bounceEvent(job!.target, { bounceType: 'Transient', bounceSubType: 'MailboxFull' }))).toBe('applied');
    expect(await deliver(bounceEvent(job!.target))).toBe('applied');
    expect(await deliver(bounceEvent(job!.target))).toBe('applied');

    expect(await suppressionFor(workspaceId, job!.email)).toHaveLength(1);
    expect(await counters(job!.campaignId)).toMatchObject({ n_bounced: 1 });
    const events = await db.raw<{ n: number }>(`select count(*)::int as n from provider_events where job_id = $1`, [job!.jobId]);
    expect(events.rows[0]?.n).toBe(3);
    const actions = (await auditFor(job!.jobId)).map((a) => a.metadata['suppressionAction']);
    expect(actions).toEqual(['none', 'created', 'existing']);
  });

  it('bounce followed by complaint: the bounce suppression stands, the job ends complained, both counted', async () => {
    const { workspaceId } = await db.createUser('bounce-then-complaint@example.test');
    const [job] = await sentCampaign(workspaceId);
    expect(await deliver(bounceEvent(job!.target))).toBe('applied');
    expect(await deliver(complaintEvent(job!.target))).toBe('applied');

    expect(await suppressionFor(workspaceId, job!.email)).toMatchObject([{ reason: 'hard_bounce' }]);
    expect(await jobStatus(job!.jobId)).toBe('complained');
    expect(await counters(job!.campaignId)).toMatchObject({ n_bounced: 1, n_complained: 1 });
  });

  it('complaint followed by bounce: the complaint stands and the job never moves backwards', async () => {
    const { workspaceId } = await db.createUser('complaint-then-bounce@example.test');
    const [job] = await sentCampaign(workspaceId);
    expect(await deliver(complaintEvent(job!.target))).toBe('applied');
    expect(await deliver(bounceEvent(job!.target))).toBe('applied');

    expect(await suppressionFor(workspaceId, job!.email)).toMatchObject([{ reason: 'complaint' }]);
    expect(await jobStatus(job!.jobId)).toBe('complained');
    expect(await counters(job!.campaignId)).toMatchObject({ n_bounced: 0, n_complained: 1 });
  });
});

describe('matching: a forged or mis-tagged event suppresses nobody', () => {
  let a: SentJob;
  let b: SentJob;
  let dry: SentJob;
  let wsA: string;
  let wsB: string;

  beforeAll(async () => {
    wsA = (await db.createUser('match-a@example.test')).workspaceId;
    wsB = (await db.createUser('match-b@example.test')).workspaceId;
    [a] = (await sentCampaign(wsA, { emails: ['shared@example.com'] })) as [SentJob];
    [b] = (await sentCampaign(wsB, { emails: ['shared@example.com'] })) as [SentJob];
    [dry] = (await sentCampaign(wsA, { emails: ['dry@example.com'], mode: 'dry_run' })) as [SentJob];
  });

  async function expectNothingChanged(snsId: string, reason: string) {
    expect(await eventRow(snsId)).toEqual([
      expect.objectContaining({ outcome: 'unmatched', workspace_id: null, job_id: null, detail: expect.objectContaining({ unmatched: reason }) }),
    ]);
    for (const job of [a, b, dry]) {
      expect(await suppressionFor(job.workspaceId, job.email)).toEqual([]);
      expect(['sent']).toContain(await jobStatus(job.jobId));
    }
  }

  it.each([
    ['tags naming workspace B for a job in A', () => ({ ...a.target, workspaceId: b.workspaceId }), 'no_job'],
    ['a job id from another workspace', () => ({ ...a.target, jobId: b.jobId }), 'no_job'],
    ['the right job with another message id', () => ({ ...a.target, messageId: b.messageId }), 'no_job'],
    ['an unknown message id', () => ({ ...a.target, messageId: 'unknown-message-id' }), 'no_job'],
    ['no tags at all', () => ({ ...a.target, workspaceId: null, jobId: null }), 'no_tags'],
    ['a recipient that is not the job’s address', () => ({ ...a.target, recipients: ['someone-else@example.com'] }), 'recipient_mismatch'],
    ['an invalid recipient', () => ({ ...a.target, recipients: ['not an address'] }), 'recipient_mismatch'],
    ['a dry-run job (never reached SES)', () => dry.target, 'not_live'],
  ])('%s → unmatched, nothing else happens', async (_name, build, reason) => {
    for (const make of [bounceEvent, complaintEvent] as const) {
      const snsId = snsMessageId();
      expect(await deliver(make(build()), snsId)).toBe('unmatched');
      await expectNothingChanged(snsId, reason);
    }
  });

  it('the genuine event for A suppresses in A only', async () => {
    expect(await deliver(complaintEvent(a.target))).toBe('applied');
    expect(await suppressionFor(wsA, 'shared@example.com')).toHaveLength(1);
    expect(await suppressionFor(wsB, 'shared@example.com')).toEqual([]);
    expect(await jobStatus(b.jobId)).toBe('sent');
  });
});

describe('existing suppressions', () => {
  it('an existing unsubscribe is preserved exactly', async () => {
    const { workspaceId } = await db.createUser('existing-unsub@example.test');
    const [job] = await sentCampaign(workspaceId);
    await db.asServiceRole((as) => as.raw(`select sending_record_unsubscribe($1, $2)`, [workspaceId, job!.jobId]));
    const before = await suppressionFor(workspaceId, job!.email);
    expect(before).toMatchObject([{ reason: 'unsubscribe', source: 'unsubscribe_link' }]);

    const snsId = snsMessageId();
    expect(await deliver(complaintEvent(job!.target), snsId)).toBe('applied');
    expect(await suppressionFor(workspaceId, job!.email)).toEqual(before);
    expect((await eventRow(snsId))[0]?.suppression_action).toBe('existing');
    expect((await auditFor(job!.jobId)).at(-1)?.action).toBe('provider_event.recorded');
  });

  it('an existing hard bounce is preserved when a complaint arrives', async () => {
    const { workspaceId } = await db.createUser('existing-bounce@example.test');
    const [job] = await sentCampaign(workspaceId);
    await seedSuppression(db, workspaceId, job!.email, 'hard_bounce', 'import');
    expect(await deliver(complaintEvent(job!.target))).toBe('applied');
    expect(await suppressionFor(workspaceId, job!.email)).toMatchObject([{ reason: 'hard_bounce', source: 'import' }]);
  });

  it('a manual block stays a block, is strengthened to the complaint, and can no longer be lifted', async () => {
    const owner = await db.createUser('existing-manual@example.test');
    const [job] = await sentCampaign(owner.workspaceId);
    await seedSuppression(db, owner.workspaceId, job!.email, 'manually_blocked', 'manual');

    const snsId = snsMessageId();
    expect(await deliver(complaintEvent(job!.target), snsId)).toBe('applied');
    expect(await suppressionFor(owner.workspaceId, job!.email)).toMatchObject([
      { reason: 'complaint', source: 'ses_event', campaign_id: job!.campaignId },
    ]);
    expect((await eventRow(snsId))[0]?.suppression_action).toBe('strengthened');
    expect((await auditFor(job!.jobId)).at(-1)).toMatchObject({ action: 'suppression.auto', metadata: { suppressionAction: 'strengthened' } });

    // The owner's delete now matches no row (0005: complaints are irreversible).
    const deleted = await db.asUser(owner.userId, (as) =>
      as.raw(`delete from suppressions where workspace_id = $1 and email_normalized = $2`, [owner.workspaceId, job!.email]),
    );
    expect(deleted.affectedRows).toBe(0);
    expect(await suppressionFor(owner.workspaceId, job!.email)).toHaveLength(1);
  });

  it('a manual block on an unrelated address is untouched, and still removable by its owner', async () => {
    const owner = await db.createUser('manual-unrelated@example.test');
    const [job] = await sentCampaign(owner.workspaceId);
    await seedSuppression(db, owner.workspaceId, 'unrelated@example.com', 'manually_blocked', 'manual');
    await deliver(bounceEvent(job!.target));
    const deleted = await db.asUser(owner.userId, (as) =>
      as.raw(`delete from suppressions where workspace_id = $1 and email_normalized = 'unrelated@example.com'`, [owner.workspaceId]),
    );
    expect(deleted.affectedRows).toBe(1);
  });
});

describe('future sending', () => {
  it('a bounced address is ineligible, excluded from new campaigns, and its pending jobs elsewhere are cancelled', async () => {
    const { workspaceId } = await db.createUser('future-owner@example.test');
    const [job] = await sentCampaign(workspaceId, { emails: ['bounces@example.com', 'fine@example.com'] });

    // A second campaign to the same people, already materialised and pending.
    const second = await seedLaunchableCampaign(db, workspaceId, { emails: ['bounces2@example.com'], approvedMode: 'live' });
    const contactId = (
      await db.raw<{ id: string }>(`select id from contacts where workspace_id = $1 and email_normalized = 'bounces@example.com'`, [workspaceId])
    ).rows[0]!.id;
    await db.raw(`insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)`, [workspaceId, second.listId, contactId]);
    await db.asServiceRole(async (as) => {
      await as.raw(`select sending_promote_campaign($1, $2, 'live')`, [workspaceId, second.campaignId]);
      await as.raw(`select sending_materialize_campaign($1, $2)`, [workspaceId, second.campaignId]);
    });
    const pendingBefore = (await jobsFor(db, second.campaignId)).find((j) => j.to_email === 'bounces@example.com');
    expect(pendingBefore?.status).toBe('pending');

    // jobsFor orders by address, so the first job is bounces@.
    expect(job!.email).toBe('bounces@example.com');
    expect(await deliver(bounceEvent(job!.target))).toBe('applied');

    // 1. The eligibility authority says no.
    const verdict = await checkEligibility(testEligibilityReader(db), { workspaceId, email: 'Bounces@Example.com' });
    expect(verdict).toMatchObject({ eligible: false, reason: 'suppressed' });
    // 2. The pending job in the other campaign was moved out of the claimable set.
    const pendingAfter = (await jobsFor(db, second.campaignId)).find((j) => j.to_email === 'bounces@example.com');
    expect(pendingAfter?.status).toBe('suppressed');
    // 3. A campaign materialised from now on does not include the address.
    const third = await seedLaunchableCampaign(db, workspaceId, { emails: ['third@example.com'], approvedMode: 'dry_run' });
    await db.raw(`insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)`, [workspaceId, third.listId, contactId]);
    await db.asServiceRole(async (as) => {
      await as.raw(`select sending_promote_campaign($1, $2, 'dry_run')`, [workspaceId, third.campaignId]);
      await as.raw(`select sending_materialize_campaign($1, $2)`, [workspaceId, third.campaignId]);
    });
    expect((await jobsFor(db, third.campaignId)).map((j) => j.to_email)).toEqual(['third@example.com']);
    const counts = await db.raw<{ eligible: number; suppressed: number }>(
      `select eligible::int, suppressed::int from campaign_audience_counts($1, $2)`,
      [workspaceId, third.listId],
    );
    expect(counts.rows[0]).toMatchObject({ eligible: 1, suppressed: 1 });
  });
});

describe('failure and rollback', () => {
  it('a failure after the event row is written rolls everything back, and the retry then applies', async () => {
    const { workspaceId } = await db.createUser('rollback-owner@example.test');
    const [job] = await sentCampaign(workspaceId);
    const snsId = snsMessageId();

    // Make the last step of the transaction (the audit insert) fail.
    await db.exec(`
      create function pg_temp.fail_audit() returns trigger language plpgsql as $$
      begin raise exception 'simulated audit failure'; end $$;
      create trigger zz_fail_audit before insert on audit_logs
        for each row when (new.actor_type = 'provider') execute function pg_temp.fail_audit();
    `);
    try {
      await expect(deliver(complaintEvent(job!.target), snsId)).rejects.toThrow(/simulated audit failure/);
    } finally {
      await db.exec(`drop trigger zz_fail_audit on audit_logs;`);
    }

    expect(await eventRow(snsId)).toEqual([]);
    expect(await suppressionFor(workspaceId, job!.email)).toEqual([]);
    expect(await jobStatus(job!.jobId)).toBe('sent');
    expect(await counters(job!.campaignId)).toMatchObject({ n_complained: 0 });

    // SNS redelivers the same message: it is processed afresh, once.
    expect(await deliver(complaintEvent(job!.target), snsId)).toBe('applied');
    expect(await suppressionFor(workspaceId, job!.email)).toHaveLength(1);
    expect(await auditFor(job!.jobId)).toHaveLength(1);
  });

  it('malformed input to the functions raises and records nothing', async () => {
    const { workspaceId } = await db.createUser('malformed-owner@example.test');
    const [job] = await sentCampaign(workspaceId);
    for (const [type, subtype] of [
      ['Soft', 'General'],
      [null, 'General'],
      ['Permanent', "General'; drop table suppressions; --"],
    ] as const) {
      const snsId = snsMessageId();
      await expectRejected(() =>
        db.asServiceRole((as) =>
          as.raw(`select events_record_bounce($1, now(), now(), $2, $3, $4, array[$5]::text[], $6, $7)`, [
            snsId,
            job!.messageId,
            workspaceId,
            job!.jobId,
            job!.email,
            type,
            subtype,
          ]),
        ),
      );
      expect(await eventRow(snsId)).toEqual([]);
    }
    expect(await suppressionFor(workspaceId, job!.email)).toEqual([]);
  });

  it('other event types are recorded as ignored, once', async () => {
    const snsId = snsMessageId();
    const parsed = parseSesEvent(JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'delivered-1' } }));
    if (!parsed.ok) throw new Error('fixture');
    const note = { snsMessageId: snsId, snsTimestamp: new Date().toISOString() };
    expect(await applyProviderEvent(testStore(), note, parsed.event)).toBe('ignored');
    expect(await applyProviderEvent(testStore(), note, parsed.event)).toBe('duplicate');
    expect(await eventRow(snsId)).toMatchObject([{ outcome: 'ignored', event_type: 'delivery', workspace_id: null }]);
  });
});

describe('who can touch provider events and suppressions', () => {
  it('no client role can read or write provider_events, or call the event functions', async () => {
    const owner = await db.createUser('perm-owner@example.test');
    const [job] = await sentCampaign(owner.workspaceId);
    await deliver(complaintEvent(job!.target));

    for (const run of [
      <T>(fn: (as: TestDb) => Promise<T>) => db.asUser(owner.userId, fn),
      <T>(fn: (as: TestDb) => Promise<T>) => db.asAnon(fn),
    ]) {
      await expectRejected(() => run((as) => as.raw(`select * from provider_events`)));
      await expectRejected(() =>
        run((as) =>
          as.raw(`insert into provider_events (sns_message_id, event_type, sns_timestamp, outcome) values ('x', 'bounce', now(), 'ignored')`),
        ),
      );
      await expectRejected(() =>
        run((as) =>
          as.raw(`select events_record_complaint('forged', now(), now(), $1, $2, $3, array['a@example.com'], 'abuse')`, [
            job!.messageId,
            owner.workspaceId,
            job!.jobId,
          ]),
        ),
      );
      await expectRejected(() => run((as) => as.raw(`select events_record_ignored('forged', now(), 'bounce', null)`)));
      await expectRejected(() =>
        run((as) =>
          as.raw(`select app.strengthen_suppression($1, 'x@example.com', 'complaint', 's', null, null)`, [owner.workspaceId]),
        ),
      );
    }
  });

  it('a member reads the audit row for their workspace (RLS), and nobody reads another’s', async () => {
    const owner = await db.createUser('perm-audit@example.test');
    const other = await db.createUser('perm-audit-other@example.test');
    const [job] = await sentCampaign(owner.workspaceId);
    await deliver(bounceEvent(job!.target));
    const mine = await db.asUser(owner.userId, (as) =>
      as.raw(`select action from audit_logs where entity_id = $1`, [job!.jobId]),
    );
    expect(mine.rows).toEqual([{ action: 'suppression.auto' }]);
    const theirs = await db.asUser(other.userId, (as) =>
      as.raw(`select action from audit_logs where entity_id = $1`, [job!.jobId]),
    );
    expect(theirs.rows).toEqual([]);
  });

  it('the service role cannot delete events, and audit rows stay append-only', async () => {
    const owner = await db.createUser('perm-service@example.test');
    const [job] = await sentCampaign(owner.workspaceId);
    const snsId = snsMessageId();
    await deliver(bounceEvent(job!.target), snsId);
    await expectRejected(() => db.asServiceRole((as) => as.raw(`delete from provider_events where sns_message_id = $1`, [snsId])));
    await expectRejected(() => db.asServiceRole((as) => as.raw(`update audit_logs set action = 'x' where entity_id = $1`, [job!.jobId])));
    await expectRejected(() => db.raw(`delete from audit_logs where entity_id = $1`, [job!.jobId]));
  });

  it('no role can weaken a suppression or change its subject — not even the owner of the table', async () => {
    const owner = await db.createUser('perm-guard@example.test');
    await seedContact(db, owner.workspaceId, 'guarded@example.com');
    const id = await seedSuppression(db, owner.workspaceId, 'guarded@example.com', 'complaint', 'ses_event');

    for (const sql of [
      `update suppressions set reason = 'manually_blocked' where id = $1`,
      `update suppressions set reason = 'invalid' where id = $1`,
      `update suppressions set reason = 'hard_bounce' where id = $1`,
      `update suppressions set email_normalized = 'other@example.com' where id = $1`,
      `update suppressions set workspace_id = gen_random_uuid() where id = $1`,
    ]) {
      await expectRejected(() => db.raw(sql, [id]));
    }
    // authenticated has no UPDATE grant at all, and the service role none either.
    await expectRejected(() => db.asUser(owner.userId, (as) => as.raw(`update suppressions set detail = 'x' where id = $1`, [id])));
    await expectRejected(() => db.asServiceRole((as) => as.raw(`update suppressions set detail = 'x' where id = $1`, [id])));
    // The strengthening helper refuses a reversible target.
    await expectRejected(() =>
      db.asServiceRole((as) =>
        as.raw(`select app.strengthen_suppression($1, 'guarded@example.com', 'manually_blocked', 's', null, null)`, [owner.workspaceId]),
      ),
    );
    expect((await suppressionFor(owner.workspaceId, 'guarded@example.com'))[0]?.reason).toBe('complaint');
  });
});
