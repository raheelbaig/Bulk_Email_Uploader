import { createSign, generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';

/**
 * SNS fixtures for P6. Fixtures only: no key, certificate or message here has
 * ever been near AWS, and nothing in this file performs network I/O.
 *
 * The signing certificate is a real X.509 certificate, self-signed at test time
 * with a freshly generated RSA key and encoded by the small DER writer below,
 * so the verifier's certificate parsing and validity checks run for real and no
 * private key is ever committed to the repository.
 */

export const TEST_REGION = 'eu-west-1';
export const TEST_TOPIC_ARN = `arn:aws:sns:${TEST_REGION}:123456789012:email-uploader-ses-events`;
export const TEST_CERT_URL = `https://sns.${TEST_REGION}.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem`;

// ── DER ──────────────────────────────────────────────────────────────────────

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const integer = (bytes: number[]) => tlv(0x02, Buffer.from((bytes[0] ?? 0) & 0x80 ? [0, ...bytes] : bytes));
const nullValue = () => Buffer.from([0x05, 0x00]);
const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, 'utf8'));
const bitString = (content: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), content]));

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let v = part >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const value =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(value, 'ascii'));
}

const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const sha256WithRsa = () => seq(oid('1.2.840.113549.1.1.11'), nullValue());

export interface TestSigner {
  privateKey: KeyObject;
  certificatePem: string;
}

/** A self-signed RSA certificate, valid from `notBefore` to `notAfter`. */
export function createTestSigner(
  options: { notBefore?: Date; notAfter?: Date; commonName?: string } = {},
): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const notBefore = options.notBefore ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const notAfter = options.notAfter ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const subject = name(options.commonName ?? 'sns.amazonaws.com');

  const tbs = seq(
    tlv(0xa0, integer([2])),
    integer([0x01, 0x23, 0x45, 0x67]),
    sha256WithRsa(),
    subject,
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = signBytes('sha256', tbs, privateKey);
  const der = seq(tbs, sha256WithRsa(), bitString(signature));
  const body = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return { privateKey, certificatePem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n` };
}

// ── SNS envelopes ────────────────────────────────────────────────────────────

export type Envelope = Record<string, string>;

/**
 * The SNS canonical string, written independently of the implementation under
 * test (lib/provider-events/sns-verify) from the AWS documentation, so a bug in
 * one is not silently mirrored by the other.
 */
function canonical(envelope: Envelope): string {
  const keys =
    envelope['Type'] === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  let out = '';
  for (const key of keys) {
    const value = envelope[key];
    if (value !== undefined) out += `${key}\n${value}\n`;
  }
  return out;
}

export function signEnvelope(envelope: Envelope, privateKey: KeyObject): Envelope {
  const signature = createSign('RSA-SHA256').update(canonical(envelope), 'utf8').sign(privateKey, 'base64');
  return { ...envelope, Signature: signature };
}

let counter = 0;
export function snsMessageId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export function notification(
  message: unknown,
  signer: TestSigner,
  overrides: Partial<Envelope> = {},
): Envelope {
  const unsigned: Envelope = {
    Type: 'Notification',
    MessageId: snsMessageId(),
    TopicArn: TEST_TOPIC_ARN,
    Message: typeof message === 'string' ? message : JSON.stringify(message),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    SigningCertURL: TEST_CERT_URL,
    UnsubscribeURL: `https://sns.${TEST_REGION}.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=x`,
    ...overrides,
  };
  return signEnvelope(unsigned, signer.privateKey);
}

export function subscriptionConfirmation(signer: TestSigner, overrides: Partial<Envelope> = {}): Envelope {
  const token = 'a'.repeat(64);
  const unsigned: Envelope = {
    Type: 'SubscriptionConfirmation',
    MessageId: snsMessageId(),
    Token: token,
    TopicArn: TEST_TOPIC_ARN,
    Message: 'You have chosen to subscribe to the topic.',
    SubscribeURL:
      `https://sns.${TEST_REGION}.amazonaws.com/?Action=ConfirmSubscription` +
      `&TopicArn=${encodeURIComponent(TEST_TOPIC_ARN)}&Token=${token}`,
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    SigningCertURL: TEST_CERT_URL,
    ...overrides,
  };
  return signEnvelope(unsigned, signer.privateKey);
}

// ── SES events (the JSON inside Message) ─────────────────────────────────────

export interface EventTarget {
  messageId: string;
  workspaceId?: string | null;
  jobId?: string | null;
  recipients: string[];
}

function mail(target: EventTarget) {
  const tags: Record<string, string[]> = { 'ses:configuration-set': ['app-primary'] };
  if (target.workspaceId !== null && target.workspaceId !== undefined) tags['workspace_id'] = [target.workspaceId];
  if (target.jobId !== null && target.jobId !== undefined) tags['job_id'] = [target.jobId];
  return {
    timestamp: new Date().toISOString(),
    source: 'news@send.example.com',
    messageId: target.messageId,
    destination: target.recipients,
    tags,
  };
}

export function bounceEvent(
  target: EventTarget,
  bounce: { bounceType?: string; bounceSubType?: string } = {},
): Record<string, unknown> {
  return {
    eventType: 'Bounce',
    bounce: {
      bounceType: bounce.bounceType ?? 'Permanent',
      bounceSubType: bounce.bounceSubType ?? 'General',
      bouncedRecipients: target.recipients.map((emailAddress) => ({
        emailAddress,
        action: 'failed',
        status: '5.1.1',
        diagnosticCode: `smtp; 550 5.1.1 <${emailAddress}>: user unknown`,
      })),
      timestamp: new Date().toISOString(),
      feedbackId: 'feedback-0001',
    },
    mail: mail(target),
  };
}

export function complaintEvent(target: EventTarget, feedbackType = 'abuse'): Record<string, unknown> {
  return {
    eventType: 'Complaint',
    complaint: {
      complainedRecipients: target.recipients.map((emailAddress) => ({ emailAddress })),
      complaintFeedbackType: feedbackType,
      timestamp: new Date().toISOString(),
      feedbackId: 'feedback-0002',
    },
    mail: mail(target),
  };
}
