import 'server-only';
import { z } from 'zod';

/**
 * Server-side environment.
 *
 * The `server-only` import above is the enforcement mechanism: importing this
 * module from a Client Component is a *build* error, not a runtime surprise.
 * That is what keeps SUPABASE_SERVICE_ROLE_KEY out of the browser bundle.
 *
 * Never add a value here that is also needed on the client. Client-visible
 * configuration lives in `env.client.ts` and must carry the NEXT_PUBLIC_ prefix.
 */
const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Public — duplicated here so server code has one validated source.
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_APP_URL: z.string().url(),

  // Secret. Bypasses RLS. See lib/db/service.ts before using it.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // Direct Postgres connection, used by migrations and Drizzle. Optional in
  // environments that only talk to Supabase over HTTP.
  DATABASE_URL: z.string().min(1).optional(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ── P3: Amazon SES, sender configuration only ─────────────────────────────
  //
  // Optional as a set. A deployment with no AWS credentials runs normally; the
  // sender-domain feature reports itself unconfigured rather than the whole
  // application failing to boot. Nothing here may ever gain a NEXT_PUBLIC_
  // prefix — scripts/scan-client-bundle.mjs fails the build if a value reaches
  // a client asset, and tests/sending-gates.test.ts pins the modules allowed to
  // name these variables.
  //
  // Until live sending is deliberately enabled, the credential should carry
  // docs/ses-iam-policy.json, which denies `ses:SendEmail`. The live policy is
  // docs/ses-iam-policy-live.json (P5, ADR-0003 §4).
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, 'AWS_REGION must be a region code, e.g. eu-west-1')
    .optional(),
  AWS_ACCESS_KEY_ID: z.string().min(16).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(20).optional(),
  // Set only when running under temporary credentials (assumed role).
  AWS_SESSION_TOKEN: z.string().min(1).optional(),
  // Optional and purely informational: the SESv2 identity APIs do not return an
  // identity ARN, so `sender_domains.ses_identity_arn` is populated only when the
  // account id is known. Nothing in P3 reads the ARN; it is stored for operators.
  AWS_ACCOUNT_ID: z.string().regex(/^\d{12}$/).optional(),

  // ── P5: the sending engine ────────────────────────────────────────────────
  //
  // The master switch. `disabled` (the default) means the worker does nothing at
  // all: scheduled campaigns stay scheduled and nothing is consumed. `dry_run`
  // runs the entire pipeline — promotion, materialisation, claims, attempts,
  // retries, completion — against a sink that never touches the network.
  // `live` hands messages to Amazon SES, and only when every requirement in
  // `lib/sending/config.ts#liveSendingGate` is also met.
  EMAIL_SENDING_MODE: z.enum(['disabled', 'dry_run', 'live']).default('disabled'),

  // Mandatory for live sending: without a configuration set SES emits no events,
  // and suppression, reconciliation and health all go dark (ARCHITECTURE §15.2).
  AWS_SES_CONFIGURATION_SET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'AWS_SES_CONFIGURATION_SET must be a configuration set name')
    .optional(),

  // Authenticates the scheduler's calls to the worker endpoint (HMAC over
  // timestamp + body). Without it the endpoint refuses every request.
  WORKER_HMAC_SECRET: z.string().min(32).optional(),

  // Signs unsubscribe links. Versioned: a retired key must keep verifying for as
  // long as mail carrying its links may be opened (ARCHITECTURE §10.2).
  UNSUBSCRIBE_SECRET_V1: z.string().min(32).optional(),

  // Operational policy (ARCHITECTURE §24.5, ADR-0001, ADR-0002). Documented
  // defaults, never magic numbers at call sites.
  SEND_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(3000).default(60),
  SEND_BATCH_MAX: z.coerce.number().int().min(1).max(500).default(50),
  PROVIDER_SAFETY_FACTOR: z.coerce.number().min(0.1).max(1).default(0.8),
  REAPER_CLAIM_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(240).default(15),
  RECONCILE_GRACE_MINUTES: z.coerce.number().int().min(10).max(1440).default(30),
  UNCERTAIN_ATTEMPT_POLICY: z.enum(['hold', 'redispatch']).default('hold'),
  SCHEDULE_GRACE_MINUTES: z.coerce.number().int().min(1).max(10080).default(120),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

/**
 * Parses and caches server environment.
 *
 * Throws with the offending variable names — but never their values, which is
 * the whole point of not using Zod's default error formatting here.
 */
export function serverEnv(): ServerEnv {
  if (cached !== undefined) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .filter((name, i, all) => name.length > 0 && all.indexOf(name) === i)
      .sort();
    throw new Error(
      `Invalid server environment. Check these variables against .env.example: ${names.join(', ')}`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: clears the memoised environment. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
