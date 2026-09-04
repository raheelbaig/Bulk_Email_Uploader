import { describe, it, expect } from 'vitest';
import {
  evaluateSpf,
  joinTxtChunks,
  selectSpfRecords,
  SES_SPF_INCLUDE,
  SPF_GUIDANCE,
} from '@/lib/sender/dns/spf';
import { DMARC_GUIDANCE, evaluateDmarc } from '@/lib/sender/dns/dmarc';
import { classifyDnsError, isQueryableName } from '@/lib/sender/dns/resolver';
import { MAIL_FROM_SPF_VALUE, requiredDnsRecords } from '@/lib/sender/records';
import { fakeResolver, txt } from './helpers/sender';

/**
 * DNS evaluation.
 *
 * Every record below comes from a zone the domain's owner controls, which makes
 * it untrusted input with an attacker-chosen shape. The cases that matter most
 * are the ones a naive `includes('amazonses.com')` would call verified.
 */

describe('SPF', () => {
  it('joins TXT chunks with no separator, as DNS defines them', () => {
    // Joining with a space would break `include:amazon` + `ses.com` apart and
    // report a correctly configured domain as unauthorized.
    expect(joinTxtChunks(['v=spf1 include:amazon', 'ses.com ~all'])).toBe(
      'v=spf1 include:amazonses.com ~all',
    );
  });

  it('authorizes a correct record', () => {
    const result = evaluateSpf({ txt: txt('v=spf1 include:amazonses.com ~all') });
    expect(result.verdict).toBe('authorized');
    expect(result.allQualifier).toBe('~');
    expect(result.expectedInclude).toBe(SES_SPF_INCLUDE);
  });

  it('authorizes a record split across chunks', () => {
    expect(
      evaluateSpf({ txt: [['v=spf1 include:amazon', 'ses.com -all']] }).verdict,
    ).toBe('authorized');
  });

  it('authorizes when SES sits among other mechanisms', () => {
    expect(
      evaluateSpf({
        txt: txt('v=spf1 ip4:192.0.2.0/24 include:_spf.google.com include:amazonses.com -all'),
      }).verdict,
    ).toBe('authorized');
  });

  it('ignores unrelated TXT records at the same name', () => {
    const result = evaluateSpf({
      txt: txt(
        'google-site-verification=abc123',
        'v=spf1 include:amazonses.com ~all',
        'MS=ms12345',
      ),
    });
    expect(result.verdict).toBe('authorized');
  });

  it('reports a missing record rather than assuming one', () => {
    expect(evaluateSpf({ txt: [] }).verdict).toBe('missing');
    expect(evaluateSpf({ txt: txt('unrelated=value') }).verdict).toBe('missing');
  });

  it('reports a record that does not include SES', () => {
    const result = evaluateSpf({ txt: txt('v=spf1 include:_spf.google.com ~all') });
    expect(result.verdict).toBe('not_authorized');
    expect(result.record).toBe('v=spf1 include:_spf.google.com ~all');
  });

  it('treats two SPF records as the permanent error RFC 7208 says it is', () => {
    expect(
      evaluateSpf({
        txt: txt('v=spf1 include:amazonses.com ~all', 'v=spf1 include:_spf.google.com ~all'),
      }).verdict,
    ).toBe('multiple_records');
  });

  it('rejects a record whose only content is the version tag', () => {
    expect(evaluateSpf({ txt: txt('v=spf1') }).verdict).toBe('malformed');
  });

  it('rejects +all, which authorizes the entire internet', () => {
    // The include is present, so a substring check would call this verified.
    const result = evaluateSpf({ txt: txt('v=spf1 include:amazonses.com +all') });
    expect(result.verdict).toBe('malformed');
  });

  describe('does not mistake a lookalike for authorization', () => {
    it.each([
      ['a comment mentioning the host', 'v=spf1 ip4:192.0.2.1 ~all amazonses.com'],
      ['a subdomain of an attacker domain', 'v=spf1 include:amazonses.com.evil.example ~all'],
      ['a different mechanism', 'v=spf1 a:amazonses.com ~all'],
      ['a redirect rather than an include', 'v=spf1 redirect=amazonses.com'],
      ['a prefix match', 'v=spf1 include:notamazonses.com ~all'],
    ])('%s', (_label, record) => {
      expect(evaluateSpf({ txt: txt(record) }).verdict).toBe('not_authorized');
    });

    it('accepts a trailing dot on the include, which is the same name', () => {
      expect(evaluateSpf({ txt: txt('v=spf1 include:amazonses.com. ~all') }).verdict).toBe(
        'authorized',
      );
    });

    it('is case-insensitive, as the RFC requires', () => {
      expect(evaluateSpf({ txt: txt('V=SPF1 INCLUDE:AMAZONSES.COM ~ALL') }).verdict).toBe(
        'authorized',
      );
    });
  });

  it('distinguishes a lookup failure from a missing record', () => {
    // A resolver timeout is not evidence that a record is absent. Conflating the
    // two would flip a verified domain to unverified on a transient fault.
    const result = evaluateSpf({ txt: null });
    expect(result.verdict).toBe('lookup_failed');
    expect(result.record).toBeNull();
  });

  it('selects only SPF records from a mixed TXT set', () => {
    expect(selectSpfRecords(txt('v=DMARC1; p=none', 'v=spf1 -all', 'x=y'))).toEqual(['v=spf1 -all']);
  });

  it('has guidance for every verdict', () => {
    for (const guidance of Object.values(SPF_GUIDANCE)) {
      expect(guidance.length).toBeGreaterThan(20);
    }
  });
});

