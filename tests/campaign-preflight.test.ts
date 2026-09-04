import { describe, it, expect } from 'vitest';
import {
  evaluateCampaignPreflight,
  preflightSummary,
  UNSUBSCRIBE_ENFORCED,
  UNSUBSCRIBE_MECHANISM_AVAILABLE,
  type PreflightCode,
  type PreflightInput,
  type PreflightResult,
} from '@/lib/campaigns/preflight';
import type { CampaignRecord } from '@/lib/campaigns/ports';
import type { TemplateSnapshot } from '@/lib/campaigns/snapshot';
import type { AudienceCounts } from '@/lib/eligibility';
import type { SenderReadiness } from '@/lib/sender/readiness';
import type { TemplateRecord } from '@/lib/templates/ports';
import { buildPreview } from '@/lib/templates/preview';
import { MAX_HTML_CHARS } from '@/lib/templates/constants';

/**
 * The preflight engine.
 *
 * Every blocker is exercised on its own, from an otherwise-ready campaign, so a
 * passing test means "this one condition is what blocked it" rather than "the
 * campaign was broken in several ways and something complained".
 *
 * The engine is pure, so all of this runs without a database: the point of
 * `evaluateCampaignPreflight` taking records rather than fetching them is that
 * the decision can be examined exhaustively.
 */

const NOW = new Date('2026-03-01T12:00:00.000Z');

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222';
const TEMPLATE_ID = '33333333-3333-3333-3333-333333333333';

