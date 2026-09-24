import { serverEnv } from '@/lib/env';
import { writeAuditLog } from '@/lib/audit';
import { serviceEligibilityReader } from '@/lib/eligibility/readers';
import { logger } from '@/lib/observability/logger';
import { newRequestId, runWithContext } from '@/lib/observability/context';
import { emailProvider, isProviderConfigured } from '@/lib/sender/provider';
import { sendingConfig } from '@/lib/sending/config';
import { budgetFromLimits } from '@/lib/sending/limits';
import { outboundProviderFor } from '@/lib/sending/provider';
import { sendingStore } from '@/lib/sending/store';
import { runSendTick } from '@/lib/sending/worker';
import { verifyWorkerRequest } from '@/lib/sending/worker-auth';
import { unsubscribeUrlFor } from '@/lib/unsubscribe/server';

/**
 * POST /api/internal/worker/tick — ARCHITECTURE §13.1.
 *
 * The sending engine's only entry point. Called by the scheduler (pg_cron +
 * pg_net, `supabase/ops/p5_schedule.sql`), never by a browser:
 *
 *   - HMAC over timestamp + body, ±300 s (`lib/sending/worker-auth`). No
 *     session, no cookie, no CSRF surface; the signature is the credential.
 *   - Every failure of authentication is the same bare 401, so the endpoint
 *     does not say which part was wrong.
 *   - With no WORKER_HMAC_SECRET configured it refuses everything — there is no
 *     "open" configuration.
 *   - The body is ignored beyond the signature. A caller cannot choose a
 *     workspace, a campaign or a mode; the tick decides all three from the
 *     database and the environment.
 *
 * The response is counts only: no address, id or message content.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel caps this by plan; the tick keeps its own 45 s deadline inside it and
// hands back any claim it has not attempted, so a cut-off tick loses nothing.
export const maxDuration = 60;

const MAX_BODY_BYTES = 4096;

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  const auth = verifyWorkerRequest({
    secret: serverEnv().WORKER_HMAC_SECRET,
    timestamp: request.headers.get('x-timestamp'),
    signature: request.headers.get('x-signature'),
    body,
  });
  if (!auth.ok) {
    logger.warn('worker request rejected', { reason: auth.reason });
    return new Response(null, { status: 401 });
  }

  return runWithContext({ requestId: newRequestId(), route: 'worker:tick' }, async () => {
    try {
      const config = sendingConfig();
      const summary = await runSendTick({
        store: sendingStore(),
        config,
        providerFor: outboundProviderFor,
        eligibility: serviceEligibilityReader(),
        unsubscribeUrl: (claims) => unsubscribeUrlFor(claims, config.appUrl),
        providerBudget: async () => {
          if (!isProviderConfigured()) return null;
          try {
            return budgetFromLimits(await emailProvider().getSendingLimits(), config.providerSafetyFactor);
          } catch (cause) {
            logger.warn('provider limits could not be read', { cause });
            return null;
          }
        },
        audit: writeAuditLog,
        logger,
      });
      return Response.json(summary, { status: 200 });
    } catch (cause) {
      logger.error('send tick failed', { cause });
      return Response.json({ error: 'tick_failed' }, { status: 500 });
    }
  });
}
