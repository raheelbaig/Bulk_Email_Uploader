import { describe, it, expect } from 'vitest';
import {
  domainReadiness,
  isDmarcEnforcing,
  isDomainUsable,
  readinessSummary,
  READINESS_LABEL,
  READINESS_TONE,
  REQUIRED_CHECKS,
  type DomainVerificationState,
  type VerificationStatus,
} from '@/lib/sender/status';
import {
  BLOCKER_MESSAGE,
  evaluateSenderReadiness,
  STALE_CHECK_HOURS,
  WARNING_MESSAGE,
  type SenderBlocker,
} from '@/lib/sender/readiness';
import type { SenderDomainRecord, SenderIdentityRecord } from '@/lib/sender/ports';

/**
 * The two authorities: what makes a domain usable, and what makes a sender
 * ready. Every blocker is exercised on its own, because the failure mode this
 * guards against is a check that is only ever reached in combination with
 * another and so is never really tested.
 */

const CHECKED_AT = '2026-01-01T00:00:00.000Z';
const NOW = new Date('2026-01-01T06:00:00.000Z');

function state(overrides: Partial<DomainVerificationState> = {}): DomainVerificationState {
  return {
    spfStatus: 'verified',
    dkimStatus: 'verified',
    dmarcStatus: 'verified',
    mailFromStatus: 'verified',
    dmarcPolicy: 'quarantine',
    lastCheckedAt: CHECKED_AT,
    ...overrides,
  };
}

const WORKSPACE = '11111111-1111-1111-1111-111111111111';
const DOMAIN_ID = '22222222-2222-2222-2222-222222222222';

function domainRecord(overrides: Partial<SenderDomainRecord> = {}): SenderDomainRecord {
  return {
    id: DOMAIN_ID,
    workspace_id: WORKSPACE,
    domain: 'example.com',
    ses_identity_arn: null,
    dkim_tokens: ['a'.repeat(32)],
    mail_from_domain: 'bounce.example.com',
    spf_status: 'verified',
    dkim_status: 'verified',
    dmarc_status: 'verified',
    dmarc_policy: 'quarantine',
    mail_from_status: 'verified',
    last_checked_at: CHECKED_AT,
    last_check_error: null,
    created_at: CHECKED_AT,
    updated_at: null,
    ...overrides,
  };
}

function identityRecord(overrides: Partial<SenderIdentityRecord> = {}): SenderIdentityRecord {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    workspace_id: WORKSPACE,
    domain_id: DOMAIN_ID,
    from_email: 'hello@example.com',
    from_name: 'Example',
    reply_to: null,
    from_domain: 'example.com',
    verified_at: CHECKED_AT,
    created_at: CHECKED_AT,
    updated_at: null,
    ...overrides,
  };
}

describe('domain usability', () => {
  it('requires DKIM, SPF and MAIL FROM, and nothing else', () => {
    expect([...REQUIRED_CHECKS]).toEqual(['dkimStatus', 'spfStatus', 'mailFromStatus']);
  });

  it('is usable when all three required checks are verified', () => {
    expect(isDomainUsable(state())).toBe(true);
  });

  it.each(REQUIRED_CHECKS)('is not usable when %s is anything but verified', (check) => {
    for (const status of ['pending', 'failed', 'not_configured'] as VerificationStatus[]) {
      expect(isDomainUsable(state({ [check]: status })), `${check}=${status}`).toBe(false);
    }
  });

  it('is usable without DMARC, because DMARC does not affect authentication', () => {
    expect(isDomainUsable(state({ dmarcStatus: 'not_configured', dmarcPolicy: null }))).toBe(true);
    expect(isDomainUsable(state({ dmarcStatus: 'failed', dmarcPolicy: null }))).toBe(true);
  });

  it('counts DMARC as enforcing only for quarantine and reject', () => {
    expect(isDmarcEnforcing(state({ dmarcPolicy: 'reject' }))).toBe(true);
    expect(isDmarcEnforcing(state({ dmarcPolicy: 'quarantine' }))).toBe(true);
    expect(isDmarcEnforcing(state({ dmarcStatus: 'pending', dmarcPolicy: 'none' }))).toBe(false);
    expect(isDmarcEnforcing(state({ dmarcStatus: 'not_configured', dmarcPolicy: null }))).toBe(false);
  });
});

