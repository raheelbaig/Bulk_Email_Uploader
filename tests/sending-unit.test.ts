import { describe, it, expect } from 'vitest';
import { evaluateLiveGate, type LiveGateInput } from '@/lib/sending/gate';
import { MAX_ATTEMPTS, nextAttemptAt } from '@/lib/sending/retry';
import { encodeHeaderText, formatAddress } from '@/lib/sending/mime';
import { composeMessage, type ComposeInput } from '@/lib/sending/compose';
import { mintUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/unsubscribe/token';
import { signWorkerRequest, verifyWorkerRequest } from '@/lib/sending/worker-auth';
import { classifySesError, createSesSendClient, SES_SEND_PATH } from '@/lib/sending/provider/ses-send-client';
import { buildSesSendRequest, createSesOutboundProvider } from '@/lib/sending/provider/ses';
import { createDryRunProvider } from '@/lib/sending/provider/dry-run';
import { budgetFromLimits } from '@/lib/sending/limits';
import type { OutboundMessage } from '@/lib/sending/provider/types';
import type { TemplateSnapshot } from '@/lib/campaigns/snapshot';

/**
 * The sending engine's pure parts, exhaustively. No database, no network.
 */

// ── The live gate ─────────────────────────────────────────────────────────────

describe('the live gate', () => {
  const open: LiveGateInput = {
    mode: 'live',
    hasProviderCredentials: true,
    hasConfigurationSet: true,
    hasUnsubscribeSecret: true,
    hasWorkerSecret: true,
    appUrl: 'https://mail.example.com',
  };

  it('opens only when every requirement holds', () => {
    expect(evaluateLiveGate(open)).toEqual({ allowed: true, unmet: [] });
  });

  it.each([
    ['mode_is_live', { mode: 'dry_run' as const }],
    ['provider_credentials', { hasProviderCredentials: false }],
    ['configuration_set', { hasConfigurationSet: false }],
    ['unsubscribe_secret', { hasUnsubscribeSecret: false }],
    ['worker_secret', { hasWorkerSecret: false }],
    ['https_app_url', { appUrl: 'http://mail.example.com' }],
    ['https_app_url', { appUrl: 'https://localhost:3000' }],
    ['https_app_url', { appUrl: 'not a url' }],
  ])('stays closed without %s', (requirement, patch) => {
    const verdict = evaluateLiveGate({ ...open, ...patch });
    expect(verdict.allowed).toBe(false);
    expect(verdict.unmet).toEqual([requirement]);
  });

  it('names every unmet requirement, never a value', () => {
    const verdict = evaluateLiveGate({
      mode: 'disabled',
      hasProviderCredentials: false,
      hasConfigurationSet: false,
      hasUnsubscribeSecret: false,
      hasWorkerSecret: false,
      appUrl: 'http://localhost:3000',
    });
    expect(verdict.unmet).toHaveLength(6);
  });
});

// ── Retry timing ──────────────────────────────────────────────────────────────

describe('retry timing (ARCHITECTURE §14.2)', () => {
  const now = new Date('2026-09-01T00:00:00.000Z');

  it.each([
    [1, 60_000],
    [2, 240_000],
    [3, 900_000],
    [4, 3_600_000],
  ])('after attempt %i waits at most %i ms', (attempts, ceiling) => {
    const latest = nextAttemptAt(attempts, now, () => 0.999999);
    expect(latest).not.toBeNull();
    expect(latest!.getTime() - now.getTime()).toBeLessThanOrEqual(ceiling);
    expect(latest!.getTime() - now.getTime()).toBeGreaterThan(ceiling * 0.99);
  });

  it('has a floor, so a jittered retry never lands in the same tick', () => {
    const soonest = nextAttemptAt(1, now, () => 0);
    expect(soonest!.getTime() - now.getTime()).toBe(10_000);
  });

  it('jitters — the same failure does not retry at the same instant', () => {
    const a = nextAttemptAt(3, now, () => 0.1)!.getTime();
    const b = nextAttemptAt(3, now, () => 0.7)!.getTime();
    expect(a).not.toBe(b);
  });

  it('gives up after the fifth attempt', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(nextAttemptAt(5, now)).toBeNull();
    expect(nextAttemptAt(6, now)).toBeNull();
  });
});

// ── Header encoding ───────────────────────────────────────────────────────────

