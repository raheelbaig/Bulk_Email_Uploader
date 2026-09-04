import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import {
  fakeProvider,
  fakeResolver,
  seedSenderDomain,
  seedSenderIdentity,
  testSenderRepository,
  txt,
  type FakeProvider,
} from './helpers/sender';
import { EmailProviderError } from '@/lib/sender/provider/types';
import { evaluateSpf } from '@/lib/sender/dns/spf';
import { evaluateDmarc } from '@/lib/sender/dns/dmarc';
import type { SenderDomainRecord, SenderRepository } from '@/lib/sender/ports';

/**
 * The verifier.
 *
 * The pure half is tested directly; the orchestration is tested against a real
 * migrated database through the repository port, so "the status was written"
 * means a row actually changed.
 */

const auditWrites: Array<{ action: string; entityId?: string | undefined }> = [];
vi.mock('@/lib/audit', () => ({
  writeAuditLog: async (entry: { action: string; entityId?: string }) => {
    auditWrites.push({ action: entry.action, entityId: entry.entityId });
  },
  AUDIT_ACTIONS: [],
}));

const { computeVerification, runDomainCheck, spfCheckName } = await import(
  '@/lib/sender/verification'
);

const SPF_OK = txt('v=spf1 include:amazonses.com ~all');
const DMARC_ENFORCING = txt('v=DMARC1; p=reject; rua=mailto:d@example.com');