function campaign(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
  return {
    id: CAMPAIGN_ID,
    workspace_id: WORKSPACE_ID,
    name: 'March newsletter',
    status: 'validating',
    template_id: TEMPLATE_ID,
    sender_identity_id: '44444444-4444-4444-4444-444444444444',
    list_id: '55555555-5555-5555-5555-555555555555',
    template_snapshot: null,
    scheduled_at: '2026-03-05T09:00:00.000Z',
    launched_at: null,
    completed_at: null,
    requires_unsubscribe: true,
    max_rate_override: null,
    pause_reason: null,
    launched_by: null,
    n_total: 0,
    n_sent: 0,
    n_delivered: 0,
    n_bounced: 0,
    n_complained: 0,
    n_failed: 0,
    n_unsubscribed: 0,
    n_suppressed: 0,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

function template(overrides: Partial<TemplateRecord> = {}): TemplateRecord {
  return {
    id: TEMPLATE_ID,
    workspace_id: WORKSPACE_ID,
    name: 'Newsletter',
    subject: 'Hello {{first_name}}',
    preview_text: 'This month at {{company}}',
    html: '<p>Hello {{first_name}}, welcome to {{company}}.</p>',
    text: 'Hello {{first_name}}, welcome to {{company}}.',
    variables: ['first_name', 'company'],
    version: 3,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

const READY_SENDER: SenderReadiness = {
  ready: true,
  blockers: [],
  warnings: [],
  domainReadiness: 'VERIFIED',
};

const HEALTHY_AUDIENCE: AudienceCounts = {
  total: 1000,
  eligible: 940,
  suppressed: 0,
  inactive: 0,
  capped: false,
};

/** A campaign with nothing wrong with it. Every case below breaks one thing. */
function readyInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  const used = overrides.template === undefined ? template() : overrides.template;
  return {
    campaign: campaign(),
    intent: 'schedule',
    list: { id: '55555555-5555-5555-5555-555555555555', name: 'Subscribers', contact_count: 1000 },
    audience: HEALTHY_AUDIENCE,
    senderIdentity: {
      id: '44444444-4444-4444-4444-444444444444',
      from_email: 'hello@acme.test',
      from_name: 'Acme',
    },
    senderReadiness: READY_SENDER,
    template: used,
    snapshot: null,
    sampleRender:
      used === null
        ? null
        : renderOf(used),
    now: NOW,
    timeZone: 'UTC',
    ...overrides,
  };
}

function renderOf(record: TemplateRecord) {
  const preview = buildPreview({
    template: {
      subject: record.subject,
      previewText: record.preview_text,
      html: record.html,
      text: record.text,
    },
  });
  return {
    subject: preview.subject,
    previewText: preview.previewText,
    html: preview.html,
    text: preview.text,
    missing: preview.missing,
    issues: preview.issues,
  };
}

const codes = (result: PreflightResult): PreflightCode[] => result.issues.map((issue) => issue.code);
const blockerCodes = (result: PreflightResult): PreflightCode[] =>
  result.blockers.map((issue) => issue.code);
const warningCodes = (result: PreflightResult): PreflightCode[] =>
  result.warnings.map((issue) => issue.code);

describe('a campaign with nothing wrong with it', () => {
  it('is ready', () => {
    const result = evaluateCampaignPreflight(readyInput());
    expect(result.blockers).toEqual([]);
    expect(result.ready).toBe(true);
  });

  it('still reports the facts a reviewer needs', () => {
    const result = evaluateCampaignPreflight(readyInput());
    expect(codes(result)).toContain('audience_size');
    expect(codes(result)).toContain('sender_from');
    expect(codes(result)).toContain('template_version');
    expect(codes(result)).toContain('schedule_time');
  });

  it('says on every result that this deployment cannot send', () => {
    // A green "Ready" badge must not be read as "mail is about to go out".
    const result = evaluateCampaignPreflight(readyInput());
    expect(codes(result)).toContain('sending_not_available');
    expect(
      result.info.find((issue) => issue.code === 'sending_not_available')?.message,
    ).toMatch(/cannot deliver email/i);
  });

  it('is deterministic — the same input gives the identical result', () => {
    expect(evaluateCampaignPreflight(readyInput())).toEqual(
      evaluateCampaignPreflight(readyInput()),
    );
  });
});

describe('blockers, one at a time', () => {
  it('no audience selected', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ list_id: null }), list: null }),
    );
    expect(blockerCodes(result)).toEqual(['audience_missing']);
    expect(result.ready).toBe(false);
  });

  it('the selected list is no longer available', () => {
    const result = evaluateCampaignPreflight(readyInput({ list: null }));
    expect(blockerCodes(result)).toEqual(['audience_unavailable']);
  });

  it('the audience is empty', () => {
    const result = evaluateCampaignPreflight(
      readyInput({
        audience: { total: 0, eligible: 0, suppressed: 0, inactive: 0, capped: false },
      }),
    );
    expect(blockerCodes(result)).toEqual(['audience_empty']);
  });

  it('the audience has contacts but none of them are eligible', () => {
    const result = evaluateCampaignPreflight(
      readyInput({
        audience: { total: 50, eligible: 0, suppressed: 40, inactive: 10, capped: false },
      }),
    );
    expect(blockerCodes(result)).toEqual(['audience_no_eligible']);
  });

  it('no sender selected', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ sender_identity_id: null }), senderReadiness: null }),
    );
    expect(blockerCodes(result)).toEqual(['sender_not_selected']);
  });

  it('the sender identity has gone', () => {
    const result = evaluateCampaignPreflight(readyInput({ senderReadiness: null }));
    expect(blockerCodes(result)).toEqual(['sender_identity_missing']);
  });

  it.each([
    ['dkim_not_verified', 'sender_dkim_not_verified'],
    ['spf_not_verified', 'sender_spf_not_verified'],
    ['mail_from_not_verified', 'sender_mail_from_not_verified'],
    ['domain_never_checked', 'sender_domain_never_checked'],
    ['identity_domain_mismatch', 'sender_identity_domain_mismatch'],
    ['identity_not_marked_verified', 'sender_identity_not_verified'],
    ['sender_domain_missing', 'sender_domain_missing'],
  ] as const)('sender readiness blocker %s becomes %s', (blocker, code) => {
    const result = evaluateCampaignPreflight(
      readyInput({
        senderReadiness: { ready: false, blockers: [blocker], warnings: [], domainReadiness: 'PENDING' },
      }),
    );
    expect(blockerCodes(result)).toEqual([code]);
  });

  it('reports each sender blocker separately, so each is separately actionable', () => {
    const result = evaluateCampaignPreflight(
      readyInput({
        senderReadiness: {
          ready: false,
          blockers: ['dkim_not_verified', 'spf_not_verified'],
          warnings: [],
          domainReadiness: 'PENDING',
        },
      }),
    );
    expect(blockerCodes(result)).toEqual(['sender_dkim_not_verified', 'sender_spf_not_verified']);
  });

  it('no template selected', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ template_id: null }), template: null, sampleRender: null }),
    );
    expect(blockerCodes(result)).toEqual(['template_not_selected']);
  });

  it('the template is no longer available', () => {
    const result = evaluateCampaignPreflight(readyInput({ template: null, sampleRender: null }));
    expect(blockerCodes(result)).toEqual(['template_unavailable']);
  });

  it.each([
    ['an empty subject', { subject: '   ' }, 'template_subject_empty'],
    ['an empty HTML body', { html: '   ' }, 'template_body_empty'],
    ['an empty text body', { text: '   ' }, 'template_text_empty'],
  ] as const)('template with %s', (_label, overrides, code) => {
    const record = template(overrides);
    const result = evaluateCampaignPreflight(
      readyInput({ template: record, sampleRender: renderOf(record) }),
    );
    expect(blockerCodes(result)).toContain(code);
  });

  it('an unknown personalization variable', () => {
    const record = template({ subject: 'Hello {{frist_name}}' });
    const result = evaluateCampaignPreflight(
      readyInput({ template: record, sampleRender: renderOf(record) }),
    );
    expect(blockerCodes(result)).toEqual(['personalization_unknown_variable']);
  });

  it('a malformed personalization tag', () => {
    const record = template({ html: '<p>Hello {{first name}}</p>' });
    const result = evaluateCampaignPreflight(
      readyInput({ template: record, sampleRender: renderOf(record) }),
    );
    expect(blockerCodes(result)).toEqual(['personalization_malformed_variable']);
  });

  it('template logic, which is not a supported feature', () => {
    const record = template({ html: '<p>{{#if admin}}secret{{/if}}</p>' });
    const result = evaluateCampaignPreflight(
      readyInput({ template: record, sampleRender: renderOf(record) }),
    );
    expect(blockerCodes(result).length).toBeGreaterThan(0);
  });

  it('the sample render could not be produced at all', () => {
    const result = evaluateCampaignPreflight(readyInput({ sampleRender: null }));
    expect(blockerCodes(result)).toEqual(['personalization_render_failed']);
  });

  it('a schedule in the past', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ scheduled_at: '2026-02-01T09:00:00.000Z' }) }),
    );
    expect(blockerCodes(result)).toEqual(['schedule_in_past']);
  });

  it('a malformed schedule', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ scheduled_at: 'not a date' }) }),
    );
    expect(blockerCodes(result)).toEqual(['schedule_invalid']);
  });

  it('no schedule at all, when the intent is to schedule', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ scheduled_at: null }), intent: 'schedule' }),
    );
    expect(blockerCodes(result)).toEqual(['schedule_missing']);
  });

  it('a campaign that is no longer open for changes', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ status: 'scheduled' }) }),
    );
    expect(blockerCodes(result)).toContain('campaign_not_editable');
  });
});

