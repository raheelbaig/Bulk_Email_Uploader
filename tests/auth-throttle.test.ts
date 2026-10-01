import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Brute-force limits on the sign-in and sign-up actions (second QA pass).
 *
 * The production server actions and the production limiter module, with the
 * limiter's database call answered by an in-memory counter that implements the
 * same contract as `public.consume_rate_limit` (admit `limit` per window).
 * Supabase Auth is a spy, so the tests can prove a throttled guess never
 * reaches it.
 */

const state = vi.hoisted(() => ({
  ip: '203.0.113.7' as string | null,
  buckets: new Map<string, number>(),
  keys: [] as string[],
  cookies: new Map<string, string>(),
  user: null as { id: string; email: string } | null,
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'x-forwarded-for' ? state.ip : name === 'user-agent' ? 'vitest' : null),
  }),
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined),
    delete: (name: string) => state.cookies.delete(name),
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: 'NEXT_REDIRECT' });
  },
}));

const signInWithPassword = vi.fn(async () => ({
  data: { user: null, session: null },
  error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
}));
const signUp = vi.fn(async () => ({ data: { user: null, session: null }, error: null }));
const resetPasswordForEmail = vi.fn(async (_email: string, _options: { redirectTo?: string }) => ({ data: {}, error: null }));
const updateUser = vi.fn(async (_attrs: { password: string }) => ({
  data: { user: null },
  error: null as { code: string; message: string; status: number } | null,
}));
const getUser = vi.fn(async () => ({ data: { user: state.user }, error: null }));
const membership = {
  select: () => membership,
  eq: () => membership,
  limit: () => membership,
  maybeSingle: async () => ({ data: { workspace_id: 'ws-1' }, error: null }),
};
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { signInWithPassword, signUp, resetPasswordForEmail, updateUser, getUser },
    from: () => membership,
  }),
}));

const audits: Array<{ action: string }> = [];
vi.mock('@/lib/audit', () => ({ writeAuditLog: async (entry: { action: string }) => void audits.push(entry) }));

vi.mock('@/lib/db/service', () => ({
  unscopedServiceClient: () => ({
    rpc: async (_fn: string, args: { p_bucket_key: string; p_limit: number }) => {
      state.keys.push(args.p_bucket_key);
      const used = (state.buckets.get(args.p_bucket_key) ?? 0) + 1;
      state.buckets.set(args.p_bucket_key, used);
      return { data: used <= args.p_limit, error: null };
    },
  }),
}));

const { signIn, signUp: signUpAction, requestPasswordReset, updatePassword } = await import('@/app/(auth)/actions');

function form(email: string, password = 'correct-horse-battery'): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  return data;
}

beforeEach(() => {
  state.buckets.clear();
  state.keys.length = 0;
  state.ip = '203.0.113.7';
  signInWithPassword.mockClear();
  signUp.mockClear();
  resetPasswordForEmail.mockClear();
  updateUser.mockClear();
  state.cookies.clear();
  state.user = null;
  audits.length = 0;
  process.env['NEXT_PUBLIC_APP_URL'] = 'https://mail.example.com';
});

describe('sign-in throttling', () => {
  it('stops password guessing against one account after 10 tries, before Supabase is asked', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await signIn({ message: null }, form('victim@example.com', `guess-${i}-xxxx`))).message).toMatch(
        /check your email address and password/i,
      );
    }
    const refused = await signIn({ message: null }, form('victim@example.com', 'guess-11-xxxx'));
    expect(refused.message).toMatch(/too many sign-in attempts for this account/i);
    expect(signInWithPassword).toHaveBeenCalledTimes(10);
  });

  it('the per-account limit holds however the guesses are spread across client addresses', async () => {
    for (let i = 0; i < 10; i += 1) {
      state.ip = `198.51.100.${i}`;
      await signIn({ message: null }, form('Victim@Example.com'));
    }
    state.ip = '198.51.100.99';
    expect((await signIn({ message: null }, form('victim@example.com'))).message).toMatch(/too many/i);
    expect(signInWithPassword).toHaveBeenCalledTimes(10);
  });

  it('stops one client spraying many accounts', async () => {
    for (let i = 0; i < 50; i += 1) await signIn({ message: null }, form(`user${i}@example.com`));
    expect((await signIn({ message: null }, form('user50@example.com'))).message).toMatch(/too many sign-in attempts/i);
    expect(signInWithPassword).toHaveBeenCalledTimes(50);
  });

  it('answers identically for an account that does not exist, so throttling is not an oracle', async () => {
    const run = async (email: string) => {
      for (let i = 0; i < 10; i += 1) await signIn({ message: null }, form(email));
      return (await signIn({ message: null }, form(email))).message;
    };
    state.ip = '192.0.2.1';
    const existing = await run('real-user@example.com');
    state.ip = '192.0.2.2';
    const missing = await run('nobody-here@example.com');
    expect(existing).toBe(missing);
  });

  it('stores neither the address nor the client IP in limiter keys', async () => {
    await signIn({ message: null }, form('private.person@example.com'));
    expect(state.keys.length).toBeGreaterThan(0);
    for (const key of state.keys) {
      expect(key).not.toContain('private.person');
      expect(key).not.toContain('203.0.113.7');
    }
  });
});

