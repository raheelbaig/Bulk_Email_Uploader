import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Staged-file lifecycle, and the static guarantees that cannot be observed at
 * runtime: that the importer uses the P1 normalizer rather than a second one,
 * and that every import audit action is declared.
 */

// ── Lifecycle ───────────────────────────────────────────────────────────────

interface StoredRow {
  id: string;
  status: string;
  storage_path: string;
}

const state: {
  rows: StoredRow[];
  updates: Array<{ id: string; patch: Record<string, unknown>; statuses: string[] }>;
  removed: string[];
  removeShouldFailFor: Set<string>;
} = { rows: [], updates: [], removed: [], removeShouldFailFor: new Set() };

/** A PostgREST-shaped stub that records what the sweeper built. */
function selectBuilder() {
  const builder = {
    lt: () => builder,
    neq: () => builder,
    order: () => builder,
    limit: () => Promise.resolve({ data: state.rows, error: null }),
  };
  return builder;
}

function updateBuilder(patch: Record<string, unknown>) {
  let id = '';
  const builder = {
    eq(_column: string, value: string) {
      id = value;
      return builder;
    },
    in(_column: string, statuses: string[]) {
      state.updates.push({ id, patch, statuses });
      return Promise.resolve({ data: null, error: null });
    },
    then(resolve: (value: { data: null; error: null }) => unknown) {
      state.updates.push({ id, patch, statuses: [] });
      return Promise.resolve(resolve({ data: null, error: null }));
    },
  };
  return builder;
}

vi.mock('@/lib/db/service', () => ({
  serviceForWorkspace: () => ({
    select: () => selectBuilder(),
    update: (_table: string, patch: Record<string, unknown>) => updateBuilder(patch),
  }),
  unscopedServiceClient: () => ({}),
}));

vi.mock('@/lib/imports/repository', () => ({
  importRepository: () => ({}),
  importStorage: () => ({
    async remove(paths: readonly string[]) {
      for (const path of paths) {
        if (state.removeShouldFailFor.has(path)) throw new Error('object not found');
        state.removed.push(path);
      }
    },
  }),
}));

vi.mock('@/lib/observability/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { sweepStagedFiles } = await import('@/lib/imports/lifecycle');
const { STAGED_FILE_MAX_AGE_MS } = await import('@/lib/imports/constants');

const WORKSPACE = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  state.rows = [];
  state.updates = [];
  state.removed = [];
  state.removeShouldFailFor = new Set();
});

