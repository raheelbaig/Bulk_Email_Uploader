import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Static source guarantees.
 *
 * These catch the class of mistake that no runtime test would: a secret imported
 * into a Client Component, a service-role client created outside its sanctioned
 * home, an authorization check using getSession(). They run in milliseconds and
 * fail the build.
 */

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function isClientComponent(content: string): boolean {
  return /^\s*(['"])use client\1/m.test(content.split('\n').slice(0, 5).join('\n'));
}

const FILES = sourceFiles();
const rel = (f: string) => relative(process.cwd(), f).replace(/\\/g, '/');

describe('source security invariants', () => {
  it('finds source files to check', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  // ── Proof 7 (source half) ──────────────────────────────────────────────────
  describe('proof 7: secrets cannot reach the browser', () => {
    const SERVER_SECRET_NAMES = [
      'SUPABASE_SERVICE_ROLE_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'WORKER_HMAC_SECRET',
      'UNSUBSCRIBE_SECRET_V1',
      'DATABASE_URL',
    ];

    it('no Client Component references a server-only environment variable', () => {
      const offenders = FILES.filter((f) => {
        const content = read(f);
        return isClientComponent(content) && SERVER_SECRET_NAMES.some((n) => content.includes(n));
      }).map(rel);
      expect(offenders).toEqual([]);
    });

    it('only lib/db/service.ts and lib/env.ts name the service-role key', () => {
      const allowed = new Set(['src/lib/db/service.ts', 'src/lib/env.ts']);
      const offenders = FILES.filter(
        (f) => read(f).includes('SUPABASE_SERVICE_ROLE_KEY') && !allowed.has(rel(f)),
      ).map(rel);
      expect(offenders).toEqual([]);
    });

    it('every module handling secrets is marked server-only', () => {
      const mustBeServerOnly = ['src/lib/env.ts', 'src/lib/db/service.ts', 'src/lib/audit/index.ts'];
      for (const target of mustBeServerOnly) {
        const content = read(join(process.cwd(), target));
        expect(content, `${target} must import 'server-only'`).toMatch(
          /^import ['"]server-only['"];/m,
        );
      }
    });

    it('no Client Component imports a server-only module', () => {
      const serverOnly = FILES.filter((f) => /^import ['"]server-only['"];/m.test(read(f))).map(
        (f) => rel(f).replace(/^src\//, '@/').replace(/\.tsx?$/, ''),
      );

      const offenders: string[] = [];
      for (const file of FILES) {
        const content = read(file);
        if (!isClientComponent(content)) continue;
        for (const mod of serverOnly) {
          if (content.includes(`from '${mod}'`) || content.includes(`from "${mod}"`)) {
            offenders.push(`${rel(file)} imports ${mod}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('no hard-coded credential-shaped literal in source', () => {
      const patterns = [
        { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
        { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
        { name: 'postgres URL with password', re: /postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@/ },
      ];
      const offenders: string[] = [];
      for (const file of FILES) {
        const content = read(file);
        for (const { name, re } of patterns) {
          if (re.test(content)) offenders.push(`${rel(file)}: ${name}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  // ── Proof 5 ────────────────────────────────────────────────────────────────
  describe('proof 5: server authorization uses getUser(), never getSession()', () => {
    it('no source file calls auth.getSession()', () => {
      const offenders = FILES.filter((f) => /auth\s*\.\s*getSession\s*\(/.test(read(f))).map(rel);
      expect(
        offenders,
        'getSession() decodes the cookie without verifying the JWT and is never an authorization input',
      ).toEqual([]);
    });

    it('session resolution goes through auth.getUser()', () => {
      const session = read(join(process.cwd(), 'src/lib/auth/session.ts'));
      expect(session).toMatch(/auth\.getUser\(\)/);
    });

    it('the middleware refreshes the session with getUser()', () => {
      const mw = read(join(process.cwd(), 'src/lib/supabase/middleware.ts'));
      expect(mw).toMatch(/auth\.getUser\(\)/);
    });
  });

  // ── Proof 6 (source half) ──────────────────────────────────────────────────
  describe('proof 6: service-role access is workspace-scoped by construction', () => {
    it('a supabase-js client is constructed only in lib/db/service.ts', () => {
      // What must be centralised is the *construction* of a service-role client.
      // Importing `SupabaseClient` as a type carries no capability — it compiles
      // away — so a type-only import is not a finding.
      const offenders = FILES.filter((f) => {
        if (rel(f) === 'src/lib/db/service.ts') return false;
        const content = read(f);
        const valueImport = /^import\s+(?!type\s)[^;]*from ['"]@supabase\/supabase-js['"]/m.test(
          content,
        );
        const constructs = /createClient\s*\(/.test(content);
        return valueImport || constructs;
      }).map(rel);
      expect(offenders).toEqual([]);
    });

    it('any supabase-js import outside that module is type-only', () => {
      const importers = FILES.filter(
        (f) =>
          rel(f) !== 'src/lib/db/service.ts' &&
          /from ['"]@supabase\/supabase-js['"]/.test(read(f)),
      );
      for (const file of importers) {
        expect(
          read(file),
          `${rel(file)} imports supabase-js as a value, not a type`,
        ).toMatch(/^import type [^;]*from ['"]@supabase\/supabase-js['"]/m);
      }
    });

    it('the unscoped escape hatch requires a stated reason', () => {
      const service = read(join(process.cwd(), 'src/lib/db/service.ts'));
      expect(service).toMatch(/export function unscopedServiceClient\(reason: string\)/);
    });

    it('every use of the unscoped client passes a reason literal', () => {
      const uses: string[] = [];
      for (const file of FILES) {
        if (rel(file) === 'src/lib/db/service.ts') continue;
        const content = read(file);
        const re = /unscopedServiceClient\(\s*(['"][^'"]+['"])?/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(content)) !== null) {
          if (match[1] === undefined) uses.push(`${rel(file)}: called without a reason`);
        }
      }
      expect(uses).toEqual([]);
    });
  });

  // ── Proof 4 (source half) ──────────────────────────────────────────────────
  describe('proof 4: protected routes are guarded in the layout, not the middleware', () => {
    it('the app layout resolves the user and redirects when absent', () => {
      const layout = read(join(process.cwd(), 'src/app/(app)/layout.tsx'));
      expect(layout).toMatch(/getCurrentUser\(\)/);
      expect(layout).toMatch(/redirect\(['"]\/login['"]\)/);
    });

    it('the middleware makes no authorization decision', () => {
      const mw = read(join(process.cwd(), 'src/lib/supabase/middleware.ts'));
      expect(mw).not.toMatch(/redirect|NextResponse\.redirect/);
    });

    it('every page under (app) is covered by that layout', () => {
      const pages = FILES.filter((f) => /\(app\)[\\/].*page\.tsx$/.test(f));
      expect(pages.length).toBeGreaterThan(0);
      // A nested layout would shadow the guard; there must be exactly one.
      const layouts = FILES.filter((f) => /\(app\)[\\/].*layout\.tsx$/.test(f)).map(rel);
      expect(layouts).toEqual(['src/app/(app)/layout.tsx']);
    });
  });

  describe('error handling does not leak', () => {
    it('no source file interpolates a raw error into a user-facing message', () => {
      const offenders = FILES.filter((f) => /userMessage:\s*`[^`]*\$\{/.test(read(f))).map(rel);
      expect(offenders).toEqual([]);
    });
  });
});
