import type { ParsedSesEvent, ProviderEventType } from './parse';

/**
 * Maps one verified, parsed SES event to one database function (0016, 0017).
 *
 * No decision is made here. Reconciling the attempt, matching the event to a
 * job, suppressing, moving the job and its counter, writing the audit row and
 * pausing on a health breach all happen inside that one function call, in one
 * transaction, so there is no partial state for this layer to get wrong. A
 * store failure propagates: the route answers 500 and SNS redelivers, and
 * because nothing was committed the retry starts clean.
 */

export type ProviderEventOutcome = 'applied' | 'duplicate' | 'unmatched' | 'ignored';
type Matched = 'applied' | 'duplicate' | 'unmatched';

interface Recorded {
  snsMessageId: string;
  /** The SNS envelope's Timestamp, ISO. */
  snsTimestamp: string;
}

export interface Correlated extends Recorded {
  occurredAt: string | null;
  providerMessageId: string;
  workspaceId: string | null;
  jobId: string | null;
  attemptNo: number | null;
  recipients: string[];
}

export interface ProviderEventStore {
  recordBounce(
    input: Correlated & { bounceType: 'Permanent' | 'Transient' | 'Undetermined'; bounceSubType: string | null },
  ): Promise<Matched>;
  recordComplaint(input: Correlated & { feedbackType: string | null }): Promise<Matched>;
  recordSend(input: Correlated): Promise<Matched>;
  recordDelivery(input: Correlated): Promise<Matched>;
  recordReject(input: Correlated & { reason: string | null }): Promise<Matched>;
  recordIgnored(
    input: Recorded & { eventType: ProviderEventType; providerMessageId: string | null },
  ): Promise<'ignored' | 'duplicate'>;
}

export async function applyProviderEvent(
  store: ProviderEventStore,
  notification: Recorded,
  event: ParsedSesEvent,
): Promise<ProviderEventOutcome> {
  if (event.kind === 'ignored') {
    return store.recordIgnored({ ...notification, eventType: event.eventType, providerMessageId: event.messageId });
  }

  const correlated: Correlated = {
    ...notification,
    occurredAt: event.occurredAt,
    providerMessageId: event.messageId,
    workspaceId: event.workspaceId,
    jobId: event.jobId,
    attemptNo: event.attemptNo,
    recipients: event.recipients,
  };

  switch (event.kind) {
    case 'bounce':
      return store.recordBounce({ ...correlated, bounceType: event.bounceType, bounceSubType: event.bounceSubType });
    case 'complaint':
      return store.recordComplaint({ ...correlated, feedbackType: event.feedbackType });
    case 'send':
      return store.recordSend(correlated);
    case 'delivery':
      return store.recordDelivery(correlated);
    case 'reject':
      return store.recordReject({ ...correlated, reason: event.reason });
  }
}
