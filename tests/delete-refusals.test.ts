import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, expectRejected, type TestDb } from './helpers/db';
import { seedList } from './helpers/p1';
import { seedCampaign, seedTemplate } from './helpers/p4';

/**
 * Regression (final QA pass): a refused delete showed "Something went wrong on
 * our side" instead of saying why.
 *
 * `campaigns.list_id` and `campaigns.template_id` are ON DELETE RESTRICT, so a
 * list or template any campaign has used — finished ones included — cannot be
 * deleted. That is correct and stays. But the delete buttons were void form
 * actions: the template service's clear ConflictError, and the list service's
 * raw FK error (mapped to InternalError), were thrown into the error boundary.
 * Now the list service maps 23503 to a ConflictError and every destructive
 * action returns a FormState the page renders.
 */

const state = {
  deleteResult: { data: null as unknown, error: null as unknown },
  serviceError: null as Error | null,
};

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: 'NEXT_REDIRECT' });
  },
}));
vi.mock('@/lib/auth/workspace', () => ({
  requireWorkspace: vi.fn(async () => ({ userId: 'u', workspaceId: 'w', role: 'owner' })),
  currentWorkspace: vi.fn(async () => ({ userId: 'u', workspaceId: 'w', role: 'owner' })),
}));
vi.mock('@/lib/audit', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['delete', 'eq', 'select']) chain[m] = () => chain;
      chain['maybeSingle'] = async () => state.deleteResult;
      return chain;
    },
  }),
}));

const { ConflictError } = await import('@/lib/errors');

function failOrPass<T>(value: T): Promise<T> {
  if (state.serviceError !== null) return Promise.reject(state.serviceError);
  return Promise.resolve(value);
}
vi.mock('@/lib/templates/service', () => ({
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(() => failOrPass(undefined)),
}));
vi.mock('@/lib/campaigns/service', () => ({
  cancelCampaign: vi.fn(() => failOrPass(undefined)),
  createCampaign: vi.fn(),
  deleteCampaign: vi.fn(() => failOrPass(undefined)),
  runCampaignPreflight: vi.fn(),
  scheduleCampaign: vi.fn(),
  unscheduleCampaign: vi.fn(),
  updateCampaignDraft: vi.fn(),
}));
vi.mock('@/lib/contacts/service', () => ({
  createContact: vi.fn(),
  updateContact: vi.fn(),
  deleteContact: vi.fn(() => failOrPass(undefined)),
}));

const { deleteContactList } = await import('@/lib/lists/service');
const appActions = await import('@/app/(app)/actions');
const templateActions = await import('@/app/(app)/templates/actions');
const campaignActions = await import('@/app/(app)/campaigns/actions');

const IDLE = { ok: false, message: null } as const;

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  state.deleteResult = { data: null, error: null };
  state.serviceError = null;
});

describe('the database refuses to delete a list or template a campaign uses', () => {
  let db: TestDb;
  let alice: { userId: string; workspaceId: string };

  beforeAll(async () => {
    db = await createTestDb();
    alice = await db.createUser('delete-refusal@example.test');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('a list named by a campaign cannot be deleted, and the error is a 23503', async () => {
    const listId = await seedList(db, alice.workspaceId, 'Used list');
    const campaignId = await seedCampaign(db, alice.workspaceId);
    await db.raw('update campaigns set list_id = $1 where id = $2', [listId, campaignId]);

    const err = await db.asUser(alice.userId, () =>
      expectRejected(() => db.raw('delete from contact_lists where id = $1', [listId])),
    );
    expect((err as Error & { code?: string }).code).toBe('23503');
    const still = await db.raw('select 1 from contact_lists where id = $1', [listId]);
    expect(still.rows).toHaveLength(1);
  });

  it('a template named by a campaign cannot be deleted either', async () => {
    const templateId = await seedTemplate(db, alice.workspaceId);
    const campaignId = await seedCampaign(db, alice.workspaceId);
    await db.raw('update campaigns set template_id = $1 where id = $2', [templateId, campaignId]);

    const err = await db.asUser(alice.userId, () =>
      expectRejected(() => db.raw('delete from templates where id = $1', [templateId])),
    );
    expect((err as Error & { code?: string }).code).toBe('23503');
  });
});

describe('deleteContactList maps the FK refusal to a ConflictError', () => {
  it('23503 becomes a ConflictError with an explanation', async () => {
    state.deleteResult = { data: null, error: { code: '23503', message: 'violates foreign key constraint' } };
    const err = await deleteContactList('w', 'l').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as InstanceType<typeof ConflictError>).userMessage).toMatch(/campaign uses this list/i);
  });

  it('any other database error is still an internal error, not a conflict', async () => {
    state.deleteResult = { data: null, error: { code: '57014', message: 'canceling statement' } };
    const err = await deleteContactList('w', 'l').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ConflictError);
  });
});

describe('destructive actions return the refusal as a message', () => {
  const refusal = () => new ConflictError('A campaign still uses this template. Remove or cancel that campaign first.');

  it('deleteTemplateAction shows the in-use message', async () => {
    state.serviceError = refusal();
    const result = await templateActions.deleteTemplateAction(IDLE, form({ templateId: 't' }));
    expect(result).toEqual({ ok: false, message: refusal().userMessage });
  });

  it('deleteListAction shows the in-use message', async () => {
    state.deleteResult = { data: null, error: { code: '23503', message: 'fk' } };
    const result = await appActions.deleteListAction(IDLE, form({ listId: 'l' }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/campaign uses this list/i);
  });

  it('cancel, delete campaign and delete contact return messages too', async () => {
    state.serviceError = new ConflictError('This campaign has already moved on.');
    for (const run of [
      () => campaignActions.cancelCampaignAction(IDLE, form({ campaignId: 'c' })),
      () => campaignActions.deleteCampaignAction(IDLE, form({ campaignId: 'c' })),
      () => appActions.deleteContactAction(IDLE, form({ contactId: 'x' })),
    ]) {
      await expect(run()).resolves.toEqual({ ok: false, message: 'This campaign has already moved on.' });
    }
  });

  it('a successful delete still redirects', async () => {
    await expect(templateActions.deleteTemplateAction(IDLE, form({ templateId: 't' }))).rejects.toThrow(
      'NEXT_REDIRECT /templates',
    );
    state.deleteResult = { data: { id: 'l' }, error: null };
    await expect(appActions.deleteListAction(IDLE, form({ listId: 'l' }))).rejects.toThrow('NEXT_REDIRECT /lists');
  });

  it('no (app) server action is a void form action any more', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name === 'actions.ts') files.push(path);
      }
    };
    walk(join(process.cwd(), 'src', 'app', '(app)'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/export async function \w+\(\s*form: FormData\s*\): Promise<void>/);
    }
  });
});