describe('warnings — surfaced, never fatal', () => {
  it('suppressed contacts in the audience', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ audience: { total: 100, eligible: 80, suppressed: 20, inactive: 0, capped: false } }),
    );
    expect(result.ready).toBe(true);
    expect(warningCodes(result)).toContain('audience_has_suppressed');
  });

  it('inactive contacts in the audience', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ audience: { total: 100, eligible: 90, suppressed: 0, inactive: 10, capped: false } }),
    );
    expect(result.ready).toBe(true);
    expect(warningCodes(result)).toContain('audience_has_inactive');
  });

  it('an audience so large the count is a lower bound', () => {
    const result = evaluateCampaignPreflight(
      readyInput({
        audience: { total: 200_000, eligible: 199_000, suppressed: 1_000, inactive: 0, capped: true },
      }),
    );
    expect(result.ready).toBe(true);
    expect(warningCodes(result)).toContain('audience_count_capped');
  });

  it.each([
    ['dmarc_not_enforcing', 'sender_dmarc_not_enforcing'],
    ['dmarc_invalid', 'sender_dmarc_invalid'],
    ['verification_stale', 'sender_verification_stale'],
  ] as const)('sender warning %s becomes %s and does not block', (warning, code) => {
    const result = evaluateCampaignPreflight(
      readyInput({
        senderReadiness: { ready: true, blockers: [], warnings: [warning], domainReadiness: 'VERIFIED' },
      }),
    );
    expect(result.ready).toBe(true);
    expect(warningCodes(result)).toContain(code);
  });

  it('no preview text', () => {
    const record = template({ preview_text: null });
    const result = evaluateCampaignPreflight(
      readyInput({ template: record, sampleRender: renderOf(record) }),
    );
    expect(result.ready).toBe(true);
    expect(warningCodes(result)).toContain('template_no_preview_text');
  });

  it('a very large message, which Gmail will truncate', () => {
    const record = template({ html: `<p>${'a'.repeat(Math.round(MAX_HTML_CHARS * 0.9))}</p>` });
    const result = evaluateCampaignPreflight(
      readyInput({ template: record, sampleRender: renderOf(record) }),
    );
    expect(result.ready).toBe(true);
    expect(warningCodes(result)).toContain('template_large');
  });

  it('fields that are empty for the sample contact', () => {
    const record = template({ subject: 'Hi {{phone}}', variables: ['phone'] });
    const result = evaluateCampaignPreflight(
      readyInput({
        template: record,
        sampleRender: { ...renderOf(record), missing: ['phone'] },
      }),
    );
    expect(result.ready).toBe(true);
    expect(warningCodes(result)).toContain('personalization_missing_values');
  });

  it('a schedule more than three months ahead', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ scheduled_at: '2026-09-01T09:00:00.000Z' }) }),
    );
    expect(result.ready).toBe(true);
    expect(warningCodes(result)).toContain('schedule_far_future');
  });

  it('a template that has moved on from the frozen snapshot', () => {
    const snapshot: TemplateSnapshot = {
      template_id: TEMPLATE_ID,
      version: 2,
      name: 'Newsletter',
      subject: 'Old subject',
      preview_text: null,
      html: '<p>old</p>',
      text: 'old',
      variables: [],
      frozen_at: '2026-02-01T00:00:00.000Z',
    };
    const result = evaluateCampaignPreflight(readyInput({ snapshot }));
    expect(result.ready).toBe(true);
    expect(warningCodes(result)).toContain('template_snapshot_stale');
  });
});

