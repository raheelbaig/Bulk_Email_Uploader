import type { ParsedSesEvent, ProviderEventType } from './parse';

/**
 * Maps one verified, parsed SES event to one database function (0016).
 *
 * No decision is made here. Matching the event to a job, suppressing, moving
 * the job and its counter, and writing the audit row all happen inside that one
 * function call, in one transaction, so there is no partial state for this
 * layer to get wrong. A store failure propagates: the route answers 500 and SNS
 * redelivers, and because nothing was committed the retry starts clean.
 */

export type ProviderEventOutcome = 'applied' | 'duplicate' | 'unmatched' | 'ignored';

interface Recorded {
  snsMessageId: string;
  /** The SNS envelope's Timestamp, ISO. */
  snsTimestamp: string;
}

interface Correlated extends Recorded {
  occurredAt: string | null;
  providerMessageId: string;
  workspaceId: string | null;
  jobId: string | null;
  recipients: string[];
}

export interface ProviderEventStore {
  recordBounce(
    input: Correlated & { bounceType: 'Permanent' | 'Transient' | 'Undetermined'; bounceSubType: string | null },
  ): Promise<'applied' | 'duplicate' | 'unmatched'>;
  recordComplaint(input: Correlated & { feedbackType: string | null }): Promise<'applied' | 'duplicate' | 'unmatched'>;
  recordIgnored(
    input: Recorded & { eventType: ProviderEventType; providerMessageId: string | null },
  ): Promise<'ignored' | 'duplicate'>;
}

export async function applyProviderEvent(
  store: ProviderEventStore,
  notification: Recorded,
  event: ParsedSesEvent,
): Promise<ProviderEventOutcome> {
  switch (event.kind) {
    case 'bounce':
      return store.recordBounce({
        ...notification,
        occurredAt: event.occurredAt,
        providerMessageId: event.messageId,
        workspaceId: event.workspaceId,
        jobId: event.jobId,
        recipients: event.recipients,
        bounceType: event.bounceType,
        bounceSubType: event.bounceSubType,
      });
    case 'complaint':
      return store.recordComplaint({
        ...notification,
        occurredAt: event.occurredAt,
        providerMessageId: event.messageId,
        workspaceId: event.workspaceId,
        jobId: event.jobId,
        recipients: event.recipients,
        feedbackType: event.feedbackType,
      });
    case 'ignored':
      return store.recordIgnored({ ...notification, eventType: event.eventType, providerMessageId: event.messageId });
  }
}
