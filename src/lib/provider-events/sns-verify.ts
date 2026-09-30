import { X509Certificate, createVerify } from 'node:crypto';
import { z } from 'zod';

/**
 * SNS message authentication — ARCHITECTURE §16.2, ADR-0005 §1.5.
 *
 * The webhook is a public URL. Without this, anyone who finds it can forge a
 * bounce or a complaint and poison the suppression list. Pure: the certificate
 * fetch is injected, so every rule here is testable with a generated key pair
 * and no network.
 *
 * A message is accepted only when all of these hold, checked cheapest first:
 *
 *   1. The envelope has the documented shape, and its `Type` agrees with the
 *      `x-amz-sns-message-type` header SNS sends.
 *   2. `TopicArn` equals the one configured topic. A correctly signed message
 *      from any other topic — including one an attacker owns — is refused.
 *   3. `SignatureVersion` is 2 (SHA256withRSA). Version 1 (SHA1) is refused.
 *   4. `SigningCertURL` is `https://sns.<region>.amazonaws.com/….pem`, in the
 *      topic's own region, with no credentials, port, query or fragment. This
 *      check is the whole security of the scheme: without it an attacker
 *      supplies their own certificate and signs anything. It also closes the
 *      SSRF vector — the endpoint can only ever be made to fetch from SNS.
 *   5. `Timestamp` is within the last hour (and not more than 5 minutes ahead).
 *      Older messages are refused as replays; the database's primary key on the
 *      MessageId makes a replay inside the window a no-op anyway.
 *   6. The certificate parses, is currently valid, and its RSA key verifies the
 *      signature over the canonical string SNS defines for the message type.
 */

export const SNS_MAX_BODY_BYTES = 256 * 1024;
export const SNS_MAX_AGE_MS = 60 * 60 * 1000;
export const SNS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const TOPIC_ARN = /^arn:aws:sns:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):([A-Za-z0-9_-]{1,256})$/;

const text = (max: number) => z.string().min(1).max(max);

const common = {
  MessageId: text(128),
  TopicArn: text(400),
  Message: z.string().max(SNS_MAX_BODY_BYTES),
  Timestamp: text(64),
  SignatureVersion: text(8),
  Signature: z.string().min(1).max(2048).regex(/^[A-Za-z0-9+/=]+$/),
  SigningCertURL: text(1024),
};

const notificationSchema = z.object({
  Type: z.literal('Notification'),
  ...common,
  Subject: z.string().max(512).optional(),
  UnsubscribeURL: z.string().max(1024).optional(),
});

const subscriptionSchema = z.object({
  Type: z.enum(['SubscriptionConfirmation', 'UnsubscribeConfirmation']),
  ...common,
  Token: text(2048),
  SubscribeURL: text(2048),
});

const envelopeSchema = z.discriminatedUnion('Type', [notificationSchema, subscriptionSchema]);

export type SnsEnvelope = z.infer<typeof envelopeSchema>;

export type SnsEnvelopeFailure = 'not_json' | 'malformed_envelope' | 'type_mismatch';

/**
 * Parses the SNS envelope, and nothing inside it. The SES event in `Message` is
 * not looked at until the signature over it has been verified.
 */
export function parseSnsEnvelope(
  body: string,
  messageTypeHeader: string | null,
): { ok: true; envelope: SnsEnvelope } | { ok: false; reason: SnsEnvelopeFailure } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'malformed_envelope' };
  if (messageTypeHeader !== parsed.data.Type) return { ok: false, reason: 'type_mismatch' };
  return { ok: true, envelope: parsed.data };
}

/** The region of a topic ARN, or null when it is not a standard SNS topic ARN. */
export function topicRegion(topicArn: string): string | null {
  return TOPIC_ARN.exec(topicArn)?.[1] ?? null;
}

/** `https://sns.<region>.amazonaws.com` for exactly that region, nothing else. */
function isSnsOrigin(url: URL, region: string): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname === `sns.${region}.amazonaws.com` &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  );
}

/** Rule 4. The only certificate URLs this application will ever fetch. */
export function isAllowedSigningCertUrl(value: string, topicArn: string): boolean {
  const region = topicRegion(topicArn);
  if (region === null) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return isSnsOrigin(url, region) && url.search === '' && /^\/[A-Za-z0-9._-]+\.pem$/.test(url.pathname);
}

