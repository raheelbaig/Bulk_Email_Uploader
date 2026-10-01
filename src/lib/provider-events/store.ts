import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { unscopedServiceClient } from '@/lib/db/service';
import type { Correlated, ProviderEventStore } from './apply';

/**
 * The production provider-event store: one `events_record_*` call (0016, 0017)
 * per event, nothing else.
 *
 * Unscoped by necessity — this is the case `unscopedServiceClient` documents:
 * an inbound event does not yet have a trusted workspace. The workspace it
 * names in its tags is handed to the database as a claim to check, not as a
 * scope to trust; the function matches it against the job, the attempt and the
 * provider message id before touching anything.
 *
 * A reply that is not one of the function's documented outcomes throws, so a
 * schema drift fails loudly (and SNS retries) instead of being reported as a
 * processed event.
 */
export function providerEventStore(): ProviderEventStore {
  const db: SupabaseClient = unscopedServiceClient('SES webhook: resolving an inbound provider event to its workspace');

  const call = async <T extends string>(fn: string, args: Record<string, unknown>, allowed: readonly T[]): Promise<T> => {
    const { data, error } = await db.rpc(fn, args);
    if (error !== null) throw new Error(`${fn} failed: ${error.message}`);
    if (typeof data !== 'string' || !(allowed as readonly string[]).includes(data)) {
      throw new Error(`${fn} returned an unexpected outcome`);
    }
    return data as T;
  };

  const matched = ['applied', 'duplicate', 'unmatched'] as const;

  const correlation = (input: Correlated) => ({
    p_sns_message_id: input.snsMessageId,
    p_sns_timestamp: input.snsTimestamp,
    p_occurred_at: input.occurredAt,
    p_message_id: input.providerMessageId,
    p_workspace_id: input.workspaceId,
    p_job_id: input.jobId,
    p_attempt_no: input.attemptNo,
    p_recipients: input.recipients,
  });

  return {
    recordBounce(input) {
      return call(
        'events_record_bounce',
        { ...correlation(input), p_bounce_type: input.bounceType, p_bounce_subtype: input.bounceSubType },
        matched,
      );
    },

    recordComplaint(input) {
      return call('events_record_complaint', { ...correlation(input), p_feedback_type: input.feedbackType }, matched);
    },

    recordSend(input) {
      return call('events_record_send', correlation(input), matched);
    },

    recordDelivery(input) {
      return call('events_record_delivery', correlation(input), matched);
    },

    recordReject(input) {
      return call('events_record_reject', { ...correlation(input), p_reason: input.reason }, matched);
    },

    recordIgnored(input) {
      return call(
        'events_record_ignored',
        {
          p_sns_message_id: input.snsMessageId,
          p_sns_timestamp: input.snsTimestamp,
          p_event_type: input.eventType,
          p_message_id: input.providerMessageId,
        },
        ['ignored', 'duplicate'] as const,
      );
    },
  };
}
