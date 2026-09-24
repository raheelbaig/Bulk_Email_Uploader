import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signRequest } from '@/lib/sender/provider/ses/sigv4';
import { createSesClient, SES_OPERATIONS, safeProviderMessage } from '@/lib/sender/provider/ses/client';
import { createSesProvider } from '@/lib/sender/provider/ses/provider';
import { EmailProviderError, EMAIL_PROVIDER_METHODS } from '@/lib/sender/provider/types';

/**
 * The provider adapter.
 *
 * `fetch` is stubbed, so these are assertions about the requests this code
 * *makes* and the state it derives — including that the set of requests it is
 * capable of making contains no send operation.
 */

const CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: string | undefined;
}

const requests: RecordedRequest[] = [];

/** A fetch stub that records the request and returns a scripted response. */
function stubFetch(script: Array<{ status?: number; body?: unknown; errorType?: string }>) {
  let call = 0;
  return (async (url: string | URL, init?: RequestInit) => {
    const step = script[Math.min(call, script.length - 1)] ?? {};
    call += 1;
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
    });
    const status = step.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(step.errorType === undefined ? {} : { 'x-amzn-errortype': step.errorType }),
      text: async () => (step.body === undefined ? '' : JSON.stringify(step.body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function providerWith(script: Parameters<typeof stubFetch>[0], region = 'eu-west-1') {
  return createSesProvider({
    region,
    accessKeyId: CREDENTIALS.accessKeyId,
    secretAccessKey: CREDENTIALS.secretAccessKey,
    fetchImpl: stubFetch(script),
  });
}

beforeEach(() => {
  requests.length = 0;
});

describe('SigV4 signing', () => {
  const signable = {
    method: 'POST' as const,
    path: '/v2/email/identities',
    host: 'email.eu-west-1.amazonaws.com',
    region: 'eu-west-1',
    service: 'ses',
    body: '{"EmailIdentity":"example.com"}',
    credentials: CREDENTIALS,
    now: new Date('2024-01-15T09:30:45Z'),
  };

  it('is deterministic for the same request and instant', () => {
    expect(signRequest(signable)).toEqual(signRequest(signable));
  });

  it('produces a credential scope naming the date, region and service', () => {
    const headers = signRequest(signable);
    expect(headers['authorization']).toContain(
      `Credential=${CREDENTIALS.accessKeyId}/20240115/eu-west-1/ses/aws4_request`,
    );
    expect(headers['x-amz-date']).toBe('20240115T093045Z');
  });

  it('never places the secret key in a header', () => {
    const headers = signRequest(signable);
    for (const value of Object.values(headers)) {
      expect(value).not.toContain(CREDENTIALS.secretAccessKey);
    }
  });

  it('changes the signature when the body changes', () => {
    const other = signRequest({ ...signable, body: '{"EmailIdentity":"other.example"}' });
    expect(other['authorization']).not.toBe(signRequest(signable)['authorization']);
  });

  it('changes the signature when the path changes', () => {
    const other = signRequest({ ...signable, path: '/v2/email/identities/example.com' });
    expect(other['authorization']).not.toBe(signRequest(signable)['authorization']);
  });

  it('signs the session token when one is present', () => {
    const headers = signRequest({
      ...signable,
      credentials: { ...CREDENTIALS, sessionToken: 'session-token-value' },
    });
    expect(headers['x-amz-security-token']).toBe('session-token-value');
    expect(headers['authorization']).toContain('x-amz-security-token');
  });

  it('omits content-type when there is no body', () => {
    const headers = signRequest({ ...signable, method: 'GET', body: '' });
    expect(headers['content-type']).toBeUndefined();
    expect(headers['authorization']).not.toContain('content-type');
  });
});

describe('the SES client can only make configuration requests', () => {
  it('exposes exactly four operations', () => {
    expect(Object.keys(SES_OPERATIONS).sort()).toEqual([
      'createEmailIdentity',
      'getAccount',
      'getEmailIdentity',
      'putMailFromAttributes',
    ]);
  });

  it('has no path that could send a message', () => {
    // SESv2's send operation is POST /v2/email/outbound-emails.
    const paths = Object.values(SES_OPERATIONS).map((op) => op.path('example.com'));
    for (const path of paths) {
      expect(path).not.toContain('outbound-emails');
      expect(path).not.toMatch(/send/i);
    }
  });

  it('the source file names no send endpoint at all', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/sender/provider/ses/client.ts'),
      'utf8',
    );
    // Comments are stripped first: the block comment at the top of that file
    // explains why the send endpoint is absent and necessarily names it. What
    // must not appear is the endpoint in *code*.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('outbound-emails');
    expect(code).not.toMatch(/SendEmail|sendEmail/);
  });

  it('talks only to the region endpoint, over https, without following redirects', async () => {
    const provider = providerWith([{ body: { VerificationStatus: 'PENDING' } }]);
    await provider.getDomainIdentity('example.com');

    expect(requests[0]?.url).toBe(
      'https://email.eu-west-1.amazonaws.com/v2/email/identities/example.com',
    );
    expect(requests[0]?.redirect).toBe('error');
  });

  it('refuses an invalid region rather than building a wrong host', () => {
    expect(() =>
      createSesClient({ region: 'not a region', credentials: CREDENTIALS }),
    ).toThrow(EmailProviderError);
  });

  it('refuses an identity that is not already a normalised domain', async () => {
    const client = createSesClient({
      region: 'eu-west-1',
      credentials: CREDENTIALS,
      fetchImpl: stubFetch([{ body: {} }]),
    });
    // Path traversal through the identity segment is the attack this prevents.
    for (const identity of ['../account', 'Example.COM', 'example.com/../account', '']) {
      await expect(client.call('getEmailIdentity', { identity })).rejects.toBeInstanceOf(
        EmailProviderError,
      );
    }
    expect(requests).toHaveLength(0);
  });

  it('strips credential-shaped text from a provider message before it can be stored', () => {
    expect(safeProviderMessage('denied for AKIAIOSFODNN7EXAMPLE on Signature=deadbeefdeadbeef99')).toBe(
      'denied for [redacted] on Signature=[redacted]',
    );
  });

  it('bounds a provider message so it cannot bloat the row it is stored in', () => {
    expect(safeProviderMessage('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('domain identity state', () => {
  it('creates an identity and returns its DKIM tokens', async () => {
    const provider = providerWith([
      {
        body: {
          IdentityType: 'DOMAIN',
          DkimAttributes: {
            Status: 'PENDING',
            // 32 lowercase alphanumeric characters, as SES issues them.
            Tokens: ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)],
            SigningEnabled: true,
          },
        },
      },
    ]);

    const identity = await provider.createDomainIdentity('example.com');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.body).toBe('{"EmailIdentity":"example.com"}');
    expect(identity.dkim.tokens).toEqual(['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]);
    expect(identity.dkim.status).toBe('pending');
    expect(identity.usableForSending).toBe(false);
  });

  it('is idempotent: an existing identity is read back, not duplicated', async () => {
    const provider = providerWith([
      { status: 400, errorType: 'AlreadyExistsException', body: { message: 'already exists' } },
      {
        body: {
          VerificationStatus: 'SUCCESS',
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: 'SUCCESS', Tokens: ['a'.repeat(32)], SigningEnabled: true },
        },
      },
    ]);

    const identity = await provider.createDomainIdentity('example.com');
    expect(requests.map((r) => r.method)).toEqual(['POST', 'GET']);
    expect(identity.usableForSending).toBe(true);
    expect(identity.dkim.status).toBe('verified');
  });

  it('returns null for an identity the provider does not have', async () => {
    const provider = providerWith([{ status: 404, errorType: 'NotFoundException' }]);
    await expect(provider.getDomainIdentity('example.com')).resolves.toBeNull();
  });

  it.each([
    ['SUCCESS', 'verified'],
    ['PENDING', 'pending'],
    ['FAILED', 'failed'],
    ['TEMPORARY_FAILURE', 'temporary_failure'],
    ['NOT_STARTED', 'not_started'],
    ['SOMETHING_NEW', 'not_started'],
  ])('maps DKIM status %s to %s', async (sesStatus, expected) => {
    const provider = providerWith([
      { body: { VerificationStatus: sesStatus, DkimAttributes: { Status: sesStatus } } },
    ]);
    const identity = await provider.getDomainIdentity('example.com');
    expect(identity?.dkim.status).toBe(expected);
  });

  it('does not call an identity usable on DKIM success alone', async () => {
    // SES gates sending on VerifiedForSendingStatus; so does this adapter.
    const provider = providerWith([
      {
        body: {
          VerificationStatus: 'SUCCESS',
          VerifiedForSendingStatus: false,
          DkimAttributes: { Status: 'SUCCESS', Tokens: [] },
        },
      },
    ]);
    const identity = await provider.getDomainIdentity('example.com');
    expect(identity?.usableForSending).toBe(false);
  });

  it('discards DKIM tokens that are not in the format SES issues', async () => {
    // These end up in DNS record hosts shown to the user.
    const provider = providerWith([
      {
        body: {
          DkimAttributes: {
            Status: 'PENDING',
            Tokens: ['good1234good1234', '../../evil', 'has spaces', 42, 'UPPER1234UPPER12'],
          },
        },
      },
    ]);
    const identity = await provider.getDomainIdentity('example.com');
    expect(identity?.dkim.tokens).toEqual(['good1234good1234', 'upper1234upper12']);
  });

  it('caps DKIM tokens at three', async () => {
    const provider = providerWith([
      {
        body: {
          DkimAttributes: { Status: 'PENDING', Tokens: Array.from({ length: 6 }, (_, i) => `token${i}0000000000`) },
        },
      },
    ]);
    const identity = await provider.getDomainIdentity('example.com');
    expect(identity?.dkim.tokens).toHaveLength(3);
  });

  it('reports MAIL FROM as unconfigured when the provider has none', async () => {
    const provider = providerWith([{ body: { MailFromAttributes: {} } }]);
    const identity = await provider.getDomainIdentity('example.com');
    expect(identity?.mailFrom).toEqual({ domain: null, status: 'not_started' });
  });

  it('reports the configured MAIL FROM and its status', async () => {
    const provider = providerWith([
      {
        body: {
          MailFromAttributes: {
            MailFromDomain: 'bounce.example.com',
            MailFromDomainStatus: 'SUCCESS',
          },
        },
      },
    ]);
    const identity = await provider.getDomainIdentity('example.com');
    expect(identity?.mailFrom).toEqual({ domain: 'bounce.example.com', status: 'verified' });
  });

  it('configures MAIL FROM with a PUT that does not reject mail on MX failure', async () => {
    const provider = providerWith([{ body: {} }]);
    await provider.configureMailFrom('example.com', 'bounce.example.com');

    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.url).toContain('/v2/email/identities/example.com/mail-from');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      MailFromDomain: 'bounce.example.com',
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    });
  });

  it('refuses a MAIL FROM subdomain outside the sending domain', async () => {
    const provider = providerWith([{ body: {} }]);
    await expect(
      provider.configureMailFrom('example.com', 'bounce.attacker.example'),
    ).rejects.toBeInstanceOf(EmailProviderError);
    expect(requests).toHaveLength(0);
  });

  it('composes an identity ARN only when the account id is configured', async () => {
    const withAccount = createSesProvider({
      region: 'eu-west-1',
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      accountId: '123456789012',
      fetchImpl: stubFetch([{ body: {} }, { body: {} }]),
    });
    expect((await withAccount.getDomainIdentity('example.com'))?.identityArn).toBe(
      'arn:aws:ses:eu-west-1:123456789012:identity/example.com',
    );

    const without = providerWith([{ body: {} }]);
    expect((await without.getDomainIdentity('example.com'))?.identityArn).toBeNull();
  });
});

