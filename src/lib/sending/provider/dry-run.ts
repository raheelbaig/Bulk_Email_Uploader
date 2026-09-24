import { randomUUID } from 'node:crypto';
import type { OutboundEmailProvider, OutboundMessage, SendOutcome } from './types';

/**
 * The dry-run provider.
 *
 * Accepts every message and delivers none. It performs no I/O of any kind —
 * no network, no file, no log line carrying message content — so a dry run is
 * safe to point at a production audience: the only side effects are the rows
 * the pipeline writes about itself, all of which are stamped `dry_run`.
 *
 * The message id is prefixed `dryrun-` so no one can mistake it for an SES id
 * in the database, an export or a support conversation.
 *
 * `inspect`, when given, receives each message. It is how the test suite proves
 * what *would* have been sent — headers, tags, the rendered body — without a
 * real provider.
 */
export function createDryRunProvider(
  options: { inspect?: (message: OutboundMessage) => void } = {},
): OutboundEmailProvider {
  return {
    mode: 'dry_run',
    async send(message: OutboundMessage): Promise<SendOutcome> {
      options.inspect?.(message);
      return { status: 'accepted', providerMessageId: `dryrun-${randomUUID()}` };
    },
  };
}
