import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { PreflightIssue, PreflightResult, PreflightSeverity } from '@/lib/campaigns/preflight';

/**
 * The preflight verdict, rendered.
 *
 * Blockers, warnings and notices are kept visually distinct on purpose. A list
 * that treats "DMARC is not enforcing" the same as "there is nobody to send to"
 * trains people to skim it, and the one that mattered is the one they skim past.
 */

const ICON: Record<PreflightSeverity, typeof Info> = {
  blocker: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const TONE: Record<PreflightSeverity, string> = {
  blocker: 'text-[--color-destructive]',
  warning: 'text-amber-600 dark:text-amber-400',
  info: 'text-[--color-muted-foreground]',
};

function IssueRow({ issue }: { issue: PreflightIssue }) {
  const Icon = ICON[issue.severity];
  return (
    <li className="flex gap-2.5 px-4 py-2.5">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE[issue.severity]}`} aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium">{issue.title}</p>
        <p className="text-sm text-[--color-muted-foreground]">{issue.message}</p>
        {issue.remediation !== undefined && (
          <p className="mt-0.5 text-xs text-[--color-muted-foreground]">{issue.remediation}</p>
        )}
      </div>
    </li>
  );
}

export function PreflightReport({ result }: { result: PreflightResult }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {result.ready ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span className="font-medium">Ready to schedule</span>
          </>
        ) : (
          <>
            <XCircle className="h-4 w-4 text-[--color-destructive]" aria-hidden />
            <span className="font-medium">Blocked</span>
          </>
        )}
        <Badge tone={result.ready ? 'positive' : 'danger'}>
          {result.blockers.length} {result.blockers.length === 1 ? 'blocker' : 'blockers'}
        </Badge>
        {result.warnings.length > 0 && (
          <Badge tone="warning">
            {result.warnings.length} {result.warnings.length === 1 ? 'warning' : 'warnings'}
          </Badge>
        )}
      </div>

      <ul className="divide-y rounded-lg border">
        {[...result.blockers, ...result.warnings, ...result.info].map((issue, index) => (
          <IssueRow key={`${issue.code}-${index}`} issue={issue} />
        ))}
      </ul>
    </div>
  );
}
