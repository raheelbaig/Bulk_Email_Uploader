import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { PreflightIssue, PreflightResult, PreflightSeverity } from '@/lib/campaigns/preflight';

/**
 * The preflight verdict, rendered.
 *
 * Blockers, warnings and notices are kept visually distinct on purpose. A list
 * that treats "DMARC is not enforcing" the same as "there is nobody to send to"
 * trains people to skim it, and the one that mattered is the one they skim past.
 * Each group is labelled in words as well as colour.
 */

const ICON: Record<PreflightSeverity, typeof Info> = {
  blocker: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const TONE: Record<PreflightSeverity, string> = {
  blocker: 'text-(--color-danger)',
  warning: 'text-(--color-warning)',
  info: 'text-(--color-muted-foreground)',
};

const GROUP_LABEL: Record<PreflightSeverity, string> = {
  blocker: 'Must fix before scheduling',
  warning: 'Worth checking',
  info: 'Good to know',
};

function IssueRow({ issue }: { issue: PreflightIssue }) {
  const Icon = ICON[issue.severity];
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon className={cn('mt-0.5 size-4 shrink-0', TONE[issue.severity])} aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium">{issue.title}</p>
        <p className="text-sm leading-relaxed text-(--color-muted-foreground)">{issue.message}</p>
        {issue.remediation !== undefined && (
          <p className="mt-1 text-sm font-medium text-(--color-foreground)/80">{issue.remediation}</p>
        )}
      </div>
    </li>
  );
}

/**
 * `ready` overrides the headline when the page knows more than the verdict —
 * the builder's "check" run treats a missing send time as a notice, but a
 * campaign without one cannot be scheduled, so it must not read "Ready".
 */
export function PreflightReport({ result, ready = result.ready }: { result: PreflightResult; ready?: boolean }) {
  const groups: Array<[PreflightSeverity, PreflightIssue[]]> = [
    ['blocker', result.blockers],
    ['warning', result.warnings],
    ['info', result.info],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {ready ? (
          <>
            <CheckCircle2 className="size-5 text-(--color-success)" aria-hidden />
            <span className="font-semibold">Ready to schedule</span>
          </>
        ) : (
          <>
            <XCircle className="size-5 text-(--color-danger)" aria-hidden />
            <span className="font-semibold">Not ready yet</span>
          </>
        )}
        {result.blockers.length > 0 && (
          <Badge tone="danger">
            {result.blockers.length} to fix
          </Badge>
        )}
        {result.warnings.length > 0 && (
          <Badge tone="warning">
            {result.warnings.length} {result.warnings.length === 1 ? 'warning' : 'warnings'}
          </Badge>
        )}
      </div>

      {groups
        .filter(([, issues]) => issues.length > 0)
        .map(([severity, issues]) => (
          <div key={severity} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-wider text-(--color-muted-foreground) uppercase">
              {GROUP_LABEL[severity]}
            </h3>
            <ul
              className={cn(
                'divide-y overflow-hidden rounded-lg border bg-(--color-surface)',
                severity === 'blocker' && 'border-(--color-danger-border)',
              )}
            >
              {issues.map((issue, index) => (
                <IssueRow key={`${issue.code}-${index}`} issue={issue} />
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}