describe('header encoding (RFC 2047)', () => {
  const decode = (encoded: string) =>
    encoded
      .split(' ')
      .map((word) => {
        const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word);
        return m === null ? word : Buffer.from(m[1]!, 'base64').toString('utf8');
      })
      .join('');

  it('leaves ASCII alone', () => {
    expect(encodeHeaderText('March newsletter')).toBe('March newsletter');
  });

  it('encodes non-ASCII so SES accepts it, and it decodes back exactly', () => {
    const subject = 'Café news — 50% off for Zoë 🎉';
    const encoded = encodeHeaderText(subject);
    expect(encoded).toMatch(/^[\x20-\x7e]+$/);
    expect(decode(encoded)).toBe(subject);
  });

  it('keeps every encoded-word within 75 characters and never splits a character', () => {
    const subject = 'Ünïcödé '.repeat(30) + '日本語のテキスト'.repeat(10);
    const words = encodeHeaderText(subject).split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    expect(decode(encodeHeaderText(subject))).toBe(subject);
  });

  it('quotes an ASCII display name, so a comma cannot split the address', () => {
    expect(formatAddress('Acme, Inc.', 'news@acme.test')).toBe('"Acme, Inc." <news@acme.test>');
    expect(formatAddress('Say "hi"', 'a@b.test')).toBe('"Say \\"hi\\"" <a@b.test>');
    expect(formatAddress('  ', 'a@b.test')).toBe('a@b.test');
  });

  it('encodes a non-ASCII display name', () => {
    const formatted = formatAddress('Zoë', 'z@b.test');
    expect(formatted).toMatch(/^=\?UTF-8\?B\?.+\?= <z@b\.test>$/);
  });
});

// ── Composition ───────────────────────────────────────────────────────────────

const SNAPSHOT: TemplateSnapshot = {
  template_id: '33333333-3333-3333-3333-333333333333',
  version: 2,
  name: 'Newsletter',
  subject: 'Hello {{first_name}}',
  preview_text: 'News from {{company}}',
  html: '<p>Hello {{first_name}} at <a href="{{website}}">{{company}}</a></p>',
  text: 'Hello {{first_name}} at {{company}}',
  variables: ['first_name', 'company', 'website'],
  frozen_at: '2026-09-01T00:00:00.000Z',
};

function composeInput(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    snapshot: SNAPSHOT,
    mergeData: { first_name: 'Ada', company: 'Analytical & Co', website: 'https://ada.example', custom: {} },
    toEmail: 'ada@example.org',
    sender: { fromEmail: 'news@acme.test', fromName: 'Acme', replyTo: 'hello@acme.test' },
    requiresUnsubscribe: true,
    unsubscribeUrl: 'https://mail.example.com/u/abc.def',
    tags: { job_id: 'j1', attempt_no: '1' },
    ...overrides,
  };
}

function composed(overrides: Partial<ComposeInput> = {}): OutboundMessage {
  const result = composeMessage(composeInput(overrides));
  if (!result.ok) throw new Error(`compose failed: ${result.reason}`);
  return result.message;
}

