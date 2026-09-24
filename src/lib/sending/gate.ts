/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIVE-SENDING GATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Whether this deployment may hand a message to a real provider. Pure: it takes
 * the facts and returns a verdict, so the worker, the settings page and the
 * test suite all reach the same answer from the same inputs.
 *
 * Live sending is refused unless *every* requirement holds. Each unmet one is
 * named, never its value — the output of this function is logged and shown.
 *
 * The gate is one of several independent layers. The others are outside this
 * file and each is sufficient on its own:
 *
 *   - `EMAIL_SENDING_MODE` defaults to `disabled`.
 *   - Every campaign's sender must be verified by SES and by DNS
 *     (lib/sender/readiness), re-checked at launch and on every tick.
 *   - The documented IAM policy (docs/ses-iam-policy.json) still denies
 *     `ses:SendEmail`; the live policy is a separate file an operator attaches.
 *   - SES itself refuses an unverified identity.
 *
 * Deliberately free of `server-only`: pure, and the campaign page renders it.
 */

export type SendingMode = 'disabled' | 'dry_run' | 'live';

export type LiveRequirement =
  | 'mode_is_live'
  | 'provider_credentials'
  | 'configuration_set'
  | 'unsubscribe_secret'
  | 'worker_secret'
  | 'https_app_url';

export interface LiveGateInput {
  mode: SendingMode;
  hasProviderCredentials: boolean;
  hasConfigurationSet: boolean;
  hasUnsubscribeSecret: boolean;
  hasWorkerSecret: boolean;
  appUrl: string;
}

export interface LiveGateVerdict {
  allowed: boolean;
  unmet: LiveRequirement[];
}

export function evaluateLiveGate(input: LiveGateInput): LiveGateVerdict {
  const unmet: LiveRequirement[] = [];
  if (input.mode !== 'live') unmet.push('mode_is_live');
  if (!input.hasProviderCredentials) unmet.push('provider_credentials');
  if (!input.hasConfigurationSet) unmet.push('configuration_set');
  if (!input.hasUnsubscribeSecret) unmet.push('unsubscribe_secret');
  if (!input.hasWorkerSecret) unmet.push('worker_secret');
  if (!isHttpsUrl(input.appUrl)) unmet.push('https_app_url');
  return { allowed: unmet.length === 0, unmet };
}

/**
 * Unsubscribe links point at the app. Over plain HTTP a link in a real
 * recipient's inbox would be interceptable and, on most mail clients, flagged.
 */
function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== 'localhost';
  } catch {
    return false;
  }
}

export const LIVE_REQUIREMENT_MESSAGE: Record<LiveRequirement, string> = {
  mode_is_live: 'EMAIL_SENDING_MODE is not set to live.',
  provider_credentials: 'Amazon SES credentials and region are not configured.',
  configuration_set: 'AWS_SES_CONFIGURATION_SET is not configured, so SES would emit no delivery events.',
  unsubscribe_secret: 'UNSUBSCRIBE_SECRET_V1 is not configured, so messages could not carry a working unsubscribe link.',
  worker_secret: 'WORKER_HMAC_SECRET is not configured, so the scheduler cannot authenticate to the worker.',
  https_app_url: 'NEXT_PUBLIC_APP_URL is not a public https address, so unsubscribe links would not work for recipients.',
};

export const SENDING_MODE_LABEL: Record<SendingMode, string> = {
  disabled: 'Sending disabled',
  dry_run: 'Dry run',
  live: 'Live',
};

/** What a person should be told about the deployment's mode, plainly. */
export const SENDING_MODE_NOTICE: Record<SendingMode, string> = {
  disabled:
    'Sending is disabled for this deployment. Scheduled campaigns stay scheduled and nothing is delivered.',
  dry_run:
    'This deployment is in dry-run mode. Campaigns run through the whole sending pipeline, but no email is delivered to anyone.',
  live: 'This deployment delivers email through Amazon SES.',
};
