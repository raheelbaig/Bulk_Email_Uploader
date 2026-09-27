import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seedContact, testEligibilityReader } from './helpers/p1';
import { campaignRow, jobsFor, seedLaunchableCampaign, type LaunchableCampaign } from './helpers/p5';
import { testSendingStore } from './helpers/sending-store';
import { runSendTick, type WorkerConfig } from '@/lib/sending/worker';
import { createDryRunProvider } from '@/lib/sending/provider/dry-run';
import type { OutboundMessage } from '@/lib/sending/provider/types';
import { mintUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/unsubscribe/token';
import { checkEligibility } from '@/lib/eligibility';

/**
 * Phase B of the second QA pass: the unsubscribe mechanism, end to end.
 *
 * A dry-run tick composes real messages with links minted by the production
 * signer (`lib/unsubscribe/server`), and those links are posted to the
 * production route handler (`app/u/[token]`), whose database call runs the real
 * `sending_record_unsubscribe` against the migrated database as the service
 * role. Only the environment (a key generated per run) and the audit writer are
 * stand-ins.
 */

const env = vi.hoisted(() => ({
  UNSUBSCRIBE_SECRET_V1: '',
  NEXT_PUBLIC_APP_URL: 'https://mail.example.com',
}));
vi.mock('@/lib/env', () => ({ serverEnv: () => env }));

const audits = vi.hoisted(() => [] as Array<{ action: string }>);
vi.mock('@/lib/audit', () => ({
  writeAuditLog: async (entry: { action: string }) => {
    audits.push(entry);
  },
}));

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/lib/db/service', () => ({
  serviceForWorkspace: () => ({
    rpc: async (fn: string, args: { p_workspace_id: string; p_job_id: string }) => {
      if (fn !== 'sending_record_unsubscribe') throw new Error(`unexpected rpc ${fn}`);
      const db = holder.db as TestDb;
      const res = await db.asServiceRole((svc) =>
        svc.raw<{ result: boolean | null }>(`select sending_record_unsubscribe($1, $2) as result`, [
          args.p_workspace_id,
          args.p_job_id,
        ]),
      );
      return { data: res.rows[0]?.result ?? null, error: null };
    },
  }),
}));

const CONFIG: WorkerConfig = {
  mode: 'dry_run',
  ratePerMinute: 1000,
  batchMax: 100,
  reaperTimeoutMinutes: 15,
  reconcileGraceMinutes: 30,
  uncertainPolicy: 'hold',
  scheduleGraceMinutes: 120,
  dailyCap: 100_000,
  contactCooldownMinutes: 0,
  unsubscribeConfigured: true,
  live: { allowed: false, unmet: ['mode_is_live'] },
};

