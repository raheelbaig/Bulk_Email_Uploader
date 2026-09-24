import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SENDING GATES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Supersedes tests/no-sending.test.ts (P0–P4), which proved that no send path
 * existed. P5 adds one, and this suite is the replacement guarantee: there is
 * exactly ONE send path, it is reachable from exactly one place, and it is
 * closed unless a deployment deliberately opens it.
 *
 * The layers, each checked here or in the suite named:
 *
 *   1. Still no mail SDK, SMTP library or transport. SendEmail is one
 *      hand-signed request in one file (`lib/sending/provider/ses-send-client.ts`).
 *   2. Exactly two outbound network call sites: P3's configuration client (four
 *      reviewed operations, still none of them a send) and the send client.
 *   3. The send client is reachable only through the provider factory, and the
 *      factory only from the worker endpoint.
 *   4. EMAIL_SENDING_MODE defaults to `disabled`; `live` additionally requires
 *      every item in the live gate (tests/sending-unit.test.ts proves the gate).
 *   5. The documented IAM policy still DENIES ses:SendEmail. The live policy is
 *      a separate file an operator must choose to attach.
 *   6. Every campaign still passes sender readiness at launch and on every
 *      tick (tests/sending-worker.test.ts).
 *   7. Unsubscribe is enforced: a campaign requiring it cannot launch, and a
 *      message cannot be composed, without a signed link.
 *
 * Retained from the P0–P4 suite because they are still true and still matter:
 * the import engine cannot deliver anything, the import queue cannot become an
 * email queue, and credentials are read in a closed set of server-only modules.
 */

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

const SRC = join(process.cwd(), 'src');
const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const FILES = sourceFiles(SRC);
const rel = (f: string) => relative(process.cwd(), f).split('\\').join('/');
const read = (f: string) => readFileSync(f, 'utf8');

/** A file with comments removed, so checks look at code rather than the prose explaining it. */
function codeOf(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');
}

function allMigrations(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => read(join(MIGRATIONS, f)))
    .join('\n');
}

const SEND_CLIENT = 'src/lib/sending/provider/ses-send-client.ts';
const CONFIG_CLIENT = 'src/lib/sender/provider/ses/client.ts';
const PROVIDER_FACTORY = 'src/lib/sending/provider/index.ts';
const WORKER_ROUTE = 'src/app/api/internal/worker/tick/route.ts';
const UNSUBSCRIBE_ROUTE = 'src/app/u/[token]/route.ts';

