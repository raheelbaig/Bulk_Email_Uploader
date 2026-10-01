import { z } from 'zod';
import { normalizeEmail } from '@/lib/email/normalize';

/**
 * The SES event inside a verified SNS notification — ADR-0005 §1.5, ADR-0006.
 *
 * Runs only after the SNS signature has been verified, but still trusts
 * nothing: every field it keeps is shape-checked, and the ones that reach the
 * database are bounded. What it keeps:
 *
 *   - the event type — Bounce, Complaint, Send, Delivery and Reject are acted
 *     on; every other type, known or not, is recorded as `ignored`;
 *   - `mail.messageId`, the id SendEmail returned and the job stored;
 *   - the `workspace_id` / `job_id` / `attempt_no` tags the worker attached —
 *     used only as a lookup key, which the database then cross-checks (0016 E2,
 *     0017 E6);
 *   - recipients, through the application's one normalizer, so an event about
 *     `Person@Example.COM` matches a job for `person@example.com` exactly as
 *     every other boundary does. An address the normalizer rejects is dropped;
 *     if none survive, the event cannot name its recipient and is recorded as
 *     unmatched rather than guessed at.
 *
 * An acted-on event missing its message id, or the part of the event that
 * names its recipients, is malformed and refused, never recorded as success.
 */

export type ProviderEventType =
  | 'bounce'
  | 'complaint'
  | 'delivery'
  | 'send'
  | 'reject'
  | 'delivery_delay'
  | 'rendering_failure'
  | 'open'
  | 'click'
  | 'subscription'
  | 'other';

const SES_EVENT_TYPES: Record<string, ProviderEventType> = {
  Bounce: 'bounce',
  Complaint: 'complaint',
  Delivery: 'delivery',
  Send: 'send',
  Reject: 'reject',
  DeliveryDelay: 'delivery_delay',
  'Rendering Failure': 'rendering_failure',
  RenderingFailure: 'rendering_failure',
  Open: 'open',
  Click: 'click',
  Subscription: 'subscription',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** SES message ids are printable tokens: letters, digits, dashes, dots, @. */
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._@+=-]{0,255}$/;
/** email_jobs.attempts is 0–5 and an attempt is numbered 1–5 (0010). */
const ATTEMPT_NO = /^[1-5]$/;
/** Reject reasons are short English phrases ("Bad content"). Anything else is dropped. */
const REJECT_REASON = /^[A-Za-z0-9 ._-]{1,60}$/;
const MAX_RECIPIENTS = 100;

const messageId = z.string().regex(MESSAGE_ID);
const recipient = z.object({ emailAddress: z.string().min(1).max(320) });
const address = z.string().min(1).max(320);

const mailSchema = z.object({
  messageId,
  // Read leniently: only Send and Reject use it, and only as information.
  timestamp: z.unknown().optional(),
  tags: z.record(z.string().max(256), z.array(z.string().max(256)).max(10)).optional(),
});
// Parsed apart from `mail`: only Send and Reject need it, and an odd destination
// list must not make a bounce or complaint unreadable.
const destinationSchema = z.array(address).min(1).max(MAX_RECIPIENTS);

const bounceSchema = z.object({
  bounceType: z.enum(['Permanent', 'Transient', 'Undetermined']),
  bounceSubType: z.string().regex(/^[A-Za-z]{1,40}$/).optional(),
  bouncedRecipients: z.array(recipient).min(1).max(MAX_RECIPIENTS),
  timestamp: z.string().max(64).optional(),
});

const complaintSchema = z.object({
  complainedRecipients: z.array(recipient).min(1).max(MAX_RECIPIENTS),
  complaintFeedbackType: z.string().regex(/^[A-Za-z0-9-]{1,40}$/).optional(),
  timestamp: z.string().max(64).optional(),
});

const deliverySchema = z.object({
  recipients: z.array(address).min(1).max(MAX_RECIPIENTS),
  timestamp: z.string().max(64).optional(),
});

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

const envelopeSchema = z.object({
  // Configuration-set event publishing says `eventType`; identity feedback
  // notifications say `notificationType`. Either names the same types.
  eventType: z.string().max(64).optional(),
  notificationType: z.string().max(64).optional(),
  mail: z.unknown().optional(),
  bounce: z.unknown().optional(),
  complaint: z.unknown().optional(),
  delivery: z.unknown().optional(),
  reject: z.unknown().optional(),
});

interface Correlation {
  messageId: string;
  /** From the message tags; a lookup key only, never trusted on its own. */
  workspaceId: string | null;
  jobId: string | null;
  /** Which attempt of the job SES is talking about (ADR-0001 §3.2). */
  attemptNo: number | null;
  /** Canonical, de-duplicated. Possibly empty. */
  recipients: string[];
  /** ISO timestamp of the event itself, when SES gave a valid one. */
  occurredAt: string | null;
}

export type ParsedSesEvent =
  | ({ kind: 'bounce'; bounceType: 'Permanent' | 'Transient' | 'Undetermined'; bounceSubType: string | null } & Correlation)
  | ({ kind: 'complaint'; feedbackType: string | null } & Correlation)
  | ({ kind: 'send' } & Correlation)
  | ({ kind: 'delivery' } & Correlation)
  | ({ kind: 'reject'; reason: string | null } & Correlation)
  | { kind: 'ignored'; eventType: ProviderEventType; messageId: string | null };