/**
 * The confirmation URL of a `SubscriptionConfirmation`, if it is safe to visit:
 * SNS in the topic's region, the ConfirmSubscription action, for the configured
 * topic, with a token. Anything else is refused — auto-confirming an arbitrary
 * subscription would let an attacker attach their own topic.
 */
export function allowedSubscribeUrl(envelope: SnsEnvelope, topicArn: string): string | null {
  if (envelope.Type !== 'SubscriptionConfirmation') return null;
  const region = topicRegion(topicArn);
  if (region === null) return null;
  let url: URL;
  try {
    url = new URL(envelope.SubscribeURL);
  } catch {
    return null;
  }
  if (!isSnsOrigin(url, region) || url.pathname !== '/') return null;
  const params = url.searchParams;
  if (params.get('Action') !== 'ConfirmSubscription') return null;
  if (params.get('TopicArn') !== topicArn) return null;
  const token = params.get('Token');
  if (token === null || token.length === 0 || token !== envelope.Token) return null;
  return url.toString();
}

/** The string SNS signs, per message type. Never JSON.stringify the payload. */
export function canonicalString(envelope: SnsEnvelope): string {
  const pairs: Array<[string, string | undefined]> =
    envelope.Type === 'Notification'
      ? [
          ['Message', envelope.Message],
          ['MessageId', envelope.MessageId],
          ['Subject', envelope.Subject],
          ['Timestamp', envelope.Timestamp],
          ['TopicArn', envelope.TopicArn],
          ['Type', envelope.Type],
        ]
      : [
          ['Message', envelope.Message],
          ['MessageId', envelope.MessageId],
          ['SubscribeURL', envelope.SubscribeURL],
          ['Timestamp', envelope.Timestamp],
          ['Token', envelope.Token],
          ['TopicArn', envelope.TopicArn],
          ['Type', envelope.Type],
        ];
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([key, value]) => `${key}\n${value}\n`)
    .join('');
}

export type SnsVerifyFailure =
  | 'not_configured'
  | 'wrong_topic'
  | 'bad_signature_version'
  | 'bad_cert_url'
  | 'bad_timestamp'
  | 'stale'
  | 'cert_unavailable'
  | 'bad_certificate'
  | 'bad_signature';

export interface SnsVerifyOptions {
  /** The configured AWS_SNS_TOPIC_ARN. Undefined refuses everything. */
  topicArn: string | undefined;
  /** Returns the PEM at an already-validated URL. Throws when unreachable. */
  fetchCertificate: (url: string) => Promise<string>;
  nowMs?: number;
}

export async function verifySnsEnvelope(
  envelope: SnsEnvelope,
  options: SnsVerifyOptions,
): Promise<{ ok: true } | { ok: false; reason: SnsVerifyFailure }> {
  const { topicArn } = options;
  if (topicArn === undefined || topicRegion(topicArn) === null) return { ok: false, reason: 'not_configured' };
  if (envelope.TopicArn !== topicArn) return { ok: false, reason: 'wrong_topic' };
  if (envelope.SignatureVersion !== '2') return { ok: false, reason: 'bad_signature_version' };
  if (!isAllowedSigningCertUrl(envelope.SigningCertURL, topicArn)) return { ok: false, reason: 'bad_cert_url' };

  const sentAt = Date.parse(envelope.Timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(envelope.Timestamp) || Number.isNaN(sentAt)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const now = options.nowMs ?? Date.now();
  if (now - sentAt > SNS_MAX_AGE_MS || sentAt - now > SNS_MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'stale' };
  }

  let pem: string;
  try {
    pem = await options.fetchCertificate(envelope.SigningCertURL);
  } catch {
    return { ok: false, reason: 'cert_unavailable' };
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    return { ok: false, reason: 'bad_certificate' };
  }
  if (
    certificate.publicKey.asymmetricKeyType !== 'rsa' ||
    now < Date.parse(certificate.validFrom) ||
    now > Date.parse(certificate.validTo)
  ) {
    return { ok: false, reason: 'bad_certificate' };
  }

  let valid = false;
  try {
    valid = createVerify('RSA-SHA256')
      .update(canonicalString(envelope), 'utf8')
      .verify(certificate.publicKey, envelope.Signature, 'base64');
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
