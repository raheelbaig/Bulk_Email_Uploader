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
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'x-forwarded-for' ? state.ip : name === 'user-agent' ? 'vitest' : null),
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
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ auth: { signInWithPassword, signUp } }),
}));

vi.mock('@/lib/audit', () => ({ writeAuditLog: async () => {} }));

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

const { signIn, signUp: signUpAction } = await import('@/app/(auth)/actions');

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