describe('derived domain status', () => {
  it('is NOT_CONFIGURED before anything has been checked', () => {
    expect(
      domainReadiness({
        spfStatus: 'pending',
        dkimStatus: 'pending',
        dmarcStatus: 'not_configured',
        mailFromStatus: 'not_configured',
        dmarcPolicy: null,
        lastCheckedAt: null,
      }),
    ).toBe('NOT_CONFIGURED');
  });

  it('is PENDING once checked but incomplete', () => {
    expect(domainReadiness(state({ dkimStatus: 'pending' }))).toBe('PENDING');
  });

  it('is FAILED when any required check hard-failed, whatever else passed', () => {
    expect(domainReadiness(state({ spfStatus: 'failed' }))).toBe('FAILED');
    expect(domainReadiness(state({ dkimStatus: 'failed' }))).toBe('FAILED');
    expect(domainReadiness(state({ mailFromStatus: 'failed' }))).toBe('FAILED');
  });

  it('a DMARC failure alone does not fail the domain', () => {
    expect(domainReadiness(state({ dmarcStatus: 'failed', dmarcPolicy: null }))).toBe('ATTENTION');
  });

  it('is VERIFIED only with an enforcing DMARC policy', () => {
    expect(domainReadiness(state({ dmarcPolicy: 'reject' }))).toBe('VERIFIED');
    expect(domainReadiness(state({ dmarcPolicy: 'quarantine' }))).toBe('VERIFIED');
  });

  it('is ATTENTION when the domain can send but DMARC is p=none', () => {
    // The example from the brief: everything green except DMARC.
    const attention = state({ dmarcStatus: 'pending', dmarcPolicy: 'none' });
    expect(domainReadiness(attention)).toBe('ATTENTION');
    expect(isDomainUsable(attention)).toBe(true);
    expect(readinessSummary(attention)).toContain('none');
  });

  it('is ATTENTION when the domain can send but has no DMARC record', () => {
    expect(domainReadiness(state({ dmarcStatus: 'not_configured', dmarcPolicy: null }))).toBe(
      'ATTENTION',
    );
  });

  it('has a label, tone and summary for every status', () => {
    for (const status of Object.keys(READINESS_LABEL)) {
      expect(READINESS_LABEL[status as keyof typeof READINESS_LABEL].length).toBeGreaterThan(3);
      expect(READINESS_TONE[status as keyof typeof READINESS_TONE]).toBeDefined();
    }
    expect(readinessSummary(state())).toContain('fully verified');
  });
});

