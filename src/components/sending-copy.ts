import type { SendingMode } from '@/lib/sending/gate';

/**
 * Plain-language descriptions of the sending mode, for people who do not know
 * (or need to know) how delivery is wired. The technical wording in
 * `lib/sending/gate` stays the source of truth and is still shown to
 * administrators under "Technical details".
 */
export const SENDING_MODE_SHORT: Record<SendingMode, string> = {
  disabled: 'Email sending off',
  dry_run: 'Test mode · nothing delivered',
  live: 'Live sending',
};

export const SENDING_MODE_HEADLINE: Record<SendingMode, string> = {
  disabled: 'Email sending is currently turned off',
  dry_run: 'Email sending is in test mode',
  live: 'Email sending is on',
};

export const SENDING_MODE_EXPLANATION: Record<SendingMode, string> = {
  disabled:
    'You can prepare and schedule campaigns safely, but no emails will be delivered until sending is turned on for your workspace.',
  dry_run:
    'Campaigns run exactly as they would for real, so you can check everything works — but no email reaches anyone.',
  live: 'Scheduled campaigns will be delivered to their recipients once every check passes.',
};

export const SENDING_MODE_BADGE: Record<SendingMode, string> = {
  disabled: 'Off',
  dry_run: 'Test mode',
  live: 'On',
};
