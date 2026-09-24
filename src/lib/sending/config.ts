import 'server-only';
import { serverEnv } from '@/lib/env';
import { evaluateLiveGate, type LiveGateVerdict, type SendingMode } from './gate';

/**
 * The sending engine's view of the environment.
 *
 * Carries policy numbers and *booleans about* secrets, never a secret. The
 * modules that need a secret value (the worker-signature check, the unsubscribe
 * signer, the provider factory) read it from `lib/env` themselves, so no object
 * that gets passed around, logged or rendered can carry one.
 */
export interface SendingConfig {
  mode: SendingMode;
  ratePerMinute: number;
  batchMax: number;
  providerSafetyFactor: number;
  reaperTimeoutMinutes: number;
  reconcileGraceMinutes: number;
  uncertainPolicy: 'hold' | 'redispatch';
  scheduleGraceMinutes: number;
  appUrl: string;
  unsubscribeConfigured: boolean;
  live: LiveGateVerdict;
}

export function sendingConfig(): SendingConfig {
  const env = serverEnv();
  const unsubscribeConfigured = env.UNSUBSCRIBE_SECRET_V1 !== undefined;

  return {
    mode: env.EMAIL_SENDING_MODE,
    ratePerMinute: env.SEND_RATE_PER_MINUTE,
    batchMax: env.SEND_BATCH_MAX,
    providerSafetyFactor: env.PROVIDER_SAFETY_FACTOR,
    reaperTimeoutMinutes: env.REAPER_CLAIM_TIMEOUT_MINUTES,
    reconcileGraceMinutes: env.RECONCILE_GRACE_MINUTES,
    uncertainPolicy: env.UNCERTAIN_ATTEMPT_POLICY,
    scheduleGraceMinutes: env.SCHEDULE_GRACE_MINUTES,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    unsubscribeConfigured,
    live: evaluateLiveGate({
      mode: env.EMAIL_SENDING_MODE,
      hasProviderCredentials:
        env.AWS_REGION !== undefined &&
        env.AWS_ACCESS_KEY_ID !== undefined &&
        env.AWS_SECRET_ACCESS_KEY !== undefined,
      hasConfigurationSet: env.AWS_SES_CONFIGURATION_SET !== undefined,
      hasUnsubscribeSecret: unsubscribeConfigured,
      hasWorkerSecret: env.WORKER_HMAC_SECRET !== undefined,
      appUrl: env.NEXT_PUBLIC_APP_URL,
    }),
  };
}

/**
 * Whether a working unsubscribe mechanism exists in this deployment.
 *
 * The endpoint (`app/u/[token]`) is always present in the code; what can be
 * missing is the key that signs its links. The preflight uses this to decide
 * whether a campaign that requires unsubscribe may launch.
 */
export function unsubscribeMechanismAvailable(): boolean {
  return serverEnv().UNSUBSCRIBE_SECRET_V1 !== undefined;
}
