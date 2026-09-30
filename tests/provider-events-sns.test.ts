import { describe, it, expect, beforeAll } from 'vitest';
import {
  allowedSubscribeUrl,
  canonicalString,
  isAllowedSigningCertUrl,
  parseSnsEnvelope,
  verifySnsEnvelope,
  type SnsEnvelope,
} from '@/lib/provider-events/sns-verify';
import { parseSesEvent } from '@/lib/provider-events/parse';
import {
  TEST_CERT_URL,
  TEST_TOPIC_ARN,
  bounceEvent,
  complaintEvent,
  createTestSigner,
  notification,
  signEnvelope,
  subscriptionConfirmation,
  type Envelope,
  type TestSigner,
} from './helpers/sns';

/**
 * P6, the pure half: SNS authentication (ADR-0005 §1.6) and SES event parsing.
 * No database, no network — the certificate fetch is a function returning the
 * test certificate.
 */

let signer: TestSigner;
let attacker: TestSigner;

beforeAll(() => {
  signer = createTestSigner();
  attacker = createTestSigner();
});

const WS = '11111111-1111-4111-8111-111111111111';
const JOB = '33333333-3333-4333-8333-333333333333';
const target = { messageId: '0102018f00000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-000000', workspaceId: WS, jobId: JOB, recipients: ['person@example.com'] };

function envelopeOf(raw: Envelope): SnsEnvelope {
  const parsed = parseSnsEnvelope(JSON.stringify(raw), raw['Type'] ?? null);
  if (!parsed.ok) throw new Error(`fixture envelope did not parse: ${parsed.reason}`);
  return parsed.envelope;
}