export type SesParseFailure =
  | 'not_json'
  | 'malformed_event'
  | 'missing_message_id'
  | 'malformed_bounce'
  | 'malformed_complaint'
  | 'malformed_delivery'
  | 'malformed_mail';

type Tags = Record<string, string[]> | undefined;

function tag(tags: Tags, name: string): string | null {
  const value = tags?.[name]?.[0];
  return value !== undefined && UUID.test(value) ? value.toLowerCase() : null;
}

function attemptTag(tags: Tags): number | null {
  const value = tags?.['attempt_no']?.[0];
  return value !== undefined && ATTEMPT_NO.test(value) ? Number(value) : null;
}

function isoOrNull(value: string | undefined): string | null {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** `a@b.com`, or the address inside `Name <a@b.com>`. */
function canonicalRecipients(list: readonly string[]): string[] {
  const out = new Set<string>();
  for (const emailAddress of list) {
    const angle = /<([^<>]+)>\s*$/.exec(emailAddress);
    const result = normalizeEmail(angle?.[1] ?? emailAddress);
    if (result.ok) out.add(result.normalized);
  }
  return [...out];
}

type Parsed = { ok: true; event: ParsedSesEvent } | { ok: false; reason: SesParseFailure };

export function parseSesEvent(message: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return { ok: false, reason: 'malformed_event' };

  const rawType = envelope.data.eventType ?? envelope.data.notificationType;
  if (rawType === undefined) return { ok: false, reason: 'malformed_event' };
  const eventType = SES_EVENT_TYPES[rawType] ?? 'other';

  const mail = mailSchema.safeParse(envelope.data.mail);

  if (
    eventType !== 'bounce' &&
    eventType !== 'complaint' &&
    eventType !== 'send' &&
    eventType !== 'delivery' &&
    eventType !== 'reject'
  ) {
    const raw = (envelope.data.mail as { messageId?: unknown } | undefined)?.messageId;
    const id = mail.success ? mail.data.messageId : messageId.safeParse(raw).success ? (raw as string) : null;
    return { ok: true, event: { kind: 'ignored', eventType, messageId: id } };
  }

  if (!mail.success) {
    const raw = (envelope.data.mail as { messageId?: unknown } | undefined)?.messageId;
    return { ok: false, reason: messageId.safeParse(raw).success ? 'malformed_mail' : 'missing_message_id' };
  }
  const base = {
    messageId: mail.data.messageId,
    workspaceId: tag(mail.data.tags, 'workspace_id'),
    jobId: tag(mail.data.tags, 'job_id'),
    attemptNo: attemptTag(mail.data.tags),
  };

  switch (eventType) {
    case 'bounce': {
      const bounce = bounceSchema.safeParse(envelope.data.bounce);
      if (!bounce.success) return { ok: false, reason: 'malformed_bounce' };
      return {
        ok: true,
        event: {
          kind: 'bounce',
          ...base,
          bounceType: bounce.data.bounceType,
          bounceSubType: bounce.data.bounceSubType ?? null,
          recipients: canonicalRecipients(bounce.data.bouncedRecipients.map((r) => r.emailAddress)),
          occurredAt: isoOrNull(bounce.data.timestamp),
        },
      };
    }
    case 'complaint': {
      const complaint = complaintSchema.safeParse(envelope.data.complaint);
      if (!complaint.success) return { ok: false, reason: 'malformed_complaint' };
      return {
        ok: true,
        event: {
          kind: 'complaint',
          ...base,
          feedbackType: complaint.data.complaintFeedbackType ?? null,
          recipients: canonicalRecipients(complaint.data.complainedRecipients.map((r) => r.emailAddress)),
          occurredAt: isoOrNull(complaint.data.timestamp),
        },
      };
    }
    case 'delivery': {
      const delivery = deliverySchema.safeParse(envelope.data.delivery);
      if (!delivery.success) return { ok: false, reason: 'malformed_delivery' };
      return {
        ok: true,
        event: {
          kind: 'delivery',
          ...base,
          recipients: canonicalRecipients(delivery.data.recipients),
          occurredAt: isoOrNull(delivery.data.timestamp),
        },
      };
    }
    case 'send':
    case 'reject': {
      // Neither carries its own recipient list: `mail.destination` is it.
      const destination = destinationSchema.safeParse((envelope.data.mail as { destination?: unknown }).destination);
      if (!destination.success) return { ok: false, reason: 'malformed_mail' };
      const stamp = mail.data.timestamp;
      const occurredAt = typeof stamp === 'string' && stamp.length <= 64 ? isoOrNull(stamp) : null;
      const recipients = canonicalRecipients(destination.data);
      if (eventType === 'send') return { ok: true, event: { kind: 'send', ...base, recipients, occurredAt } };
      const reject = rejectSchema.safeParse(envelope.data.reject ?? {});
      const reason = reject.success ? reject.data.reason : undefined;
      return {
        ok: true,
        event: {
          kind: 'reject',
          ...base,
          recipients,
          occurredAt,
          reason: reason !== undefined && REJECT_REASON.test(reason) ? reason : null,
        },
      };
    }
  }
}
