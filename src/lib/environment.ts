/**
 * Which environment a deployment is.
 *
 * `APP_ENVIRONMENT` defaults to `development`, and only `production` can ever
 * send live email (lib/sending/gate). A development checkout may run against
 * the one real Supabase project, so this says nothing about which data is in
 * use — it decides whether real delivery is possible at all.
 *
 * Pure, and free of `server-only`: `lib/env` uses it at parse time and the
 * test suite imports it directly.
 */

export type AppEnvironment = 'development' | 'production';

export const APP_ENVIRONMENTS = ['development', 'production'] as const;

export const APP_ENVIRONMENT_LABEL: Record<AppEnvironment, string> = {
  development: 'Development',
  production: 'Production',
};
