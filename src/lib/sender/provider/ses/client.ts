import 'server-only';
import { signRequest, type AwsCredentials } from './sigv4';
import { EmailProviderError, type ProviderErrorKind } from '../types';
import { normalizeDomainName } from '../../domain-name';

/**
 * The SESv2 configuration client.
 *
 * ── The operation allowlist is the security boundary ──────────────────────
 *
 * This module can issue exactly the four requests named in `SES_OPERATIONS`.
 * There is no method that takes a path, a URL or an operation name from a
 * caller: the request line is assembled here, from a closed union, and the only
 * caller-supplied value that reaches it is a domain that has already been
 * through `normalizeDomainName` and is re-checked below before it is encoded
 * into the path.
 *
 * SESv2's send operation is `POST /v2/email/outbound-emails`. It is absent, and
 * tests/no-sending.test.ts asserts that no path in this file matches it.
 *
 * ── SSRF ──────────────────────────────────────────────────────────────────
 *
 * The host is `email.<region>.amazonaws.com`, built from a region validated by
 * `lib/env.ts` and re-validated here. Redirects are refused rather than
 * followed, so a response cannot move the request to another host. No user
 * input reaches the host, the scheme or the port.
 */

/** Every request this client is capable of making. */
export const SES_OPERATIONS = {
  createEmailIdentity: { method: 'POST', path: () => '/v2/email/identities' },
  getEmailIdentity: {
    method: 'GET',
    path: (identity: string) => `/v2/email/identities/${identity}`,
  },
  putMailFromAttributes: {
    method: 'PUT',
    path: (identity: string) => `/v2/email/identities/${identity}/mail-from`,
  },
  getAccount: { method: 'GET', path: () => '/v2/email/account' },
} as const satisfies Record<
  string,
  { method: 'GET' | 'POST' | 'PUT'; path: (identity: string) => string }
>;

export type SesOperation = keyof typeof SES_OPERATIONS;

const SERVICE = 'ses';
const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const REQUEST_TIMEOUT_MS = 10_000;

export interface SesClientConfig {
  region: string;
  credentials: AwsCredentials;
  /** Injectable for tests. Defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

/** JSON object, without committing to a shape the API may extend. */
export type SesResponse = Record<string, unknown>;

export interface SesClient {
  readonly region: string;
  readonly endpoint: string;
  call(
    operation: SesOperation,
    args: { identity?: string; body?: Record<string, unknown> },
  ): Promise<SesResponse>;
}

/**
 * Maps an HTTP status and SES error name onto the port's error vocabulary.
 *
 * The mapping matters more than it looks: `already_exists` is what makes domain
 * provisioning idempotent, and `not_found` is what distinguishes "never
 * provisioned" from "provisioning failed".
 */
function classify(status: number, errorType: string): ProviderErrorKind {
  if (errorType === 'AlreadyExistsException') return 'already_exists';
  if (errorType === 'NotFoundException') return 'not_found';
  if (status === 404) return 'not_found';
  if (status === 403 || status === 401) return 'access_denied';
  if (status === 429) return 'rate_limited';
  if (errorType === 'TooManyRequestsException' || errorType === 'LimitExceededException') {
    return 'rate_limited';
  }
  if (status >= 500) return 'unavailable';
  return 'invalid_request';
}

/**
 * Trims a provider message to something safe to persist.
 *
 * Bounded because it lands in `sender_domains.last_check_error` (§22), and
 * stripped of anything credential-shaped because a provider error can quote the
 * request that caused it.
 */
export function safeProviderMessage(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  return text
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/Signature=[0-9a-f]{16,}/gi, 'Signature=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** The identity path segment. Validated, then encoded — in that order. */
function encodeIdentity(identity: string): string {
  const parsed = normalizeDomainName(identity);
  if (!parsed.ok || parsed.domain !== identity) {
    throw new EmailProviderError('invalid_request', 'identity is not a normalised domain');
  }
  return encodeURIComponent(parsed.domain);
}

export function createSesClient(config: SesClientConfig): SesClient {
  if (!REGION_PATTERN.test(config.region)) {
    throw new EmailProviderError('not_configured', 'AWS region is not a valid region code');
  }
  const host = `email.${config.region}.amazonaws.com`;
  const doFetch = config.fetchImpl ?? fetch;

  return {
    region: config.region,
    endpoint: `https://${host}`,

    async call(operation, args) {
      const spec = SES_OPERATIONS[operation];
      const identity = args.identity === undefined ? '' : encodeIdentity(args.identity);
      const path = spec.path(identity);
      const body = args.body === undefined ? '' : JSON.stringify(args.body);

      const headers = signRequest({
        method: spec.method,
        path,
        host,
        region: config.region,
        service: SERVICE,
        body,
        credentials: config.credentials,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await doFetch(`https://${host}${path}`, {
          method: spec.method,
          headers,
          ...(body.length > 0 ? { body } : {}),
          // A 3xx from an AWS endpoint is not something to chase. Following one
          // would let a response choose the next host this signed request goes to.
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (cause) {
        const aborted = cause instanceof Error && cause.name === 'AbortError';
        throw new EmailProviderError(
          'unavailable',
          aborted ? 'the provider did not respond in time' : 'the provider could not be reached',
          cause,
        );
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      let parsed: SesResponse = {};
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as SesResponse;
        } catch {
          if (response.ok) {
            throw new EmailProviderError('unavailable', 'the provider returned an unreadable response');
          }
        }
      }

      if (!response.ok) {
        // SES puts the error name in a header on some paths and in the body on
        // others; both are read, neither is trusted for anything but the label.
        const headerType = response.headers.get('x-amzn-errortype') ?? '';
        const errorType = headerType.split(':')[0] ?? '';
        const message = safeProviderMessage(parsed['message'] ?? parsed['Message'] ?? errorType);
        throw new EmailProviderError(
          classify(response.status, errorType),
          message.length > 0 ? message : `provider returned ${response.status}`,
        );
      }

      return parsed;
    },
  };
}