describe('message composition', () => {
  it('renders the frozen snapshot with the frozen merge data', () => {
    const message = composed();
    expect(message.subject).toBe('Hello Ada');
    expect(message.to).toBe('ada@example.org');
    expect(message.html).toContain('Hello Ada');
    expect(message.html).toContain('Analytical &amp; Co');
    expect(message.text).toContain('Hello Ada at Analytical & Co');
  });

  it('carries RFC 8058 one-click headers and a visible link in both bodies', () => {
    const message = composed();
    expect(message.headers).toEqual({
      'List-Unsubscribe': '<https://mail.example.com/u/abc.def>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(message.html).toContain('href="https://mail.example.com/u/abc.def"');
    expect(message.text).toContain('Unsubscribe: https://mail.example.com/u/abc.def');
  });

  it('refuses to compose without a link when the campaign requires one', () => {
    const result = composeMessage(composeInput({ unsubscribeUrl: null }));
    expect(result).toMatchObject({ ok: false, reason: 'unsubscribe_unavailable' });
  });

  it('adds no unsubscribe machinery to a campaign that does not require it', () => {
    const message = composed({ requiresUnsubscribe: false, unsubscribeUrl: null });
    expect(message.headers).toEqual({});
    expect(message.html).not.toMatch(/unsubscribe/i);
  });

  it('includes a hidden preheader from the preview text', () => {
    expect(composed().html).toMatch(/display:none[^>]*>News from Analytical &amp; Co</);
  });

  it('refuses a template whose personalization does not resolve', () => {
    const result = composeMessage(
      composeInput({ snapshot: { ...SNAPSHOT, subject: 'Hi {{frist_name}}' } }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'render_failed' });
  });

  it('a hostile merge value cannot inject markup, a script URL, or a header', () => {
    const message = composed({
      mergeData: {
        first_name: 'Eve\r\nBcc: victim@example.org',
        company: '<script>alert(1)</script>',
        website: 'javascript:alert(1)',
      },
    });
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toMatch(/href="javascript:/i);
  });

  it('a value that looks like a variable is not re-expanded', () => {
    const message = composed({ mergeData: { first_name: '{{email}}', company: 'x' } });
    expect(message.subject).toBe('Hello {{email}}');
  });

  it('refuses an undeliverable recipient', () => {
    expect(composeMessage(composeInput({ toEmail: 'not an address' }))).toMatchObject({
      ok: false,
      reason: 'invalid_recipient',
    });
  });

  it('refuses an unsubscribe URL that would break the header', () => {
    const result = composeMessage(composeInput({ unsubscribeUrl: 'https://x.test/u/a\r\nBcc: y@z' }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid_header' });
  });
});

// ── Unsubscribe tokens ────────────────────────────────────────────────────────

describe('unsubscribe tokens (ARCHITECTURE §10)', () => {
  const keys = { v1: 'k'.repeat(40) };
  const claims = {
    workspaceId: '11111111-1111-1111-1111-111111111111',
    campaignId: '22222222-2222-2222-2222-222222222222',
    jobId: '33333333-3333-3333-3333-333333333333',
  };

  it('round-trips', () => {
    const token = mintUnsubscribeToken(claims, keys, 'v1');
    expect(verifyUnsubscribeToken(token, keys)).toEqual(claims);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('rejects a tampered payload', () => {
    const token = mintUnsubscribeToken(claims, keys, 'v1');
    const [, sig] = token.split('.');
    const forged = Buffer.from(`v1.${claims.workspaceId}.${claims.campaignId}.44444444-4444-4444-4444-444444444444`).toString('base64url');
    expect(verifyUnsubscribeToken(`${forged}.${sig}`, keys)).toBeNull();
  });

  it('rejects a token signed with another key', () => {
    const token = mintUnsubscribeToken(claims, { v1: 'x'.repeat(40) }, 'v1');
    expect(verifyUnsubscribeToken(token, keys)).toBeNull();
  });

  it('rejects a retired or unknown key version', () => {
    const token = mintUnsubscribeToken(claims, { v2: 'k'.repeat(40) }, 'v2');
    expect(verifyUnsubscribeToken(token, keys)).toBeNull();
  });

  it('keeps verifying an old version while it stays in the map — links never expire', () => {
    const old = mintUnsubscribeToken(claims, keys, 'v1');
    expect(verifyUnsubscribeToken(old, { ...keys, v2: 'n'.repeat(40) })).toEqual(claims);
  });

  it.each(['', 'a', 'a.b.c', '....', 'x'.repeat(600), '%%%.%%%', null, 42])('rejects garbage: %s', (value) => {
    expect(verifyUnsubscribeToken(value, keys)).toBeNull();
  });

  it('refuses to mint with no key configured', () => {
    expect(() => mintUnsubscribeToken(claims, {}, 'v1')).toThrow(/not configured/);
  });
});

// ── Worker authentication ─────────────────────────────────────────────────────

describe('worker request authentication', () => {
  const secret = 's'.repeat(40);
  const now = 1_790_000_000;
  const ts = String(now);
  const body = '{}';

  it('accepts a correctly signed, fresh request', () => {
    const signature = signWorkerRequest(secret, ts, body);
    expect(verifyWorkerRequest({ secret, timestamp: ts, signature, body, nowSeconds: now })).toEqual({ ok: true });
  });

  it.each([
    ['not_configured', { secret: undefined }],
    ['not_configured', { secret: 'short' }],
    ['missing_headers', { signature: null }],
    ['missing_headers', { timestamp: null }],
    ['bad_timestamp', { timestamp: 'yesterday' }],
    ['stale', { nowSeconds: now + 301 }],
    ['stale', { nowSeconds: now - 301 }],
    ['bad_signature', { signature: signWorkerRequest('t'.repeat(40), ts, body) }],
    ['bad_signature', { body: '{"campaign":"x"}' }],
    ['bad_signature', { signature: 'v1=00' }],
  ] as const)('refuses: %s', (reason, patch) => {
    const signature = signWorkerRequest(secret, ts, body);
    const result = verifyWorkerRequest({ secret, timestamp: ts, signature, body, nowSeconds: now, ...patch });
    expect(result).toEqual({ ok: false, reason });
  });
});

// ── The SES send client ───────────────────────────────────────────────────────

describe('SES error classification', () => {
  it.each([
    ['AccountSuspendedException', 400, 'halt'],
    ['SendingPausedException', 400, 'halt'],
    ['MailFromDomainNotVerifiedException', 400, 'halt'],
    ['NotFoundException', 404, 'halt'],
    ['AccessDeniedException', 403, 'halt'],
    ['', 403, 'halt'],
    ['TooManyRequestsException', 429, 'transient'],
    ['LimitExceededException', 400, 'transient'],
    ['', 503, 'transient'],
    ['MessageRejected', 400, 'permanent'],
    ['BadRequestException', 400, 'permanent'],
    ['SomethingNobodyHasSeen', 400, 'permanent'],
  ] as const)('%s (%i) → %s', (type, status, expected) => {
    expect(classifySesError(status, type)).toBe(expected);
  });
});

describe('the SES send client', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-secret-secret' };
  const message: OutboundMessage = {
    from: { email: 'news@acme.test', name: 'Acme' },
    replyTo: null,
    to: 'ada@example.org',
    subject: 'Café',
    html: '<p>hi</p>',
    text: 'hi',
    headers: { 'List-Unsubscribe': '<https://x.test/u/t>' },
    tags: { job_id: '33333333-3333-3333-3333-333333333333', attempt_no: '1' },
  };

  function clientWith(respond: (url: string, init: RequestInit) => Promise<Response> | Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
    const provider = createSesOutboundProvider({
      configurationSet: 'app-primary',
      client: createSesSendClient({ region: 'eu-west-1', credentials, fetchImpl, timeoutMs: 50 }),
    });
    return { provider, calls };
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('posts one signed request to the regional endpoint and records the message id', async () => {
    const { provider, calls } = clientWith(() => json(200, { MessageId: '0102abc-000000' }));
    await expect(provider.send(message)).resolves.toEqual({ status: 'accepted', providerMessageId: '0102abc-000000' });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`https://email.eu-west-1.amazonaws.com${SES_SEND_PATH}`);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request/);
    expect(JSON.stringify(headers)).not.toContain('secret-secret-secret');

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body['ConfigurationSetName']).toBe('app-primary');
    expect(body['Destination']).toEqual({ ToAddresses: ['ada@example.org'] });
    expect(body['EmailTags']).toEqual([
      { Name: 'job_id', Value: '33333333-3333-3333-3333-333333333333' },
      { Name: 'attempt_no', Value: '1' },
    ]);
  });

  it.each([
    [400, 'MessageRejected', 'permanent'],
    [429, 'TooManyRequestsException', 'transient'],
    [403, 'AccessDeniedException', 'halt'],
    [500, 'InternalFailure', 'transient'],
  ] as const)('a %i %s is a known rejection (%s)', async (status, type, failure) => {
    const { provider } = clientWith(() =>
      json(status, { message: 'nope AKIAABCDEFGHIJKLMNOP' }, { 'x-amzn-errortype': `${type}:http://internal` }),
    );
    const outcome = await provider.send(message);
    expect(outcome).toMatchObject({ status: 'rejected', failure, code: type });
    // Provider messages are scrubbed of anything credential-shaped before storage.
    expect(JSON.stringify(outcome)).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('a timeout is UNKNOWN, never a retryable rejection', async () => {
    const { provider } = clientWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    await expect(provider.send(message)).resolves.toMatchObject({ status: 'unknown', code: 'timeout' });
  });

  it('a connection reset mid-request is UNKNOWN', async () => {
    const { provider } = clientWith(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    await expect(provider.send(message)).resolves.toMatchObject({ status: 'unknown', code: 'network_error' });
  });

  it('a connection that never opened is a transient rejection — nothing can have been sent', async () => {
    const { provider } = clientWith(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    await expect(provider.send(message)).resolves.toMatchObject({
      status: 'rejected',
      failure: 'transient',
      code: 'connect_failed',
    });
  });

  it('a 200 with no message id is UNKNOWN — SES may have accepted it', async () => {
    const { provider } = clientWith(() => json(200, {}));
    await expect(provider.send(message)).resolves.toMatchObject({ status: 'unknown', code: 'missing_message_id' });
  });

  it('refuses an invalid region at construction', () => {
    expect(() => createSesSendClient({ region: 'evil.com/', credentials })).toThrow(/region/);
  });
});

describe('the SES request body', () => {
  const base: OutboundMessage = {
    from: { email: 'news@acme.test', name: 'Zoë' },
    replyTo: 'reply@acme.test',
    to: 'ada@example.org',
    subject: 'Café news',
    html: '<p>h</p>',
    text: 't',
    headers: {},
    tags: {},
  };

  it('encodes a non-ASCII subject and sender name, which SES requires', () => {
    const body = buildSesSendRequest(base, 'app-primary') as {
      FromEmailAddress: string;
      Content: { Simple: { Subject: { Data: string } } };
      ReplyToAddresses: string[];
    };
    expect(body.Content.Simple.Subject.Data).toMatch(/^=\?UTF-8\?B\?/);
    expect(body.FromEmailAddress).toMatch(/^=\?UTF-8\?B\?.+\?= <news@acme\.test>$/);
    expect(body.ReplyToAddresses).toEqual(['reply@acme.test']);
  });

  it('refuses a tag SES would reject, before sending anything', async () => {
    let called = false;
    const provider = createSesOutboundProvider({
      configurationSet: 'app-primary',
      client: {
        region: 'eu-west-1',
        sendEmail: async () => {
          called = true;
          return { status: 'accepted', providerMessageId: 'x' };
        },
      },
    });
    const outcome = await provider.send({ ...base, tags: { job_id: 'has space' } });
    expect(outcome).toMatchObject({ status: 'rejected', failure: 'permanent', code: 'invalid_message' });
    expect(called).toBe(false);
  });

  it('refuses to exist without a configuration set', () => {
    expect(() =>
      createSesOutboundProvider({ configurationSet: '', client: { region: 'eu-west-1', sendEmail: async () => ({ status: 'unknown', code: 'x', detail: 'x' }) } }),
    ).toThrow(/configuration set/);
  });
});

// ── Dry run and budgets ───────────────────────────────────────────────────────

describe('the dry-run provider', () => {
  it('accepts every message with an id that cannot be mistaken for a real one', async () => {
    const seen: OutboundMessage[] = [];
    const provider = createDryRunProvider({ inspect: (m) => seen.push(m) });
    const outcome = await provider.send({
      from: { email: 'a@b.test', name: 'A' },
      replyTo: null,
      to: 'c@d.test',
      subject: 's',
      html: 'h',
      text: 't',
      headers: {},
      tags: {},
    });
    expect(provider.mode).toBe('dry_run');
    expect(outcome.status).toBe('accepted');
    expect(outcome.status === 'accepted' && outcome.providerMessageId).toMatch(/^dryrun-[0-9a-f-]{36}$/);
    expect(seen).toHaveLength(1);
  });
});

describe('provider limits → budget', () => {
  it('scales the provider rate and daily cap by the safety factor', () => {
    expect(
      budgetFromLimits({ sandbox: true, sendingEnabled: true, maxSendRate: 1, max24HourSend: 200, sentLast24Hours: 50 }, 0.8),
    ).toEqual({ perMinute: 48, remainingToday: 110 });
  });

  it('never goes negative when the provider has already counted past the cap', () => {
    expect(
      budgetFromLimits({ sandbox: true, sendingEnabled: true, maxSendRate: 1, max24HourSend: 200, sentLast24Hours: 199 }, 0.8),
    ).toEqual({ perMinute: 48, remainingToday: 0 });
  });

  it('is zero when the account cannot send', () => {
    expect(
      budgetFromLimits({ sandbox: false, sendingEnabled: false, maxSendRate: 14, max24HourSend: 50000, sentLast24Hours: 0 }, 0.8),
    ).toEqual({ perMinute: 0, remainingToday: 0 });
  });

  it('is unknown — and so blocks — when any limit is missing', () => {
    expect(
      budgetFromLimits({ sandbox: true, sendingEnabled: true, maxSendRate: 1, max24HourSend: 200, sentLast24Hours: null }, 0.8),
    ).toBeNull();
  });
});