describe('sender readiness', () => {
  it('is ready for a verified identity on a verified domain', () => {
    const result = evaluateSenderReadiness({
      identity: identityRecord(),
      domain: domainRecord(),
      now: NOW,
    });
    expect(result).toMatchObject({ ready: true, blockers: [], warnings: [] });
    expect(result.domainReadiness).toBe('VERIFIED');
  });

  describe('every blocker, on its own', () => {
    const cases: Array<[SenderBlocker, Parameters<typeof evaluateSenderReadiness>[0]]> = [
      ['sender_identity_missing', { identity: null, domain: domainRecord(), now: NOW }],
      ['sender_domain_missing', { identity: identityRecord(), domain: null, now: NOW }],
      [
        'identity_domain_mismatch',
        {
          identity: identityRecord({ from_domain: 'other.example' }),
          domain: domainRecord(),
          now: NOW,
        },
      ],
      [
        'domain_never_checked',
        {
          identity: identityRecord({ verified_at: null }),
          domain: domainRecord({ last_checked_at: null }),
          now: NOW,
        },
      ],
      [
        'dkim_not_verified',
        {
          identity: identityRecord({ verified_at: null }),
          domain: domainRecord({ dkim_status: 'pending' }),
          now: NOW,
        },
      ],
      [
        'spf_not_verified',
        {
          identity: identityRecord({ verified_at: null }),
          domain: domainRecord({ spf_status: 'failed' }),
          now: NOW,
        },
      ],
      [
        'mail_from_not_verified',
        {
          identity: identityRecord({ verified_at: null }),
          domain: domainRecord({ mail_from_status: 'not_configured' }),
          now: NOW,
        },
      ],
      [
        'identity_not_marked_verified',
        { identity: identityRecord({ verified_at: null }), domain: domainRecord(), now: NOW },
      ],
    ];

    it.each(cases)('reports %s', (blocker, input) => {
      const result = evaluateSenderReadiness(input);
      expect(result.ready).toBe(false);
      expect(result.blockers).toContain(blocker);
    });

    it('has a user-safe message for every blocker and warning', () => {
      for (const message of [
        ...Object.values(BLOCKER_MESSAGE),
        ...Object.values(WARNING_MESSAGE),
      ]) {
        expect(message.length).toBeGreaterThan(20);
      }
    });
  });

  it('does not evaluate the domain at all when the identity is absent', () => {
    const result = evaluateSenderReadiness({ identity: null, domain: domainRecord(), now: NOW });
    expect(result.blockers).toEqual(['sender_identity_missing']);
    expect(result.domainReadiness).toBeNull();
  });

  it('catches a cross-workspace pairing even though the schema forbids storing one', () => {
    const result = evaluateSenderReadiness({
      identity: identityRecord({ workspace_id: '99999999-9999-9999-9999-999999999999' }),
      domain: domainRecord(),
      now: NOW,
    });
    expect(result.blockers).toContain('identity_domain_mismatch');
  });

  it('catches an identity pointing at a different domain row', () => {
    const result = evaluateSenderReadiness({
      identity: identityRecord({ domain_id: '44444444-4444-4444-4444-444444444444' }),
      domain: domainRecord(),
      now: NOW,
    });
    expect(result.blockers).toContain('identity_domain_mismatch');
  });

  it('reports every applicable blocker rather than stopping at the first', () => {
    const result = evaluateSenderReadiness({
      identity: identityRecord({ verified_at: null }),
      domain: domainRecord({
        dkim_status: 'pending',
        spf_status: 'pending',
        mail_from_status: 'not_configured',
        last_checked_at: null,
      }),
      now: NOW,
    });
    expect(result.blockers).toEqual([
      'domain_never_checked',
      'dkim_not_verified',
      'spf_not_verified',
      'mail_from_not_verified',
    ]);
  });

  describe('warnings do not block', () => {
    it('warns but stays ready when DMARC is not enforcing', () => {
      const result = evaluateSenderReadiness({
        identity: identityRecord(),
        domain: domainRecord({ dmarc_status: 'pending', dmarc_policy: 'none' }),
        now: NOW,
      });
      expect(result.ready).toBe(true);
      expect(result.warnings).toContain('dmarc_not_enforcing');
    });

    it('warns but stays ready when the DMARC record is invalid', () => {
      const result = evaluateSenderReadiness({
        identity: identityRecord(),
        domain: domainRecord({ dmarc_status: 'failed', dmarc_policy: null }),
        now: NOW,
      });
      expect(result.ready).toBe(true);
      expect(result.warnings).toEqual(['dmarc_invalid']);
    });

    it('warns when the last check is older than the staleness window', () => {
      const stale = new Date(
        new Date(CHECKED_AT).getTime() + (STALE_CHECK_HOURS + 1) * 3_600_000,
      );
      const result = evaluateSenderReadiness({
        identity: identityRecord(),
        domain: domainRecord(),
        now: stale,
      });
      expect(result.ready).toBe(true);
      expect(result.warnings).toContain('verification_stale');
    });

    it('does not warn about staleness inside the window', () => {
      expect(
        evaluateSenderReadiness({ identity: identityRecord(), domain: domainRecord(), now: NOW })
          .warnings,
      ).not.toContain('verification_stale');
    });
  });
});
