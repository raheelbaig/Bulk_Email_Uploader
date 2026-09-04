import 'server-only';
import { createSesClient, type SesClient, type SesResponse } from './client';
import {
  EmailProviderError,
  type EmailProvider,
  type ProviderDomainIdentity,
  type ProviderSendingLimits,
  type ProviderVerificationState,
} from '../types';

/**
 * The SES adapter.
 *
 * This is the only module in the codebase that knows what SES calls things.
 * Everything it returns is in the port's vocabulary (`../types`), so a status
 * string like `TEMPORARY_FAILURE` never escapes this file — which is what stops
 * SES's spelling from becoming the application's spelling and then the
 * database's.
 */

/** SES verification states, mapped onto the port's. */
function toVerificationState(raw: unknown): ProviderVerificationState {
  switch (typeof raw === 'string' ? raw.toUpperCase() : '') {
    case 'SUCCESS':
      return 'verified';
    case 'PENDING':
      return 'pending';
    case 'FAILED':
      return 'failed';
    case 'TEMPORARY_FAILURE':
      return 'temporary_failure';
    case 'NOT_STARTED':
      return 'not_started';
    default:
      return 'not_started';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * DKIM tokens, filtered to the shape the database will accept.
 *
 * SES returns lowercase alphanumeric selectors. Anything else is dropped rather
 * than stored: these values are interpolated into DNS record hosts shown to the
 * user, and an unexpected character there is a place to inject a different
 * record than the one we mean to instruct them to publish.
 */
function readDkimTokens(dkim: Record<string, unknown>): string[] {
  const raw = dkim['Tokens'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((token): token is string => typeof token === 'string')
    .map((token) => token.toLowerCase())
    .filter((token) => /^[a-z0-9]{16,64}$/.test(token))
    .slice(0, 3);
}

function toDomainIdentity(
  domain: string,
  response: SesResponse,
  region: string,
  accountId: string | undefined,
): ProviderDomainIdentity {
  const dkim = asRecord(response['DkimAttributes']);
  const mailFrom = asRecord(response['MailFromAttributes']);
  const mailFromDomain = mailFrom['MailFromDomain'];

  // `VerificationStatus` is absent from CreateEmailIdentity's response; for a
  // freshly created Easy DKIM identity the DKIM status is the identity status.
  const identityStatus =
    response['VerificationStatus'] === undefined
      ? dkim['Status']
      : response['VerificationStatus'];

  return {
    domain,
    status: toVerificationState(identityStatus),
    // The provider's own verdict, never inferred. SES omits this field on
    // creation, when the answer is definitively "not yet".
    usableForSending: response['VerifiedForSendingStatus'] === true,
    dkim: {
      tokens: readDkimTokens(dkim),
      status: toVerificationState(dkim['Status']),
      signingEnabled: dkim['SigningEnabled'] === true,
    },
    mailFrom: {
      domain: typeof mailFromDomain === 'string' && mailFromDomain.length > 0 ? mailFromDomain : null,
      status:
        typeof mailFromDomain === 'string' && mailFromDomain.length > 0
          ? toVerificationState(mailFrom['MailFromDomainStatus'])
          : 'not_started',
    },
    // SESv2's identity APIs do not return an ARN. It is composed only when the
    // account id is configured, and nothing in P3 reads it.
    identityArn:
      accountId === undefined ? null : `arn:aws:ses:${region}:${accountId}:identity/${domain}`,
  };
}

export interface SesProviderOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  accountId?: string | undefined;
  fetchImpl?: typeof fetch;
  /** Injected by tests; production builds one from the options above. */
  client?: SesClient;
}

export function createSesProvider(options: SesProviderOptions): EmailProvider {
  const client =
    options.client ??
    createSesClient({
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        sessionToken: options.sessionToken,
      },
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const accountId = options.accountId;

  const provider: EmailProvider = {
    region: options.region,

    /**
     * Create-or-fetch.
     *
     * SES answers `AlreadyExistsException` for a domain it already holds, which
     * is treated as success and followed by a read. That is what makes adding
     * the same domain twice — from a double-clicked button, a retried request,
     * or two workspaces naming the same domain — produce one identity and no
     * error (§5).
     */
    async createDomainIdentity(domain: string): Promise<ProviderDomainIdentity> {
      try {
        const response = await client.call('createEmailIdentity', {
          body: { EmailIdentity: domain },
        });
        return toDomainIdentity(domain, response, client.region, accountId);
      } catch (err) {
        if (err instanceof EmailProviderError && err.kind === 'already_exists') {
          const existing = await provider.getDomainIdentity(domain);
          if (existing !== null) return existing;
        }
        throw err;
      }
    },

    async getDomainIdentity(domain: string): Promise<ProviderDomainIdentity | null> {
      try {
        const response = await client.call('getEmailIdentity', { identity: domain });
        return toDomainIdentity(domain, response, client.region, accountId);
      } catch (err) {
        if (err instanceof EmailProviderError && err.kind === 'not_found') return null;
        throw err;
      }
    },

    /**
     * `USE_DEFAULT_VALUE` is deliberate: if the MAIL FROM subdomain's MX record
     * is missing or broken, SES falls back to its own envelope domain and the
     * mail still leaves. `REJECT_MESSAGE` would silently stop a workspace's
     * sending on a DNS mistake, which is a worse failure than losing DMARC
     * alignment until the record is fixed — and the domain's readiness status
     * reports the loss of alignment either way.
     */
    async configureMailFrom(domain: string, mailFromDomain: string): Promise<void> {
      if (!mailFromDomain.endsWith(`.${domain}`)) {
        throw new EmailProviderError(
          'invalid_request',
          'the MAIL FROM subdomain must sit under the sending domain',
        );
      }
      await client.call('putMailFromAttributes', {
        identity: domain,
        body: { MailFromDomain: mailFromDomain, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' },
      });
    },

    async getSendingLimits(): Promise<ProviderSendingLimits> {
      const response = await client.call('getAccount', {});
      const quota = asRecord(response['SendQuota']);
      const max24 = quota['Max24HourSend'];
      const rate = quota['MaxSendRate'];
      return {
        // Absent means the account is out of the sandbox on some API versions;
        // the conservative reading is that a missing field is not proof of
        // production access.
        sandbox: response['ProductionAccessEnabled'] !== true,
        sendingEnabled: response['SendingEnabled'] === true,
        max24HourSend: typeof max24 === 'number' ? max24 : null,
        maxSendRate: typeof rate === 'number' ? rate : null,
      };
    },
  };

  return provider;
}
