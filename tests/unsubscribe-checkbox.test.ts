import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, type TestDb } from './helpers/db';
import { testCampaignRepository } from './helpers/p4';
import type { TemplateSnapshot } from '@/lib/campaigns/snapshot';

/**
 * Regression: "Include an unsubscribe link" could be unticked on Create
 * Campaign and the campaign was still created with the link ON.
 *
 * An unticked checkbox submits no field at all, and the action mapped "no
 * field" to 'true'. The form now renders a hidden companion
 * (`requiresUnsubscribeShown`) so the action can tell "rendered and unticked"
 * (→ off) from "not part of this submission" (→ the safe default, on).
 *
 * These run the real server action → real service → the migration-0009 schema
 * in PGlite, then compose a message from the stored flag the way the worker
 * does, so each case is proven from the form field to the email body.
 */

let access = { userId: '', workspaceId: '', role: 'owner' as const };

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: 'NEXT_REDIRECT', to });
  },
}));
vi.mock('@/lib/auth/workspace', () => ({
  requireWorkspace: async () => access,
  currentWorkspace: async () => access,
}));
vi.mock('@/lib/rate-limit', () => ({ enforceRateLimit: async () => {} }));
vi.mock('@/lib/audit', () => ({ writeAuditLog: async () => {} }));

let repository: ReturnType<typeof testCampaignRepository> | null = null;
vi.mock('@/lib/campaigns/repository', () => ({
  campaignRepository: async () => {
    if (repository === null) throw new Error('no repository');
    return repository;
  },
}));

const { createCampaignAction, updateCampaignAction } = await import('@/app/(app)/campaigns/actions');
const { parseRequiresUnsubscribe } = await import('@/lib/campaigns/service');
const { readCheckbox } = await import('@/lib/form-fields');
const { composeMessage } = await import('@/lib/sending/compose');

const IDLE = { ok: false, message: null } as const;

function form(entries: Array<[string, string]>): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

/** The fields the Create Campaign form actually renders. */
const SHOWN: [string, string] = ['requiresUnsubscribeShown', '1'];
const TICKED: [string, string] = ['requiresUnsubscribe', 'true'];

const SNAPSHOT: TemplateSnapshot = {
  template_id: '33333333-3333-3333-3333-333333333333',
  version: 1,
  name: 'T',
  subject: 'Hello',
  preview_text: '',
  html: '<p>Hello</p>',
  text: 'Hello',
  variables: [],
  frozen_at: '2026-09-01T00:00:00.000Z',
};

/** What the worker hands the composer for a campaign row (worker.ts). */
function composeFor(requiresUnsubscribe: boolean) {
  const result = composeMessage({
    snapshot: SNAPSHOT,
    mergeData: { custom: {} },
    toEmail: 'ada@example.org',
    sender: { fromEmail: 'news@acme.test', fromName: 'Acme', replyTo: null },
    requiresUnsubscribe,
    unsubscribeUrl: requiresUnsubscribe ? 'https://mail.example.com/u/abc.def' : null,
    postalAddress: 'QA Test Co., 1 Example Street',
    tags: { job_id: 'j1', attempt_no: '1' },
  });
  if (!result.ok) throw new Error(`compose failed: ${result.reason}`);
  return result.message;
}

