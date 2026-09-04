import { Check, CircleDashed, TriangleAlert, X } from 'lucide-react';
import type { VerificationStatus } from '@/lib/sender/status';

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
  verified: 'text-emerald-600 dark:text-emerald-400',
  pending: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
  not_configured: 'text-[--color-muted-foreground]',
};

const STATUS_LABEL: Record<VerificationStatus, string> = {
  verified: 'verified',
  pending: 'pending',
  failed: 'failed',
  not_configured: 'not configured',
};

export interface CheckRow {
  label: string;
  status: VerificationStatus;
}

export function SenderCheck({ label, status }: CheckRow) {
  const Icon = ICON[status];
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className={`h-3.5 w-3.5 ${TONE[status]}`} aria-hidden />
      <span className="w-24 text-[--color-muted-foreground]">{label}</span>
      <span className={TONE[status]}>{STATUS_LABEL[status]}</span>
    </div>
  );
}

export function SenderChecks({ checks }: { checks: CheckRow[] }) {
  return (
    <div className="flex flex-col gap-1">
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
