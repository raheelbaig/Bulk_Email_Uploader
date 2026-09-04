import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const TESTING_DIR = join(process.cwd(), 'supabase', 'testing');

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * A migrated database.
 *
 * The real migration files are executed verbatim — the same bytes that will run
 * against Supabase. Only the Supabase-provided surface (roles, auth schema) is
 * emulated, from `supabase/testing/`.
 */
export async function createTestDb(): Promise<TestDb> {
  // pg_trgm backs contact search (migration 0005). PGlite ships contrib
  // extensions as opt-in bundles; Supabase provides it natively.
  const pg = await new PGlite({ extensions: { pg_trgm } });

  await pg.exec(readFileSync(join(TESTING_DIR, '0000_supabase_emulation.sql'), 'utf8'));
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await pg.exec(sql);
    } catch (cause) {
      throw new Error(`migration ${file} failed: ${(cause as Error).message}`);
    }
  }

  return new TestDb(pg);
}

export interface QueryResult<T> {
  rows: T[];
  affectedRows: number;
}

export class TestDb {
  constructor(private readonly pg: PGlite) {}

  /** Runs as the migration owner: superuser-equivalent, bypasses RLS. */
  async raw<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pg.query<T>(sql, params);
    return { rows: res.rows, affectedRows: res.affectedRows ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  /**
   * Runs `fn` with the session bound to `userId` under the `authenticated` role,
   * exactly as PostgREST does for a request carrying that user's JWT. This is
   * the only way the RLS tests observe the database.
   */
  async asUser<T>(userId: string, fn: (db: TestDb) => Promise<T>): Promise<T> {
    await this.pg.exec(
      `set request.jwt.claims = '${JSON.stringify({ sub: userId, role: 'authenticated' })}'; set role authenticated;`,
    );
    try {
      return await fn(this);
    } finally {
      await this.pg.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
    }
  }

  /** Runs `fn` as `anon` — an unauthenticated request. */
  async asAnon<T>(fn: (db: TestDb) => Promise<T>): Promise<T> {
    await this.pg.exec(`select set_config('request.jwt.claims', '', false); set role anon;`);
    try {
      return await fn(this);
    } finally {
      await this.pg.exec(`reset role;`);
    }
  }

  /** Runs `fn` as `service_role`, which has BYPASSRLS — the worker's context. */
  async asServiceRole<T>(fn: (db: TestDb) => Promise<T>): Promise<T> {
    await this.pg.exec(`set role service_role;`);
    try {
      return await fn(this);
    } finally {
      await this.pg.exec(`reset role;`);
    }
  }

  /** Creates an auth user, firing the signup bootstrap trigger. */
  async createUser(email: string): Promise<{ userId: string; workspaceId: string }> {
    const inserted = await this.raw<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [email],
    );
    const userId = inserted.rows[0]?.id;
    if (userId === undefined) throw new Error(`failed to create user ${email}`);

    const ws = await this.raw<{ workspace_id: string }>(
      `select workspace_id from workspace_members where user_id = $1`,
      [userId],
    );
    const workspaceId = ws.rows[0]?.workspace_id;
    if (workspaceId === undefined) throw new Error(`signup bootstrap did not create a workspace for ${email}`);

    return { userId, workspaceId };
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

/** Postgres error code for an RLS/GRANT denial, and the check-violation raised by the audit trigger. */
export const PG_INSUFFICIENT_PRIVILEGE = '42501';

export async function expectRejected(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the operation to be rejected, but it succeeded');
}
