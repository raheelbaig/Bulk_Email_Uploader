import 'server-only';
import { serverEnv } from '@/lib/env';
import { evaluateLiveGate } from '../gate';
import { createDryRunProvider } from './dry-run';
import { createSesOutboundProvider } from './ses';
import { createSesSendClient } from './ses-send-client';
import type { OutboundEmailProvider } from './types';

export type { OutboundEmailProvider, OutboundMessage, SendOutcome, SendFailureClass } from './types';

/**
 * The outbound provider factory.
 *
 * The one place a campaign's execution mode is turned into something that can
 * send. The decision, in order:
 *
 *   1. A `dry_run` campaign always gets the dry-run provider — whatever the
 *      deployment's mode is now. A rehearsal never becomes a real send.
 *   2. A `live` campaign gets SES only if the live gate passes *right now*.
 *      Otherwise this returns null and the worker leaves the campaign's jobs
 *      untouched: pending, not failed, ready for when the gate opens again.
 *
 * Credentials are read here and handed straight to the signer. They are never
 * returned, stored on an object that leaves this module, or logged.
 */
export function outboundProviderFor(executionMode: 'dry_run' | 'live'): OutboundEmailProvider | null {
  if (executionMode === 'dry_run') return createDryRunProvider();

  const env = serverEnv();
  const gate = evaluateLiveGate({
    mode: env.EMAIL_SENDING_MODE,
    hasProviderCredentials:
      env.AWS_REGION !== undefined &&
      env.AWS_ACCESS_KEY_ID !== undefined &&
      env.AWS_SECRET_ACCESS_KEY !== undefined,
    hasConfigurationSet: env.AWS_SES_CONFIGURATION_SET !== undefined,
    hasUnsubscribeSecret: env.UNSUBSCRIBE_SECRET_V1 !== undefined,
    hasWorkerSecret: env.WORKER_HMAC_SECRET !== undefined,
    appUrl: env.NEXT_PUBLIC_APP_URL,
  });
  if (!gate.allowed) return null;

  const region = env.AWS_REGION;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const configurationSet = env.AWS_SES_CONFIGURATION_SET;
  if (
    region === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    configurationSet === undefined
  ) {
    return null;
  }

  return createSesOutboundProvider({
    configurationSet,
    client: createSesSendClient({
      region,
      credentials: { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN },
    }),
  });
}
