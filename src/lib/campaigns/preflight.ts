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
import { SENDING_MODE_NOTICE, type SendingMode } from '@/lib/sending/gate';

// ─────────────────────────────────────────────────────────────────────────────
// The unsubscribe mechanism
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The assumed state of the unsubscribe mechanism when the caller does not say.
 *
 * P5 builds the mechanism — signed links (`lib/unsubscribe`), `List-Unsubscribe`
 * and one-click headers, the `/u/[token]` endpoint and the suppression write
 * behind it — but whether it *works* in a given deployment depends on a signing
 * key being configured. That is an environment fact, and this module is pure, so
 * the server passes it in (`lib/sending/config#unsubscribeMechanismAvailable`).
 *
 * The default is the safe reading: a caller that forgets to say gets "not
 * available", which blocks rather than permits.
 */
export const UNSUBSCRIBE_MECHANISM_AVAILABLE = false;

/**
 * Whether a missing unsubscribe mechanism blocks a campaign.
 *
 * P4 left this `false` because P4 could not send, and said P5 must flip it in the
 * same change that adds a send path. This is that change. A campaign that
 * requires unsubscribe and has no working mechanism can no longer be scheduled
 * or launched — and `lib/sending/compose.ts` refuses to build a message without
 * a link, as a second lock on the same door.
 */
export const UNSUBSCRIBE_ENFORCED = true;

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
  // launch (P5)
  | 'campaign_not_launchable'
  | 'template_snapshot_missing'
  // what the deployment will do with this campaign
  | 'sending_not_available'
  | 'sending_dry_run'
  | 'sending_live';

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

/**
 * Why the preflight is running.
 *
 *   check     a person asked "is this ready?"
 *   schedule  the final gate before content is frozen and a time recorded
 *   launch    the worker, when a scheduled campaign's time arrives, and a person
 *             resuming a paused one (ARCHITECTURE §19.1: preflight runs three
 *             times, because a domain can lose verification between scheduling
 *             and sending). Judges the *frozen snapshot*, not the live template,
 *             and does not re-judge the schedule — the time has, by definition,
 *             arrived.
 */
export type PreflightIntent = 'check' | 'schedule' | 'launch';

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
    /** Injected so both settings stay provable. Defaults to UNSUBSCRIBE_ENFORCED. */
    enforced?: boolean;
  };

  /** The deployment's sending mode, so the verdict can say what will happen. */
  sendingMode?: SendingMode;

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

  const launching = input.intent === 'launch';

  // ── The campaign itself ─────────────────────────────────────────────────
  if (launching) {
    if (!['scheduled', 'paused'].includes(input.campaign.status)) {
      add({
        code: 'campaign_not_launchable',
        severity: 'blocker',
        title: 'Campaign cannot start',
        message: 'Only a scheduled or paused campaign can start sending.',
      });
    }
    if (input.snapshot === null) {
      add({
        code: 'template_snapshot_missing',
        severity: 'blocker',
        title: 'Frozen content is missing',
        message: 'This campaign has no frozen copy of its content, so there is nothing to send.',
        remediation: 'Unschedule the campaign and schedule it again.',
      });
    }
  } else if (!isEditable(input.campaign.status as CampaignStatus)) {
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
          'This campaign is marked as requiring an unsubscribe link, and this deployment cannot sign unsubscribe links. It cannot be delivered until it can.',
        remediation: enforced
          ? 'Ask an administrator to configure UNSUBSCRIBE_SECRET_V1 for this deployment.'
          : 'Nothing to do now — the campaign records the requirement.',
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
  if (launching) {
    // Not re-judged: the worker only launches a campaign whose time has come,
    // and the missed-schedule grace window (ADR-0002 §5.1) is enforced in SQL.
  } else if (!schedule.ok) {
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

  // ── What will actually happen ───────────────────────────────────────────
  // Stated on every result, because a person looking at a green "Ready" badge
  // must know whether that means real mail, a rehearsal, or nothing at all.
  const mode: SendingMode = input.sendingMode ?? 'disabled';
  add({
    code: mode === 'live' ? 'sending_live' : mode === 'dry_run' ? 'sending_dry_run' : 'sending_not_available',
    severity: 'info',
    title: mode === 'live' ? 'Live sending' : mode === 'dry_run' ? 'Dry run' : 'Sending is not enabled',
    message: SENDING_MODE_NOTICE[mode],
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
