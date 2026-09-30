import {
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  Clock,
  Info,
  Loader,
  Pause,
  Send,
  XCircle,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { STATUS_LABEL as CAMPAIGN_LABEL, STATUS_TONE as CAMPAIGN_TONE, type CampaignStatus } from '@/lib/campaigns/status';

/**
 * One status vocabulary. Every badge carries text and an icon, so a status is
 * never communicated by colour alone.
 */

const TONE_ICON: Record<BadgeTone, LucideIcon> = {
  neutral: Circle,
  positive: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
};

export function StatusBadge({
  tone,
  label,
  icon,
  className,
}: {
  tone: BadgeTone;
  label: string;
  icon?: LucideIcon;
  className?: string;
}) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <Badge tone={tone} {...(className !== undefined ? { className } : {})}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}

const CAMPAIGN_ICON: Record<CampaignStatus, LucideIcon> = {
  draft: CircleDashed,
  validating: Loader,
  scheduled: Clock,
  queued: Clock,
  sending: Send,
  paused: Pause,
  completed: CheckCircle2,
  cancelled: Ban,
  failed: XCircle,
};

/** Campaign statuses read as progress, so scheduled is informational, not success. */
const CAMPAIGN_DISPLAY_TONE: Partial<Record<CampaignStatus, BadgeTone>> = {
  scheduled: 'info',
  queued: 'info',
  sending: 'info',
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <StatusBadge
      tone={CAMPAIGN_DISPLAY_TONE[status] ?? CAMPAIGN_TONE[status]}
      label={CAMPAIGN_LABEL[status]}
      icon={CAMPAIGN_ICON[status]}
    />
  );
}

const CONTACT_STATUS: Record<string, { tone: BadgeTone; label: string; icon: LucideIcon }> = {
  active: { tone: 'positive', label: 'Active', icon: CheckCircle2 },
  suppressed: { tone: 'warning', label: 'Unsubscribed or blocked', icon: Ban },
  invalid: { tone: 'danger', label: 'Invalid address', icon: XCircle },
};

/** A contact's mailability, in words: active, unsubscribed or blocked, or invalid. */
export function ContactStatusBadge({ status }: { status: string }) {
  const entry = CONTACT_STATUS[status] ?? { tone: 'neutral' as const, label: status, icon: Circle };
  return <StatusBadge tone={entry.tone} label={entry.label} icon={entry.icon} />;
}
