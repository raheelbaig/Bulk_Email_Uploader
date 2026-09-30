import { Check, CircleDashed, TriangleAlert, X } from 'lucide-react';
import type { VerificationStatus } from '@/lib/sender/status';
import { CHECK_EXPLANATION } from '@/components/sender-copy';
import { cn } from '@/lib/utils';

/**
 * The four-check summary shown on every domain card and setup page.
 *
 * Rendered from the stored statuses only. There is no prop that lets a caller
 * assert a check has passed, and no client code path that can set one — the
 * values arrive from a server component that read them from the database.
 */

const ICON: Record<VerificationStatus, typeof Check> = {
  verified: Check,
  pending: CircleDashed,
  failed: X,
  not_configured: TriangleAlert,
};

const TONE: Record<VerificationStatus, string> = {
  verified: 'text-(--color-success-foreground)',
  pending: 'text-(--color-warning-foreground)',
  failed: 'text-(--color-danger-foreground)',
  not_configured: 'text-(--color-muted-foreground)',
};

const STATUS_LABEL: Record<VerificationStatus, string> = {
  verified: 'Verified',
  pending: 'Waiting',
  failed: 'Not passing',
  not_configured: 'Not set up',
};

export interface CheckRow {
  label: keyof typeof CHECK_EXPLANATION;
  status: VerificationStatus;
}

export function SenderCheck({ label, status }: CheckRow) {
  const Icon = ICON[status];
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className={cn('size-3.5 shrink-0', TONE[status])} aria-hidden />
      <span className="w-24 shrink-0 text-(--color-muted-foreground)">{label}</span>
      <span className={cn('font-medium', TONE[status])}>{STATUS_LABEL[status]}</span>
    </div>
  );
}

/**
 * `detailed` adds a plain-language line under each check, for the domain's own
 * page; the compact grid is for the domain cards.
 */
export function SenderChecks({ checks, detailed = false }: { checks: CheckRow[]; detailed?: boolean }) {
  if (detailed) {
    return (
      <ul className="flex flex-col divide-y rounded-lg border bg-(--color-surface-subtle)">
        {checks.map((check) => (
          <li key={check.label} className="flex flex-col gap-0.5 px-3 py-2.5">
            <SenderCheck {...check} />
            <p className="pl-5.5 text-xs leading-relaxed text-(--color-muted-foreground)">
              {CHECK_EXPLANATION[check.label]}
            </p>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="grid gap-1.5 rounded-lg border bg-(--color-surface-subtle) px-3 py-2.5 sm:grid-cols-2">
      {checks.map((check) => (
        <SenderCheck key={check.label} {...check} />
      ))}
    </div>
  );
}

/** The canonical order and labels, so every surface lists them identically. */
export function checksFor(record: {
  spf_status: VerificationStatus;
  dkim_status: VerificationStatus;
  dmarc_status: VerificationStatus;
  mail_from_status: VerificationStatus;
}): CheckRow[] {
  return [
    { label: 'SPF', status: record.spf_status },
    { label: 'DKIM', status: record.dkim_status },
    { label: 'DMARC', status: record.dmarc_status },
    { label: 'MAIL FROM', status: record.mail_from_status },
  ];
}
