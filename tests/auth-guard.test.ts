import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Behavioural tests for the authorization helpers.
 *
 * The Supabase client is mocked so the branches that matter can be driven
 * directly: no session, a session with no membership, a membership with an
 * insufficient role. The RLS suite proves the database half; this proves the
 * application half behaves correctly even when RLS would also have caught it.
 */

const authGetUser = vi.fn();
const fromMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: authGetUser },
    from: fromMock,
  }),
}));

const { requireUser, getCurrentUser } = await import('@/lib/auth/session');
const { requireWorkspace, currentWorkspace } = await import('@/lib/auth/workspace');
const { UnauthenticatedError, ForbiddenError } = await import('@/lib/errors');

const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'a@example.test' };
const WORKSPACE = '22222222-2222-2222-2222-222222222222';

/** Minimal PostgREST-shaped builder: every method chains, maybeSingle resolves. */
function queryReturning(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit']) {
    builder[method] = () => builder;
  }
  builder['maybeSingle'] = async () => result;
  return builder;
}

beforeEach(() => {
  authGetUser.mockReset();
  fromMock.mockReset();
});

describe('proof 4: an unauthenticated caller is rejected', () => {
  it('getCurrentUser returns null when there is no session', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await getCurrentUser()).toBeNull();
  });

  it('getCurrentUser returns null when the JWT fails verification', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
    expect(await getCurrentUser()).toBeNull();
  });

  it('requireUser throws UnauthenticatedError', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('requireWorkspace throws before it ever queries the database', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(requireWorkspace(WORKSPACE)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('the unauthenticated error message does not disclose why', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const err = await requireUser().then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as Error,
    );
    expect(err.message).toBe('Sign in to continue.');
  });
});

describe('requireWorkspace authorization', () => {
  beforeEach(() => {
    authGetUser.mockResolvedValue({ data: { user: USER }, error: null });
  });

  it('grants access when a membership row exists', async () => {
    fromMock.mockReturnValue(queryReturning({ data: { role: 'owner' }, error: null }));
    const access = await requireWorkspace(WORKSPACE);
    expect(access).toEqual({ userId: USER.id, workspaceId: WORKSPACE, role: 'owner' });
  });

  it('denies when no membership row exists', async () => {
    fromMock.mockReturnValue(queryReturning({ data: null, error: null }));
    await expect(requireWorkspace(WORKSPACE)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('denies identically when the query errors — no oracle', async () => {
    fromMock.mockReturnValue(queryReturning({ data: null, error: { message: 'boom' } }));
    const missing = await requireWorkspace(WORKSPACE).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as Error,
    );

    fromMock.mockReturnValue(queryReturning({ data: null, error: null }));
    const denied = await requireWorkspace(WORKSPACE).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e as Error,
    );

    // Same class, same status, same words: a caller cannot distinguish
    // "workspace does not exist" from "not yours".
    expect(missing.constructor).toBe(denied.constructor);
    expect(missing.message).toBe(denied.message);
    expect(denied.message).toBe('You do not have access to this workspace.');
  });

  it('rejects a role value that is not in the allowed set', async () => {
    fromMock.mockReturnValue(queryReturning({ data: { role: 'superuser' }, error: null }));
    await expect(requireWorkspace(WORKSPACE)).rejects.toBeInstanceOf(ForbiddenError);
  });

  describe('minimum role', () => {
    it.each([
      ['member', 'admin', true],
      ['member', 'owner', true],
      ['admin', 'owner', true],
      ['admin', 'admin', false],
      ['owner', 'owner', false],
      ['owner', 'admin', false],
    ])('role %s against minimum %s rejects=%s', async (role, minimumRole, shouldReject) => {
      fromMock.mockReturnValue(queryReturning({ data: { role }, error: null }));
      const call = requireWorkspace(WORKSPACE, { minimumRole: minimumRole as 'admin' | 'owner' });
      if (shouldReject) await expect(call).rejects.toBeInstanceOf(ForbiddenError);
      else await expect(call).resolves.toMatchObject({ role });
    });
  });

  it('does not trust the caller-supplied id as authorization — membership decides', async () => {
    // The browser asks for a workspace it does not belong to. The membership
    // lookup is keyed on the *session* user, so it finds nothing.
    fromMock.mockReturnValue(queryReturning({ data: null, error: null }));
    await expect(requireWorkspace('33333333-3333-3333-3333-333333333333')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('currentWorkspace', () => {
  beforeEach(() => {
    authGetUser.mockResolvedValue({ data: { user: USER }, error: null });
  });

  it('resolves the caller’s workspace', async () => {
    fromMock.mockReturnValue(
      queryReturning({ data: { workspace_id: WORKSPACE, role: 'owner' }, error: null }),
    );
    await expect(currentWorkspace()).resolves.toEqual({
      userId: USER.id,
      workspaceId: WORKSPACE,
      role: 'owner',
    });
  });

  it('denies a user with no workspace rather than inventing one', async () => {
    fromMock.mockReturnValue(queryReturning({ data: null, error: null }));
    await expect(currentWorkspace()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
