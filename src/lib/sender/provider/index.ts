import 'server-only';
import { serverEnv } from '@/lib/env';
import { createSesProvider } from './ses/provider';
import { EmailProviderError, type EmailProvider } from './types';

export type {
  EmailProvider,
  ProviderDomainIdentity,
  ProviderDkimState,
  ProviderMailFromState,
  ProviderSendingLimits,
  ProviderVerificationState,
  ProviderErrorKind,
} from './types';
export { EmailProviderError, EMAIL_PROVIDER_METHODS } from './types';

/**
 * The provider factory.
 *
 * The rest of the application asks for `emailProvider()` and receives the port,
 * never the adapter. Swapping providers is a change to this function and one new
 * directory under `./`.
 *
 * A deployment with no AWS credentials is a supported state, not an error: the
 * application boots, every other feature works, and the sender-domain pages say
 * the provider is not configured. Throwing at import time would make a missing
 * optional integration take down contacts and imports with it.
 */

let cached: EmailProvider | undefined;

export function isProviderConfigured(): boolean {
  const env = serverEnv();
  return (
    env.AWS_REGION !== undefined &&
    env.AWS_ACCESS_KEY_ID !== undefined &&
    env.AWS_SECRET_ACCESS_KEY !== undefined
  );
}

/**
 * The configured provider.
 *
 * Throws `EmailProviderError('not_configured')` rather than returning null, so a
 * caller that forgot to check cannot proceed with an undefined provider. Callers
 * that want to render a page either way use `isProviderConfigured()` first.
 */
export function emailProvider(): EmailProvider {
  if (cached !== undefined) return cached;

  const env = serverEnv();
  const region = env.AWS_REGION;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;

  if (region === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new EmailProviderError(
      'not_configured',
      'the email provider is not configured for this deployment',
    );
  }

  cached = createSesProvider({
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN,
    accountId: env.AWS_ACCOUNT_ID,
  });
  return cached;
}

/** Test-only: drops the memoised provider. */
export function resetProviderCache(): void {
  cached = undefined;
}