describe('account posture', () => {
  it('reads sending limits without assuming production access', async () => {
    const provider = providerWith([
      {
        body: {
          ProductionAccessEnabled: false,
          SendingEnabled: true,
          SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 17 },
        },
      },
    ]);
    await expect(provider.getSendingLimits()).resolves.toEqual({
      sandbox: true,
      sendingEnabled: true,
      max24HourSend: 200,
      maxSendRate: 1,
      sentLast24Hours: 17,
    });
  });

  it('treats a missing production flag as still in the sandbox', async () => {
    const provider = providerWith([{ body: { SendingEnabled: true } }]);
    await expect(provider.getSendingLimits()).resolves.toMatchObject({ sandbox: true });
  });
});

describe('error classification', () => {
  it.each([
    [403, undefined, 'access_denied'],
    [429, undefined, 'rate_limited'],
    [400, 'TooManyRequestsException', 'rate_limited'],
    [404, undefined, 'not_found'],
    [400, 'BadRequestException', 'invalid_request'],
    [503, undefined, 'unavailable'],
  ])('status %s / %s → %s', async (status, errorType, kind) => {
    const provider = providerWith([
      { status, ...(errorType === undefined ? {} : { errorType }), body: { message: 'nope' } },
    ]);
    // getDomainIdentity swallows only not_found; everything else surfaces.
    const call = provider.getDomainIdentity('example.com');
    if (kind === 'not_found') {
      await expect(call).resolves.toBeNull();
    } else {
      await expect(call).rejects.toMatchObject({ kind });
    }
  });

  it('reports a timeout as unavailable rather than as a verification failure', async () => {
    const aborting = (async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;

    const provider = createSesProvider({
      region: 'eu-west-1',
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      fetchImpl: aborting,
    });
    await expect(provider.getDomainIdentity('example.com')).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('does not treat an unreadable success body as a verified identity', async () => {
    const bad = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => 'not json',
      }) as unknown as Response) as unknown as typeof fetch;

    const provider = createSesProvider({
      region: 'eu-west-1',
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      fetchImpl: bad,
    });
    await expect(provider.getDomainIdentity('example.com')).rejects.toBeInstanceOf(
      EmailProviderError,
    );
  });
});

describe('the provider port has no send path', () => {
  it('exposes exactly the four configuration methods', () => {
    const provider = providerWith([{ body: {} }]);
    expect(Object.keys(provider).sort()).toEqual([...EMAIL_PROVIDER_METHODS, 'region'].sort());
  });

  it('has no method whose name suggests delivery', () => {
    for (const method of EMAIL_PROVIDER_METHODS) {
      expect(method).not.toMatch(/send(?!ingLimits)/i);
      expect(method).not.toMatch(/deliver|dispatch|transport|message/i);
    }
  });

  it('the factory is not configured when credentials are absent', async () => {
    vi.resetModules();
    vi.doMock('@/lib/env', () => ({ serverEnv: () => ({ LOG_LEVEL: 'info' }) }));
    const { isProviderConfigured, emailProvider } = await import('@/lib/sender/provider');

    expect(isProviderConfigured()).toBe(false);
    // Matched by message, not by class: resetModules gives the reloaded graph
    // its own EmailProviderError constructor.
    expect(() => emailProvider()).toThrow(/not configured/);
    vi.doUnmock('@/lib/env');
    vi.resetModules();
  });
});