async function verify(raw: Envelope, options: { topicArn?: string | undefined; certificate?: string; nowMs?: number } = {}) {
  const fetched: string[] = [];
  const verdict = await verifySnsEnvelope(envelopeOf(raw), {
    topicArn: 'topicArn' in options ? options.topicArn : TEST_TOPIC_ARN,
    fetchCertificate: async (url) => {
      fetched.push(url);
      return options.certificate ?? signer.certificatePem;
    },
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
  return { verdict, fetched };
}

describe('SNS envelope parsing', () => {
  it('accepts a well-formed notification whose type matches the header', () => {
    const raw = notification(bounceEvent(target), signer);
    expect(parseSnsEnvelope(JSON.stringify(raw), 'Notification').ok).toBe(true);
  });

  it.each([
    ['not JSON', 'hello', 'Notification', 'not_json'],
    ['an empty object', '{}', 'Notification', 'malformed_envelope'],
    ['an array', '[]', 'Notification', 'malformed_envelope'],
    ['an unknown Type', JSON.stringify({ Type: 'Surprise' }), 'Surprise', 'malformed_envelope'],
  ])('refuses %s', (_name, body, header, reason) => {
    expect(parseSnsEnvelope(body, header)).toEqual({ ok: false, reason });
  });

  it.each(['MessageId', 'TopicArn', 'Message', 'Timestamp', 'SignatureVersion', 'Signature', 'SigningCertURL'])(
    'refuses a notification without %s',
    (field) => {
      const raw = notification(bounceEvent(target), signer);
      delete raw[field];
      expect(parseSnsEnvelope(JSON.stringify(raw), 'Notification')).toEqual({ ok: false, reason: 'malformed_envelope' });
    },
  );

  it('refuses a body whose Type disagrees with (or lacks) the x-amz-sns-message-type header', () => {
    const raw = notification(bounceEvent(target), signer);
    expect(parseSnsEnvelope(JSON.stringify(raw), 'SubscriptionConfirmation')).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(parseSnsEnvelope(JSON.stringify(raw), null)).toEqual({ ok: false, reason: 'type_mismatch' });
  });

  it('refuses a signature that is not base64', () => {
    const raw = { ...notification(bounceEvent(target), signer), Signature: '<script>' };
    expect(parseSnsEnvelope(JSON.stringify(raw), 'Notification').ok).toBe(false);
  });
});

describe('SNS signature verification (ADR-0005 §1.6)', () => {
  it('a signature made with the certificate key verifies', async () => {
    const { verdict, fetched } = await verify(notification(bounceEvent(target), signer));
    expect(verdict).toEqual({ ok: true });
    expect(fetched).toEqual([TEST_CERT_URL]);
  });

  it('a subscription confirmation verifies over its own canonical fields', async () => {
    const { verdict } = await verify(subscriptionConfirmation(signer));
    expect(verdict).toEqual({ ok: true });
  });

  it('the canonical string follows the documented field order, omitting an absent Subject', () => {
    const raw = notification('m', signer, { MessageId: 'id-1', Timestamp: '2026-09-30T00:00:00.000Z' });
    expect(canonicalString(envelopeOf(raw))).toBe(
      `Message\nm\nMessageId\nid-1\nTimestamp\n2026-09-30T00:00:00.000Z\nTopicArn\n${TEST_TOPIC_ARN}\nType\nNotification\n`,
    );
  });

  it.each(['Message', 'MessageId', 'Timestamp', 'Subject'])('a tampered %s fails', async (field) => {
    const raw = notification(bounceEvent(target), signer, { Subject: 'original' });
    const tampered =
      field === 'Message'
        ? { ...raw, Message: JSON.stringify(bounceEvent({ ...target, recipients: ['victim@example.com'] })) }
        : field === 'Timestamp'
          ? { ...raw, Timestamp: new Date(Date.now() - 1000).toISOString() }
          : { ...raw, [field]: `${raw[field] ?? ''}x` };
    const { verdict } = await verify(tampered);
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it("a message signed with someone else's key fails (forged SNS request)", async () => {
    const { verdict } = await verify(notification(bounceEvent(target), attacker));
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('SignatureVersion 1 (SHA1) is refused before any certificate is fetched', async () => {
    const raw = signEnvelope({ ...notification(bounceEvent(target), signer), SignatureVersion: '1' }, signer.privateKey);
    const { verdict, fetched } = await verify(raw);
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature_version' });
    expect(fetched).toEqual([]);
  });

  it.each([
    ['http:', 'http://sns.eu-west-1.amazonaws.com/cert.pem'],
    ['sns.evil.com', 'https://sns.evil.com/cert.pem'],
    ['a look-alike suffix', 'https://sns.eu-west-1.amazonaws.com.evil.com/cert.pem'],
    ['a look-alike prefix', 'https://evil-sns.eu-west-1.amazonaws.com/cert.pem'],
    ['a non-.pem path', 'https://sns.eu-west-1.amazonaws.com/cert.txt'],
    ['another region than the topic', 'https://sns.us-east-1.amazonaws.com/cert.pem'],
    ['credentials in the URL', 'https://user:pw@sns.eu-west-1.amazonaws.com/cert.pem'],
    ['an explicit port', 'https://sns.eu-west-1.amazonaws.com:8443/cert.pem'],
    ['a query string', 'https://sns.eu-west-1.amazonaws.com/cert.pem?x=1'],
    ['a nested path', 'https://sns.eu-west-1.amazonaws.com/uploads/cert.pem'],
    ['not a URL', 'cert.pem'],
  ])('a certificate URL on %s is refused, and never fetched', async (_name, url) => {
    const raw = notification(bounceEvent(target), attacker, { SigningCertURL: url });
    const { verdict, fetched } = await verify(raw, { certificate: attacker.certificatePem });
    expect(verdict).toEqual({ ok: false, reason: 'bad_cert_url' });
    expect(fetched).toEqual([]);
  });

  it('only SNS certificate URLs in the topic region pass the URL check', () => {
    expect(isAllowedSigningCertUrl(TEST_CERT_URL, TEST_TOPIC_ARN)).toBe(true);
    expect(isAllowedSigningCertUrl(TEST_CERT_URL, 'not-an-arn')).toBe(false);
  });

  it('a correctly signed message from another topic is refused', async () => {
    const raw = notification(bounceEvent(target), signer, { TopicArn: 'arn:aws:sns:eu-west-1:999999999999:attacker-topic' });
    const { verdict, fetched } = await verify(raw);
    expect(verdict).toEqual({ ok: false, reason: 'wrong_topic' });
    expect(fetched).toEqual([]);
  });

  it('with no topic configured, everything is refused', async () => {
    const { verdict } = await verify(notification(bounceEvent(target), signer), { topicArn: undefined });
    expect(verdict).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('a message older than an hour is refused as a replay; one far in the future too', async () => {
    const old = notification(bounceEvent(target), signer, { Timestamp: new Date(Date.now() - 61 * 60 * 1000).toISOString() });
    expect((await verify(old)).verdict).toEqual({ ok: false, reason: 'stale' });
    const future = notification(bounceEvent(target), signer, { Timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    expect((await verify(future)).verdict).toEqual({ ok: false, reason: 'stale' });
    const garbage = notification(bounceEvent(target), signer, { Timestamp: 'yesterday' });
    expect((await verify(garbage)).verdict).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('an unreachable certificate is reported as such (retryable), not as forged', async () => {
    const verdict = await verifySnsEnvelope(envelopeOf(notification(bounceEvent(target), signer)), {
      topicArn: TEST_TOPIC_ARN,
      fetchCertificate: async () => {
        throw new Error('network down');
      },
    });
    expect(verdict).toEqual({ ok: false, reason: 'cert_unavailable' });
  });

  it('a certificate that is not a certificate, or is expired or not yet valid, is refused', async () => {
    const raw = notification(bounceEvent(target), signer);
    expect((await verify(raw, { certificate: 'not a pem' })).verdict).toEqual({ ok: false, reason: 'bad_certificate' });

    const expired = createTestSigner({ notBefore: new Date(Date.now() - 2e9), notAfter: new Date(Date.now() - 1e9) });
    const withExpired = notification(bounceEvent(target), expired);
    expect((await verify(withExpired, { certificate: expired.certificatePem })).verdict).toEqual({
      ok: false,
      reason: 'bad_certificate',
    });
  });
});

describe('subscription confirmation URL', () => {
  it('accepts only ConfirmSubscription on SNS in the topic region, for this topic and token', () => {
    const good = envelopeOf(subscriptionConfirmation(signer));
    expect(allowedSubscribeUrl(good, TEST_TOPIC_ARN)).toMatch(/^https:\/\/sns\.eu-west-1\.amazonaws\.com\/\?Action=ConfirmSubscription/);

    const bad = (SubscribeURL: string) =>
      allowedSubscribeUrl(envelopeOf(subscriptionConfirmation(signer, { SubscribeURL })), TEST_TOPIC_ARN);
    const token = 'a'.repeat(64);
    const arn = encodeURIComponent(TEST_TOPIC_ARN);
    expect(bad(`https://evil.example.com/?Action=ConfirmSubscription&TopicArn=${arn}&Token=${token}`)).toBeNull();
    expect(bad(`https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${arn}&Token=${token}`)).toBeNull();
    expect(bad(`http://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${arn}&Token=${token}`)).toBeNull();
    expect(bad(`https://sns.eu-west-1.amazonaws.com/?Action=Subscribe&TopicArn=${arn}&Token=${token}`)).toBeNull();
    expect(bad(`https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=other&Token=${token}`)).toBeNull();
    expect(bad(`https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${arn}&Token=other`)).toBeNull();
    expect(allowedSubscribeUrl(envelopeOf(notification('x', signer)), TEST_TOPIC_ARN)).toBeNull();
  });
});

describe('SES event parsing', () => {
  it('a permanent bounce keeps its message id, tags, subtype and canonical recipients', () => {
    const parsed = parseSesEvent(
      JSON.stringify(bounceEvent({ ...target, recipients: ['  Person@EXAMPLE.com ', '"Other" <Other@Example.com>'] })),
    );
    expect(parsed).toMatchObject({
      ok: true,
      event: {
        kind: 'bounce',
        messageId: target.messageId,
        workspaceId: WS,
        jobId: JOB,
        bounceType: 'Permanent',
        bounceSubType: 'General',
        recipients: ['person@example.com', 'other@example.com'],
      },
    });
  });

  it('a complaint keeps its feedback type', () => {
    expect(parseSesEvent(JSON.stringify(complaintEvent(target, 'abuse')))).toMatchObject({
      ok: true,
      event: { kind: 'complaint', feedbackType: 'abuse', recipients: ['person@example.com'] },
    });
  });

  it('identity-notification format (notificationType) is understood too', () => {
    const event = { ...bounceEvent(target), notificationType: 'Bounce' } as Record<string, unknown>;
    delete event['eventType'];
    expect(parseSesEvent(JSON.stringify(event))).toMatchObject({ ok: true, event: { kind: 'bounce' } });
  });

  it.each([
    ['Delivery', 'delivery'],
    ['Send', 'send'],
    ['Reject', 'reject'],
    ['DeliveryDelay', 'delivery_delay'],
    ['Rendering Failure', 'rendering_failure'],
    ['Open', 'open'],
    ['SomethingNew', 'other'],
  ])('%s is recorded as ignored (%s), never acted on', (eventType, kind) => {
    expect(parseSesEvent(JSON.stringify({ eventType, mail: { messageId: 'abc-1' } }))).toEqual({
      ok: true,
      event: { kind: 'ignored', eventType: kind, messageId: 'abc-1' },
    });
  });

  it('an invalid recipient address is dropped rather than guessed at', () => {
    const parsed = parseSesEvent(JSON.stringify(bounceEvent({ ...target, recipients: ['not an address', 'x@y'] })));
    expect(parsed).toMatchObject({ ok: true, event: { kind: 'bounce', recipients: [] } });
  });

  it('tags that are not UUIDs are discarded (payload injection)', () => {
    const parsed = parseSesEvent(
      JSON.stringify(bounceEvent({ ...target, workspaceId: "' or 1=1 --", jobId: '../../etc/passwd' })),
    );
    expect(parsed).toMatchObject({ ok: true, event: { workspaceId: null, jobId: null } });
  });

  it.each([
    ['not JSON', '{nope', 'not_json'],
    ['no event type', JSON.stringify({ mail: { messageId: 'a' } }), 'malformed_event'],
    ['a bounce without a message id', JSON.stringify({ ...bounceEvent(target), mail: { tags: {} } }), 'missing_message_id'],
    ['a bounce with a malformed message id', JSON.stringify({ ...bounceEvent(target), mail: { messageId: 'a b\n' } }), 'missing_message_id'],
    ['a bounce without recipients', JSON.stringify(bounceEvent({ ...target, recipients: [] })), 'malformed_bounce'],
    ['a bounce with an unknown type', JSON.stringify(bounceEvent(target, { bounceType: 'Soft' })), 'malformed_bounce'],
    ['a bounce with no bounce object', JSON.stringify({ eventType: 'Bounce', mail: { messageId: 'a' } }), 'malformed_bounce'],
    ['a complaint without recipients', JSON.stringify(complaintEvent({ ...target, recipients: [] })), 'malformed_complaint'],
    [
      'a complaint with an injected feedback type',
      JSON.stringify(complaintEvent(target, "abuse'; drop table suppressions; --")),
      'malformed_complaint',
    ],
  ])('refuses %s', (_name, message, reason) => {
    expect(parseSesEvent(message)).toEqual({ ok: false, reason });
  });

  it('refuses more than 100 recipients rather than truncating', () => {
    const many = Array.from({ length: 101 }, (_, i) => `r${i}@example.com`);
    expect(parseSesEvent(JSON.stringify(bounceEvent({ ...target, recipients: many })))).toEqual({
      ok: false,
      reason: 'malformed_bounce',
    });
  });
});