describe('Create Campaign: unsubscribe checkbox', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    const alice = await db.createUser('alice@example.test');
    access = { userId: alice.userId, workspaceId: alice.workspaceId, role: 'owner' };
    repository = testCampaignRepository(db, alice.workspaceId);
  });
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.raw('delete from campaigns');
  });

  /** Submits the create action and returns the stored flag. */
  async function create(entries: Array<[string, string]>): Promise<boolean> {
    const name = `C ${Math.random().toString(36).slice(2, 8)}`;
    const result = await createCampaignAction(IDLE, form([['name', name], ...entries])).then(
      (state) => ({ redirected: false as const, state }),
      (err: unknown) => {
        if (err instanceof Error && 'digest' in err && err.digest === 'NEXT_REDIRECT') {
          return { redirected: true as const, state: null };
        }
        throw err;
      },
    );
    expect(result).toMatchObject({ redirected: true });
    const { rows } = await db.raw<{ requires_unsubscribe: boolean }>(
      'select requires_unsubscribe from campaigns where name = $1',
      [name],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.requires_unsubscribe;
  }

  it('1. checked → stored ON, and the email carries the link and one-click headers', async () => {
    const stored = await create([SHOWN, TICKED]);
    expect(stored).toBe(true);

    const message = composeFor(stored);
    expect(message.headers['List-Unsubscribe']).toBe('<https://mail.example.com/u/abc.def>');
    expect(message.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(message.html).toContain('href="https://mail.example.com/u/abc.def"');
    expect(message.text).toContain('https://mail.example.com/u/abc.def');
  });

  it('2. unchecked (rendered, not ticked) → stored OFF, and the email has no unsubscribe machinery', async () => {
    const stored = await create([SHOWN]);
    expect(stored).toBe(false);

    const message = composeFor(stored);
    expect(message.headers).toEqual({});
    expect(message.html).not.toMatch(/unsubscribe/i);
    expect(message.text).not.toMatch(/unsubscribe/i);
    // The postal address is still in the footer.
    expect(message.text).toContain('QA Test Co.');
  });

  it('3. missing (neither field submitted) → safe default ON', async () => {
    expect(await create([])).toBe(true);
  });

  it.each([
    ['on (browser default value)', 'on'],
    ['empty string', ''],
    ['"0"', '0'],
    ['"no"', 'no'],
    ['"FALSE" (wrong case)', 'FALSE'],
    ['" false " (padded)', ' false '],
  ])('4. malformed value %s → safe default ON, even with the companion field', async (_label, value) => {
    expect(await create([SHOWN, ['requiresUnsubscribe', value]])).toBe(true);
  });

  it('4. a duplicated field (crafted "true" + "false") → safe default ON', async () => {
    expect(await create([SHOWN, ['requiresUnsubscribe', 'false'], TICKED])).toBe(true);
    expect(await create([SHOWN, TICKED, ['requiresUnsubscribe', 'false']])).toBe(true);
  });

  it('a stray companion value does not matter; only its presence does', async () => {
    expect(await create([['requiresUnsubscribeShown', 'anything']])).toBe(false);
  });

  describe('builder toggle on a draft', () => {
    async function draft(initial: boolean): Promise<string> {
      const { rows } = await db.raw<{ id: string }>(
        'insert into campaigns (workspace_id, name, requires_unsubscribe) values ($1, $2, $3) returning id',
        [access.workspaceId, 'Draft', initial],
      );
      return rows[0]!.id;
    }
    async function stored(id: string): Promise<boolean> {
      const { rows } = await db.raw<{ requires_unsubscribe: boolean }>(
        'select requires_unsubscribe from campaigns where id = $1',
        [id],
      );
      return rows[0]!.requires_unsubscribe;
    }

    it('unticking turns it off; ticking turns it back on', async () => {
      const id = await draft(true);
      expect(await updateCampaignAction(IDLE, form([['campaignId', id], SHOWN]))).toMatchObject({ ok: true });
      expect(await stored(id)).toBe(false);
      expect(await updateCampaignAction(IDLE, form([['campaignId', id], SHOWN, TICKED]))).toMatchObject({ ok: true });
      expect(await stored(id)).toBe(true);
    });

    it('a malformed value on an OFF draft turns it ON, never the reverse', async () => {
      const id = await draft(false);
      await updateCampaignAction(IDLE, form([['campaignId', id], SHOWN, ['requiresUnsubscribe', 'yes']]));
      expect(await stored(id)).toBe(true);
    });
  });

  describe('existing campaigns are unaffected by edits that do not include the checkbox', () => {
    for (const initial of [true, false]) {
      it(`a builder save without the field keeps requires_unsubscribe = ${initial}`, async () => {
        const { rows } = await db.raw<{ id: string }>(
          'insert into campaigns (workspace_id, name, requires_unsubscribe) values ($1, $2, $3) returning id',
          [access.workspaceId, 'Existing', initial],
        );
        const id = rows[0]!.id;

        const state = await updateCampaignAction(IDLE, form([['campaignId', id], ['name', 'Renamed']]));
        expect(state).toMatchObject({ ok: true });

        const after = await db.raw<{ name: string; requires_unsubscribe: boolean }>(
          'select name, requires_unsubscribe from campaigns where id = $1',
          [id],
        );
        expect(after.rows[0]).toEqual({ name: 'Renamed', requires_unsubscribe: initial });
      });
    }
  });
});

describe('readCheckbox / parseRequiresUnsubscribe', () => {
  it('distinguishes ticked, unticked and absent', () => {
    expect(readCheckbox(form([SHOWN, TICKED]), 'requiresUnsubscribe')).toBe('true');
    expect(readCheckbox(form([SHOWN]), 'requiresUnsubscribe')).toBe('false');
    expect(readCheckbox(form([]), 'requiresUnsubscribe')).toBeUndefined();
  });

  it('only an explicit false turns the link off', () => {
    expect(parseRequiresUnsubscribe(false)).toBe(false);
    expect(parseRequiresUnsubscribe('false')).toBe(false);
    for (const value of [undefined, null, true, 'true', 'on', '', '0', 'no', 'FALSE', 0, {}, 'ambiguous']) {
      expect(parseRequiresUnsubscribe(value)).toBe(true);
    }
  });
});

describe('forms that render the checkbox', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('Create Campaign: ticked by default, with the hidden companion field', () => {
    const source = read('src/app/(app)/campaigns/page.tsx');
    expect(source).toMatch(/name="requiresUnsubscribe"\s+value="true"\s+defaultChecked\s/);
    expect(source).toContain(`type="hidden" name={checkboxShownField('requiresUnsubscribe')}`);
  });

  it('campaign builder: reflects the stored value, with the hidden companion field', () => {
    const source = read('src/app/(app)/campaigns/[id]/page.tsx');
    expect(source).toMatch(/name="requiresUnsubscribe"\s+value="true"\s+defaultChecked=\{campaign\.requires_unsubscribe\}/);
    expect(source).toContain(`type="hidden" name={checkboxShownField('requiresUnsubscribe')}`);
  });

  it('every form that renders the checkbox also renders the companion', () => {
    for (const path of ['src/app/(app)/campaigns/page.tsx', 'src/app/(app)/campaigns/[id]/page.tsx']) {
      const source = read(path);
      const boxes = source.match(/name="requiresUnsubscribe"/g)?.length ?? 0;
      const companions = source.match(/checkboxShownField\('requiresUnsubscribe'\)/g)?.length ?? 0;
      expect(companions, path).toBe(boxes);
    }
  });
});
