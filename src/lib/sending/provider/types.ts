/**
 * The outbound email port.
 *
 * Separate from P3's configuration port (`lib/sender/provider/types.ts`) on
 * purpose. That port provisions and verifies domains and can never deliver
 * anything; this one delivers and can do nothing else. Code that needs to
 * verify a domain cannot reach a send method by accident, and code that sends
 * cannot reconfigure a domain.
 *
 * Provider-neutral by construction: nothing here names SES. The SES adapter
 * translates SES's errors into `SendOutcome`, and nothing downstream of the
 * adapter ever sees an SES error name as anything but an opaque `code`.
 *
 * ── Why `send` returns an outcome instead of throwing ─────────────────────
 *
 * ADR-0001's whole design rests on distinguishing three answers, and an
 * exception conflates them:
 *
 *   accepted  the provider took the message and gave it an id
 *   rejected  the provider answered and the answer was no — a *known* outcome,
 *             so a retry is safe when the class allows it
 *   unknown   the request may or may not have reached the provider (a timeout,
 *             a dropped connection, an unreadable response). Never retried
 *             automatically: the attempt stays open and the reconciler holds it.
 *
 * An adapter that is unsure must answer `unknown`. Mislabelling an unknown as a
 * rejection is the one mistake in this layer that sends somebody the same email
 * twice.
 */

export type SendFailureClass =
  /** Throttling, a 5xx the provider returned, a connection that never opened. Retry with backoff. */
  | 'transient'
  /** The message or its configuration is wrong. Retrying cannot help. */
  | 'permanent'
  /** The account cannot send at all. Stop the workspace. */
  | 'halt';

export type SendOutcome =
  | { status: 'accepted'; providerMessageId: string }
  | { status: 'rejected'; failure: SendFailureClass; code: string; detail: string }
  | { status: 'unknown'; code: string; detail: string };

export interface OutboundAddress {
  email: string;
  name: string;
}

/**
 * One message to one recipient.
 *
 * One recipient per message, always (ARCHITECTURE §15.2): a second address would
 * make per-recipient event correlation impossible and expose recipients to each
 * other. `to` is a string, not an array, so the type cannot express the mistake.
 */
export interface OutboundMessage {
  from: OutboundAddress;
  replyTo: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe. Names and values are validated by the composer. */
  headers: Readonly<Record<string, string>>;
  /**
   * Correlation tags carried back in provider events (ADR-0001 §3.2). Values
   * are restricted to what SES accepts: letters, digits, `_` and `-`.
   */
  tags: Readonly<Record<string, string>>;
}

export interface OutboundEmailProvider {
  /** `dry_run` or `live`. Recorded on every attempt. */
  readonly mode: 'dry_run' | 'live';
  send(message: OutboundMessage): Promise<SendOutcome>;
}

/** The only method the port exposes. Asserted by tests/sending-gates.test.ts. */
export const OUTBOUND_PROVIDER_METHODS = ['send'] as const;
