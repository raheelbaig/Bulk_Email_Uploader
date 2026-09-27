import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLiveGate } from '@/lib/sending/gate';
import { applyRefusal, describeTarget, parseArgs } from '../scripts/migrate-lib.mjs';

/**
 * A development checkout must never be able to deliver real email, and the one
 * real database must never be migrated by accident:
 *
 *   - APP_ENVIRONMENT defaults to development and accepts only
 *     development | production;
 *   - live sending requires APP_ENVIRONMENT=production;
 *   - the migration runner needs three explicit flags for any remote target.
 */

const PRODUCTION = 'productionrefbbbbbbb';

describe('APP_ENVIRONMENT', () => {
  const saved = { ...process.env };
  afterEach(async () => {
    process.env = { ...saved };
    (await import('@/lib/env')).resetServerEnvCache();
  });

  async function load(extra: Record<string, string>) {
    process.env = {
      NODE_ENV: 'test',
      NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION}.supabase.co`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-anon-key-anon-key',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-service-role',
      ...extra,
    } as NodeJS.ProcessEnv;
    const mod = await import('@/lib/env');
    mod.resetServerEnvCache();
    return mod.serverEnv;
  }

  it('defaults to development, which is never production', async () => {
    expect((await load({}))().APP_ENVIRONMENT).toBe('development');
  });

  it('runs development against the real Supabase project', async () => {
    expect((await load({ APP_ENVIRONMENT: 'development' }))().APP_ENVIRONMENT).toBe('development');
  });

  it('rejects any other value, naming the variable but no secret', async () => {
    const serverEnv = await load({ APP_ENVIRONMENT: 'staging' });
    expect(() => serverEnv()).toThrow(/APP_ENVIRONMENT/);
    expect(() => serverEnv()).toThrow(expect.objectContaining({ message: expect.not.stringContaining('service-role') }));
  });
});

describe('live gate requires APP_ENVIRONMENT=production', () => {
  const open = {
    mode: 'live' as const,
    appEnvironment: 'production' as const,
    hasProviderCredentials: true,
    hasConfigurationSet: true,
    hasUnsubscribeSecret: true,
    hasWorkerSecret: true,
    appUrl: 'https://mail.example.com',
  };

  it('stays closed in development even with everything else configured', () => {
    expect(evaluateLiveGate({ ...open, appEnvironment: 'development' })).toEqual({
      allowed: false,
      unmet: ['production_environment'],
    });
  });
});

describe('migration runner: production is never an accident', () => {
  const pooler = (ref: string) => `postgresql://postgres.${ref}:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`;
  const production = describeTarget(pooler(PRODUCTION));
  const local = describeTarget('postgres://u:p@localhost:54322/postgres');
  const args = (...argv: string[]) => parseArgs(argv);

  it('parses --confirm-production', () => {
    expect(parseArgs(['--confirm-production'])).toMatchObject({ confirmProduction: true, unknown: [] });
    expect(parseArgs([])).toMatchObject({ confirmProduction: false });
  });

  it('local needs no flags', () => {
    expect(applyRefusal(local, args())).toBeNull();
  });

  it('refuses a remote target without --yes-production or with the wrong --project-ref', () => {
    expect(applyRefusal(production, args(`--project-ref=${PRODUCTION}`, '--confirm-production'))).toMatch(/--yes-production/);
    expect(applyRefusal(production, args('--yes-production', '--confirm-production'))).toMatch(`--project-ref=${PRODUCTION}`);
    expect(applyRefusal(production, args('--yes-production', '--project-ref=someotherrefccccc', '--confirm-production'))).toMatch(
      `--project-ref=${PRODUCTION}`,
    );
  });

  it('refuses a remote target unless --confirm-production is also given', () => {
    expect(applyRefusal(production, args('--yes-production', `--project-ref=${PRODUCTION}`))).toMatch(
      /production.*--confirm-production/s,
    );
    expect(applyRefusal(production, args('--yes-production', `--project-ref=${PRODUCTION}`, '--confirm-production'))).toBeNull();
  });
});