describe('unsubscribe lifecycle', () => {
  let db: TestDb;
  let c: LaunchableCampaign;
  let messages: OutboundMessage[];
  let route: typeof import('@/app/u/[token]/route');
  let target: { email: string; url: string; token: string; jobId: string };

  beforeAll(async () => {
    env.UNSUBSCRIBE_SECRET_V1 = randomBytes(32).toString('hex');
    db = await createTestDb();
    holder.db = db;
    route = await import('@/app/u/[token]/route');
    const { unsubscribeUrlFor } = await import('@/lib/unsubscribe/server');

    const user = await db.createUser('unsub-owner@example.test');
    c = await seedLaunchableCampaign(db, user.workspaceId, { recipients: 3 });

    messages = [];
    await runSendTick({
      store: testSendingStore(db),
      config: CONFIG,
      providerFor: () => createDryRunProvider({ inspect: (m) => messages.push(m) }),
      eligibility: testEligibilityReader(db),
      unsubscribeUrl: (claims) => unsubscribeUrlFor(claims, env.NEXT_PUBLIC_APP_URL),
      providerBudget: async () => null,
      audit: async () => {},
      logger: { info() {}, warn() {}, error() {} },
    });

    const message = messages[0]!;
    const url = /^<(.+)>$/.exec(message.headers['List-Unsubscribe'] ?? '')![1]!;
    const token = url.split('/u/')[1]!;
    const job = (await jobsFor(db, c.campaignId)).find((j) => j.to_email === message.to)!;
    target = { email: message.to, url, token, jobId: job.id };
  });
  afterAll(async () => {
    await db?.close();
  });

  const post = (token: string, body = 'List-Unsubscribe=One-Click') =>
    route.POST(new Request(`https://mail.example.com/u/${token}`, { method: 'POST', body }), {
      params: Promise.resolve({ token }),
    });
  const get = (token: string) =>
    route.GET(new Request(`https://mail.example.com/u/${token}`), { params: Promise.resolve({ token }) });

  async function suppressionsFor(email: string) {
    const res = await db.raw<{ workspace_id: string; reason: string; source: string }>(
      `select workspace_id, reason::text as reason, source from suppressions where email_normalized = $1`,
      [email],
    );
    return res.rows;
  }

  it('every message carries the one-click header pair, a visible HTML link and a text link to the same URL', () => {
    expect(messages).toHaveLength(3);
    for (const m of messages) {
      const url = /^<(https:\/\/mail\.example\.com\/u\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)>$/.exec(
        m.headers['List-Unsubscribe'] ?? '',
      )?.[1];
      expect(url).toBeDefined();
      expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(m.html).toContain(`<a href="${url}">Unsubscribe</a>`);
      expect(m.text).toContain(`Unsubscribe: ${url}`);
    }
  });

  it('the token names exactly one job, carries no expiry, and verifies only with this deployment key', () => {
    const claims = verifyUnsubscribeToken(target.token, { v1: env.UNSUBSCRIBE_SECRET_V1 });
    expect(claims).toEqual({ workspaceId: c.workspaceId, campaignId: c.campaignId, jobId: target.jobId });
    const payload = Buffer.from(target.token.split('.')[0]!, 'base64url').toString('utf8');
    expect(payload.split('.')).toHaveLength(4); // version, workspace, campaign, job — no timestamp
    expect(verifyUnsubscribeToken(target.token, { v1: randomBytes(32).toString('hex') })).toBeNull();
  });

  it('GET changes nothing: a link scanner fetching the URL does not unsubscribe anyone', async () => {
    const response = await get(target.token);
    expect(response.status).toBe(200);
    expect(await suppressionsFor(target.email)).toEqual([]);
  });

  it('a tampered token is refused with 400 and writes nothing', async () => {
    const [payload, signature] = target.token.split('.') as [string, string];
    const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
    const otherPayload = Buffer.from(
      Buffer.from(payload, 'base64url').toString('utf8').replace(c.campaignId, '00000000-0000-0000-0000-000000000000'),
    ).toString('base64url');
    for (const bad of [`${payload}.${flipped}`, `${otherPayload}.${signature}`, 'garbage', 'a.b.c']) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(await suppressionsFor(target.email)).toEqual([]);
  });

  it('one-click POST suppresses the address, marks the contact, counts once, audits once', async () => {
    const response = await post(target.token);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(target.email);

    expect(await suppressionsFor(target.email)).toEqual([
      { workspace_id: c.workspaceId, reason: 'unsubscribe', source: 'unsubscribe_link' },
    ]);
    const contact = await db.raw<{ status: string }>(
      `select status from contacts where workspace_id = $1 and email_normalized = $2`,
      [c.workspaceId, target.email],
    );
    expect(contact.rows[0]?.status).toBe('suppressed');
    expect((await campaignRow(db, c.campaignId)).n_unsubscribed).toBe(1);
    expect(audits.filter((a) => a.action === 'suppression.unsubscribed')).toHaveLength(1);
  });

  it('replaying the same POST is harmless: still 200, still one suppression, counted and audited once', async () => {
    for (let i = 0; i < 3; i += 1) expect((await post(target.token)).status).toBe(200);
    expect(await suppressionsFor(target.email)).toHaveLength(1);
    expect((await campaignRow(db, c.campaignId)).n_unsubscribed).toBe(1);
    expect(audits.filter((a) => a.action === 'suppression.unsubscribed')).toHaveLength(1);
  });

  it('a validly signed token cannot reach across workspaces: the job must belong to the named workspace', async () => {
    const other = await db.createUser('unsub-other@example.test');
    const victimEmail = messages[1]!.to;
    const victimJob = (await jobsFor(db, c.campaignId)).find((j) => j.to_email === victimEmail)!;
    // Even a token signed with the real key, naming another workspace, finds no job.
    const crossed = mintUnsubscribeToken(
      { workspaceId: other.workspaceId, campaignId: c.campaignId, jobId: victimJob.id },
      { v1: env.UNSUBSCRIBE_SECRET_V1 },
      'v1',
    );
    expect((await post(crossed)).status).toBe(200); // the same answer as always — no oracle
    expect(await suppressionsFor(victimEmail)).toEqual([]);
  });

  it('an unsubscribe cannot be removed — not by the owner, not by the service role', async () => {
    const owner = await db.raw<{ user_id: string }>(
      `select user_id from workspace_members where workspace_id = $1 and role = 'owner'`,
      [c.workspaceId],
    );
    const removed = await db.asUser(owner.rows[0]!.user_id, (as) =>
      as.raw(`delete from suppressions where workspace_id = $1 and email_normalized = $2`, [c.workspaceId, target.email]),
    );
    expect(removed.affectedRows).toBe(0);

    const err = await db
      .asServiceRole((svc) => svc.raw(`delete from suppressions where email_normalized = $1`, [target.email]))
      .then(() => null)
      .catch((e: Error) => e);
    expect(err?.message).toMatch(/permission denied/i);
    expect(await suppressionsFor(target.email)).toHaveLength(1);
  });

  it('the address never becomes eligible again: deleted and re-created, it is still suppressed', async () => {
    await db.raw(`delete from contacts where workspace_id = $1 and email_normalized = $2`, [c.workspaceId, target.email]);
    await seedContact(db, c.workspaceId, target.email);
    const verdict = await checkEligibility(testEligibilityReader(db), {
      workspaceId: c.workspaceId,
      email: target.email.toUpperCase(),
    });
    expect(verdict).toMatchObject({ eligible: false, reason: 'suppressed' });
  });

  it('a later campaign to the same audience does not include it', async () => {
    const next = await seedLaunchableCampaign(db, c.workspaceId, { emails: ['fresh-person@recipient.example'] });
    // The unsubscribed person is on the new list too.
    await db.raw(
      `insert into list_members (workspace_id, list_id, contact_id)
       select workspace_id, $2, id from contacts where workspace_id = $1 and email_normalized = $3`,
      [c.workspaceId, next.listId, target.email],
    );
    await db.raw(`update campaigns set status = 'paused', pause_reason = 'test_parked' where id <> $1 and status = 'scheduled'`, [
      next.campaignId,
    ]);
    const sent: OutboundMessage[] = [];
    await runSendTick({
      store: testSendingStore(db),
      config: CONFIG,
      providerFor: () => createDryRunProvider({ inspect: (m) => sent.push(m) }),
      eligibility: testEligibilityReader(db),
      unsubscribeUrl: () => 'https://mail.example.com/u/x.y',
      providerBudget: async () => null,
      audit: async () => {},
      logger: { info() {}, warn() {}, error() {} },
    });
    expect(sent.map((m) => m.to)).toEqual(['fresh-person@recipient.example']);
    expect((await jobsFor(db, next.campaignId)).map((j) => j.to_email)).not.toContain(target.email);
  });
});