describe('DMARC', () => {
  it('parses an enforcing policy', () => {
    const result = evaluateDmarc(txt('v=DMARC1; p=reject; rua=mailto:dmarc@example.com; pct=100'));
    expect(result).toMatchObject({
      verdict: 'enforcing',
      policy: 'reject',
      percent: 100,
      hasAggregateReporting: true,
    });
  });

  it.each([
    ['none', 'monitoring_only'],
    ['quarantine', 'enforcing'],
    ['reject', 'enforcing'],
  ])('policy=%s → %s', (policy, verdict) => {
    const result = evaluateDmarc(txt(`v=DMARC1; p=${policy}`));
    expect(result.verdict).toBe(verdict);
    expect(result.policy).toBe(policy);
  });

  it('does not treat a monitoring-only record as protection', () => {
    // A record exists; the domain is not protected. Reporting these identically
    // is how "DMARC ✓" ends up next to a domain anyone can spoof.
    const result = evaluateDmarc(txt('v=DMARC1; p=none'));
    expect(result.verdict).toBe('monitoring_only');
  });

  it('reads the subdomain policy and percentage', () => {
    const result = evaluateDmarc(txt('v=DMARC1; p=quarantine; sp=reject; pct=25'));
    expect(result.subdomainPolicy).toBe('reject');
    expect(result.percent).toBe(25);
  });

  it('is case- and whitespace-insensitive in the tag list', () => {
    expect(evaluateDmarc(txt('V=DMARC1 ;  P = Reject ;')).verdict).toBe('enforcing');
  });

  it('reports a missing record', () => {
    expect(evaluateDmarc([]).verdict).toBe('missing');
    expect(evaluateDmarc(txt('some-other-record=1')).verdict).toBe('missing');
  });

  describe('malformed records', () => {
    it.each([
      ['no policy tag', 'v=DMARC1; rua=mailto:x@example.com'],
      ['unknown policy value', 'v=DMARC1; p=block'],
      ['empty policy', 'v=DMARC1; p='],
    ])('%s', (_label, record) => {
      const result = evaluateDmarc(txt(record));
      expect(result.verdict).toBe('malformed');
      expect(result.policy).toBeNull();
    });

    it('requires the version tag first, so a mention of DMARC1 elsewhere is not a record', () => {
      expect(evaluateDmarc(txt('note=v=DMARC1; p=reject')).verdict).toBe('missing');
    });

    it('takes the first value of a repeated tag, as receivers do', () => {
      // A second `p=` must not be able to override the first.
      expect(evaluateDmarc(txt('v=DMARC1; p=none; p=reject')).policy).toBe('none');
    });
  });

  it('treats several DMARC records as no usable policy', () => {
    expect(evaluateDmarc(txt('v=DMARC1; p=reject', 'v=DMARC1; p=none')).verdict).toBe(
      'multiple_records',
    );
  });

  it('distinguishes a lookup failure from a missing record', () => {
    expect(evaluateDmarc(null).verdict).toBe('lookup_failed');
  });

  it('does not claim reporting when rua has no address', () => {
    expect(evaluateDmarc(txt('v=DMARC1; p=reject; rua=')).hasAggregateReporting).toBe(false);
  });

  it('has guidance for every verdict', () => {
    for (const guidance of Object.values(DMARC_GUIDANCE)) {
      expect(guidance.length).toBeGreaterThan(20);
    }
  });
});

