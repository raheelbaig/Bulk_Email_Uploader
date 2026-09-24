import 'server-only';
import { signRequest, type AwsCredentials } from '@/lib/sender/provider/ses/sigv4';
import { safeProviderMessage } from '@/lib/sender/provider/ses/client';
import type { SendFailureClass, SendOutcome } from './types';

/**
 * The SESv2 SendEmail transport.
 *
 * ── The only place in the codebase that can deliver email ────────────────
 *
 * One operation, one fixed path, one host derived from a validated region. It
 * is separate from P3's configuration client (`lib/sender/provider/ses/client.ts`)
 * so that client's closed four-operation allowlist stays exactly as reviewed,
 * and so this file is the single thing a reviewer has to read to know how mail
 * leaves. tests/sending-gates.test.ts pins both facts.
 *
 * Still no AWS SDK: the request is signed by P3's SigV4 implementation. Pulling
 * in `@aws-sdk/client-sesv2` would add every other SES operation — bulk send,
 * templates, identity deletion — to the dependency graph for the sake of one call.
 *
 * ── Classifying the answer (ADR-0001) ─────────────────────────────────────
 *
 * The provider *answered* → accepted, or a known rejection. The provider did not
 * answer and the request may have reached it → unknown. The request provably
 * never left (DNS failure, connection refused) → a transient rejection, because
 * nothing can have been sent.
 */

export const SES_SEND_PATH = '/v2/email/outbound-emails';

const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const REQUEST_TIMEOUT_MS = 15_000;

/** Errors that mean the request never reached a server. */
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

export interface SesSendClientConfig {
  region: string;
  credentials: AwsCredentials;
  /** Injectable for tests. Defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SesSendClient {
  readonly region: string;
  sendEmail(body: Record<string, unknown>): Promise<SendOutcome>;
}

/**
 * SES error names → failure class.
 *
 * Two departures from ARCHITECTURE §14.1, both toward stopping sooner:
 *
 *   - `MailFromDomainNotVerifiedException`, `NotFoundException` (usually the
 *     configuration set) and an authorization failure are `halt`, not
 *     `permanent`. They are properties of the *account*, so every message in the
 *     campaign would fail the same way; failing each job one by one would burn
 *     the whole list into `failed`. Halting pauses the campaign with its jobs
 *     intact, to resume once the configuration is fixed.
 *   - An authorization failure is where the documented IAM policy's explicit
 *     Deny on `ses:SendEmail` surfaces. It must stop the workspace, loudly.
 */
export function classifySesError(status: number, errorType: string): SendFailureClass {
  switch (errorType) {
    case 'AccountSuspendedException':
    case 'SendingPausedException':
    case 'MailFromDomainNotVerifiedException':
    case 'NotFoundException':
    case 'AccessDeniedException':
    case 'UnrecognizedClientException':
    case 'InvalidSignatureException':
    case 'SignatureDoesNotMatch':
    case 'ExpiredTokenException':
      return 'halt';
    case 'TooManyRequestsException':
    case 'ThrottlingException':
    case 'LimitExceededException':
    case 'ServiceUnavailable':
    case 'InternalFailure':
      return 'transient';
    case 'MessageRejected':
    case 'BadRequestException':
      return 'permanent';
  }
  if (status === 401 || status === 403) return 'halt';
  if (status === 429 || status >= 500) return 'transient';
  // An error we do not recognise is not retried (§14.1): repeating something we
  // do not understand against a reputation-sensitive provider is worse than
  // failing one message and surfacing it.
  return 'permanent';
}

function errorCodeOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const direct = (cause as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  return errorCodeOf((cause as { cause?: unknown }).cause);
}

export function createSesSendClient(config: SesSendClientConfig): SesSendClient {
  if (!REGION_PATTERN.test(config.region)) {
    throw new Error('AWS region is not a valid region code');
  }
  const host = `email.${config.region}.amazonaws.com`;
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return {
    region: config.region,

    async sendEmail(requestBody) {
      const body = JSON.stringify(requestBody);
      const headers = signRequest({
        method: 'POST',
        path: SES_SEND_PATH,
        host,
        region: config.region,
        service: 'ses',
        body,
        credentials: config.credentials,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await doFetch(`https://${host}${SES_SEND_PATH}`, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (cause) {
        const code = errorCodeOf(cause);
        if (code !== undefined && NOT_SENT_CODES.has(code)) {
          return {
            status: 'rejected',
            failure: 'transient',
            code: 'connect_failed',
            detail: 'the provider could not be reached',
          };
        }
        const aborted = cause instanceof Error && cause.name === 'AbortError';
        // The request may have been received and acted on. Do not guess.
        return {
          status: 'unknown',
          code: aborted ? 'timeout' : 'network_error',
          detail: aborted ? 'the provider did not respond in time' : 'the connection failed mid-request',
        };
      } finally {
        clearTimeout(timer);
      }

      let text = '';
      try {
        text = await response.text();
      } catch {
        if (response.ok) {
          return { status: 'unknown', code: 'unreadable_response', detail: 'the response body could not be read' };
        }
      }

      let parsed: Record<string, unknown> = {};
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }

      if (response.ok) {
        const messageId = parsed['MessageId'];
        if (typeof messageId === 'string' && messageId.length > 0 && messageId.length <= 256) {
          return { status: 'accepted', providerMessageId: messageId };
        }
        // A 200 with no id: SES says it took the message but we cannot record
        // which one. Treated as unknown so the reconciler, not a retry, decides.
        return { status: 'unknown', code: 'missing_message_id', detail: 'the provider returned no message id' };
      }

      const headerType = (response.headers.get('x-amzn-errortype') ?? '').split(':')[0] ?? '';
      const bodyType = typeof parsed['__type'] === 'string' ? String(parsed['__type']).split('#').pop() ?? '' : '';
      const errorType = headerType.length > 0 ? headerType : bodyType;
      const message = safeProviderMessage(parsed['message'] ?? parsed['Message'] ?? '');

      return {
        status: 'rejected',
        failure: classifySesError(response.status, errorType),
        code: (errorType.length > 0 ? errorType : `http_${response.status}`).slice(0, 100),
        detail: message.length > 0 ? message : `provider returned ${response.status}`,
      };
    },
  };
}
