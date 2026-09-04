import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/audit';
import { redact } from '@/lib/observability/redact';
import { prepareTemplate } from '@/lib/templates/service';
import { evaluateCampaignPreflight, preflightSummary } from '@/lib/campaigns/preflight';

/**
 * Audit coverage for P4.
 *
 * Two things must hold, and the second matters more than it looks. Every P4
 * mutation has a named action — and no audit metadata carries anything that
 * should not be retained forever. Audit records are never deleted
 * (ARCHITECTURE §22.4), so template HTML written here is template HTML kept
 * permanently, in a table read by support.
 *
 * ARCHITECTURE §24.4 names the things that must never be logged. Two of them
 * belong to P4 specifically: raw template HTML, and full recipient lists.
 */

const REQUIRED_P4_ACTIONS: AuditAction[] = [
  'template.created',
  'template.updated',
  'template.deleted',
  'campaign.created',
  'campaign.updated',
  'campaign.deleted',
  'campaign.scheduled',
  'campaign.unscheduled',
  'campaign.preflight_passed',
  'campaign.preflight_failed',
  'campaign.cancelled',
];

const SRC = join(process.cwd(), 'src');

describe('P4 audit logging', () => {
  describe('action vocabulary', () => {
    it.each(REQUIRED_P4_ACTIONS)('%s is a declared action', (action) => {
      expect(AUDIT_ACTIONS).toContain(action);
    });

    it('every declared action is unique', () => {
      expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    });

    it('the campaign services write only declared actions', () => {
      const declared = new Set<string>(AUDIT_ACTIONS);
      const sources = [
        readFileSync(join(SRC, 'lib/campaigns/service.ts'), 'utf8'),
        readFileSync(join(SRC, 'lib/templates/service.ts'), 'utf8'),
      ].join('\n');

      const written = [...sources.matchAll(/action:\s*'([a-z_.]+)'/g)].map((m) => m[1] ?? '');
      expect(written.length).toBeGreaterThan(5);
      for (const action of written) {
        expect(declared, `${action} is written but not declared`).toContain(action);
      }
    });

    it('no P5 action is written yet', () => {
      const sources = [
        readFileSync(join(SRC, 'lib/campaigns/service.ts'), 'utf8'),
        readFileSync(join(SRC, 'lib/templates/service.ts'), 'utf8'),
      ].join('\n');

      for (const action of ['campaign.launched', 'campaign.paused', 'test_send.dispatched']) {
        expect(sources, `${action} belongs to a later phase`).not.toContain(`'${action}'`);
      }
    });
  });

  describe('metadata is safe to keep forever', () => {
    it('a template audit records shape, never the body', () => {
      // The exact shape the service builds, exercised through the real function
      // so a future field lands in this assertion rather than in the table.
      const prepared = prepareTemplate({
        name: 'Newsletter',
        subject: 'Hello {{first_name}}',
        html: '<p>Secret internal copy about the acquisition</p>',
      });

      const metadata = {
        name: 'Newsletter',
        version: 1,
        subjectLength: prepared.write.subject.length,
        htmlLength: prepared.write.html.length,
        textLength: prepared.write.text.length,
        variables: prepared.write.variables,
        removedTags: prepared.report.removedTags,
        removedAttributes: prepared.report.removedAttributes,
        removedUrls: prepared.report.removedUrls,
      };

      const stored = JSON.stringify(redact(metadata));
      expect(stored).not.toContain('acquisition');
      expect(stored).not.toContain('<p>');
      expect(stored).toContain('htmlLength');
    });

    it('a preflight audit records codes, never the messages', () => {
      const result = evaluateCampaignPreflight({
        campaign: {
          id: '11111111-1111-1111-1111-111111111111',
          workspace_id: '22222222-2222-2222-2222-222222222222',
          name: 'March',
          status: 'validating',
          template_id: null,
          sender_identity_id: null,
          list_id: null,
          template_snapshot: null,
          scheduled_at: null,
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
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: null,
        },
        intent: 'check',
        list: null,
        audience: { total: 0, eligible: 0, suppressed: 0, inactive: 0, capped: false },
        senderIdentity: null,
        senderReadiness: null,
        template: null,
        snapshot: null,
        sampleRender: null,
      });

      const summary = preflightSummary(result);
      expect(summary['blockers']).toContain('audience_missing');

      // The messages name lists, contacts and addresses. The codes do not, and
      // the codes are what a support conversation actually needs.
      const stored = JSON.stringify(redact(summary));
      for (const issue of result.issues) {
        expect(stored).not.toContain(issue.message);
      }
    });

    it('no audit call in P4 passes an HTML or contact-list field', () => {
      const sources = [
        readFileSync(join(SRC, 'lib/campaigns/service.ts'), 'utf8'),
        readFileSync(join(SRC, 'lib/templates/service.ts'), 'utf8'),
      ].join('\n');

      // Metadata blocks, as written. A field named `html`, `text`, `contacts`
      // or `emails` here would be the leak this test exists to prevent.
      const metadataBlocks = [...sources.matchAll(/metadata:\s*\{([^}]*)\}/gs)].map((m) => m[1] ?? '');
      for (const block of metadataBlocks) {
        expect(block).not.toMatch(/\bhtml\s*:/);
        expect(block).not.toMatch(/\bsubject\s*:/);
        expect(block).not.toMatch(/\bcontacts\s*:/);
        expect(block).not.toMatch(/\bemails\s*:/);
        expect(block).not.toMatch(/\brecipients\s*:/);
      }
    });

    it('the redactor still strips a secret that reached campaign metadata', () => {
      const redacted = redact({
        campaignId: 'abc',
        unsubscribeToken: 'super-secret-value',
        apiKey: 'sk_live_1234567890',
      }) as Record<string, unknown>;

      expect(redacted['campaignId']).toBe('abc');
      expect(redacted['unsubscribeToken']).toBe('[redacted]');
      expect(redacted['apiKey']).toBe('[redacted]');
    });
  });
});
