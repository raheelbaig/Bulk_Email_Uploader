/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CAMPAIGN PREFLIGHT ENGINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The single place that answers "may this campaign go out?".
 *
 * ARCHITECTURE §1.3: a campaign cannot leave `draft` without passing preflight.
 * From P5 the send path calls this again immediately before launch, because a
 * domain can lose verification between scheduling and delivery. Adding a new
 * caller means calling this function, not writing another one.
 *
 * ── Why the decision is pure ─────────────────────────────────────────────
 *
 * `evaluateCampaignPreflight` takes records and returns a verdict. It performs
 * no I/O, exactly like `evaluateSenderReadiness` and for the same reason: the
 * request path, the future worker under the service role, and the test suite all
 * reach the identical conclusion from the identical inputs. `runCampaignPreflight`
 * in `./service.ts` is the thin half that does the fetching.
 *
 * ── Why it does not reimplement anything ─────────────────────────────────
 *
 * Sender readiness comes from `getSenderReadiness` — this module never reads
 * `dkim_status`. Eligibility counts come from the eligibility authority's own
 * SQL. Template validity comes from the template engine's own scan and render.
 * Preflight *composes* the authorities; it is not a fourth opinion.
 *
 * ── Three severities, not one ────────────────────────────────────────────
 *
 * A blocker is a reason the campaign must not go out. A warning is something a
 * person should see and may accept — an unenforced DMARC policy, a list with
 * suppressed members. Informational notices carry the facts a reviewer needs to
 * confirm the campaign is the one they meant. Treating every issue as a blocker
 * teaches people to ignore the list, which is how the real blocker gets missed.
 *
 * Deliberately free of `server-only`: pure, and the review step renders it.
 */

import {
  BLOCKER_MESSAGE as SENDER_BLOCKER_MESSAGE,
  WARNING_MESSAGE as SENDER_WARNING_MESSAGE,
  type SenderBlocker,
  type SenderReadiness,
  type SenderWarning,
} from '@/lib/sender/readiness';
import type { AudienceCounts } from '@/lib/eligibility';
import type { RenderedMessage } from '@/lib/templates/render';
import type { TemplateRecord } from '@/lib/templates/ports';
import { MAX_HTML_CHARS } from '@/lib/templates/constants';
import { checkStoredSchedule, formatInZone, SCHEDULE_FAILURE_MESSAGE } from './schedule';
import { isEditable, type CampaignStatus } from './status';
import { snapshotIsStale, type TemplateSnapshot } from './snapshot';
import type { CampaignRecord } from './ports';

// ─────────────────────────────────────────────────────────────────────────────
// The unsubscribe mechanism
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether this deployment has a working one-click unsubscribe.
 *
 * It does not. P6 builds the signed unsubscribe endpoint, the `List-Unsubscribe`
 * headers and the suppression write behind them. Faking any of that now would be
 * worse than not having it: a link that looks like an unsubscribe and does
 * nothing is a compliance failure with a UI.
 *
 * So the fact is recorded as a constant, and the preflight *says so*, on every
 * campaign that requires it. P6 flips this to `true` when the endpoint exists.
 */
export const UNSUBSCRIBE_MECHANISM_AVAILABLE = false;

/**
 * Whether a missing unsubscribe mechanism blocks a campaign.
 *
 * At P4 it does not, and the reason is worth stating precisely: P4 cannot send.
 * A campaign that requires unsubscribe and has no mechanism cannot violate
 * anything, because it cannot reach a recipient — so blocking it here would stop
 * people preparing campaigns for a capability that is deliberately not built
 * yet, and would teach them that the preflight list is noise.
 *
 * P5 must flip this to `true` in the same change that adds a send path, and
 * `tests/campaign-preflight.test.ts` exercises both settings so the enforcing
 * behaviour is proven before it is needed.
 */
export const UNSUBSCRIBE_ENFORCED = false;

// ─────────────────────────────────────────────────────────────────────────────
// Result shape
// ─────────────────────────────────────────────────────────────────────────────

