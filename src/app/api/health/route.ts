import { NextResponse } from 'next/server';
import { newRequestId, runWithContext } from '@/lib/observability/context';

export const dynamic = 'force-dynamic';

/**
 * Liveness probe. Deliberately discloses nothing: no version, no dependency
 * status, no environment detail. A health endpoint is unauthenticated, so it is
 * an information-disclosure surface if it reports anything useful to an attacker.
 */
export function GET() {
  return runWithContext({ requestId: newRequestId(), route: '/api/health' }, () =>
    NextResponse.json({ status: 'ok' }, { status: 200 }),
  );
}
