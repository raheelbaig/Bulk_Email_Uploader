import type { AuditAction } from '@/lib/audit';

/**
 * Human-readable names for audit actions. Display only — the stored action
 * codes are unchanged. An action missing here falls back to a tidied version
 * of its code rather than disappearing.
 */
export const ACTIVITY_LABEL: Record<AuditAction, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.signup': 'Account created',
  'auth.password_reset_requested': 'Password reset requested',
  'auth.password_changed': 'Password changed',
  'workspace.bootstrapped': 'Workspace created',
  'workspace.renamed': 'Workspace renamed',
  'workspace.settings_updated': 'Workspace settings updated',
  'contact.created': 'Contact added',
  'contact.updated': 'Contact updated',
  'contact.deleted': 'Contact deleted',
  'list.created': 'List created',
  'list.updated': 'List renamed',
  'list.deleted': 'List deleted',
  'list.member_added': 'Contact added to a list',
  'list.member_removed': 'Contact removed from a list',
  'import.started': 'Import started',
  'import.mapped': 'Import columns confirmed',
  'import.completed': 'Contact import completed',
  'import.failed': 'Contact import failed',
  'domain.added': 'Sending domain added',
  'domain.verified': 'Sending domain verified',
  'domain.verification_failed': 'Sending domain verification failed',
  'domain.updated': 'Sending domain checked',
  'domain.removed': 'Sending domain removed',
  'identity.added': 'Sender address added',
  'identity.updated': 'Sender address updated',
  'identity.removed': 'Sender address removed',
  'template.created': 'Template created',
  'template.updated': 'Template updated',
  'template.deleted': 'Template deleted',
  'campaign.created': 'Campaign created',
  'campaign.updated': 'Campaign updated',
  'campaign.deleted': 'Campaign deleted',
  'campaign.scheduled': 'Campaign scheduled',
  'campaign.unscheduled': 'Campaign moved back to draft',
  'campaign.preflight_passed': 'Campaign passed its checks',
  'campaign.preflight_failed': 'Campaign checks found problems',
  'campaign.cancelled': 'Campaign cancelled',
  'suppression.added_manual': 'Address blocked',
  'suppression.removed': 'Address unblocked',
  'campaign.launched': 'Campaign started sending',
  'campaign.paused': 'Campaign paused',
  'campaign.resumed': 'Campaign resumed',
  'campaign.missed_schedule': 'Campaign missed its scheduled time',
  'campaign.completed': 'Campaign finished sending',
  'campaign.failed': 'Campaign failed',
  'policy.auto_paused': 'Sending paused automatically',
  'send.uncertain_held': 'Message delivery unconfirmed',
  'send.uncertain_redispatched': 'Unconfirmed message sent again',
  'send.uncertain_left': 'Unconfirmed message left as is',
  'suppression.unsubscribed': 'Someone unsubscribed',
  'suppression.auto': 'Address blocked automatically',
  'provider_event.recorded': 'Delivery report received',
  'send.confirmed_by_provider': 'Amazon SES confirmed a message was sent',
  'policy.rate_changed': 'Sending rate changed',
  'policy.health_state_changed': 'Sending health changed',
  'test_send.dispatched': 'Test email sent',
};

export function activityLabel(action: string): string {
  const known = (ACTIVITY_LABEL as Record<string, string>)[action];
  if (known !== undefined) return known;
  const tidy = action.replace(/[._]/g, ' ');
  return tidy.charAt(0).toUpperCase() + tidy.slice(1);
}

/** "3 minutes ago", "yesterday", or a date — relative to `now`. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return rtf.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return rtf.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 7 * 86_400) return rtf.format(-Math.floor(seconds / 86_400), 'day');
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