describe('there is one send path, and nothing else can deliver', () => {
  it('no email SDK, SMTP library or external queue is installed', () => {
    const pkg = JSON.parse(read(join(process.cwd(), 'package.json'))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const forbidden = all.filter((name) =>
      /^(@aws-sdk|aws-sdk|nodemailer|@sendgrid|postmark|resend|mailgun|bullmq|bull|ioredis)/.test(name),
    );
    expect(forbidden, `sending or queue dependency present: ${forbidden.join(', ')}`).toEqual([]);
  });

  it('no source file references a mail transport', () => {
    const patterns = [
      /\bSendEmailCommand\b/,
      /\bSESv2Client\b/,
      /\bcreateTransport\b/,
      /\bnodemailer\b/,
      /@aws-sdk\/client-ses/,
      /\bsmtp:\/\//i,
      /\bnet\.connect\b|\btls\.connect\b/,
    ];
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const re of patterns) if (re.test(codeOf(file))) offenders.push(`${rel(file)}: ${String(re)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('exactly two modules make an outbound network call', () => {
    const allowed = new Set([CONFIG_CLIENT, SEND_CLIENT]);
    const offenders = FILES.filter(
      (f) => !allowed.has(rel(f)) && /\bfetch\s*\(|\bhttps?\.request\b|\bXMLHttpRequest\b/.test(read(f)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the SES send path appears in exactly one file', () => {
    const holders = FILES.filter((f) => /outbound-(bulk-)?emails/.test(codeOf(f))).map(rel);
    expect(holders).toEqual([SEND_CLIENT]);
    const client = codeOf(join(process.cwd(), SEND_CLIENT));
    // One operation, one fixed path, never bulk.
    expect(client).toMatch(/SES_SEND_PATH = '\/v2\/email\/outbound-emails'/);
    expect(client).not.toContain('outbound-bulk-emails');
  });

  it('both network clients can only reach the regional SES endpoint, and refuse redirects', () => {
    for (const file of [CONFIG_CLIENT, SEND_CLIENT]) {
      const code = read(join(process.cwd(), file));
      expect(code, file).toMatch(/const host = `email\.\$\{config\.region\}\.amazonaws\.com`/);
      expect(code, file).toMatch(/redirect: 'error'/);
      expect(code, file).toMatch(/REGION_PATTERN\.test\(config\.region\)/);
      expect(code, file).not.toMatch(/doFetch\(\s*(?:url|endpoint|target)\b/);
    }
  });

  it("P3's configuration client still cannot send", () => {
    const code = codeOf(join(process.cwd(), CONFIG_CLIENT));
    expect(code).not.toContain('outbound-emails');
    expect(code).not.toMatch(/SendEmail|SendBulkEmail|SendRawEmail/);
    const paths = [...code.matchAll(/'(\/v2\/email[^']*)'|`(\/v2\/email[^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '');
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).not.toMatch(/outbound|send/i);
  });

  it("P3's configuration port still declares no send method", () => {
    const code = codeOf(join(SRC, 'lib/sender/provider/types.ts'));
    for (const forbidden of ['to:', 'toaddress', 'recipient', 'subject', 'html', 'body', 'template']) {
      expect(code.toLowerCase(), `the configuration port must not mention ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).not.toMatch(/\bsend(?!ingLimits|ing\b)[A-Z]/);
  });

  it('the send client is imported only by the provider factory', () => {
    const importers = FILES.filter((f) => /from '\.\/ses-send-client'|ses-send-client'/.test(read(f)))
      .map(rel)
      .filter((f) => f !== SEND_CLIENT);
    // ses.ts takes the client's *type* only; the factory is the one that builds one.
    expect(importers.sort()).toEqual([PROVIDER_FACTORY, 'src/lib/sending/provider/ses.ts'].sort());
    const adapter = read(join(SRC, 'lib/sending/provider/ses.ts'));
    expect(adapter).toMatch(/import type \{ SesSendClient \} from '\.\/ses-send-client'/);
    expect(adapter).not.toMatch(/createSesSendClient/);
  });

  it('the provider factory is used only by the worker endpoint', () => {
    const callers = FILES.filter((f) => /\boutboundProviderFor\b/.test(codeOf(f)))
      .map(rel)
      .filter((f) => f !== PROVIDER_FACTORY);
    expect(callers).toEqual([WORKER_ROUTE]);
    // And the SES adapter itself is constructed nowhere else.
    const builders = FILES.filter((f) => /(?<!function )createSesOutboundProvider\(/.test(codeOf(f))).map(rel);
    expect(builders).toEqual([PROVIDER_FACTORY]);
  });

  it('the dry-run provider performs no I/O', () => {
    const dryRun = codeOf(join(SRC, 'lib/sending/provider/dry-run.ts'));
    expect(dryRun).not.toMatch(/\bfetch\b|node:(?:http|https|net|tls|fs)|\blogger\b|console\./);
    expect(dryRun).toMatch(/mode: 'dry_run'/);
  });

  it('a dry-run campaign can never be handed the SES provider', () => {
    const factory = codeOf(join(process.cwd(), PROVIDER_FACTORY));
    expect(factory).toMatch(/if \(executionMode === 'dry_run'\) return createDryRunProvider\(\);/);
    expect(factory).toMatch(/if \(!gate\.allowed\) return null;/);
  });

  it('the outbound port has one method, and it takes one recipient', () => {
    const types = codeOf(join(SRC, 'lib/sending/provider/types.ts'));
    expect(types).toMatch(/OUTBOUND_PROVIDER_METHODS = \['send'\] as const/);
    expect(types).toMatch(/\n\s*to: string;/);
    expect(types).not.toMatch(/\bto: string\[\]|\bcc\b|\bbcc\b/i);
  });
});

describe('the send path is closed by default', () => {
  const saved = { ...process.env };
  afterEach(async () => {
    process.env = { ...saved };
    const { resetServerEnvCache } = await import('@/lib/env');
    resetServerEnvCache();
  });

  const baseEnv = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-anon-key-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://mail.example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-service-role',
  };
  const fullLive = {
    AWS_REGION: 'eu-west-1',
    AWS_ACCESS_KEY_ID: 'AKIDEXAMPLEEXAMPLE00',
    AWS_SECRET_ACCESS_KEY: 'secret-secret-secret-secret-secret',
    AWS_SES_CONFIGURATION_SET: 'app-primary',
    UNSUBSCRIBE_SECRET_V1: 'u'.repeat(40),
    WORKER_HMAC_SECRET: 'w'.repeat(40),
  };

  async function withEnv(extra: Record<string, string>) {
    process.env = { NODE_ENV: 'test', ...baseEnv, ...extra } as NodeJS.ProcessEnv;
    const { resetServerEnvCache } = await import('@/lib/env');
    resetServerEnvCache();
    const { outboundProviderFor } = await import('@/lib/sending/provider');
    const { sendingConfig } = await import('@/lib/sending/config');
    return { outboundProviderFor, sendingConfig };
  }

  it('EMAIL_SENDING_MODE defaults to disabled', async () => {
    const { sendingConfig } = await withEnv({});
    expect(sendingConfig().mode).toBe('disabled');
  });

  it('with every credential present but the mode unset, no live provider is issued', async () => {
    const { outboundProviderFor, sendingConfig } = await withEnv(fullLive);
    expect(sendingConfig().mode).toBe('disabled');
    expect(sendingConfig().live.allowed).toBe(false);
    expect(outboundProviderFor('live')).toBeNull();
  });

  it.each(Object.keys(fullLive))('live mode without %s issues no live provider', async (missing) => {
    const env: Record<string, string> = { ...fullLive, EMAIL_SENDING_MODE: 'live' };
    delete env[missing];
    // Session tokens are optional; AWS_REGION etc. are not.
    const { outboundProviderFor, sendingConfig } = await withEnv(env);
    expect(sendingConfig().live.allowed).toBe(false);
    expect(outboundProviderFor('live')).toBeNull();
  });

  it('live mode with a plain-http app URL issues no live provider', async () => {
    const { outboundProviderFor } = await withEnv({
      ...fullLive,
      EMAIL_SENDING_MODE: 'live',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    });
    expect(outboundProviderFor('live')).toBeNull();
  });

  it('only a fully configured live deployment gets the SES provider', async () => {
    const { outboundProviderFor, sendingConfig } = await withEnv({ ...fullLive, EMAIL_SENDING_MODE: 'live' });
    expect(sendingConfig().live).toEqual({ allowed: true, unmet: [] });
    expect(outboundProviderFor('live')?.mode).toBe('live');
  });

  it('dry run needs no credentials at all, and never becomes live', async () => {
    const { outboundProviderFor } = await withEnv({ EMAIL_SENDING_MODE: 'dry_run' });
    expect(outboundProviderFor('dry_run')?.mode).toBe('dry_run');
    expect(outboundProviderFor('live')).toBeNull();
  });

  it('the sending config carries no secret value', async () => {
    const { sendingConfig } = await withEnv({ ...fullLive, EMAIL_SENDING_MODE: 'live' });
    const serialized = JSON.stringify(sendingConfig());
    for (const value of Object.values(fullLive)) {
      if (value === 'eu-west-1' || value === 'app-primary') continue;
      expect(serialized).not.toContain(value);
    }
  });
});

describe('the documented IAM policies', () => {
  const load = (file: string) =>
    JSON.parse(read(join(process.cwd(), 'docs', file))) as {
      Statement: Array<{ Sid?: string; Effect: string; Action: string[]; Resource: string | string[]; Condition?: unknown }>;
    };

  it('the default policy still grants no send permission and denies it explicitly', () => {
    const policy = load('ses-iam-policy.json');
    const allowed = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => s.Action);
    for (const action of allowed) {
      expect(action).not.toMatch(/ses:Send/);
      expect(action).not.toMatch(/ses:Delete/);
    }
    const denied = policy.Statement.filter((s) => s.Effect === 'Deny').flatMap((s) => s.Action);
    expect(denied).toContain('ses:SendEmail');
    expect(denied).toContain('ses:SendRawEmail');
    expect(denied).toContain('ses:DeleteEmailIdentity');
  });

  it('the live policy grants SendEmail only, scoped, and still denies the rest', () => {
    const policy = load('ses-iam-policy-live.json');
    const send = policy.Statement.filter((s) => s.Effect === 'Allow' && s.Action.includes('ses:SendEmail'));
    expect(send).toHaveLength(1);
    const statement = send[0]!;
    expect(statement.Action).toEqual(['ses:SendEmail']);
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    expect(resources.every((r) => r.startsWith('arn:aws:ses:'))).toBe(true);
    expect(resources.some((r) => r === '*')).toBe(false);
    expect(resources.some((r) => r.includes(':configuration-set/'))).toBe(true);

    const allowed = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => s.Action);
    for (const action of allowed) {
      expect(action).not.toMatch(/ses:SendRawEmail|ses:SendBulk|ses:SendTemplated|ses:Delete/);
    }
    const denied = policy.Statement.filter((s) => s.Effect === 'Deny').flatMap((s) => s.Action);
    expect(denied).toEqual(expect.arrayContaining(['ses:SendRawEmail', 'ses:SendBulkEmail', 'ses:DeleteEmailIdentity']));
  });
});

describe('entry points', () => {
  it('the API surface is an allowlist', () => {
    const routes = FILES.filter((f) => /route\.tsx?$/.test(f)).map(rel).sort();
    expect(routes).toEqual(
      [
        'src/app/api/health/route.ts',
        'src/app/api/imports/[id]/rejections/route.ts',
        // P5: the scheduler's entry point and the public unsubscribe link.
        WORKER_ROUTE,
        UNSUBSCRIBE_ROUTE,
      ].sort(),
    );
  });

  it('the worker endpoint is POST-only and authenticates before doing anything', () => {
    const code = codeOf(join(process.cwd(), WORKER_ROUTE));
    expect(code).toMatch(/export async function POST\(/);
    expect(code).not.toMatch(/export async function (GET|PUT|PATCH|DELETE)\(/);
    const verifyAt = code.indexOf('verifyWorkerRequest(');
    const tickAt = code.indexOf('runSendTick(');
    expect(verifyAt).toBeGreaterThan(0);
    expect(tickAt).toBeGreaterThan(verifyAt);
    expect(code).toMatch(/if \(!auth\.ok\) \{[\s\S]*?status: 401/);
    // Nothing from the request body chooses what the tick does.
    expect(code).not.toMatch(/JSON\.parse\(body\)|request\.json\(\)/);
  });

  it('the unsubscribe GET changes nothing — only POST suppresses', () => {
    const code = codeOf(join(process.cwd(), UNSUBSCRIBE_ROUTE));
    const getBody = code.slice(code.indexOf('export async function GET('), code.indexOf('export async function POST('));
    expect(getBody.length).toBeGreaterThan(50);
    expect(getBody).not.toMatch(/rpc\(|writeAuditLog|insert\(/);
    const postBody = code.slice(code.indexOf('export async function POST('));
    expect(postBody).toMatch(/sending_record_unsubscribe/);
  });

  it('the campaign actions offer no send-now, launch or test-send', () => {
    const actions = codeOf(join(SRC, 'app', '(app)', 'campaigns', 'actions.ts'));
    const exported = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1] ?? '');
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      expect(name, `${name} looks like a dispatch action`).not.toMatch(/launch|dispatch|deliver|blast|sendnow|testsend/i);
    }
    // The two P5 controls a person has over a campaign in flight.
    expect(exported).toEqual(expect.arrayContaining(['pauseSendingAction', 'resumeSendingAction']));
  });

  it('campaign and template modules cannot reach the provider or the worker', () => {
    const files = FILES.filter(
      (f) => rel(f).startsWith('src/lib/campaigns/') || rel(f).startsWith('src/lib/templates/'),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(codeOf(file), rel(file)).not.toMatch(
        /from '@\/lib\/(sender\/provider|sending\/(provider|worker|store))/,
      );
    }
  });

  it('only the store calls the state-changing worker functions', () => {
    const workerFunctions =
      /sending_(reap_claimed|reconcile_attempts|hold_missed_campaigns|promote_campaign|materialize_campaign|reserve_budget|claim_jobs|release_job|begin_attempt|record_accepted|record_rejected|pause_workspace|finish_campaign)/;
    const callers = FILES.filter((f) => workerFunctions.test(codeOf(f))).map(rel);
    expect(callers).toEqual(['src/lib/sending/store.ts']);
  });

  it('no client component can reach the sending engine or a credential', () => {
    const clientFiles = FILES.filter((f) =>
      /^\s*(['"])use client\1/m.test(read(f).split('\n').slice(0, 5).join('\n')),
    );
    expect(clientFiles.length).toBeGreaterThan(0);
    for (const file of clientFiles) {
      const content = read(file);
      expect(content, rel(file)).not.toMatch(
        /from '@\/lib\/(sender\/(provider|service|verification|repository|identities)|sending\/(config|provider|store|service|worker)|unsubscribe\/server)/,
      );
      expect(content).not.toMatch(/AWS_|amazonaws\.com/);
    }
  });
});

describe('secrets and credentials', () => {
  /** A *read* of a variable — `env.NAME` or `process.env.NAME` — not a mention in a message. */
  const readersOf = (name: string) =>
    FILES.filter((f) => new RegExp(`\\.${name}\\b`).test(codeOf(f))).map(rel).sort();

  it('AWS credentials are read in a closed set of server-only modules', () => {
    const allowed = [
      'src/lib/env.ts',
      'src/lib/sender/provider/index.ts',
      'src/lib/sending/config.ts',
      PROVIDER_FACTORY,
    ].sort();
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      for (const reader of readersOf(name)) expect(allowed, `${reader} reads ${name}`).toContain(reader);
    }
    expect(readersOf('AWS_SECRET_ACCESS_KEY').length).toBeGreaterThan(0);
  });

  it('the worker and unsubscribe secrets are read only where they are used', () => {
    expect(readersOf('WORKER_HMAC_SECRET')).toEqual(
      ['src/lib/sending/config.ts', PROVIDER_FACTORY, WORKER_ROUTE].sort(),
    );
    expect(readersOf('UNSUBSCRIBE_SECRET_V1')).toEqual(
      ['src/lib/sending/config.ts', PROVIDER_FACTORY, 'src/lib/unsubscribe/server.ts'].sort(),
    );
  });

  it('every module that reads a secret is server-only and does not log', () => {
    for (const file of [
      'src/lib/env.ts',
      'src/lib/sender/provider/index.ts',
      'src/lib/sending/config.ts',
      PROVIDER_FACTORY,
      'src/lib/unsubscribe/server.ts',
      SEND_CLIENT,
    ]) {
      const code = codeOf(join(process.cwd(), file));
      expect(code, `${file} must be server-only`).toMatch(/^import ['"]server-only['"];/m);
      expect(code, `${file} must not log`).not.toMatch(/console\.|logger\./);
    }
  });
});

describe('the queue and the scheduler', () => {
  it('the queue is a table, not an extension — only pg_trgm is enabled', () => {
    const extensions = [...allMigrations().matchAll(/create extension[^;]*?(\w+);/gi)].map((m) => m[1]);
    expect(extensions).toEqual(['pg_trgm']);
    expect(allMigrations()).not.toMatch(/\bpgmq\s*\./i);
  });

  it('no migration schedules anything — the scheduler is an operator-applied script', () => {
    // Applying `supabase/ops/p5_schedule.sql` is the deliberate act that starts
    // the clock. A migration that scheduled ticks would start it on deploy.
    expect(allMigrations()).not.toMatch(/cron\.schedule|net\.http_post/i);
    expect(existsSync(join(process.cwd(), 'supabase', 'ops', 'p5_schedule.sql'))).toBe(true);
    const ops = read(join(process.cwd(), 'supabase', 'ops', 'p5_schedule.sql'));
    expect(ops).toMatch(/cron\.schedule/);
    expect(ops).toMatch(/revoke all on function app\.dispatch_tick/i);
  });

  it('the import queue still cannot become an email queue', () => {
    const sql = allMigrations();
    const importJobs = sql.slice(sql.indexOf('create table import_jobs'));
    const body = importJobs.slice(0, importJobs.indexOf(');'));
    for (const forbidden of ['recipient', 'to_address', 'subject', 'message_id', 'campaign']) {
      expect(body.toLowerCase(), `import_jobs must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the import engine still calls nothing that could deliver a message', () => {
    const importFiles = FILES.filter((f) => rel(f).startsWith('src/lib/imports/'));
    expect(importFiles.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of importFiles) {
      const content = read(file);
      for (const re of [/\bsend[A-Za-z]*\s*\(/, /\bdispatch[A-Za-z]*\s*\(/, /\btransport\b/i, /\bSESv2?\b/, /\bsmtp\b/i, /lib\/sending/]) {
        if (re.test(content)) offenders.push(`${rel(file)}: ${String(re)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('delivery counters are written only by SQL, never assigned in application code', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const content = codeOf(file);
      for (const counter of ['n_sent', 'n_delivered', 'n_bounced', 'n_complained', 'n_total', 'n_failed']) {
        if (new RegExp(`\\b${counter}\\s*:\\s*(?!number\\b)[^,}\\s]`).test(content)) {
          offenders.push(`${rel(file)}: ${counter}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('unsubscribe is a precondition of sending', () => {
  it('the preflight enforces it', () => {
    const preflight = read(join(SRC, 'lib/campaigns/preflight.ts'));
    expect(preflight).toMatch(/export const UNSUBSCRIBE_ENFORCED = true;/);
    expect(preflight).toMatch(/export const UNSUBSCRIBE_MECHANISM_AVAILABLE = false;/);
  });

  it('the composer refuses to build a message that requires a link and has none', () => {
    const compose = codeOf(join(SRC, 'lib/sending/compose.ts'));
    expect(compose).toMatch(/reason: 'unsubscribe_unavailable'/);
    expect(compose).toMatch(/List-Unsubscribe-Post/);
  });

  it('the eligibility authority still exists and the worker calls it', () => {
    expect(existsSync(join(SRC, 'lib', 'eligibility', 'index.ts'))).toBe(true);
    expect(codeOf(join(SRC, 'lib/sending/worker.ts'))).toMatch(/checkEligibilityBatch\(/);
  });
});