describe('informational notices', () => {
  it('a campaign with no personalization says so', () => {
    const record = template({
      subject: 'Static subject',
      preview_text: 'Static preheader',
      html: '<p>Static body</p>',
      text: 'Static body',
      variables: [],
    });
    const result = evaluateCampaignPreflight(
      readyInput({ template: record, sampleRender: renderOf(record) }),
    );
    expect(result.info.map((issue) => issue.code)).toContain('personalization_none');
  });

  it('a campaign that opts out of unsubscribe says so explicitly', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ requires_unsubscribe: false }) }),
    );
    expect(result.info.map((issue) => issue.code)).toContain('unsubscribe_not_required');
    expect(result.ready).toBe(true);
  });

  it('an unscheduled campaign being checked is told, not blocked', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ campaign: campaign({ scheduled_at: null }), intent: 'check' }),
    );
    expect(result.ready).toBe(true);
    expect(result.info.map((issue) => issue.code)).toContain('schedule_missing');
  });
});

describe('the unsubscribe requirement', () => {
  it('this deployment has no unsubscribe mechanism, and does not pretend to', () => {
    expect(UNSUBSCRIBE_MECHANISM_AVAILABLE).toBe(false);
    // P4 cannot send, so a missing mechanism cannot be violated — it is stated,
    // not enforced. P5 flips this in the same change that adds a send path.
    expect(UNSUBSCRIBE_ENFORCED).toBe(false);
  });

  it('states the requirement on every campaign that carries it', () => {
    const result = evaluateCampaignPreflight(readyInput());
    expect(codes(result)).toContain('unsubscribe_mechanism_unavailable');
    expect(
      result.warnings.find((issue) => issue.code === 'unsubscribe_mechanism_unavailable')?.message,
    ).toMatch(/cannot be delivered/i);
  });

  it('does not block at P4, because there is nothing to violate', () => {
    const result = evaluateCampaignPreflight(readyInput());
    expect(result.ready).toBe(true);
  });

  it('blocks once enforcement is turned on', () => {
    // Proven now so the enforcing behaviour is known to work before P5 needs it.
    const result = evaluateCampaignPreflight(
      readyInput({ unsubscribe: { mechanismAvailable: false, enforced: true } }),
    );
    expect(blockerCodes(result)).toEqual(['unsubscribe_mechanism_unavailable']);
    expect(result.ready).toBe(false);
  });

  it('says nothing once a mechanism exists', () => {
    const result = evaluateCampaignPreflight(
      readyInput({ unsubscribe: { mechanismAvailable: true, enforced: true } }),
    );
    expect(codes(result)).not.toContain('unsubscribe_mechanism_unavailable');
    expect(result.ready).toBe(true);
  });
});

