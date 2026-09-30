import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Regressions from the phase 3 real-database product QA (2026-09-26).
 *
 * 1. User input parsed with `schema.parse()` threw a raw ZodError, which is not
 *    an AppError: an empty list name, an empty upload, a malformed id or a
 *    malformed import mapping showed "Something went wrong on our side" (or a
 *    500 from the rejections download) and was logged as a server fault.
 * 2. /templates/[id] and /campaigns/[id] had no not-found handling, so an
 *    unknown or other-workspace id rendered the error boundary with a 500;
 *    /imports/[id] and /senders/[domainId] did the same for a malformed id.
 * 3. Every `-[--color-*]` class was Tailwind v3 syntax. Tailwind v4 emits no
 *    rule for it, so primary buttons had no fill and the destructive Delete /
 *    Cancel buttons were white text on a white page.
 * 4. The dashboard said "no sending engine … arrives in later phases" in every
 *    sending mode, and the banner claimed "not production data" on a
 *    development build pointed at the one real project.
 * 5. The global CSP / Referrer-Policy in next.config replaced the stricter
 *    headers the unsubscribe route sets for itself.
 */

vi.mock('@/lib/auth/workspace', () => ({
  requireWorkspace: vi.fn(async () => ({ userId: 'u', workspaceId: 'w', role: 'owner' })),
}));
vi.mock('@/lib/rate-limit', () => ({ enforceRateLimit: vi.fn(async () => {}) }));
vi.mock('@/lib/audit', () => ({ writeAuditLog: vi.fn(async () => {}) }));
// A client exists, but any query through it fails the test: invalid input must
// be refused before it reaches SQL (a malformed uuid there is a 22P02 → 500).
const noQueries = {
  from: () => {
    throw new Error('the database must not be reached for invalid input');
  },
  rpc: () => {
    throw new Error('the database must not be reached for invalid input');
  },
};
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => noQueries }));
vi.mock('@/lib/db/service', () => ({ serviceForWorkspace: () => noQueries, unscopedServiceClient: () => noQueries }));

const { parseInput, ValidationError, ForbiddenError, isAppError } = await import('@/lib/errors');

const SRC = join(process.cwd(), 'src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('parseInput', () => {
  const schema = z.string().trim().min(1, 'Give the list a name.');

  it('returns the parsed value', () => {
    expect(parseInput(schema, '  Newsletter ')).toBe('Newsletter');
  });

  it("throws a ValidationError carrying the schema's message, not a ZodError", () => {
    let caught: unknown;
    try {
      parseInput(schema, '   ');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(isAppError(caught)).toBe(true);
    expect((caught as InstanceType<typeof ValidationError>).userMessage).toBe('Give the list a name.');
  });
});

