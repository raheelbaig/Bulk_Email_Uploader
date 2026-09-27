import 'server-only';
import { createHash } from 'node:crypto';
import { unscopedServiceClient } from '@/lib/db/service';
import { RateLimitedError } from '@/lib/errors';
import { logger } from '@/lib/observability/logger';

/**
 * Fixed-window rate limiting.
 *
 * The counter lives in PostgreSQL (`rate_limits`, migration 0006) and is
 * incremented by a single statement that refuses to exceed the cap
 * (`public.consume_rate_limit`). Two properties follow, both of which in-memory
 * limiters lack on this platform:
 *
 *   1. It is correct under concurrency. The check and the increment are one
 *      atomic statement, so two simultaneous requests at the cap cannot both be
 *      admitted.
 *   2. It survives the process. Vercel functions are per-request and may run in
 *      several regions at once, so a Map in module scope limits nothing — every
 *      cold start resets it, and every concurrent instance keeps its own.
 *
 * The blueprint's §3.9 table is the design; this is its only implementation.
 * Adding a second limiter elsewhere would produce two different answers to the
 * same question, which is the failure mode §1.3 warns about.
 */

export type RateLimitAction =
  | 'import.create'
  | 'import.inspect'
  | 'import.confirm'
  | 'import.process'
  | 'import.export'
  | 'sender.domain_add'
  | 'sender.domain_verify'
  | 'sender.identity_write'
  | 'template.write'
  | 'campaign.write'
  | 'campaign.preflight'
  // Unauthenticated entry points (QA pass 2, 2026-09-25). Keyed by a hashed
  // subject rather than a session, because there is no session yet.
  | 'auth.sign_in_account'
  | 'auth.sign_in_ip'
  | 'auth.sign_up_ip';

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
  /** Shown when the window is exhausted. Says what to do, never why we know. */
  message: string;
}

/**
 * The rules.
 *
 * Chosen to be invisible in normal use and firm under abuse. Upload creation is
 * the tightest because each one provisions a signed URL and reserves storage;
 * inspection and processing are looser because a person legitimately retries a
 * failed import, and export looser still because downloading a rejection file
 * twice is normal.
 */
export const RATE_LIMITS: Record<RateLimitAction, RateLimitRule> = {
  'import.create': {
    limit: 20,
    windowSeconds: 600,
    message: 'You have started a lot of imports recently. Wait a few minutes and try again.',
  },
  'import.inspect': {
    limit: 60,
    windowSeconds: 600,
    message: 'Too many attempts to read that file. Wait a few minutes and try again.',
  },
  'import.confirm': {
    limit: 40,
    windowSeconds: 600,
    message: 'Too many imports started at once. Wait a few minutes and try again.',
  },
  'import.process': {
    limit: 60,
    windowSeconds: 600,
    message: 'That import is already being processed. Give it a moment.',
  },
  'import.export': {
    limit: 30,
    windowSeconds: 600,
    message: 'Too many downloads. Wait a few minutes and try again.',
  },
  // P3. Adding a domain provisions a provider identity, so it is the tightest of
  // the three. Re-checking is looser because a person legitimately clicks
  // "check again" while waiting for DNS to propagate — but every click costs a
  // provider call and two DNS queries, so it is not free.
  'sender.domain_add': {
    limit: 10,
    windowSeconds: 600,
    message: 'You have added a lot of domains recently. Wait a few minutes and try again.',
  },
  'sender.domain_verify': {
    limit: 30,
    windowSeconds: 600,
    message: 'Too many verification checks. DNS changes can take hours — wait a few minutes and try again.',
  },
  'sender.identity_write': {
    limit: 40,
    windowSeconds: 600,
    message: 'Too many changes to sender addresses. Wait a few minutes and try again.',
  },
  // P4. Editing content and campaign settings is cheap and iterative, so these
  // are loose — they exist to bound a script, not to interrupt a person writing
  // an email. Preflight is the tightest of the three because each run costs an
  // audience count over the whole list.
  'template.write': {
    limit: 120,
    windowSeconds: 600,
    message: 'Too many template changes. Wait a moment and try again.',
  },
  'campaign.write': {
    limit: 120,
    windowSeconds: 600,
    message: 'Too many campaign changes. Wait a moment and try again.',
  },
  'campaign.preflight': {
    limit: 60,
    windowSeconds: 600,
    message: 'Too many preflight checks. Wait a moment and try again.',
  },
  // Password guessing against one account, from anywhere. This is the control
  // that holds regardless of how requests are spread across addresses. The
  // cost is that someone who knows an address can lock its owner out of the
  // password form for up to 15 minutes — the usual trade, and bounded.
  'auth.sign_in_account': {
    limit: 10,
    windowSeconds: 900,
    message: 'Too many sign-in attempts for this account. Wait 15 minutes and try again.',
  },
  // Spraying many accounts from one client. Best effort: it trusts the first
  // X-Forwarded-For hop, which the hosting edge sets (Vercel overwrites it) but
  // which is spoofable where no proxy does. The per-account limit above does not
  // depend on it.
  'auth.sign_in_ip': {
    limit: 50,
    windowSeconds: 900,
    message: 'Too many sign-in attempts. Wait 15 minutes and try again.',
  },
  'auth.sign_up_ip': {
    limit: 10,
    windowSeconds: 3600,
    message: 'Too many sign-up attempts. Wait an hour and try again.',
  },
};

