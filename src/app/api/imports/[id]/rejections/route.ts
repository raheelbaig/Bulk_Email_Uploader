import { NextResponse } from 'next/server';
import { currentWorkspace } from '@/lib/auth/workspace';
import { getImport, listRejections } from '@/lib/imports/service';
import { enforceRateLimit } from '@/lib/rate-limit';
import { toSafeErrorBody } from '@/lib/errors';
import { correlationId, newRequestId, runWithContext } from '@/lib/observability/context';
import { logger } from '@/lib/observability/logger';
import { contentDisposition, toCsv } from '@/lib/imports/csv-export';
import { BUCKET_LABEL, MAX_PERSISTED_REJECTIONS } from '@/lib/imports/constants';

export const dynamic = 'force-dynamic';

/**
 * Rejected-row export.
 *
 * A route handler rather than a server action because the response *is* a file:
 * an action returns a value to React, not a `Content-Disposition`.
 *
 * Three security properties, in order of how easily each is got wrong:
 *
 *   1. **Authorization.** `currentWorkspace()` resolves the tenant from the
 *      session, and `getImport()` refuses an import belonging to anyone else.
 *      The id in the URL is a claim; nothing here trusts it. A cross-workspace
 *      request gets the same 403 as a nonexistent one.
 *
 *   2. **Formula injection.** Every cell goes through `escapeCsvCell`. The
 *      contents of this file are entirely attacker-supplied — that is what a
 *      rejected row *is* — and it is downloaded and opened in Excel by the
 *      person who uploaded it. See lib/imports/csv-export.ts.
 *
 *   3. **Header injection.** The filename in `Content-Disposition` is derived
 *      from the uploaded filename, so it is stripped to a safe character set
 *      and quoted before it reaches a header.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  return runWithContext(
    { requestId: newRequestId(), route: '/api/imports/[id]/rejections' },
    async () => {
      try {
        const { workspaceId, userId } = await currentWorkspace();
        await enforceRateLimit('import.export', userId, workspaceId);

        const record = await getImport(workspaceId, id);
        const rejections = await listRejections(workspaceId, id, MAX_PERSISTED_REJECTIONS);

        // The union of every header seen across the retained rows, so a row with
        // an extra column does not shift every later cell.
        const rawKeys: string[] = [];
        for (const rejection of rejections) {
          for (const key of Object.keys(rejection.raw_row)) {
            if (!rawKeys.includes(key)) rawKeys.push(key);
          }
        }

        const columns = [
          { key: '__row', label: 'Row' },
          { key: '__bucket', label: 'Category' },
          { key: '__reason', label: 'Reason' },
          ...rawKeys.map((key) => ({ key, label: key })),
        ];

        const rows = rejections.map((rejection) => ({
          __row: rejection.row_number,
          __bucket: BUCKET_LABEL[rejection.bucket],
          __reason: rejection.reason,
          ...rejection.raw_row,
        }));

        const csv = toCsv(columns, rows);
        const base = record.filename.replace(/\.[^.]+$/, '');

        logger.info('rejection export served', {
          importId: id,
          rowCount: rows.length,
        });

        return new NextResponse(csv, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': contentDisposition(`${base}-rejected-rows.csv`),
            // The response contains personal data; no cache may keep it.
            'Cache-Control': 'no-store, private',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch (err) {
        const { status, body } = toSafeErrorBody(err, correlationId());
        logger.warn('rejection export refused', { importId: id, status });
        return NextResponse.json(body, { status });
      }
    },
  );
}