describe('services refuse invalid input with a message, before touching the database', () => {
  it('lists: an empty or whitespace name', async () => {
    const { createContactList } = await import('@/lib/lists/service');
    for (const name of ['', '    ']) {
      await expect(createContactList('w', name)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        userMessage: 'Give the list a name.',
      });
    }
  });

  it('lists: a malformed list or contact id', async () => {
    const { addListMember } = await import('@/lib/lists/service');
    await expect(addListMember('w', 'not-a-uuid', '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('imports: an empty file', async () => {
    const { createImport } = await import('@/lib/imports/service');
    await expect(
      createImport('w', { filename: 'empty.csv', byteSize: 0, contentType: 'text/csv', targetListId: null }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', userMessage: expect.stringMatching(/empty/i) });
  });

  it('imports: a malformed import id is a 4xx, not a 500', async () => {
    const { getImport } = await import('@/lib/imports/service');
    await expect(getImport('w', 'not-a-uuid')).rejects.toBeInstanceOf(ValidationError);
  });

  it('templates, campaigns and sender domains: a malformed id answers exactly like an absent one', async () => {
    const { getTemplate } = await import('@/lib/templates/service');
    const { getCampaign } = await import('@/lib/campaigns/service');
    const { getSenderDomain } = await import('@/lib/sender/service');
    await expect(getTemplate('w', 'not-a-uuid')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCampaign('w', 'not-a-uuid')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getSenderDomain('w', "1' or 1=1--")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('no request-path service parses user input with a throwing schema.parse()', () => {
    for (const file of ['imports', 'lists', 'contacts', 'suppression'].map((d) => join(SRC, 'lib', d, 'service.ts'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\w+Schema\.parse\(/);
    }
    const actions = readFileSync(join(SRC, 'app', '(app)', 'imports', 'actions.ts'), 'utf8');
    expect(actions).not.toMatch(/Schema\.parse\(/);
  });
});

describe('detail pages render not-found for unknown, other-workspace and malformed ids', () => {
  const pages = walk(join(SRC, 'app', '(app)')).filter((p) => /[\\/]\[[a-zA-Z]+\][\\/]page\.tsx$/.test(p));

  it('finds the detail pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(6);
  });

  it.each(pages.map((p) => [p.slice(SRC.length)]))('%s calls notFound()', (rel) => {
    expect(readFileSync(join(SRC, rel), 'utf8')).toMatch(/\bnotFound\(\)/);
  });
});

describe('Tailwind v4 CSS-variable classes', () => {
  it('uses the v4 `-(--x)` form; the v3 `-[--x]` form compiles to nothing', () => {
    const offenders = walk(SRC)
      .filter((p) => /\.(tsx?|css)$/.test(p))
      .filter((p) => /-\[--[a-z0-9-]+\]/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(SRC.length));
    expect(offenders).toEqual([]);
  });
});

describe('sending state is described truthfully', () => {
  it('the dashboard derives its sending card from the configured mode', () => {
    const page = readFileSync(join(SRC, 'app', '(app)', 'dashboard', 'page.tsx'), 'utf8');
    expect(page).toContain('SENDING_MODE_NOTICE[sending.mode]');
    expect(page).not.toMatch(/foundation stage|no sending engine|arrive in later phases/i);
  });

  it('the environment banner does not claim the data is not production data', () => {
    const banner = readFileSync(join(SRC, 'components', 'environment-banner.tsx'), 'utf8');
    expect(banner).not.toMatch(/environment · not production data/i);
  });
});

describe('next.config security headers', () => {
  it('do not replace the unsubscribe route’s own CSP and Referrer-Policy', async () => {
    // The matcher Next itself uses for `headers()` sources. It ships no types.
    // @ts-expect-error TS7016 — no declaration file for Next's compiled copy
    const { pathToRegexp } = (await import('next/dist/compiled/path-to-regexp')) as unknown as {
      pathToRegexp: (source: string, keys: unknown[], options: object) => RegExp;
    };
    const config = (await import('../next.config')).default;
    const rules = await config.headers!();

    const headerFor = (path: string, key: string): string[] =>
      rules
        .filter((rule) => pathToRegexp(rule.source, [], {}).test(path))
        .flatMap((rule) => rule.headers.filter((h) => h.key === key).map((h) => h.value));

    for (const key of ['Content-Security-Policy', 'Referrer-Policy']) {
      expect(headerFor('/u/eyJ2MSJ9.c2ln', key), key).toEqual([]);
      for (const path of ['/', '/dashboard', '/login', '/users', '/api/imports/x/rejections']) {
        expect(headerFor(path, key), `${key} on ${path}`).toHaveLength(1);
      }
    }
    // The headers that do not conflict still apply everywhere, /u/ included.
    for (const key of ['X-Content-Type-Options', 'X-Frame-Options', 'Strict-Transport-Security']) {
      expect(headerFor('/u/eyJ2MSJ9.c2ln', key), key).toHaveLength(1);
    }
  });
});

describe('the app navigation cannot overflow', () => {
  // Regression: brand, nine links, the address and Sign out once sat in one
  // non-wrapping header row, so at 1400px and below the row overflowed and Sign
  // out was pushed off-screen. Navigation now lives in a left sidebar (a drawer
  // below lg); these pin the structure that keeps every control reachable at
  // 1920–320px.
  const layout = readFileSync(join(SRC, 'app', '(app)', 'layout.tsx'), 'utf8');
  const sidebar = readFileSync(join(SRC, 'components', 'app-shell', 'sidebar.tsx'), 'utf8');

  it('the page column can shrink, so wide content cannot push the page sideways', () => {
    expect(layout).toMatch(/<main[^>]*className="[^"]*\bmin-w-0\b/);
  });

  it('the sidebar is desktop-only and small screens get a drawer with the same navigation', () => {
    expect(sidebar).toMatch(/<aside[\s\S]*?className=\{cn\(\s*'[^']*\bhidden\b[^']*\blg:flex\b/);
    expect(sidebar).toMatch(/<dialog[\s\S]*?<NavList/);
    expect(sidebar).toMatch(/showModal\(\)/);
  });

  it('Sign out cannot shrink and the address truncates instead', () => {
    expect(sidebar).toMatch(/<form action=\{signOutAction\} className="[^"]*\bshrink-0\b/);
    expect(sidebar).toMatch(/className="[^"]*\btruncate\b[^"]*"\s+title=\{email\}/);
  });
});
