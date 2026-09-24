import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signWorkerRequest } from '@/lib/sending/worker-auth';
import { mintUnsubscribeToken } from '@/lib/unsubscribe/token';

/**
 * The two P5 route handlers, called directly.
 *
 * Everything behind them — the tick, the store, the database — is replaced with
 * spies, because what is under test is the handler's own contract: who gets
 * in, what a request can influence, and which verb does what.
 */

const SECRET = 'w'.repeat(40);
const UNSUB_KEY = 'u'.repeat(40);

const env = {
  WORKER_HMAC_SECRET: SECRET as string | undefined,
  UNSUBSCRIBE_SECRET_V1: UNSUB_KEY,
  NEXT_PUBLIC_APP_URL: 'https://mail.example.com',
};

vi.mock('@/lib/env', () => ({ serverEnv: () => env }));

const tick = vi.fn(async () => ({ mode: 'dry_run', sent: 0 }));
vi.mock('@/lib/sending/worker', () => ({ runSendTick: (...args: unknown[]) => tick(...(args as [])) }));
vi.mock('@/lib/sending/store', () => ({ sendingStore: () => ({}) }));
vi.mock('@/lib/sending/config', () => ({
  sendingConfig: () => ({ mode: 'dry_run', appUrl: 'https://mail.example.com', providerSafetyFactor: 0.8 }),
}));
vi.mock('@/lib/sending/provider', () => ({ outboundProviderFor: () => null }));
vi.mock('@/lib/sender/provider', () => ({ emailProvider: () => ({}), isProviderConfigured: () => false }));
vi.mock('@/lib/eligibility/readers', () => ({ serviceEligibilityReader: () => ({}) }));

const audits: unknown[] = [];
vi.mock('@/lib/audit', () => ({
  writeAuditLog: async (entry: unknown) => {
    audits.push(entry);
  },
}));

const rpc = vi.fn(async () => ({ data: true as boolean | null, error: null }));
vi.mock('@/lib/db/service', () => ({
  serviceForWorkspace: () => ({ rpc: (...args: unknown[]) => rpc(...(args as [])) }),
}));

const claims = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  campaignId: '22222222-2222-2222-2222-222222222222',
  jobId: '33333333-3333-3333-3333-333333333333',
};

beforeEach(() => {
  tick.mockClear();
  rpc.mockClear();
  audits.length = 0;
  env.WORKER_HMAC_SECRET = SECRET;
});

describe('POST /api/internal/worker/tick', () => {
  async function post(headers: Record<string, string>, body = '{}') {
    const { POST } = await import('@/app/api/internal/worker/tick/route');
    return POST(new Request('https://mail.example.com/api/internal/worker/tick', { method: 'POST', headers, body }));
  }

  const signed = (body = '{}', ts = String(Math.floor(Date.now() / 1000))) => ({
    'x-timestamp': ts,
    'x-signature': signWorkerRequest(SECRET, ts, body),
  });

  it('runs one tick for a correctly signed request and returns counts only', async () => {
    const response = await post(signed());
    expect(response.status).toBe(200);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ mode: 'dry_run', sent: 0 });
  });

  it.each([
    ['no headers', {}],
    ['a bad signature', { 'x-timestamp': String(Math.floor(Date.now() / 1000)), 'x-signature': 'v1=00' }],
    ['a stale timestamp', signed('{}', String(Math.floor(Date.now() / 1000) - 3600))],
  ])('refuses %s with a bare 401 and runs nothing', async (_name, headers) => {
    const response = await post(headers as Record<string, string>);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
    expect(tick).not.toHaveBeenCalled();
  });

  it('refuses a body that differs from what was signed', async () => {
    const response = await post(signed('{}'), '{"campaignId":"x"}');
    expect(response.status).toBe(401);
    expect(tick).not.toHaveBeenCalled();
  });

  it('refuses everything when no worker secret is configured', async () => {
    env.WORKER_HMAC_SECRET = undefined;
    const response = await post(signed());
    expect(response.status).toBe(401);
    expect(tick).not.toHaveBeenCalled();
  });

  it('a failing tick is a 500 with no detail', async () => {
    tick.mockRejectedValueOnce(new Error('database exploded: password=hunter2'));
    const response = await post(signed());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('hunter2');
  });
});

describe('/u/[token]', () => {
  const token = mintUnsubscribeToken(claims, { v1: UNSUB_KEY }, 'v1');
  const params = (value: string) => ({ params: Promise.resolve({ token: value }) });
  const request = (method: string, body?: string) =>
    new Request(`https://mail.example.com/u/${token}`, { method, ...(body === undefined ? {} : { body }) });

  it('GET shows a confirmation and suppresses nothing — link scanners fetch every URL', async () => {
    const { GET } = await import('@/app/u/[token]/route');
    const response = await GET(request('GET'), params(token));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<form method="post">/);
    expect(rpc).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it('one-click POST suppresses the address and answers 200', async () => {
    const { POST } = await import('@/app/u/[token]/route');
    const response = await POST(request('POST', 'List-Unsubscribe=One-Click'), params(token));
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('sending_record_unsubscribe', {
      p_workspace_id: claims.workspaceId,
      p_job_id: claims.jobId,
    });
    expect(audits).toHaveLength(1);
  });

  it('a repeated POST is still 200, and is not audited twice', async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    const { POST } = await import('@/app/u/[token]/route');
    const response = await POST(request('POST', 'List-Unsubscribe=One-Click'), params(token));
    expect(response.status).toBe(200);
    expect(audits).toEqual([]);
  });

  it.each(['GET', 'POST'] as const)('%s with a forged token is refused and touches nothing', async (method) => {
    const route = await import('@/app/u/[token]/route');
    const forged = mintUnsubscribeToken(claims, { v1: 'x'.repeat(40) }, 'v1');
    const response = await route[method](request(method), params(forged));
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never echoes the recipient or the campaign back', async () => {
    const { POST } = await import('@/app/u/[token]/route');
    const html = await (await POST(request('POST'), params(token))).text();
    expect(html).not.toContain(claims.jobId);
    expect(html).not.toContain(claims.campaignId);
    expect(html).not.toContain('@');
  });
});