export type PreflightSeverity = 'blocker' | 'warning' | 'info';

export type PreflightCode =
  // campaign
  | 'campaign_not_editable'
  // audience
  | 'audience_missing'
  | 'audience_unavailable'
  | 'audience_empty'
  | 'audience_no_eligible'
  | 'audience_has_suppressed'
  | 'audience_has_inactive'
  | 'audience_count_capped'
  | 'audience_size'
  // sender — one per sender-readiness blocker, so each is separately actionable
  | 'sender_not_selected'
  | 'sender_identity_missing'
  | 'sender_domain_missing'
  | 'sender_identity_domain_mismatch'
  | 'sender_domain_never_checked'
  | 'sender_dkim_not_verified'
  | 'sender_spf_not_verified'
  | 'sender_mail_from_not_verified'
  | 'sender_identity_not_verified'
  | 'sender_dmarc_not_enforcing'
  | 'sender_dmarc_invalid'
  | 'sender_verification_stale'
  | 'sender_from'
  // template
  | 'template_not_selected'
  | 'template_unavailable'
  | 'template_subject_empty'
  | 'template_body_empty'
  | 'template_text_empty'
  | 'template_unsafe_content'
  | 'template_no_preview_text'
  | 'template_large'
  | 'template_version'
  | 'template_snapshot_stale'
  // personalization
  | 'personalization_unknown_variable'
  | 'personalization_malformed_variable'
  | 'personalization_unsupported_syntax'
  | 'personalization_render_failed'
  | 'personalization_missing_values'
  | 'personalization_none'
  // unsubscribe
  | 'unsubscribe_mechanism_unavailable'
  | 'unsubscribe_not_required'
  // schedule
  | 'schedule_missing'
  | 'schedule_invalid'
  | 'schedule_in_past'
  | 'schedule_far_future'
  | 'schedule_time'
  // the standing guarantee
  | 'sending_not_available';

export interface PreflightIssue {
  code: PreflightCode;
  severity: PreflightSeverity;
  title: string;
  /** Safe to show a user: says what is wrong, never why we know. */
  message: string;
  /** What to do about it, when there is something to do. */
  remediation?: string;
}

export interface PreflightResult {
  ready: boolean;
  blockers: PreflightIssue[];
  warnings: PreflightIssue[];
  info: PreflightIssue[];
  /** Everything, in the order produced. Deterministic for a given input. */
  issues: PreflightIssue[];
}

/** Whether the run is a check or the final gate before scheduling. */
export type PreflightIntent = 'check' | 'schedule';

export interface PreflightInput {
  campaign: CampaignRecord;
  intent: PreflightIntent;

  /** Null when `campaign.list_id` names a list this workspace cannot see. */
  list: { id: string; name: string; contact_count: number } | null;
  audience: AudienceCounts;

  /** Null when no sender is selected. */
  senderIdentity: { id: string; from_email: string; from_name: string } | null;
  /** The verdict from the readiness authority. Never recomputed here. */
  senderReadiness: SenderReadiness | null;

  /** Null when `campaign.template_id` names a template this workspace cannot see. */
  template: TemplateRecord | null;
  /** The frozen copy, when the campaign has one. */
  snapshot: TemplateSnapshot | null;
  /** A render of the template against a sample contact. Null when there is no template. */
  sampleRender: RenderedMessage | null;

  unsubscribe?: {
    mechanismAvailable?: boolean;
    /** Injected so the enforcing behaviour is testable before P5 turns it on. */
    enforced?: boolean;
  };