function baseDomain(overrides: Partial<SenderDomainRecord> = {}): SenderDomainRecord {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    workspace_id: '22222222-2222-2222-2222-222222222222',
    domain: 'example.com',
    ses_identity_arn: null,
    dkim_tokens: null,
    mail_from_domain: 'bounce.example.com',
    spf_status: 'pending',
    dkim_status: 'pending',
    dmarc_status: 'not_configured',
    dmarc_policy: null,
    mail_from_status: 'not_configured',
    last_checked_at: null,
    last_check_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

describe('computeVerification', () => {
  const identity = (over: Record<string, unknown> = {}) =>
    ({
      domain: 'example.com',
      status: 'verified',
      usableForSending: true,
      dkim: { tokens: ['a'.repeat(32)], status: 'verified', signingEnabled: true },
      mailFrom: { domain: 'bounce.example.com', status: 'verified' },
      identityArn: null,
      ...over,
    }) as Parameters<typeof computeVerification>[0]['identity'];

  const run = (args: {
    previous?: SenderDomainRecord;
    identity?: Parameters<typeof computeVerification>[0]['identity'];
    spfTxt?: string[][] | null;
    dmarcTxt?: string[][] | null;
    providerError?: string | null;
  }) =>
    computeVerification({
      previous: args.previous ?? baseDomain(),
      identity: args.identity === undefined ? identity() : args.identity,
      spf: evaluateSpf({ txt: args.spfTxt === undefined ? SPF_OK : args.spfTxt }),
      dmarc: evaluateDmarc(args.dmarcTxt === undefined ? DMARC_ENFORCING : args.dmarcTxt),
      providerError: args.providerError ?? null,
      checkedAt: new Date('2026-01-01T12:00:00.000Z'),
    });

  it('marks a fully configured domain usable', () => {
    const result = run({});
    expect(result.usable).toBe(true);
    expect(result.patch).toMatchObject({
      dkim_status: 'verified',
      spf_status: 'verified',
      mail_from_status: 'verified',
      dmarc_status: 'verified',
      dmarc_policy: 'reject',
      last_check_error: null,
    });
  });

  it('records the check time on every run', () => {
    expect(run({}).patch.last_checked_at).toBe('2026-01-01T12:00:00.000Z');
  });

  describe('DKIM comes from the provider, never from DNS', () => {
    it('is not verified when the provider will not yet send from the identity', () => {
      const result = run({ identity: identity({ usableForSending: false }) });
      expect(result.patch.dkim_status).toBe('pending');
      expect(result.usable).toBe(false);
    });

    it.each([
      ['pending', 'pending'],
      ['not_started', 'pending'],
      ['temporary_failure', 'pending'],
      ['failed', 'failed'],
    ])('provider DKIM %s → stored %s', (providerStatus, stored) => {
      const result = run({
        identity: identity({
          usableForSending: false,
          dkim: { tokens: [], status: providerStatus, signingEnabled: true },
        }),
      });
      expect(result.patch.dkim_status).toBe(stored);
    });

    it('does not treat a temporary provider failure as a hard failure', () => {
      const result = run({
        identity: identity({
          usableForSending: false,
          dkim: { tokens: [], status: 'temporary_failure', signingEnabled: true },
        }),
      });
      expect(result.patch.dkim_status).not.toBe('failed');
    });
  });

  describe('MAIL FROM', () => {
    it('is not_configured when the provider has none', () => {
      const result = run({ identity: identity({ mailFrom: { domain: null, status: 'not_started' } }) });
      expect(result.patch.mail_from_status).toBe('not_configured');
      expect(result.usable).toBe(false);
    });

    it('is pending while the provider is still checking', () => {
      const result = run({
        identity: identity({ mailFrom: { domain: 'bounce.example.com', status: 'pending' } }),
      });
      expect(result.patch.mail_from_status).toBe('pending');
    });
  });

  describe('SPF is checked against the envelope domain', () => {
    it('uses the MAIL FROM domain when one is configured', () => {
      expect(spfCheckName(baseDomain(), identity())).toBe('bounce.example.com');
    });

    it('falls back to the domain itself when there is no MAIL FROM', () => {
      expect(
        spfCheckName(baseDomain({ mail_from_domain: null }), identity({ mailFrom: { domain: null, status: 'not_started' } })),
      ).toBe('example.com');
    });

    it('prefers what the provider reports over what was stored', () => {
      expect(
        spfCheckName(
          baseDomain({ mail_from_domain: 'stale.example.com' }),
          identity({ mailFrom: { domain: 'bounce.example.com', status: 'verified' } }),
        ),
      ).toBe('bounce.example.com');
    });

    it.each([
      [SPF_OK, 'verified'],
      [txt('v=spf1 include:_spf.google.com ~all'), 'pending'],
      [[], 'pending'],
      [txt('v=spf1 -all', 'v=spf1 include:amazonses.com -all'), 'failed'],
      [txt('v=spf1 include:amazonses.com +all'), 'failed'],
    ])('maps an SPF answer onto a status', (records, expected) => {
      expect(run({ spfTxt: records }).patch.spf_status).toBe(expected);
    });
  });

  describe('DMARC', () => {
    it.each([
      [DMARC_ENFORCING, 'verified', 'reject'],
      [txt('v=DMARC1; p=quarantine'), 'verified', 'quarantine'],
      [txt('v=DMARC1; p=none'), 'pending', 'none'],
      [[], 'not_configured', null],
      [txt('v=DMARC1; rua=mailto:x@example.com'), 'failed', null],
      [txt('v=DMARC1; p=none', 'v=DMARC1; p=reject'), 'failed', null],
    ])('maps a DMARC answer onto status and policy', (records, status, policy) => {
      const result = run({ dmarcTxt: records });
      expect(result.patch.dmarc_status).toBe(status);
      expect(result.patch.dmarc_policy).toBe(policy);
    });

    it('never blocks usability', () => {
      expect(run({ dmarcTxt: [] }).usable).toBe(true);
      expect(run({ dmarcTxt: txt('v=DMARC1; p=broken') }).usable).toBe(true);
    });
  });

  describe('a lookup failure is not evidence', () => {
    const verified = baseDomain({
      spf_status: 'verified',
      dkim_status: 'verified',
      dmarc_status: 'verified',
      dmarc_policy: 'reject',
      mail_from_status: 'verified',
      last_checked_at: '2026-01-01T00:00:00.000Z',
    });

    it('keeps the previous SPF status when DNS could not be read', () => {
      const result = run({ previous: verified, spfTxt: null });
      expect(result.patch.spf_status).toBe('verified');
      expect(result.usable).toBe(true);
    });

    it('keeps the previous DMARC status and policy when DNS could not be read', () => {
      const result = run({ previous: verified, dmarcTxt: null });
      expect(result.patch.dmarc_status).toBe('verified');
      expect(result.patch.dmarc_policy).toBe('reject');
    });

    it('still downgrades when the lookup succeeded and found nothing', () => {
      // The distinction that matters: an answer of "no record" is evidence.
      expect(run({ previous: verified, spfTxt: [] }).patch.spf_status).toBe('pending');
    });

    it('keeps the previous statuses when the provider could not be reached', () => {
      const result = run({
        previous: verified,
        identity: null,
        providerError: 'the provider could not be reached',
      });
      expect(result.patch.dkim_status).toBe('verified');
      expect(result.patch.mail_from_status).toBe('verified');
      expect(result.patch.last_check_error).toBe('the provider could not be reached');
    });
  });

  it('treats an identity the provider does not have as pending, not verified', () => {
    const result = run({ identity: null, providerError: null });
    expect(result.patch.dkim_status).toBe('pending');
    expect(result.usable).toBe(false);
  });
});

describe('runDomainCheck against a real database', () => {
  let db: TestDb;
  let workspaceId: string;
  let repository: SenderRepository;
  let provider: FakeProvider;

  const resolver = fakeResolver({
    txt: {
      'bounce.example.com': SPF_OK,
      '_dmarc.example.com': DMARC_ENFORCING,
    },
  });

  const check = (domain: SenderDomainRecord) =>
    runDomainCheck(repository, domain, { provider, resolver });

  beforeAll(async () => {
    db = await createTestDb();
    ({ workspaceId } = await db.createUser('verify@example.test'));
    repository = testSenderRepository(db, workspaceId);
  });
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.raw('delete from sender_identities');
    await db.raw('delete from sender_domains');
    auditWrites.length = 0;
    provider = fakeProvider();
  });

  async function seedVerifiable(): Promise<SenderDomainRecord> {
    const id = await seedSenderDomain(db, workspaceId, 'example.com', {
      mailFromDomain: 'bounce.example.com',
    });
    provider.setIdentity('example.com', {
      status: 'verified',
      usableForSending: true,
      dkimStatus: 'verified',
      mailFromDomain: 'bounce.example.com',
      mailFromStatus: 'verified',
    });
    const record = await repository.getDomain(id);
    if (record === null) throw new Error('seed failed');
    return record;
  }

  it('writes every status to the row', async () => {
    const domain = await seedVerifiable();
    const result = await check(domain);

    expect(result.usable).toBe(true);
    const stored = await repository.getDomain(domain.id);
    expect(stored).toMatchObject({
      spf_status: 'verified',
      dkim_status: 'verified',
      dmarc_status: 'verified',
      dmarc_policy: 'reject',
      mail_from_status: 'verified',
      last_check_error: null,
    });
    expect(stored?.last_checked_at).not.toBeNull();
  });

  it('stamps the identities under a domain that became usable', async () => {
    const domain = await seedVerifiable();
    const identityId = await seedSenderIdentity(db, workspaceId, domain.id, 'hello@example.com');

    await check(domain);

    const identity = await repository.getIdentity(identityId);
    expect(identity?.verified_at).not.toBeNull();
  });

  it('clears the stamp when a domain stops being usable', async () => {
    const domain = await seedVerifiable();
    const identityId = await seedSenderIdentity(db, workspaceId, domain.id, 'hello@example.com');
    await check(domain);

    // DKIM lapses at the provider.
    provider.setIdentity('example.com', { usableForSending: false, dkimStatus: 'failed' });
    const current = await repository.getDomain(domain.id);
    await check(current as SenderDomainRecord);

    const identity = await repository.getIdentity(identityId);
    expect(identity?.verified_at).toBeNull();
  });

  it('records a provider failure on the row rather than throwing', async () => {
    const id = await seedSenderDomain(db, workspaceId, 'example.com');
    provider.failNext('getDomainIdentity', new EmailProviderError('unavailable', 'ses is down'));

    const domain = await repository.getDomain(id);
    await expect(check(domain as SenderDomainRecord)).resolves.toBeTruthy();

    const stored = await repository.getDomain(id);
    expect(stored?.last_check_error).toBe('ses is down');
    expect(stored?.last_checked_at).not.toBeNull();
  });

  it('says so when the domain is not registered with the provider at all', async () => {
    const id = await seedSenderDomain(db, workspaceId, 'example.com');
    const domain = await repository.getDomain(id);
    await check(domain as SenderDomainRecord);

    const stored = await repository.getDomain(id);
    expect(stored?.last_check_error).toMatch(/not registered/i);
    expect(stored?.dkim_status).toBe('pending');
  });

  describe('repeated checks are safe', () => {
    it('produces the same row twice and audits only the transition', async () => {
      const domain = await seedVerifiable();

      await check(domain);
      const first = await repository.getDomain(domain.id);
      await check(first as SenderDomainRecord);
      const second = await repository.getDomain(domain.id);

      const { last_checked_at: _a, updated_at: _u, ...firstRest } = first as SenderDomainRecord;
      const { last_checked_at: _b, updated_at: _v, ...secondRest } = second as SenderDomainRecord;
      expect(secondRest).toEqual(firstRest);

      // One `domain.verified`, not one per check — a six-hourly sweep must not
      // write an audit row per domain per run forever.
      expect(auditWrites.filter((a) => a.action === 'domain.verified')).toHaveLength(1);
    });

    it('audits a failure once, when it appears', async () => {
      const id = await seedSenderDomain(db, workspaceId, 'example.com');
      provider.setIdentity('example.com', { dkimStatus: 'failed' });

      for (let i = 0; i < 3; i += 1) {
        const current = await repository.getDomain(id);
        await check(current as SenderDomainRecord);
      }

      expect(auditWrites.filter((a) => a.action === 'domain.verification_failed')).toHaveLength(1);
    });

    it('audits the loss of a verified domain', async () => {
      const domain = await seedVerifiable();
      await check(domain);
      auditWrites.length = 0;

      provider.setIdentity('example.com', { usableForSending: false, dkimStatus: 'pending' });
      const current = await repository.getDomain(domain.id);
      await check(current as SenderDomainRecord);

      expect(auditWrites.map((a) => a.action)).toContain('domain.verification_failed');
    });

    it('never stores DKIM tokens in the audit trail', async () => {
      const domain = await seedVerifiable();
      await check(domain);
      expect(JSON.stringify(auditWrites)).not.toContain('aaaaaaaa');
    });
  });

  it('checks SPF at the MAIL FROM name, so a record on the apex is not enough', async () => {
    const apexOnly = fakeResolver({
      txt: {
        'example.com': SPF_OK,
        '_dmarc.example.com': DMARC_ENFORCING,
      },
    });
    const domain = await seedVerifiable();
    const result = await runDomainCheck(repository, domain, { provider, resolver: apexOnly });

    expect(result.patch.spf_status).toBe('pending');
    expect(result.usable).toBe(false);
  });
});
