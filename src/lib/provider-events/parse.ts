import { z } from 'zod';
import { normalizeEmail } from '@/lib/email/normalize';

/**
 * The SES event inside a verified SNS notification — ADR-0005 §1.5.
 *
 * Runs only after the SNS signature has been verified, but still trusts
 * nothing: every field it keeps is shape-checked, and the ones that reach the
 * database are bounded. What it keeps:
 *
 *   - the event type — Bounce and Complaint are acted on; every other type,
 *     known or not, is recorded as `ignored`;
 *   - `mail.messageId`, the id SendEmail returned and the job stored;
 *   - the `workspace_id` / `job_id` tags the worker attached — used only as a
 *     lookup key, which the database then cross-checks (0016, E2);
 *   - recipients, through the application's one normalizer, so an event about
 *     `Person@Example.COM` matches a job for `person@example.com` exactly as
 *     every other boundary does. An address the normalizer rejects is dropped;
 *     if none survive, the event cannot name its recipient and is recorded as
 *     unmatched rather than guessed at.
 *
 * Bounce and complaint events missing their message id, their bounce type or
 * their recipient list are malformed and refused, never recorded as success.
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
const MAX_RECIPIENTS = 100;

const messageId = z.string().regex(MESSAGE_ID);
const recipient = z.object({ emailAddress: z.string().min(1).max(320) });

const mailSchema = z.object({
  messageId,
  tags: z.record(z.string().max(256), z.array(z.string().max(256)).max(10)).optional(),
});

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

const envelopeSchema = z.object({
  // Configuration-set event publishing says `eventType`; identity feedback
  // notifications say `notificationType`. Either names the same types.
  eventType: z.string().max(64).optional(),
  notificationType: z.string().max(64).optional(),
  mail: z.unknown().optional(),
  bounce: z.unknown().optional(),
  complaint: z.unknown().optional(),
});

interface Correlation {
  messageId: string;
  /** From the message tags; a lookup key only, never trusted on its own. */
  workspaceId: string | null;
  jobId: string | null;
  /** Canonical, de-duplicated. Possibly empty. */
  recipients: string[];
  /** ISO timestamp of the event itself, when SES gave a valid one. */
  occurredAt: string | null;
}

export type ParsedSesEvent =
  | ({ kind: 'bounce'; bounceType: 'Permanent' | 'Transient' | 'Undetermined'; bounceSubType: string | null } & Correlation)
  | ({ kind: 'complaint'; feedbackType: string | null } & Correlation)
  | { kind: 'ignored'; eventType: ProviderEventType; messageId: string | null };

export type SesParseFailure = 'not_json' | 'malformed_event' | 'missing_message_id' | 'malformed_bounce' | 'malformed_complaint';

function tag(tags: Record<string, string[]> | undefined, name: string): string | null {
  const value = tags?.[name]?.[0];
  return value !== undefined && UUID.test(value) ? value.toLowerCase() : null;
}

function isoOrNull(value: string | undefined): string | null {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** `a@b.com`, or the address inside `Name <a@b.com>`. */
function canonicalRecipients(list: Array<{ emailAddress: string }>): string[] {
  const out = new Set<string>();
  for (const { emailAddress } of list) {
    const angle = /<([^<>]+)>\s*$/.exec(emailAddress);
    const result = normalizeEmail(angle?.[1] ?? emailAddress);
    if (result.ok) out.add(result.normalized);
  }
  return [...out];
}

export function parseSesEvent(message: string): { ok: true; event: ParsedSesEvent } | { ok: false; reason: SesParseFailure } {
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

  if (eventType !== 'bounce' && eventType !== 'complaint') {
    return { ok: true, event: { kind: 'ignored', eventType, messageId: mail.success ? mail.data.messageId : null } };
  }

  if (!mail.success) return { ok: false, reason: 'missing_message_id' };
  const base = {
    messageId: mail.data.messageId,
    workspaceId: tag(mail.data.tags, 'workspace_id'),
    jobId: tag(mail.data.tags, 'job_id'),
  };

  if (eventType === 'bounce') {
    const bounce = bounceSchema.safeParse(envelope.data.bounce);
    if (!bounce.success) return { ok: false, reason: 'malformed_bounce' };
    return {
      ok: true,
      event: {
        kind: 'bounce',
        ...base,
        bounceType: bounce.data.bounceType,
        bounceSubType: bounce.data.bounceSubType ?? null,
        recipients: canonicalRecipients(bounce.data.bouncedRecipients),
        occurredAt: isoOrNull(bounce.data.timestamp),
      },
    };
  }

  const complaint = complaintSchema.safeParse(envelope.data.complaint);
  if (!complaint.success) return { ok: false, reason: 'malformed_complaint' };
  return {
    ok: true,
    event: {
      kind: 'complaint',
      ...base,
      feedbackType: complaint.data.complaintFeedbackType ?? null,
      recipients: canonicalRecipients(complaint.data.complainedRecipients),
      occurredAt: isoOrNull(complaint.data.timestamp),
    },
  };
}
