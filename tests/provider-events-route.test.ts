import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import {
  TEST_TOPIC_ARN,
  bounceEvent,
  complaintEvent,
  createTestSigner,
  deliveryEvent,
  notification,
  rejectEvent,
  sendEvent,
  signEnvelope,
  subscriptionConfirmation,
  type Envelope,
  type TestSigner,
} from './helpers/sns';

/**
 * POST /api/webhooks/ses, called directly (ADR-0005 §1.6).
 *
 * The real envelope parser, SNS verifier and SES parser run. Replaced with
 * spies: the certificate fetch (returns the test certificate), the confirmation
 * GET, and the database store — what is under test is who gets in, what a
 * request can influence, and which status comes back.
 */

const env = { AWS_SNS_TOPIC_ARN: TEST_TOPIC_ARN as string | undefined };
vi.mock('@/lib/env', () => ({ serverEnv: () => env }));

let signer: TestSigner;
const fetchCert = vi.fn(async (_url: string) => signer.certificatePem);
const confirm = vi.fn(async (_url: string) => true);
vi.mock('@/lib/provider-events/sns-fetch', () => ({
  fetchSigningCertificate: (url: string) => fetchCert(url),
  confirmSnsSubscription: (url: string) => confirm(url),
}));

const calls: Array<{ fn: string; input: Record<string, unknown> }> = [];
let failWith: Error | null = null;
let outcome: 'applied' | 'duplicate' | 'unmatched' = 'applied';
const record = (fn: string) => async (input: Record<string, unknown>) => {
  calls.push({ fn, input });
  if (failWith !== null) throw failWith;
  return fn === 'ignored' ? 'ignored' : outcome;
};
vi.mock('@/lib/provider-events/store', () => ({
  providerEventStore: () => ({
    recordBounce: record('bounce'),
    recordComplaint: record('complaint'),
    recordSend: record('send'),
    recordDelivery: record('delivery'),
    recordReject: record('reject'),
    recordIgnored: record('ignored'),
  }),
}));

const logs: unknown[] = [];
vi.mock('@/lib/observability/logger', () => ({
  logger: {
    info: (...args: unknown[]) => logs.push(args),
    warn: (...args: unknown[]) => logs.push(args),
    error: (...args: unknown[]) => logs.push(args),
    debug: () => undefined,
  },
}));

const WS = '11111111-1111-4111-8111-111111111111';
const JOB = '33333333-3333-4333-8333-333333333333';
const target = { messageId: '0102018f-test-message-000000', workspaceId: WS, jobId: JOB, recipients: ['victim@example.com'] };

beforeAll(() => {
  signer = createTestSigner();
});

beforeEach(() => {
  env.AWS_SNS_TOPIC_ARN = TEST_TOPIC_ARN;
  fetchCert.mockClear();
  fetchCert.mockImplementation(async () => signer.certificatePem);
  confirm.mockClear();
  confirm.mockImplementation(async () => true);
  calls.length = 0;
  logs.length = 0;
  failWith = null;
  outcome = 'applied';
});

async function post(body: string, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/webhooks/ses/route');
  return POST(new Request('https://mail.example.com/api/webhooks/ses', { method: 'POST', headers, body }));
}

const send = (envelope: Envelope, type = envelope['Type'] ?? 'Notification') =>
  post(JSON.stringify(envelope), { 'x-amz-sns-message-type': type, 'content-type': 'text/plain; charset=UTF-8' });

async function expectRefused(response: Response, status = 400) {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe('');
  expect(calls).toEqual([]);
  expect(confirm).not.toHaveBeenCalled();
}