describe('the result shape', () => {
  it('separates the three severities and keeps them consistent with `issues`', () => {
    const result = evaluateCampaignPreflight(
      readyInput({
        campaign: campaign({ list_id: null }),
        list: null,
        audience: { total: 0, eligible: 0, suppressed: 0, inactive: 0, capped: false },
      }),
    );

    expect(result.blockers.every((issue) => issue.severity === 'blocker')).toBe(true);
    expect(result.warnings.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(result.info.every((issue) => issue.severity === 'info')).toBe(true);
    expect(result.issues).toHaveLength(
      result.blockers.length + result.warnings.length + result.info.length,
    );
  });

  it('every issue carries a code, a title and a user-safe message', () => {
    const result = evaluateCampaignPreflight(readyInput({ senderReadiness: null }));
    for (const issue of result.issues) {
      expect(issue.code.length).toBeGreaterThan(0);
      expect(issue.title.length).toBeGreaterThan(0);
      expect(issue.message.length).toBeGreaterThan(0);
      // User-safe: no SQL, no constraint names, no internal identifiers.
      expect(issue.message).not.toMatch(/select |constraint|pg_|workspace_id|null pointer/i);
    }
  });

  it('`ready` is exactly "no blockers"', () => {
    expect(evaluateCampaignPreflight(readyInput()).ready).toBe(true);
    expect(evaluateCampaignPreflight(readyInput({ list: null })).ready).toBe(false);
  });

  it('the loggable summary carries codes and counts, never message text', () => {
    const result = evaluateCampaignPreflight(readyInput({ list: null }));
    const summary = preflightSummary(result);

    expect(summary['ready']).toBe(false);
    expect(summary['blockers']).toEqual(['audience_unavailable']);
    // The messages name lists and sample data; the codes do not.
    expect(JSON.stringify(summary)).not.toContain('Subscribers');
  });
});