describe('resolver safety', () => {
  it('accepts the names sender verification actually queries', () => {
    for (const name of [
      'example.com',
      '_dmarc.example.com',
      'bounce.example.com',
      'abc123._domainkey.example.com',
    ]) {
      expect(isQueryableName(name), name).toBe(true);
    }
  });

  it('refuses anything that is not a plain DNS name', () => {
    for (const name of [
      '',
      'example.com ',
      'example.com\nsecond.example.com',
      'exam ple.com',
      'EXAMPLE.COM',
      '.example.com',
      'example..com',
      'http://example.com',
      'example.com/path',
      `${'a'.repeat(64)}.example.com`,
      `${'a'.repeat(250)}.example.com`,
    ]) {
      expect(isQueryableName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('maps resolver error codes onto the port vocabulary', () => {
    expect(classifyDnsError('ENOTFOUND')).toBe('no_data');
    expect(classifyDnsError('ENODATA')).toBe('no_data');
    expect(classifyDnsError('NXDOMAIN')).toBe('nxdomain');
    expect(classifyDnsError('ETIMEOUT')).toBe('timeout');
    expect(classifyDnsError('REFUSED')).toBe('refused');
    expect(classifyDnsError('SERVFAIL')).toBe('error');
    expect(classifyDnsError(undefined)).toBe('error');
  });

  it('answers, fails and reports absence distinctly', async () => {
    const resolver = fakeResolver({
      txt: { 'example.com': txt('v=spf1 -all') },
      fail: { 'broken.example.com': 'timeout' },
    });

    await expect(resolver.resolveTxt('example.com')).resolves.toEqual({
      ok: true,
      records: txt('v=spf1 -all'),
    });
    await expect(resolver.resolveTxt('absent.example.com')).resolves.toEqual({
      ok: false,
      reason: 'no_data',
    });
    await expect(resolver.resolveTxt('broken.example.com')).resolves.toEqual({
      ok: false,
      reason: 'timeout',
    });
  });
});

describe('required DNS records', () => {
  const base = {
    domain: 'example.com',
    dkimTokens: ['tok1', 'tok2', 'tok3'],
    mailFromDomain: 'bounce.example.com',
    region: 'eu-west-1',
  };

  it('builds the three DKIM CNAMEs in SES format', () => {
    const dkim = requiredDnsRecords(base).filter((r) => r.purpose === 'dkim');
    expect(dkim).toHaveLength(3);
    expect(dkim[0]).toMatchObject({
      type: 'CNAME',
      host: 'tok1._domainkey.example.com',
      value: 'tok1.dkim.amazonses.com',
      required: true,
    });
  });

  it('builds a region-specific MAIL FROM MX and its SPF record', () => {
    const records = requiredDnsRecords(base);
    expect(records.find((r) => r.purpose === 'mail_from_mx')).toMatchObject({
      type: 'MX',
      host: 'bounce.example.com',
      value: 'feedback-smtp.eu-west-1.amazonses.com',
      priority: 10,
    });
    expect(records.find((r) => r.purpose === 'mail_from_spf')).toMatchObject({
      type: 'TXT',
      host: 'bounce.example.com',
      value: MAIL_FROM_SPF_VALUE,
    });
  });

  it('omits DKIM records until the provider has issued tokens', () => {
    const records = requiredDnsRecords({ ...base, dkimTokens: null });
    expect(records.filter((r) => r.purpose === 'dkim')).toEqual([]);
  });

  it('omits MAIL FROM records until one is configured', () => {
    const records = requiredDnsRecords({ ...base, mailFromDomain: null });
    expect(records.filter((r) => r.purpose.startsWith('mail_from'))).toEqual([]);
  });

  it('always offers DMARC, marked as recommended rather than required', () => {
    const dmarc = requiredDnsRecords({ ...base, dkimTokens: null, mailFromDomain: null });
    expect(dmarc).toHaveLength(1);
    expect(dmarc[0]).toMatchObject({ host: '_dmarc.example.com', required: false });
  });

  it('produces a MAIL FROM SPF value this system would itself call authorized', () => {
    // The instruction and the check cannot disagree.
    expect(evaluateSpf({ txt: txt(MAIL_FROM_SPF_VALUE) }).verdict).toBe('authorized');
  });
});