describe('authentic notifications', () => {
  it('a signed bounce is handed to the store once, with canonical recipients, and answered 200 with no body', async () => {
    const envelope = notification(bounceEvent({ ...target, recipients: ['Victim@Example.COM'] }), signer);
    const response = await send(envelope);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(calls).toEqual([
      {
        fn: 'bounce',
        input: expect.objectContaining({
          snsMessageId: envelope['MessageId'],
          providerMessageId: target.messageId,
          workspaceId: WS,
          jobId: JOB,
          recipients: ['victim@example.com'],
          bounceType: 'Permanent',
        }),
      },
    ]);
  });

  it('a signed complaint goes to the complaint function', async () => {
    expect((await send(notification(complaintEvent(target), signer))).status).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(['complaint']);
  });

  it.each(['duplicate', 'unmatched'] as const)('a %s outcome is still 200, so SNS stops redelivering', async (result) => {
    outcome = result;
    expect((await send(notification(bounceEvent(target), signer))).status).toBe(200);
  });

  it('an unexpected event type is recorded as ignored, never acted on', async () => {
    for (const eventType of ['DeliveryDelay', 'Rendering Failure', 'Open', 'Click', 'BrandNewType']) {
      expect((await send(notification({ eventType, mail: { messageId: 'm-1' } }, signer))).status).toBe(200);
    }
    expect(calls.map((c) => c.fn)).toEqual(['ignored', 'ignored', 'ignored', 'ignored', 'ignored']);
  });

  it('Send, Delivery and Reject each reach their own store function with the attempt number (0017)', async () => {
    const tagged = { ...target, attemptNo: 1 };
    for (const event of [sendEvent(tagged), deliveryEvent(tagged), rejectEvent(tagged)]) {
      expect((await send(notification(event, signer))).status).toBe(200);
    }
    expect(calls.map((c) => c.fn)).toEqual(['send', 'delivery', 'reject']);
    for (const call of calls) expect(call.input).toMatchObject({ attemptNo: 1, workspaceId: WS });
  });

  it('a Send with no destination is malformed: 400, nothing recorded', async () => {
    const res = await send(notification({ eventType: 'Send', mail: { messageId: 'm-1' } }, signer));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('never logs a recipient address', async () => {
    await send(notification(bounceEvent(target), signer));
    await send(notification(bounceEvent(target), createTestSigner()));
    expect(JSON.stringify(logs)).not.toContain('victim@example.com');
  });
});

describe('forged, malformed and unauthorised requests write nothing', () => {
  it('an unauthorised direct POST (no SNS envelope) is refused', async () => {
    await expectRefused(await post(JSON.stringify({ email: 'victim@example.com', reason: 'complaint' })));
    await expectRefused(await post(''));
    await expectRefused(await post('not json', { 'x-amz-sns-message-type': 'Notification' }));
  });

  it('a raw SES event posted without SNS (raw message delivery, or an attacker) is refused', async () => {
    await expectRefused(await post(JSON.stringify(bounceEvent(target)), { 'x-amz-sns-message-type': 'Notification' }));
  });

  it("a notification signed with the attacker's own key is refused", async () => {
    const attacker = createTestSigner();
    await expectRefused(await send(notification(bounceEvent(target), attacker)));
  });

  it("a notification pointing at the attacker's certificate is refused without fetching it", async () => {
    const attacker = createTestSigner();
    const envelope = notification(bounceEvent(target), attacker, { SigningCertURL: 'https://sns.evil.com/cert.pem' });
    await expectRefused(await send(envelope));
    expect(fetchCert).not.toHaveBeenCalled();
  });

  it('a genuine envelope with a swapped Message (payload injection) is refused', async () => {
    const envelope = notification(bounceEvent(target), signer);
    const injected = { ...envelope, Message: JSON.stringify(complaintEvent({ ...target, recipients: ['ceo@example.com'] })) };
    await expectRefused(await send(injected));
  });

  it('SignatureVersion 1, the wrong topic, and a stale timestamp are refused', async () => {
    await expectRefused(await send(signEnvelope({ ...notification(bounceEvent(target), signer), SignatureVersion: '1' }, signer.privateKey)));
    await expectRefused(await send(notification(bounceEvent(target), signer, { TopicArn: 'arn:aws:sns:eu-west-1:999999999999:other' })));
    await expectRefused(
      await send(notification(bounceEvent(target), signer, { Timestamp: new Date(Date.now() - 2 * 3600_000).toISOString() })),
    );
  });

  it('a replay of a captured notification after the freshness window is refused', async () => {
    const captured = notification(bounceEvent(target), signer, { Timestamp: new Date(Date.now() - 61 * 60_000).toISOString() });
    await expectRefused(await send(captured));
  });

  it('with no topic configured, even a genuine notification is refused', async () => {
    env.AWS_SNS_TOPIC_ARN = undefined;
    await expectRefused(await send(notification(bounceEvent(target), signer)));
  });

  it('the message-type header must match the envelope', async () => {
    await expectRefused(await send(notification(bounceEvent(target), signer), 'SubscriptionConfirmation'));
  });

  it.each([
    ['a bounce with no message id', { ...bounceEvent(target), mail: { tags: {} } }],
    ['a bounce with no recipients', bounceEvent({ ...target, recipients: [] })],
    ['a complaint with no recipients', complaintEvent({ ...target, recipients: [] })],
    ['a bounce with an unknown bounce type', bounceEvent(target, { bounceType: 'Squishy' })],
    ['an event with no type', { mail: { messageId: 'm' } }],
    ['a Message that is not JSON', 'not json'],
  ])('a signed notification carrying %s is refused (400), not reported as processed', async (_name, message) => {
    await expectRefused(await send(notification(message, signer)));
  });

  it('an oversized body is refused (413) before it is parsed', async () => {
    const huge = 'x'.repeat(256 * 1024 + 1);
    await expectRefused(await post(huge, { 'x-amz-sns-message-type': 'Notification' }), 413);
    await expectRefused(await post('{}', { 'x-amz-sns-message-type': 'Notification', 'content-length': String(10 * 1024 * 1024) }), 413);
    expect(fetchCert).not.toHaveBeenCalled();
  });

  it('exports POST alone, so every other verb is answered 405 by Next.js', async () => {
    const route = await import('@/app/api/webhooks/ses/route');
    expect(Object.keys(route).filter((key) => /^[A-Z]+$/.test(key))).toEqual(['POST']);
  });
});

describe('retry semantics', () => {
  it('a database failure is a bare 500 so SNS retries; the error detail is not echoed', async () => {
    failWith = new Error('events_record_bounce failed: connection reset password=hunter2');
    const response = await send(notification(bounceEvent(target), signer));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
  });

  it('an unreachable signing certificate is 503 (retryable) and writes nothing', async () => {
    fetchCert.mockImplementation(async () => {
      throw new Error('timeout');
    });
    await expectRefused(await send(notification(bounceEvent(target), signer)), 503);
  });
});

describe('subscription handling', () => {
  it('a signed confirmation for the configured topic is confirmed through its validated URL', async () => {
    const envelope = subscriptionConfirmation(signer);
    expect((await send(envelope)).status).toBe(200);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/^https:\/\/sns\.eu-west-1\.amazonaws\.com\/\?Action=ConfirmSubscription&TopicArn=/);
    expect(calls).toEqual([]);
  });

  it('a confirmation whose SubscribeURL leaves SNS is refused and never visited', async () => {
    const envelope = subscriptionConfirmation(signer, {
      SubscribeURL: `https://attacker.example.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TEST_TOPIC_ARN)}&Token=${'a'.repeat(64)}`,
    });
    await expectRefused(await send(envelope));
  });

  it("a confirmation for someone else's topic, or signed by someone else, is refused", async () => {
    await expectRefused(await send(subscriptionConfirmation(signer, { TopicArn: 'arn:aws:sns:eu-west-1:999999999999:theirs' })));
    await expectRefused(await send(subscriptionConfirmation(createTestSigner())));
  });

  it('a failed confirmation is 503 so SNS can resend it', async () => {
    confirm.mockImplementation(async () => false);
    expect((await send(subscriptionConfirmation(signer))).status).toBe(503);
  });
});