/**
 * The bucket key.
 *
 * Scoped by user *and* workspace: limiting by workspace alone lets one member
 * exhaust the window for colleagues, and limiting by user alone lets a single
 * account spread abuse across workspaces. The subject is a UUID from a verified
 * session, never a header — `X-Forwarded-For` is trivially spoofed, so an
 * IP-keyed limiter on this path is a limiter an attacker chooses to obey.
 */
export function bucketKey(action: RateLimitAction, userId: string, workspaceId: string): string {
  return `${action}:u:${userId}:w:${workspaceId}`;
}

/**
 * The bucket key for an unauthenticated subject: an email address or a client
 * address. Hashed, so the limiter table holds no raw address of either kind.
 */
export function subjectBucketKey(action: RateLimitAction, subject: string): string {
  const digest = createHash('sha256').update(subject.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 40);
  return `${action}:s:${digest}`;
}

export interface RateLimitDecision {
  allowed: boolean;
  action: RateLimitAction;
}

/**
 * Consumes one unit. Returns the decision rather than throwing, for callers that
 * need to record the refusal before responding.
 *
 * Fails **open** on a database error, and says so loudly. This is a deliberate
 * trade: the limiter protects against abuse, and making it a hard dependency of
 * every import would mean a transient database fault takes the feature offline
 * for legitimate users. Authorization is never handled this way — that fails
 * closed, in `requireWorkspace`.
 */
export async function consumeRateLimit(
  action: RateLimitAction,
  userId: string,
  workspaceId: string,
): Promise<RateLimitDecision> {
  return consumeKey(action, bucketKey(action, userId, workspaceId), { workspaceId, userId });
}

/** As `consumeRateLimit`, for an unauthenticated subject (see `subjectBucketKey`). */
export async function consumeSubjectRateLimit(action: RateLimitAction, subject: string): Promise<RateLimitDecision> {
  return consumeKey(action, subjectBucketKey(action, subject), {});
}

async function consumeKey(
  action: RateLimitAction,
  key: string,
  context: { workspaceId?: string; userId?: string },
): Promise<RateLimitDecision> {
  const rule = RATE_LIMITS[action];

  try {
    const db = unscopedServiceClient('rate limit counter (keyed by user, not workspace)');
    const { data, error } = await db.rpc('consume_rate_limit', {
      p_bucket_key: key,
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
    });

    if (error !== null) {
      logger.error('rate limit check failed — failing open', {
        action,
        dbError: error.message,
      });
      return { allowed: true, action };
    }

    const allowed = data === true;
    if (!allowed) {
      logger.warn('rate limit exceeded', { action, ...context });
    }
    return { allowed, action };
  } catch (cause) {
    logger.error('rate limit check threw — failing open', { action, cause });
    return { allowed: true, action };
  }
}

/** Consumes one unit and throws `RateLimitedError` when the window is exhausted. */
export async function enforceRateLimit(
  action: RateLimitAction,
  userId: string,
  workspaceId: string,
): Promise<void> {
  const decision = await consumeRateLimit(action, userId, workspaceId);
  if (!decision.allowed) throw new RateLimitedError(RATE_LIMITS[action].message);
}
