import type { PreflightIssue, PreflightResult } from '@/lib/campaigns/preflight';
import { SENDING_MODE_EXPLANATION, SENDING_MODE_HEADLINE } from '@/components/sending-copy';

/**
 * Preflight issues in the words a person sending a campaign uses.
 *
 * `lib/campaigns/preflight` stays the single authority for *whether* something
 * blocks a campaign; its wording is written for engineers and logs ("suppression
 * list", "frozen", environment variable names). This file only rewrites what is
 * displayed, keyed by the issue code, and never adds, removes or re-grades an
 * issue — `friendlyResult` maps each issue one to one. The original wording is
 * still shown to owners and admins under "Technical details".
 */

type Copy = Partial<Pick<PreflightIssue, 'title' | 'message' | 'remediation'>> & {
  /** Drop the engine's remediation line without replacing it. */
  noRemediation?: boolean;
};

const SENDER_NOT_READY: Copy = {
  title: 'Sender isn’t verified yet',
  remediation: 'Open Senders and finish setting up this domain.',
};

/** Leading number in an engine message, e.g. "12 contacts in this list…". */
function leadingCount(message: string): string | null {
  const match = /^([\d,.  ]+)\s/.exec(message);
  return match?.[1] ?? null;
}

function copyFor(issue: PreflightIssue): Copy | null {
  switch (issue.code) {
    case 'audience_missing':
      return { title: 'No audience chosen', message: 'Choose which list should receive this campaign.', noRemediation: true };
    case 'audience_no_eligible':
      return {
        message: issue.message.replace('is suppressed or inactive', 'has unsubscribed, is blocked or is inactive'),
        remediation: 'Choose a different list, or check Unsubscribed & blocked.',
      };
    case 'audience_has_suppressed': {
      const count = leadingCount(issue.message);
      return {
        title: 'Some people on this list are unsubscribed or blocked',
        message: `${count ?? 'Some'} ${count === '1' ? 'person' : 'people'} on this list won’t receive it because they unsubscribed or were blocked.`,
      };
    }
    case 'audience_has_inactive': {
      const count = leadingCount(issue.message);
      return {
        title: 'Some contacts are inactive',
        message: `${count ?? 'Some'} ${count === '1' ? 'contact' : 'contacts'} on this list ${count === '1' ? 'is' : 'are'} marked invalid or inactive and will be skipped.`,
      };
    }
    case 'audience_size':
      return { title: 'Recipients' };
    case 'sender_not_selected':
      return { title: 'No sender chosen', message: 'Choose which address this campaign is sent from.', noRemediation: true };
    case 'sender_identity_missing':
      return { title: 'Sender is unavailable', message: 'The chosen sender address no longer exists.', remediation: 'Choose a different sender.' };
    case 'sender_domain_missing':
    case 'sender_identity_domain_mismatch':
      return { ...SENDER_NOT_READY, message: 'The domain for this sender address is no longer set up.' };
    case 'sender_domain_never_checked':
      return { ...SENDER_NOT_READY, message: 'The sender’s domain hasn’t been verified yet.' };
    case 'sender_dkim_not_verified':
    case 'sender_spf_not_verified':
    case 'sender_mail_from_not_verified':
      return {
        ...SENDER_NOT_READY,
        message: 'Some of the DNS records for the sender’s domain haven’t been confirmed yet.',
      };
    case 'sender_identity_not_verified':
      return {
        ...SENDER_NOT_READY,
        message: 'This sender address hasn’t been confirmed yet. Checking its domain again usually fixes this.',
      };
    case 'sender_dmarc_not_enforcing':
      return {
        title: 'Your domain could be better protected',
        message:
          'Email will send, but your domain doesn’t yet tell inboxes to reject messages that pretend to be from you. You can tighten this later on the Senders page.',
      };
    case 'sender_dmarc_invalid':
      return {
        title: 'One of your domain’s DNS records has a mistake',
        message: 'The DMARC record for this domain couldn’t be read. Check it on the Senders page.',
      };
    case 'sender_verification_stale':
      return {
        title: 'Sender hasn’t been checked recently',
        message: 'Your domain’s DNS settings may have changed since it was last checked. Check it again on the Senders page.',
      };
    case 'sender_from':
      return { title: 'From' };
    case 'template_not_selected':
      return { title: 'No email chosen', message: 'Choose which email (template) to send.', noRemediation: true };
    case 'template_unavailable':
      return { title: 'Email is unavailable', message: 'The chosen template no longer exists.', remediation: 'Choose a different template.' };
    case 'template_subject_empty':
      return { title: 'Subject line is empty', message: 'The email has no subject line.', remediation: 'Open the template and add a subject.' };
    case 'template_body_empty':
      return { title: 'Email content is empty', message: 'The email has no content.', remediation: 'Open the template and write your email.' };
    case 'template_text_empty':
      return {
        title: 'Plain-text version is missing',
        message: 'Some inboxes show a plain-text version of your email, and this one is empty.',
        remediation: 'Open the template and save it again — the plain-text version is created automatically.',
      };
    case 'template_unsafe_content':
      return { title: 'The email contains content that isn’t allowed' };
    case 'template_no_preview_text':
      return {
        title: 'No preview text',
        message: 'Inboxes will show the first words of your email next to the subject instead.',
      };
    case 'template_large':
      return {
        title: 'The email is very long',
        message: 'Gmail cuts off very long emails, so the end of this one may be hidden.',
      };
    case 'template_version':
      // "\"Name\", version 3." — version numbers mean nothing to a recipient's sender.
      return { title: 'Email', message: issue.message.replace(/, version \d+\.$/, '') };
    case 'template_snapshot_stale':
      return {
        title: 'The template changed after you scheduled this campaign',
        message: 'This campaign will send the email as it was when you scheduled it, not your latest edits.',
        remediation: 'To send the latest version, move the campaign back to draft and schedule it again.',
      };
    case 'template_snapshot_missing':
      return {
        title: 'The email content is missing',
        message: 'This campaign has no saved copy of its email, so there is nothing to send.',
        remediation: 'Move it back to draft and schedule it again.',
      };
    case 'personalization_unknown_variable':
    case 'personalization_malformed_variable':
    case 'personalization_unsupported_syntax':
      return { title: 'A personalization field has a problem', remediation: 'Open the template and correct the field.' };
    case 'personalization_render_failed':
      return {
        title: 'Personalization couldn’t be checked',
        message: 'The email couldn’t be filled in for a sample contact.',
        remediation: 'Open the template and check its personalization fields.',
      };
    case 'personalization_missing_values':
      return { title: 'Some personalization fields are empty for the sample contact' };
    case 'unsubscribe_mechanism_unavailable':
      return {
        title: 'Unsubscribe links can’t be created yet',
        message:
          'Every marketing email must include a working unsubscribe link. This installation’s email sending setup isn’t finished, so links can’t be created yet.',
        remediation: 'This is part of the server’s sending setup, not a setting in the app.',
      };
    case 'unsubscribe_not_required':
      return {
        title: 'No unsubscribe link',
        message:
          'This campaign won’t include an unsubscribe link. That’s only appropriate for transactional email such as receipts. Sending marketing email without one leads to spam complaints.',
        remediation: 'Create the campaign again with the unsubscribe link switched on, unless this is transactional email.',
      };
    case 'postal_address_missing':
      return {
        title: 'Business address missing',
        message: 'Marketing emails must show your business’s postal address in the footer.',
        remediation: 'Add it in Settings.',
      };
    case 'schedule_missing':
      return { title: 'No send time', message: 'Choose when this campaign should be sent.', noRemediation: true };
    case 'schedule_in_past':
    case 'schedule_invalid':
      return { title: 'Send time needs changing', remediation: 'Choose a new date and time in the Schedule step.' };
    case 'schedule_time':
      return { title: 'Send time' };
    case 'schedule_far_future':
      return { title: 'Scheduled a long way ahead' };
    case 'sending_not_available':
      return { title: SENDING_MODE_HEADLINE.disabled, message: SENDING_MODE_EXPLANATION.disabled };
    case 'sending_dry_run':
      return { title: SENDING_MODE_HEADLINE.dry_run, message: SENDING_MODE_EXPLANATION.dry_run };
    case 'sending_live':
      return { title: SENDING_MODE_HEADLINE.live, message: SENDING_MODE_EXPLANATION.live };
    case 'campaign_not_editable':
      return { title: 'This campaign can’t be changed', remediation: 'Move it back to draft to make changes.' };
    default:
      return null;
  }
}

export function friendlyIssue(issue: PreflightIssue): PreflightIssue {
  const copy = copyFor(issue);
  if (copy === null) return issue;
  const { noRemediation, ...text } = copy;
  const merged: PreflightIssue = { ...issue, ...text };
  if (noRemediation === true) delete merged.remediation;
  return merged;
}

/** Same verdict, same issues, same order — only the displayed words change. */
export function friendlyResult(result: PreflightResult): PreflightResult {
  return {
    ready: result.ready,
    blockers: result.blockers.map(friendlyIssue),
    warnings: result.warnings.map(friendlyIssue),
    info: result.info.map(friendlyIssue),
    issues: result.issues.map(friendlyIssue),
  };
}
