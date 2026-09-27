import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seedLaunchableCampaign, QA_POSTAL_ADDRESS } from './helpers/p5';
import { testSendingStore } from './helpers/sending-store';

/**
 * ARCHITECTURE §19.1: preflight runs at scheduling, at launch, and on resume.
 * Scheduling and launch are covered elsewhere (campaign-service, sending-worker
 * "launch-time preflight"). This file covers resume: `resumeSending` must judge
 * the campaign as it is NOW, over the real store and real migrations, and write
 * nothing when a blocker has appeared while it was paused.
 */

const access = { userId: '', workspaceId: '', role: 'admin' as const };
const config = { mode: 'dry_run' as 'dry_run' | 'disabled', unsubscribeConfigured: true };
const statusWrites: Array<Record<string, unknown>> = [];
let db: TestDb;

vi.mock('@/lib/auth/workspace', () => ({ requireWorkspace: vi.fn(async () => access) }));
vi.mock('@/lib/rate-limit', () => ({ enforceRateLimit: vi.fn(async () => {}) }));
vi.mock('@/lib/audit', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock('@/lib/sending/config', () => ({ sendingConfig: () => config }));
vi.mock('@/lib/sending/store', () => ({ sendingStore: () => testSendingStore(db) }));
// Records the compare-and-set instead of performing it through PostgREST.
vi.mock('@/lib/db/service', () => ({
  serviceForWorkspace: () => ({
    update: (_table: string, values: Record<string, unknown>) => {
      statusWrites.push(values);
      const chain = {
        eq: () => chain,
        select: () => chain,
        maybeSingle: async () => ({ data: { id: 'x' }, error: null }),
      };
      return chain;
    },
  }),
}));

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(() => {
  statusWrites.length = 0;
  config.mode = 'dry_run';
  config.unsubscribeConfigured = true;
});

/** A campaign that launched, sent, and was then paused — the only kind resume accepts. */
async function pausedAfterLaunch(): Promise<{ workspaceId: string; campaignId: string }> {
  const user = await db.createUser(`resume-${Math.random().toString(36).slice(2, 10)}@example.test`);
  const c = await seedLaunchableCampaign(db, user.workspaceId, { recipients: 2, scheduledInMinutes: -1 });
  await db.raw(
    `update campaigns set status = 'queued', launched_at = now(), execution_mode = 'dry_run' where id = $1`,
    [c.campaignId],
  );
  await db.raw(`update campaigns set status = 'sending' where id = $1`, [c.campaignId]);
  await db.raw(`update campaigns set status = 'paused', pause_reason = 'manual' where id = $1`, [c.campaignId]);
  access.userId = user.userId;
  access.workspaceId = user.workspaceId;
  return { workspaceId: user.workspaceId, campaignId: c.campaignId };
}

describe('resume re-runs preflight', () => {
  it('resumes a paused campaign whose preflight still passes', async () => {
    const { resumeSending } = await import('@/lib/sending/service');
    const c = await pausedAfterLaunch();
    await resumeSending(c.workspaceId, c.campaignId);
    expect(statusWrites).toEqual([{ status: 'sending' }]);
  });

  it('refuses, and writes nothing, when the footer address was removed while paused', async () => {
    const { resumeSending } = await import('@/lib/sending/service');
    const c = await pausedAfterLaunch();
    await db.raw(`update workspace_settings set postal_address = null where workspace_id = $1`, [c.workspaceId]);
    await expect(resumeSending(c.workspaceId, c.campaignId)).rejects.toThrow(/cannot resume yet/);
    expect(statusWrites).toEqual([]);
    await db.raw(`update workspace_settings set postal_address = $2 where workspace_id = $1`, [
      c.workspaceId,
      QA_POSTAL_ADDRESS,
    ]);
  });

  it('refuses when the unsubscribe mechanism is no longer available', async () => {
    const { resumeSending } = await import('@/lib/sending/service');
    const c = await pausedAfterLaunch();
    config.unsubscribeConfigured = false;
    await expect(resumeSending(c.workspaceId, c.campaignId)).rejects.toThrow(/cannot resume yet/);
    expect(statusWrites).toEqual([]);
  });

  it('refuses when the sender is no longer verified', async () => {
    const { resumeSending } = await import('@/lib/sending/service');
    const c = await pausedAfterLaunch();
    await db.raw(
      `update sender_domains set dkim_status = 'failed'
        where id = (select si.domain_id from campaigns ca join sender_identities si on si.id = ca.sender_identity_id
                     where ca.id = $1)`,
      [c.campaignId],
    );
    await expect(resumeSending(c.workspaceId, c.campaignId)).rejects.toThrow(/cannot resume yet/);
    expect(statusWrites).toEqual([]);
  });

  it('refuses outright while sending is disabled', async () => {
    const { resumeSending } = await import('@/lib/sending/service');
    const c = await pausedAfterLaunch();
    config.mode = 'disabled';
    await expect(resumeSending(c.workspaceId, c.campaignId)).rejects.toThrow(/disabled/);
    expect(statusWrites).toEqual([]);
  });
});
