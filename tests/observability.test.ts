import { describe, it, expect } from 'vitest';
import { redact, REDACTED } from '@/lib/observability/redact';
import { runWithContext, enrichContext, currentContext, newRequestId } from '@/lib/observability/context';
import { formatForTest } from '@/lib/observability/logger';
import {
  AppError,
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
  toSafeErrorBody,
  isAppError,
} from '@/lib/errors';

describe('log redaction', () => {
  it('redacts by key name at any depth', () => {
    const out = redact({
      ok: 'visible',
      password: 'hunter2',
      nested: { accessToken: 'abc', deeper: { api_key: 'k' } },
    }) as Record<string, unknown>;

    expect(out['ok']).toBe('visible');
    expect(out['password']).toBe(REDACTED);
    expect((out['nested'] as Record<string, unknown>)['accessToken']).toBe(REDACTED);
    expect(
      ((out['nested'] as Record<string, unknown>)['deeper'] as Record<string, unknown>)['api_key'],
    ).toBe(REDACTED);
  });

  it.each([
    ['authorization', 'Bearer x'],
    ['Cookie', 'sb-access-token=y'],
    ['service_role_key', 'z'],
    ['hmac', 'sig'],
    ['SUPABASE_ANON_KEY', 'k'],
  ])('redacts key %s', (key, value) => {
    const out = redact({ [key]: value }) as Record<string, unknown>;
    expect(out[key]).toBe(REDACTED);
  });

  it('redacts credential-shaped values regardless of their key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    const out = redact({ harmlessLookingName: jwt, aws: 'AKIAIOSFODNN7EXAMPLE' }) as Record<
      string,
      unknown
    >;
    expect(out['harmlessLookingName']).toBe(REDACTED);
    expect(out['aws']).toBe(REDACTED);
  });

  it('truncates long strings and large arrays instead of dumping them', () => {
    const long = redact({ body: 'x'.repeat(5000) }) as Record<string, string>;
    expect(long['body']).toMatch(/…\[truncated\]$/);
    expect(long['body']!.length).toBeLessThan(2100);

    const arr = redact(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(arr).toHaveLength(21);
    expect(arr[20]).toBe('…80 more');
  });

  it('keeps errors readable but bounds the stack', () => {
    const out = redact(new Error('boom')) as Record<string, unknown>;
    expect(out['name']).toBe('Error');
    expect(out['message']).toBe('boom');
    expect(String(out['stack']).split('\n').length).toBeLessThanOrEqual(12);
  });

  it('terminates on cyclic structures', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect(JSON.stringify(redact(cyclic))).toContain('max-depth');
  });
});

describe('request context', () => {
  it('carries a request id through async work', async () => {
    const requestId = newRequestId();
    await runWithContext({ requestId }, async () => {
      await Promise.resolve();
      expect(currentContext()?.requestId).toBe(requestId);
    });
  });

  it('enriches in place so earlier and later lines share a request id', () => {
    const requestId = newRequestId();
    runWithContext({ requestId }, () => {
      enrichContext({ userId: 'u1', workspaceId: 'w1' });
      expect(currentContext()).toMatchObject({ requestId, userId: 'u1', workspaceId: 'w1' });
    });
  });

  it('is undefined outside a context, and enrich is a no-op rather than a throw', () => {
    expect(currentContext()).toBeUndefined();
    expect(() => enrichContext({ userId: 'u' })).not.toThrow();
  });

  it('does not leak between sibling contexts', () => {
    runWithContext({ requestId: 'a' }, () => enrichContext({ userId: 'first' }));
    runWithContext({ requestId: 'b' }, () => {
      expect(currentContext()?.userId).toBeUndefined();
    });
  });
});

describe('structured logging', () => {
  it('emits single-line JSON carrying the correlation id', () => {
    runWithContext({ requestId: 'req-1' }, () => {
      const line = formatForTest('info', 'campaign launched', { recipients: 10 });
      expect(line).not.toContain('\n');
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toMatchObject({ level: 'info', msg: 'campaign launched', requestId: 'req-1', recipients: 10 });
    });
  });

  it('redacts fields on the way out', () => {
    const line = formatForTest('error', 'provider call failed', {
      authorization: 'Bearer secret',
      awsSecret: 'AKIAIOSFODNN7EXAMPLE',
    });
    expect(line).not.toContain('Bearer secret');
    expect(line).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(line).toContain(REDACTED);
  });
});

describe('typed errors', () => {
  it('maps to the right status codes', () => {
    expect(new UnauthenticatedError().httpStatus).toBe(401);
    expect(new ForbiddenError().httpStatus).toBe(403);
    expect(new ValidationError('Enter an email address.').httpStatus).toBe(400);
  });

  it('keeps the cause off the wire', () => {
    const cause = new Error('duplicate key value violates unique constraint "uq_contact_email"');
    const err = new ValidationError('That contact already exists.', cause);
    const { body } = toSafeErrorBody(err, 'corr-1');

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('uq_contact_email');
    expect(serialized).not.toContain('duplicate key');
    expect(body.error.message).toBe('That contact already exists.');
    expect(body.error.correlationId).toBe('corr-1');
  });

  it('turns an unknown throw into a generic 500 disclosing nothing', () => {
    const { status, body } = toSafeErrorBody(
      new Error('PostgresError: relation "email_jobs" does not exist'),
      'corr-2',
    );
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('email_jobs');
  });

  it('handles a non-Error throw', () => {
    const { status, body } = toSafeErrorBody('a bare string', 'corr-3');
    expect(status).toBe(500);
    expect(body.error.message).toBe('Something went wrong on our side. Try again shortly.');
  });

  it('identifies application errors', () => {
    expect(isAppError(new ForbiddenError())).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('gives 403 and 404 the same wording, so neither confirms existence', () => {
    const forbidden = new ForbiddenError();
    expect(forbidden.userMessage).toBe('You do not have access to this workspace.');
    expect(forbidden.userMessage).not.toMatch(/not found|does not exist/i);
  });

  it('AppError is constructible for cases without a dedicated subclass', () => {
    const err = new AppError({ code: 'CONFLICT', userMessage: 'Already running.', httpStatus: 409 });
    expect(toSafeErrorBody(err, 'c').status).toBe(409);
  });
});