describe('sign-up throttling', () => {
  it('admits 10 sign-ups per client per hour', async () => {
    for (let i = 0; i < 10; i += 1) await signUpAction({ message: null }, form(`new${i}@example.com`));
    const refused = await signUpAction({ message: null }, form('new10@example.com'));
    expect(refused.message).toMatch(/too many sign-up attempts/i);
    expect(signUp).toHaveBeenCalledTimes(10);
  });
});

describe('password reset requests', () => {
  const ask = (email: string) => {
    const data = new FormData();
    data.set('email', email);
    return requestPasswordReset({ message: null }, data);
  };

  it('answers the same for any address and sends the link back through the fixed recovery flag', async () => {
    const result = await ask('Someone@Example.com');
    expect(result).toEqual({ ok: true, message: expect.stringMatching(/if an account uses that address/i) });
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
    const [email, options] = resetPasswordForEmail.mock.calls[0]!;
    expect(email).toBe('someone@example.com');
    expect(options.redirectTo).toBe('https://mail.example.com/auth/confirm?flow=recovery');
  });

  it('a Supabase failure still gets the neutral answer (no oracle)', async () => {
    resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: { code: 'user_not_found', message: 'x', status: 400 } } as never);
    expect(await ask('nobody@example.com')).toEqual(await ask('somebody@example.com'));
  });

  it('admits 3 requests per address per hour, before Supabase is asked', async () => {
    for (let i = 0; i < 3; i += 1) {
      state.ip = `198.51.100.${i}`;
      expect((await ask('victim@example.com')).ok).toBe(true);
    }
    state.ip = '198.51.100.50';
    expect((await ask('victim@example.com')).message).toMatch(/too many reset requests for this address/i);
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(3);
  });

  it('refuses a malformed address without calling Supabase', async () => {
    expect((await ask('not-an-address')).ok).toBeUndefined();
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe('setting a new password', () => {
  const submit = (password: string, confirm = password) => {
    const data = new FormData();
    data.set('password', password);
    data.set('confirm', confirm);
    return updatePassword({ message: null }, data);
  };

  it('refuses without a session or without the recovery marker', async () => {
    state.cookies.set('pw_recovery', '1');
    expect((await submit('a-new-password')).message).toMatch(/expired/i);
    state.cookies.clear();
    state.user = { id: 'user-1', email: 'owner@example.com' };
    expect((await submit('a-new-password')).message).toMatch(/expired/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('refuses a short or mismatched password', async () => {
    state.user = { id: 'user-1', email: 'owner@example.com' };
    state.cookies.set('pw_recovery', '1');
    expect((await submit('short')).message).toMatch(/at least 8/i);
    expect((await submit('a-new-password', 'another-password')).message).toMatch(/do not match/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('changes the password, clears the marker, audits, and goes to the dashboard', async () => {
    state.user = { id: 'user-1', email: 'owner@example.com' };
    state.cookies.set('pw_recovery', '1');
    await expect(submit('a-new-password')).rejects.toThrow('NEXT_REDIRECT /dashboard');
    expect(updateUser).toHaveBeenCalledWith({ password: 'a-new-password' });
    expect(state.cookies.has('pw_recovery')).toBe(false);
    expect(audits.map((a) => a.action)).toEqual(['auth.password_changed']);
  });

  it('explains a password Supabase rejects as weak, keeping the marker for another try', async () => {
    state.user = { id: 'user-1', email: 'owner@example.com' };
    state.cookies.set('pw_recovery', '1');
    updateUser.mockResolvedValueOnce({ data: { user: null }, error: { code: 'weak_password', message: 'weak', status: 422 } });
    expect((await submit('password123')).message).toMatch(/too easy to guess/i);
    expect(state.cookies.has('pw_recovery')).toBe(true);
  });
});
