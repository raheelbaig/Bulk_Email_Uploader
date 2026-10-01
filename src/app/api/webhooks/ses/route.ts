import { serverEnv } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import { applyProviderEvent } from '@/lib/provider-events/apply';
import { parseSesEvent } from '@/lib/provider-events/parse';
import { confirmSnsSubscription, fetchSigningCertificate } from '@/lib/provider-events/sns-fetch';
import {
  SNS_MAX_BODY_BYTES,
  allowedSubscribeUrl,
  parseSnsEnvelope,
  verifySnsEnvelope,
} from '@/lib/provider-events/sns-verify';
import { providerEventStore } from '@/lib/provider-events/store';

/**
 * POST /api/webhooks/ses — SES events over SNS (P6, ADR-0005 §1.2, ADR-0006,
 * ARCHITECTURE §16): Bounce and Complaint suppress; Send confirms an attempt;
 * Delivery and Reject settle the job; everything else is recorded only.
 *
 *   1. Size cap (256 KB), before anything is parsed.
 *   2. The SNS envelope only: shape, and the message-type header.
 *   3. Authentication: SNS signature (v2), certificate URL on SNS in the
 *      topic's region, topic = AWS_SNS_TOPIC_ARN, timestamp within the hour.
 *      With no topic configured, every request is refused.
 *   4. Only then the SES event inside it.
 *   5. One database function call per event: record (idempotent on the SNS
 *      MessageId), reconcile the attempt, match against the job, suppress,
 *      audit, and pause on a health breach — one transaction.
 *
 * Statuses, always with an empty body:
 *   200  recorded — applied, duplicate, unmatched or ignored. SNS stops.
 *   400  not an authentic, well-formed notification. Nothing written.
 *   413  too large. Nothing read beyond the cap.
 *   500  the database could not record it. Nothing committed; SNS retries.
 *   503  the signing certificate or the confirmation URL was unreachable.
 *
 * There is no session, cookie or form surface, and nothing in the request
 * chooses a workspace, a contact or an address: an event can only affect the
 * one job, in its own workspace, that the provider's message id identifies.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bare = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

/** The body as text, or null when it exceeds the cap (declared or actual). */
async function readCapped(request: Request, cap: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > cap) return null;
  if (request.body === null) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(request: Request): Promise<Response> {
  return runWithContext({ requestId: newRequestId(), route: 'webhook:ses' }, async () => {
    const body = await readCapped(request, SNS_MAX_BODY_BYTES).catch(() => null);
    if (body === null) {
      logger.warn('ses webhook rejected', { reason: 'too_large' });
      return bare(413);
    }

    const parsed = parseSnsEnvelope(body, request.headers.get('x-amz-sns-message-type'));
    if (!parsed.ok) {
      logger.warn('ses webhook rejected', { reason: parsed.reason });
      return bare(400);
    }
    const envelope = parsed.envelope;
    const topicArn = serverEnv().AWS_SNS_TOPIC_ARN;

    const verdict = await verifySnsEnvelope(envelope, { topicArn, fetchCertificate: fetchSigningCertificate });
    if (!verdict.ok) {
      logger.warn('ses webhook rejected', { reason: verdict.reason });
      return bare(verdict.reason === 'cert_unavailable' ? 503 : 400);
    }

    if (envelope.Type === 'SubscriptionConfirmation') {
      const url = topicArn === undefined ? null : allowedSubscribeUrl(envelope, topicArn);
      if (url === null) {
        logger.warn('ses webhook rejected', { reason: 'bad_subscribe_url' });
        return bare(400);
      }
      const confirmed = await confirmSnsSubscription(url).catch(() => false);
      logger.info('sns subscription confirmation', { confirmed });
      return bare(confirmed ? 200 : 503);
    }

    if (envelope.Type === 'UnsubscribeConfirmation') {
      // Someone unsubscribed the endpoint from the topic. Nothing to do here but
      // make it visible: events stop arriving until an operator resubscribes.
      logger.warn('sns unsubscribe confirmation received');
      return bare(200);
    }

    const event = parseSesEvent(envelope.Message);
    if (!event.ok) {
      logger.warn('ses webhook rejected', { reason: event.reason, snsMessageId: envelope.MessageId });
      return bare(400);
    }

    try {
      const outcome = await applyProviderEvent(
        providerEventStore(),
        { snsMessageId: envelope.MessageId, snsTimestamp: new Date(Date.parse(envelope.Timestamp)).toISOString() },
        event.event,
      );
      logger.info('ses event recorded', {
        kind: event.event.kind === 'ignored' ? event.event.eventType : event.event.kind,
        outcome,
        snsMessageId: envelope.MessageId,
      });
      return bare(200);
    } catch (cause) {
      logger.error('ses event could not be recorded', { cause, snsMessageId: envelope.MessageId });
      return bare(500);
    }
  });
}