describe('the 24-hour staged-file sweep', () => {
  it('deletes staged files left behind by old imports', async () => {
    state.rows = [
      { id: 'i1', status: 'completed', storage_path: `${WORKSPACE}/i1/a.csv` },
      { id: 'i2', status: 'failed', storage_path: `${WORKSPACE}/i2/b.csv` },
    ];

    const result = await sweepStagedFiles(WORKSPACE);

    expect(result.removed).toEqual([`${WORKSPACE}/i1/a.csv`, `${WORKSPACE}/i2/b.csv`]);
    expect(state.removed).toHaveLength(2);
  });

  it('marks an upload that was never completed as failed, honestly', async () => {
    state.rows = [{ id: 'i3', status: 'uploaded', storage_path: `${WORKSPACE}/i3/c.csv` }];

    const result = await sweepStagedFiles(WORKSPACE);

    expect(result.abandoned).toEqual(['i3']);
    const update = state.updates[0];
    expect(update?.patch['status']).toBe('failed');
    expect(update?.patch['error_message']).toContain('24 hours');
    // Guarded: only a still-pending import is rewritten, never a terminal one.
    expect(update?.statuses).toEqual(['uploaded', 'mapping']);
  });

  it('does not rewrite the status of an import that already finished', async () => {
    state.rows = [{ id: 'i4', status: 'completed', storage_path: `${WORKSPACE}/i4/d.csv` }];
    const result = await sweepStagedFiles(WORKSPACE);
    expect(result.abandoned).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('tolerates a file the runner already deleted', async () => {
    const path = `${WORKSPACE}/i5/e.csv`;
    state.rows = [{ id: 'i5', status: 'completed', storage_path: path }];
    state.removeShouldFailFor = new Set([path]);

    const result = await sweepStagedFiles(WORKSPACE);

    // The common case: the runner removed it on success and this pass is only
    // confirming. Not an error.
    expect(result.removed).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('does nothing when there is nothing to sweep', async () => {
    const result = await sweepStagedFiles(WORKSPACE);
    expect(result).toEqual({ removed: [], abandoned: [] });
  });

  it('uses a 24-hour retention window', () => {
    expect(STAGED_FILE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ── Static guarantees ───────────────────────────────────────────────────────

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? sourceFiles(full)
      : /\.(ts|tsx)$/.test(entry)
        ? [full]
        : [];
  });
}

const IMPORT_FILES = sourceFiles(join(SRC, 'lib', 'imports'));
const rel = (f: string) => relative(process.cwd(), f).replace(/\\/g, '/');

describe('the importer uses the P1 normalizer and no other', () => {
  it('classification imports the shared normalizer', () => {
    const classify = readFileSync(join(SRC, 'lib', 'imports', 'classify.ts'), 'utf8');
    expect(classify).toMatch(/from '@\/lib\/email\/normalize'/);
    expect(classify).toMatch(/normalizeEmail\(/);
  });

  it('no import module defines a second normalization function', () => {
    const offenders: string[] = [];
    for (const file of IMPORT_FILES) {
      const content = readFileSync(file, 'utf8');
      // A function *definition*, not a call and not a local variable holding a
      // result. `normalizeHeader` in mapping.ts is about column headers, not
      // addresses, and is explicitly permitted.
      const declarations =
        content.match(/function\s+normalize[A-Za-z]*\s*\(|const\s+normalize[A-Za-z]*\s*=\s*(?:\(|function)/g) ??
        [];
      for (const declaration of declarations) {
        if (declaration.includes('normalizeHeader')) continue;
        offenders.push(`${rel(file)}: ${declaration}`);
      }
    }
    expect(
      offenders,
      'the import engine must call lib/email/normalize, never reimplement it',
    ).toEqual([]);
  });

  it('no import module lowercases an address itself', () => {
    const offenders: string[] = [];
    for (const file of IMPORT_FILES) {
      const content = readFileSync(file, 'utf8');
      // Case folding on an address is normalization by another name; doing it
      // here would produce a second, quietly different, canonical form.
      if (/email[A-Za-z]*\s*\.\s*toLowerCase\s*\(/.test(content)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no import module queries the suppressions table directly', () => {
    // §11: the eligibility authority is the only thing that decides whether an
    // address is suppressed. A second query here would be a second rule.
    const offenders = IMPORT_FILES.filter((file) =>
      /from\s*\(\s*['"]suppressions['"]|from\s+suppressions\b/.test(readFileSync(file, 'utf8')),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the runner reaches suppression through the eligibility authority', () => {
    const runner = readFileSync(join(SRC, 'lib', 'imports', 'runner.ts'), 'utf8');
    expect(runner).toMatch(/from '@\/lib\/eligibility'/);
    expect(runner).toMatch(/checkEligibilityBatch\(/);
  });
});

/**
 * Extracts the argument text of every `writeAuditLog(...)` call.
 *
 * Brace-counted rather than regex-matched, because a metadata object spanning
 * several lines with nested braces is exactly the shape a regex gets wrong —
 * and getting it wrong here would silently stop checking anything.
 */
function auditCallArguments(source: string): string[] {
  const calls: string[] = [];
  const marker = 'writeAuditLog(';
  let index = source.indexOf(marker);

  while (index !== -1) {
    let depth = 0;
    let cursor = index + marker.length - 1;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(index + marker.length, cursor));
    index = source.indexOf(marker, cursor);
  }
  return calls;
}

describe('import audit actions', () => {
  it('declares the four import events', async () => {
    const { AUDIT_ACTIONS } = await import('@/lib/audit');
    for (const action of [
      'import.started',
      'import.mapped',
      'import.completed',
      'import.failed',
    ]) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });

  it('writes all four events from the service layer', () => {
    const service = readFileSync(join(SRC, 'lib', 'imports', 'service.ts'), 'utf8');
    for (const action of [
      'import.started',
      'import.mapped',
      'import.completed',
      'import.failed',
    ]) {
      expect(service).toContain(`'${action}'`);
    }
    expect(service.match(/writeAuditLog\(/g) ?? []).toHaveLength(4);
  });

  it('never carries raw spreadsheet content into an audit record', () => {
    // §20: audit metadata is shape and counts. Reading `raw_row` elsewhere in
    // the module is legitimate — the results page shows rejections — so the
    // check is scoped to the argument of each audit call.
    const service = readFileSync(join(SRC, 'lib', 'imports', 'service.ts'), 'utf8');
    const calls = auditCallArguments(service);
    expect(calls).toHaveLength(4);

    for (const call of calls) {
      for (const forbidden of ['raw_row', 'rawRow', 'emailNormalized', 'sample', 'headers']) {
        expect(call, `audit metadata must not include ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('server-only boundaries', () => {
  it('the modules that hold privileged access are server-only', () => {
    for (const target of ['service.ts', 'repository.ts', 'lifecycle.ts']) {
      const content = readFileSync(join(SRC, 'lib', 'imports', target), 'utf8');
      expect(content, `imports/${target} must import 'server-only'`).toMatch(
        /^import ['"]server-only['"];/m,
      );
    }
    const limiter = readFileSync(join(SRC, 'lib', 'rate-limit', 'index.ts'), 'utf8');
    expect(limiter).toMatch(/^import ['"]server-only['"];/m);
  });

  it('the pure parsing modules are not server-only, so they stay testable and shareable', () => {
    for (const target of ['csv.ts', 'detect.ts', 'mapping.ts', 'classify.ts', 'constants.ts']) {
      const content = readFileSync(join(SRC, 'lib', 'imports', target), 'utf8');
      expect(content).not.toMatch(/^import ['"]server-only['"];/m);
    }
  });

  it('no import module reads an environment variable directly', () => {
    const offenders = IMPORT_FILES.filter((file) =>
      /process\.env/.test(readFileSync(file, 'utf8')),
    ).map(rel);
    expect(offenders).toEqual([]);
  });
});
