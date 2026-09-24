import 'server-only';
import { encodeHeaderText, formatAddress } from '../mime';
import type { SesSendClient } from './ses-send-client';
import type { OutboundEmailProvider, OutboundMessage, SendOutcome } from './types';

/**
 * The SES adapter for the outbound port.
 *
 * Translates an `OutboundMessage` into a SESv2 SendEmail request (ARCHITECTURE
 * §15.2) and nothing more. The rules it applies, each for a stated reason:
 *
 *   - `ConfigurationSetName` on every send. Required at construction; without it
 *     SES emits no events and the whole feedback loop goes dark.
 *   - One address in `ToAddresses`. Always.
 *   - Both HTML and text bodies. A single-part message is a spam signal.
 *   - `Simple` content, not `Raw`: SES builds the MIME, and custom headers
 *     (List-Unsubscribe) go through `Content.Simple.Headers`, which SESv2
 *     accepts up to 15 of.
 *   - Subject and display names RFC 2047-encoded when not ASCII — SES rejects
 *     8-bit subjects.
 */

/** SES tag names and values: letters, digits, `_` and `-`, at most 256 characters. */
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_SES_HEADERS = 15;

export interface SesProviderConfig {
  client: SesSendClient;
  configurationSet: string;
}

export function buildSesSendRequest(
  message: OutboundMessage,
  configurationSet: string,
): Record<string, unknown> {
  const headers = Object.entries(message.headers);
  if (headers.length > MAX_SES_HEADERS) {
    throw new Error(`SES accepts at most ${MAX_SES_HEADERS} custom headers`);
  }

  const tags = Object.entries(message.tags).map(([Name, Value]) => {
    if (!TAG_PATTERN.test(Name) || !TAG_PATTERN.test(Value)) {
      throw new Error(`message tag ${Name} is not a valid SES tag`);
    }
    return { Name, Value };
  });

  return {
    FromEmailAddress: formatAddress(message.from.name, message.from.email),
    Destination: { ToAddresses: [message.to] },
    ...(message.replyTo === null ? {} : { ReplyToAddresses: [message.replyTo] }),
    ConfigurationSetName: configurationSet,
    EmailTags: tags,
    Content: {
      Simple: {
        Subject: { Data: encodeHeaderText(message.subject), Charset: 'UTF-8' },
        Body: {
          Html: { Data: message.html, Charset: 'UTF-8' },
          Text: { Data: message.text, Charset: 'UTF-8' },
        },
        Headers: headers.map(([Name, Value]) => ({ Name, Value })),
      },
    },
  };
}

export function createSesOutboundProvider(config: SesProviderConfig): OutboundEmailProvider {
  if (!TAG_PATTERN.test(config.configurationSet)) {
    throw new Error('a configuration set is required for every send');
  }

  return {
    mode: 'live',
    async send(message: OutboundMessage): Promise<SendOutcome> {
      let request: Record<string, unknown>;
      try {
        request = buildSesSendRequest(message, config.configurationSet);
      } catch (cause) {
        // Nothing was sent: the request was never built.
        return {
          status: 'rejected',
          failure: 'permanent',
          code: 'invalid_message',
          detail: cause instanceof Error ? cause.message : 'the message could not be encoded',
        };
      }
      return config.client.sendEmail(request);
    },
  };
}