  now?: Date;
  timeZone?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The evaluation
// ─────────────────────────────────────────────────────────────────────────────

/** Maps each sender-readiness blocker to its own preflight code. */
const SENDER_BLOCKER_CODE: Record<SenderBlocker, PreflightCode> = {
  sender_identity_missing: 'sender_identity_missing',
  sender_domain_missing: 'sender_domain_missing',
  identity_domain_mismatch: 'sender_identity_domain_mismatch',
  domain_never_checked: 'sender_domain_never_checked',
  dkim_not_verified: 'sender_dkim_not_verified',
  spf_not_verified: 'sender_spf_not_verified',
  mail_from_not_verified: 'sender_mail_from_not_verified',
  identity_not_marked_verified: 'sender_identity_not_verified',
};

const SENDER_WARNING_CODE: Record<SenderWarning, PreflightCode> = {
  dmarc_not_enforcing: 'sender_dmarc_not_enforcing',
  dmarc_invalid: 'sender_dmarc_invalid',
  verification_stale: 'sender_verification_stale',
};

export function evaluateCampaignPreflight(input: PreflightInput): PreflightResult {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? 'UTC';
  const mechanismAvailable = input.unsubscribe?.mechanismAvailable ?? UNSUBSCRIBE_MECHANISM_AVAILABLE;
  const enforced = input.unsubscribe?.enforced ?? UNSUBSCRIBE_ENFORCED;

  const issues: PreflightIssue[] = [];
  const add = (issue: PreflightIssue): void => {
    issues.push(issue);
  };

  // ── The campaign itself ─────────────────────────────────────────────────
  if (!isEditable(input.campaign.status as CampaignStatus)) {
    add({
      code: 'campaign_not_editable',
      severity: 'blocker',
      title: 'Campaign is not open for changes',
      message: 'This campaign is no longer a draft, so it cannot be prepared again.',
      remediation: 'Unschedule the campaign to make further changes.',
    });
  }

  // ── Audience ────────────────────────────────────────────────────────────
  if (input.campaign.list_id === null) {
    add({
      code: 'audience_missing',
      severity: 'blocker',
      title: 'No audience selected',
      message: 'This campaign has no contact list.',
      remediation: 'Choose a list on the Audience step.',
    });
  } else if (input.list === null) {
    // The composite foreign key makes a cross-workspace list impossible to
    // store, so reaching this means the list was deleted between edits.
    add({
      code: 'audience_unavailable',
      severity: 'blocker',
      title: 'Audience is unavailable',
      message: 'The selected contact list is no longer available.',
      remediation: 'Choose a different list on the Audience step.',
    });
  } else if (input.audience.total === 0) {
    add({
      code: 'audience_empty',
      severity: 'blocker',
      title: 'Audience is empty',
      message: `"${input.list.name}" has no contacts in it.`,
      remediation: 'Add contacts to the list, or choose a different one.',
    });
  } else if (input.audience.eligible === 0) {
    add({
      code: 'audience_no_eligible',
      severity: 'blocker',
      title: 'No eligible recipients',
      message: `Every contact in "${input.list.name}" is suppressed or inactive, so there is nobody to send to.`,
      remediation: 'Review the suppression list, or choose a different audience.',
    });
  } else {
    add({
      code: 'audience_size',
      severity: 'info',
      title: 'Audience',
      message: `${input.audience.eligible.toLocaleString()} eligible of ${input.audience.total.toLocaleString()} contacts in "${input.list.name}".`,
    });

    if (input.audience.suppressed > 0) {
      add({
        code: 'audience_has_suppressed',
        severity: 'warning',
        title: 'Some contacts are suppressed',
        message: `${input.audience.suppressed.toLocaleString()} contacts in this list are on the suppression list and will not be contacted.`,
      });
    }
    if (input.audience.inactive > 0) {
      add({
        code: 'audience_has_inactive',
        severity: 'warning',
        title: 'Some contacts are not active',
        message: `${input.audience.inactive.toLocaleString()} contacts in this list are marked invalid or inactive and will be skipped.`,
      });
    }
    if (input.audience.capped) {
      add({
        code: 'audience_count_capped',
        severity: 'warning',
        title: 'Audience is very large',
        message: 'This list is large enough that the counts above are a lower bound rather than an exact total.',
      });
    }
  }

  // ── Sender ──────────────────────────────────────────────────────────────
  if (input.campaign.sender_identity_id === null) {
    add({
      code: 'sender_not_selected',
      severity: 'blocker',
      title: 'No sender selected',
      message: 'This campaign has no sender address.',
      remediation: 'Choose a verified sender on the Sender step.',
    });
  } else {
    const readiness = input.senderReadiness;
    if (readiness === null) {
      add({
        code: 'sender_identity_missing',
        severity: 'blocker',
        title: 'Sender is unavailable',
        message: SENDER_BLOCKER_MESSAGE.sender_identity_missing,
        remediation: 'Choose a different sender address.',
      });
    } else {
      for (const blocker of readiness.blockers) {
        add({
          code: SENDER_BLOCKER_CODE[blocker],
          severity: 'blocker',
          title: 'Sender is not ready',
          message: SENDER_BLOCKER_MESSAGE[blocker],
          remediation: 'Open Senders and complete DNS verification for this domain.',
        });
      }
      for (const warning of readiness.warnings) {
        add({
          code: SENDER_WARNING_CODE[warning],
          severity: 'warning',
          title: 'Sender authentication',
          message: SENDER_WARNING_MESSAGE[warning],
        });
      }
      if (readiness.ready && input.senderIdentity !== null) {
        add({
          code: 'sender_from',
          severity: 'info',
          title: 'From',
          message: `${input.senderIdentity.from_name} <${input.senderIdentity.from_email}>`,
        });
      }
    }
  }

  // ── Template ────────────────────────────────────────────────────────────
  if (input.campaign.template_id === null) {
    add({
      code: 'template_not_selected',
      severity: 'blocker',
      title: 'No template selected',
      message: 'This campaign has no content.',
      remediation: 'Choose or write a template on the Template step.',
    });
  } else if (input.template === null) {
    add({
      code: 'template_unavailable',
      severity: 'blocker',
      title: 'Template is unavailable',
      message: 'The selected template is no longer available.',
      remediation: 'Choose a different template on the Template step.',
    });
  } else {
    const template = input.template;

    if (template.subject.trim().length === 0) {
      add({
        code: 'template_subject_empty',
        severity: 'blocker',
        title: 'Subject is empty',
        message: 'The template has no subject line.',
        remediation: 'Add a subject to the template.',
      });
    }
    if (template.html.trim().length === 0) {
      add({
        code: 'template_body_empty',
        severity: 'blocker',
        title: 'Message body is empty',
        message: 'The template has no HTML body.',
        remediation: 'Add content to the template.',
      });
    }
    if (template.text.trim().length === 0) {
      add({
        code: 'template_text_empty',
        severity: 'blocker',
        title: 'Plain-text version is empty',
        message: 'The template has no plain-text alternative, which most spam filters penalise.',
        remediation: 'Save the template again to regenerate the text version from the HTML.',
      });
    }
    if (template.preview_text === null) {
      add({
        code: 'template_no_preview_text',
        severity: 'warning',
        title: 'No preview text',
        message: 'Without preview text, inboxes show the first words of the message instead.',
      });
    }
    if (template.html.length > MAX_HTML_CHARS * 0.8) {
      add({
        code: 'template_large',
        severity: 'warning',
        title: 'Message is large',
        message: 'Gmail truncates messages over about 102 KB, hiding anything past the cut.',
      });
    }

    add({
      code: 'template_version',
      severity: 'info',
      title: 'Content',
      message: `"${template.name}", version ${template.version}.`,
    });

    if (input.snapshot !== null && snapshotIsStale(input.snapshot, template)) {
      add({
        code: 'template_snapshot_stale',
        severity: 'warning',
        title: 'Template has changed since this campaign was frozen',
        message: `This campaign holds version ${input.snapshot.version} of "${template.name}". The template is now at version ${template.version}.`,
        remediation: 'Unschedule and schedule again to pick up the newer content.',
      });
    }

    // ── Personalization ───────────────────────────────────────────────────
    const render = input.sampleRender;
    if (render === null) {
      add({
        code: 'personalization_render_failed',
        severity: 'blocker',
        title: 'Personalization could not be checked',
        message: 'The template could not be rendered against a sample contact.',
        remediation: 'Open the template and check its personalization fields.',
      });
    } else {
      for (const issue of render.issues) {
        add({
          code:
            issue.code === 'unknown_variable'
              ? 'personalization_unknown_variable'
              : issue.code === 'malformed_variable'
                ? 'personalization_malformed_variable'
                : 'personalization_unsupported_syntax',
          severity: 'blocker',
          title: 'Personalization problem',
          message: issue.message,
          remediation: 'Edit the template and correct the field name.',
        });
      }

      if (render.missing.length > 0) {
        add({
          code: 'personalization_missing_values',
          severity: 'warning',
          title: 'Some fields are empty for the sample contact',
          message: `${render.missing.join(', ')} had no value. Contacts missing these will see a gap where the field would be.`,
        });
      }
      if (template.variables.length === 0) {
        add({
          code: 'personalization_none',
          severity: 'info',
          title: 'No personalization',
          message: 'Every recipient receives identical content.',
        });
      }
    }
  }

  // ── Unsubscribe ─────────────────────────────────────────────────────────
  if (input.campaign.requires_unsubscribe) {
    if (!mechanismAvailable) {
      add({
        code: 'unsubscribe_mechanism_unavailable',
        severity: enforced ? 'blocker' : 'warning',
        title: 'One-click unsubscribe is not available yet',
        message:
          'This campaign is marked as requiring an unsubscribe link, and this deployment does not provide one yet. It cannot be delivered until it does.',
        remediation:
          'Nothing to do now — the campaign records the requirement and is not deliverable in any case.',
      });
    }
  } else {
    add({
      code: 'unsubscribe_not_required',
      severity: 'info',
      title: 'Unsubscribe not required',
      message:
        'This campaign is marked as not requiring an unsubscribe link. Only transactional mail qualifies.',
    });
  }

  // ── Schedule ────────────────────────────────────────────────────────────
  const schedule = checkStoredSchedule(input.campaign.scheduled_at, now);
  if (!schedule.ok) {
    const missing = schedule.reason === 'empty';
    if (missing && input.intent === 'check') {
      add({
        code: 'schedule_missing',
        severity: 'info',
        title: 'Not scheduled',
        message: 'Choose a date and time when you are ready to schedule this campaign.',
      });
    } else {
      add({
        code:
          schedule.reason === 'in_past'
            ? 'schedule_in_past'
            : missing
              ? 'schedule_missing'
              : 'schedule_invalid',
        severity: 'blocker',
        title: 'Schedule is not valid',
        message: SCHEDULE_FAILURE_MESSAGE[schedule.reason],
        remediation: 'Choose a new date and time on the Schedule step.',
      });
    }
  } else {
    add({
      code: 'schedule_time',
      severity: 'info',
      title: 'Scheduled for',
      message: `${formatInZone(schedule.at, timeZone)} (${timeZone}).`,
    });
    if (schedule.farFuture) {
      add({
        code: 'schedule_far_future',
        severity: 'warning',
        title: 'Scheduled a long way ahead',
        message: 'This campaign is scheduled more than three months from now.',
      });
    }
  }

  // ── The standing guarantee ──────────────────────────────────────────────
  // Stated on every result, at every severity level, because a person looking at
  // a green "Ready" badge must not conclude that mail is about to go out.
  add({
    code: 'sending_not_available',
    severity: 'info',
    title: 'Sending is not enabled',
    message:
      'This deployment can prepare and schedule campaigns but cannot deliver email. A scheduled campaign will not send.',
  });

  const blockers = issues.filter((issue) => issue.severity === 'blocker');

  return {
    ready: blockers.length === 0,
    blockers,
    warnings: issues.filter((issue) => issue.severity === 'warning'),
    info: issues.filter((issue) => issue.severity === 'info'),
    issues,
  };
}

/** A compact, loggable summary. Codes and counts — never message text. */
export function preflightSummary(result: PreflightResult): Record<string, unknown> {
  return {
    ready: result.ready,
    blockerCount: result.blockers.length,
    warningCount: result.warnings.length,
    blockers: result.blockers.map((issue) => issue.code),
    warnings: result.warnings.map((issue) => issue.code),
  };
}
