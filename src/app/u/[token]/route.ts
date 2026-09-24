import { writeAuditLog } from '@/lib/audit';
import { serviceForWorkspace } from '@/lib/db/service';
import { logger } from '@/lib/observability/logger';
import { readUnsubscribeToken } from '@/lib/unsubscribe/server';

/**
 * /u/[token] — the unsubscribe endpoint. ARCHITECTURE §10.4, with one deliberate
 * departure.
 *
 *   POST  performs the unsubscribe. This is what RFC 8058 one-click sends
 *         (`List-Unsubscribe=One-Click`), and what the confirmation page's
 *         button sends. Always 200 on a valid token, including a repeat — mail
 *         providers retry, and a non-2xx makes Gmail treat one-click as broken.
 *   GET   shows a page with one button. It does NOT unsubscribe.
 *
 * The departure: §10.4 suppresses on GET. Corporate mail filters (Microsoft
 * Safe Links, Mimecast, Proofpoint) fetch every link in an incoming message to
 * scan it, so a GET that unsubscribes silently removes people who never clicked.
 * One-click is unaffected — it is a POST by definition.
 *
 * No authentication, and no CSRF token, by necessity: the mail client posting
 * this has no session. The token is the capability — an HMAC the attacker cannot
 * forge (`lib/unsubscribe/token`) — and the only thing it can do is suppress
 * the one address it was minted for, which is the safe direction.
 *
 * Nothing about the recipient is echoed back: not the address, not the
 * campaign. A forwarded link reveals nothing to whoever opens it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111;line-height:1.5}button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #111;background:#111;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

const INVALID = () =>
  page(
    'Link not recognised',
    '<h1>This link is not valid</h1><p>It may have been copied incompletely. Try the unsubscribe link in the email again.</p>',
    400,
  );

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  if (readUnsubscribeToken(token) === null) return INVALID();

  // The form posts back to this same URL; the token is already in the path.
  return page(
    'Unsubscribe',
    '<h1>Unsubscribe</h1><p>Confirm that you no longer want to receive these emails.</p>' +
      '<form method="post"><button type="submit">Unsubscribe</button></form>',
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const claims = readUnsubscribeToken(token);
  if (claims === null) return INVALID();

  // Read and discarded: one-click bodies are `List-Unsubscribe=One-Click`, the
  // form's is empty, and neither changes what happens.
  await request.text().catch(() => '');

  try {
    const { data, error } = await serviceForWorkspace(claims.workspaceId).rpc('sending_record_unsubscribe', {
      p_workspace_id: claims.workspaceId,
      p_job_id: claims.jobId,
    });
    if (error !== null) throw new Error(error.message);

    if (data === true) {
      await writeAuditLog({
        workspaceId: claims.workspaceId,
        action: 'suppression.unsubscribed',
        actorType: 'system',
        entityType: 'campaign',
        entityId: claims.campaignId,
        metadata: { source: 'unsubscribe_link', jobId: claims.jobId },
      });
    }
    // `false` (already suppressed) and `null` (the job no longer exists) both
    // get the same answer: from the recipient's side, they are unsubscribed.
  } catch (cause) {
    logger.error('unsubscribe failed', { cause, workspaceId: claims.workspaceId });
    return page(
      'Something went wrong',
      '<h1>We could not process that just now</h1><p>Please try again in a few minutes.</p>',
      503,
    );
  }

  return page('Unsubscribed', '<h1>You have been unsubscribed</h1><p>You will not receive these emails any more.</p>');
}
