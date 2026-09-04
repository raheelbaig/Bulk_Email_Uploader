import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The standing guarantee: this deployment cannot send email.
 *
 * P1 added contacts, lists and suppression — the audience and the safety list.
 * P2 added the import engine, which fills that audience from a spreadsheet.
 * P3 adds sender domains and identities — the *permission* to send, established
 * and verified, with still no way to act on it.
 *
 * P4 adds templates and campaigns — the *content*, the *audience* and the
 * *schedule*, complete and reviewed, with still no way to act on any of it. It
 * is the phase where the guarantee is easiest to lose by accident, because a
 * campaign that has everything except a send button looks one small commit away
 * from sending. So P4 adds a further constraint, in the database: the campaign
 * state machine has no transition toward delivery, for any role.
 *
 * P3 is the first phase that talks to Amazon SES at all, which makes this suite
 * more important rather than less. The guarantee is maintained by these
 * separate constraints, each checked below:
 *
 *   1. No SDK. `@aws-sdk/client-sesv2` ships `SendEmailCommand` alongside the
 *      identity APIs; the four requests P3 needs are signed by hand instead, so
 *      no send-capable code is present to be called.
 *   2. A closed operation allowlist. The SES client can issue exactly four
 *      requests, none of them SESv2's `POST /v2/email/outbound-emails`.
 *   3. A provider port with no send method, and no place to put a recipient.
 *   4. An IAM policy that grants no send permission and explicitly denies it,
 *      so even a leaked credential cannot send.
 */

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? sourceFiles(full)
      : /\.(ts|tsx)$/.test(entry)
        ? [full]
        : [];
  });
}

const SRC = join(process.cwd(), 'src');
const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const FILES = sourceFiles(SRC);
const rel = (f: string) => relative(process.cwd(), f).split('\\').join('/');

/**
 * A file with its comments removed.
 *
 * Several checks below scan for the *name* of something that must not exist.
 * P3's modules explain at length why a send path, an SDK and an HTTP request to
 * a user domain are all absent, and those explanations necessarily name them.
 * Stripping comments keeps the checks pointed at code, where they belong.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function allMigrations(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

describe('no email sending capability exists', () => {
  it('no email or provider dependency is installed', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const forbidden = all.filter((name) =>
      /^(@aws-sdk|aws-sdk|nodemailer|@sendgrid|postmark|resend|mailgun|bullmq|bull|ioredis)/.test(
        name,
      ),
    );
    expect(forbidden, `sending or queue dependency present: ${forbidden.join(', ')}`).toEqual([]);
  });

  it('no source file references a mail transport or the SES API', () => {
    const patterns = [
      /\bSendEmailCommand\b/,
      /\bSESv2Client\b/,
      /\bcreateTransport\b/,
      /\bnodemailer\b/,
      /@aws-sdk\/client-ses/,
      /\bsmtp:\/\//i,
    ];
    const offenders: string[] = [];
    for (const file of FILES) {
      const content = codeOf(file);
      for (const re of patterns) {
        if (re.test(content)) offenders.push(`${rel(file)}: ${String(re)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the SES configuration client makes an outbound network call', () => {
    // The Supabase client performs its own HTTP. What must not exist is our own
    // call to an arbitrary endpoint. P3 adds exactly one such call site, and it
    // is pinned here: a second one appearing anywhere fails the build.
    const allowed = new Set(['src/lib/sender/provider/ses/client.ts']);
    const offenders = FILES.filter(
      (f) =>
        !allowed.has(rel(f)) &&
        /\bfetch\s*\(|\bhttps?\.request\b|\bXMLHttpRequest\b/.test(readFileSync(f, 'utf8')),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it('that call site can only reach the provider endpoint', () => {
    const client = readFileSync(join(SRC, 'lib/sender/provider/ses/client.ts'), 'utf8');

    // The host is built from a validated region, not from anything a request
    // supplies, and a redirect cannot move a signed request to another host.
    expect(client).toMatch(/const host = `email\.\$\{config\.region\}\.amazonaws\.com`/);
    expect(client).toMatch(/redirect: 'error'/);
    expect(client).toMatch(/REGION_PATTERN\.test\(config\.region\)/);

    // No template that could build a URL from caller input.
    expect(client).not.toMatch(/doFetch\(\s*(?:url|endpoint|target)\b/);
  });

  it('nothing in the codebase requests a user-supplied domain over HTTP', () => {
    // Domain ownership is proven by DNS and by the provider. A request to
    // `https://<user domain>/...` would be an outbound call to an address the
    // user chooses, which is the SSRF this design exists to avoid.
    const senderFiles = FILES.filter((f) => rel(f).startsWith('src/lib/sender/'));
    expect(senderFiles.length).toBeGreaterThan(8);

    for (const file of senderFiles) {
      if (rel(file) === 'src/lib/sender/provider/ses/client.ts') continue;
      expect(codeOf(file), `${rel(file)} must not construct a URL`).not.toMatch(
        /new URL\(|https?:\/\/\$\{/,
      );
    }
  });

  it('the only API routes are the health probe and the rejected-row export', () => {
    // An allowlist, not a count: a webhook receiver or a worker endpoint
    // appearing here before its phase fails the build.
    const routes = FILES.filter((f) => /route\.tsx?$/.test(f))
      .map(rel)
      .sort();
    expect(routes).toEqual([
      'src/app/api/health/route.ts',
      'src/app/api/imports/[id]/rejections/route.ts',
    ]);
  });

  it('no route handler dispatches anything — the export only reads', () => {
    const exportRoute = readFileSync(
      join(SRC, 'app', 'api', 'imports', '[id]', 'rejections', 'route.ts'),
      'utf8',
    );
    // GET only. A POST here would be a mutation surface on a download endpoint.
    expect(exportRoute).toMatch(/export async function GET\(/);
    expect(exportRoute).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\(/);
  });

  it('no queue, scheduler or sending table exists', () => {
    // Match the created object names exactly rather than scanning for the word
    // anywhere: `campaign_id` is a legitimate nullable column on suppressions,
    // and a loose search would flag it.
    const created = [...allMigrations().matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w.]+)/gi)]
      .map((m) => (m[1] ?? '').split('.').pop());

    // `campaigns` and `templates` arrive in P4 and are asserted column by column
    // below: neither carries a recipient, and no campaign can reach a sending
    // state. Everything listed here is P5 or later and must not exist yet.
    const forbidden = [
      'email_jobs',
      'send_attempts',
      'email_events',
      'event_raw',
      // `rate_ledger` is the *send* budget (ARCHITECTURE §3.9) and belongs to
      // P5. `rate_limits`, the API limiter, is a different table and is
      // legitimately present from P2.
      'rate_ledger',
    ];

    const present = created.filter((name) => name !== undefined && forbidden.includes(name));
    expect(present, `a later-phase table was created: ${present.join(', ')}`).toEqual([]);

    expect(created.sort()).toEqual([
      'audit_logs',
      // P4 — campaign preparation. Carries no recipient and no message id, and
      // its status column cannot reach a sending value; both asserted below.
      'campaigns',
      'contact_lists',
      'contacts',
      // P2 — the import engine. `import_jobs` is the import-processing queue and
      // is deliberately the only queue in the system; it carries no message
      // type, no recipient and no send path.
      'import_jobs',
      'import_rejections',
      'imports',
      'list_members',
      'rate_limits',
      'rls_policy_exceptions',
      // P3 — sender configuration. Neither table carries a recipient, a
      // subject or a body; both are asserted column-by-column below.
      'sender_domains',
      'sender_identities',
      'suppressions',
      // P4 — message content. A subject and a body are not a recipient.
      'templates',
      'workspace_members',
      'workspace_settings',
      'workspaces',
    ]);
  });

  it('the import queue cannot become an email queue', () => {
    const sql = allMigrations();
    // pgmq is a P5 dependency and must not be *used* before it. Migration 0006
    // names it in a comment explaining why it is deliberately absent, so the
    // check is for the extension and its schema, not for the word.
    expect(sql).not.toMatch(/create\s+extension[^;]*pgmq/i);
    expect(sql).not.toMatch(/\bpgmq\s*\./i);
    expect(sql).not.toMatch(/create\s+extension[^;]*pg_cron/i);
    expect(sql).not.toMatch(/create\s+extension[^;]*pg_net/i);

    // The queue table holds an import id and nothing that could address a
    // recipient.
    const importJobs = sql.slice(sql.indexOf('create table import_jobs'));
    const body = importJobs.slice(0, importJobs.indexOf(');'));
    for (const forbidden of ['recipient', 'to_address', 'subject', 'message_id', 'campaign']) {
      expect(body.toLowerCase(), `import_jobs must not carry ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it('the import engine calls nothing that could deliver a message', () => {
    const importFiles = FILES.filter((f) => rel(f).startsWith('src/lib/imports/'));
    expect(importFiles.length).toBeGreaterThan(5);

    // Call-shaped matches only, so prose and identifiers like `suppressed` or
    // `dispatchEvent`-free code do not trip it.
    const patterns = [
      { name: 'send*()', re: /\bsend[A-Za-z]*\s*\(/ },
      { name: 'dispatch*()', re: /\bdispatch[A-Za-z]*\s*\(/ },
      { name: 'transport', re: /\btransport\b/i },
      { name: 'ses client', re: /\bSESv2?\b/ },
      { name: 'smtp', re: /\bsmtp\b/i },
    ];

    const offenders: string[] = [];
    for (const file of importFiles) {
      const content = readFileSync(file, 'utf8');
      for (const { name, re } of patterns) {
        if (re.test(content)) offenders.push(`${rel(file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only pg_trgm is enabled, and only for contact search', () => {
    const extensions = [...allMigrations().matchAll(/create extension[^;]*?(\w+);/gi)].map(
      (m) => m[1],
    );
    expect(extensions).toEqual(['pg_trgm']);
  });

  it('no later-phase secret is read anywhere in source', () => {
    // These belong to the send path, the webhook receiver and the unsubscribe
    // signer. Their appearance in any file would mean a phase boundary moved.
    const secrets = [
      'AWS_SES_CONFIGURATION_SET',
      'AWS_SNS_TOPIC_ARN',
      'WORKER_HMAC_SECRET',
      'UNSUBSCRIBE_SECRET_V1',
    ];
    const offenders: string[] = [];
    for (const file of FILES) {
      const content = codeOf(file);
      for (const secret of secrets) {
        if (content.includes(secret)) offenders.push(`${rel(file)}: ${secret}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the AWS credential is read in exactly two modules', () => {
    // P3 introduces AWS credentials. `lib/env.ts` is the single validated
    // source; `sender/provider/index.ts` is the single place that turns them
    // into a provider. Both are `server-only`. Every other module receives the
    // provider, never the credential — so a third file naming one of these is a
    // leak waiting to happen, whatever it currently does with it.
    const allowed = new Set(['src/lib/env.ts', 'src/lib/sender/provider/index.ts']);
    const credentials = [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_REGION',
      'AWS_ACCOUNT_ID',
    ];
    const offenders: string[] = [];
    for (const file of FILES) {
      if (allowed.has(rel(file))) continue;
      const content = codeOf(file);
      for (const name of credentials) {
        if (content.includes(name)) offenders.push(`${rel(file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('neither module lets a credential leave through a return value or a log', () => {
    for (const file of ['src/lib/env.ts', 'src/lib/sender/provider/index.ts']) {
      const code = codeOf(join(process.cwd(), file));
      expect(code, `${file} must be server-only`).toMatch(/^import ['"]server-only['"];/m);
      expect(code, `${file} must not log`).not.toMatch(/console\.|logger\./);
    }
  });

  it('no client component can reach the provider or the credential', () => {
    const clientFiles = FILES.filter((f) =>
      /^\s*(['"])use client\1/m.test(readFileSync(f, 'utf8').split('\n').slice(0, 5).join('\n')),
    );
    expect(clientFiles.length).toBeGreaterThan(0);

    for (const file of clientFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${rel(file)} imports sender server code`).not.toMatch(
        /from '@\/lib\/sender\/(provider|service|verification|repository|identities)/,
      );
      expect(content).not.toMatch(/AWS_|amazonaws\.com/);
    }
  });

  // ── P3: SES is reachable for configuration only ────────────────────────────

  describe('the SES integration cannot send', () => {
    it('signs its own requests rather than installing a send-capable SDK', () => {
      const sigv4 = readFileSync(join(SRC, 'lib/sender/provider/ses/sigv4.ts'), 'utf8');
      expect(sigv4).toMatch(/from 'node:crypto'/);
      // Re-asserted here as well as in the dependency check above, because this
      // is the reason that check must keep passing.
      const pkg = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
      expect(pkg).not.toContain('aws-sdk');
    });

    it('exposes a closed operation allowlist with no send operation', () => {
      const client = readFileSync(join(SRC, 'lib/sender/provider/ses/client.ts'), 'utf8');
      const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      // SESv2's send operations.
      expect(code).not.toContain('outbound-emails');
      expect(code).not.toContain('outbound-bulk-emails');
      expect(code).not.toMatch(/SendEmail|SendBulkEmail|SendRawEmail/);

      // Every path literal in the file, enumerated.
      const paths = [...code.matchAll(/'(\/v2\/email[^']*)'|`(\/v2\/email[^`]*)`/g)].map(
        (m) => m[1] ?? m[2] ?? '',
      );
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path).not.toMatch(/outbound|send/i);
      }
    });

    it('the provider port declares no method that could deliver a message', () => {
      const types = readFileSync(join(SRC, 'lib/sender/provider/types.ts'), 'utf8');
      const code = types.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      // No parameter anywhere in the port names a recipient or a message body.
      for (const forbidden of ['to:', 'toAddress', 'recipient', 'subject', 'html', 'body', 'template']) {
        expect(code.toLowerCase(), `the provider port must not mention ${forbidden}`).not.toContain(
          forbidden.toLowerCase(),
        );
      }
      expect(code).toMatch(/EMAIL_PROVIDER_METHODS = \[/);
      expect(code).not.toMatch(/\bsend(?!ingLimits|ing\b)[A-Z]/);
    });

    it('no sender module imports or names a mail transport', () => {
      const senderFiles = FILES.filter((f) => rel(f).startsWith('src/lib/sender/'));
      const offenders: string[] = [];
      for (const file of senderFiles) {
        const content = codeOf(file);
        // `smtp://` rather than `smtp`: the MAIL FROM MX value SES requires is
        // `feedback-smtp.<region>.amazonses.com`, which is a DNS record this
        // system tells the user to publish, not a transport it can speak.
        for (const re of [/nodemailer/i, /createTransport/, /\bsmtp:\/\//i, /@aws-sdk/]) {
          if (re.test(content)) offenders.push(`${rel(file)}: ${String(re)}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('the documented IAM policy grants no send permission and denies it explicitly', () => {
      const policy = JSON.parse(
        readFileSync(join(process.cwd(), 'docs/ses-iam-policy.json'), 'utf8'),
      ) as { Statement: Array<{ Effect: string; Action: string[] }> };

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

    it('the sender tables carry no column that could address a message', () => {
      const sql = allMigrations();
      const start = sql.indexOf('create table sender_domains');
      const senderSql = sql.slice(start, sql.indexOf('create policy sender_identities_delete'));

      for (const forbidden of ['recipient', 'to_email', 'subject', 'body_html', 'message_id']) {
        expect(senderSql.toLowerCase()).not.toContain(forbidden);
      }
    });
  });

  // ── P4: campaigns can be prepared, and cannot be dispatched ────────────────

  describe('the campaign engine cannot dispatch', () => {
    const p4Files = () =>
      FILES.filter(
        (f) => rel(f).startsWith('src/lib/campaigns/') || rel(f).startsWith('src/lib/templates/'),
      );

    it('no campaign or template module names a transport, a queue or a dispatch', () => {
      const files = p4Files();
      expect(files.length).toBeGreaterThan(10);

      const patterns = [
        // `sender*` is excluded by name, not by accident: the campaign service
        // legitimately calls `senderRepository()` and `getSenderReadiness()`,
        // which are configuration reads. Anything else beginning `send` is not.
        { name: 'send*()', re: /\bsend(?!er|ing)[A-Za-z]*\s*\(/ },
        { name: 'dispatch*()', re: /\bdispatch[A-Za-z]*\s*\(/ },
        { name: 'launch*()', re: /\blaunch[A-Za-z]*\s*\(/ },
        { name: 'enqueue*()', re: /\benqueue[A-Za-z]*\s*\(/ },
        { name: 'transport', re: /\btransport\b/i },
        { name: 'ses client', re: /\bSESv2?\b/ },
        { name: 'smtp', re: /\bsmtp\b/i },
        { name: 'nodemailer', re: /nodemailer/i },
        { name: 'pgmq', re: /\bpgmq\b/i },
      ];

      const offenders: string[] = [];
      for (const file of files) {
        const content = codeOf(file);
        for (const { name, re } of patterns) {
          if (re.test(content)) offenders.push(`${rel(file)}: ${name}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('no campaign or template module imports the email provider', () => {
      for (const file of p4Files()) {
        expect(codeOf(file), `${rel(file)} must not reach the provider`).not.toMatch(
          /from '@\/lib\/sender\/provider/,
        );
      }
    });

    it('the campaign server actions offer no send, launch or test-send', () => {
      const actions = codeOf(join(SRC, 'app', '(app)', 'campaigns', 'actions.ts'));
      const exported = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1] ?? '');

      expect(exported.length).toBeGreaterThan(0);
      for (const name of exported) {
        expect(name, `${name} looks like a dispatch action`).not.toMatch(
          /send|launch|dispatch|deliver|queue|blast/i,
        );
      }
    });

    it('the state machine has no transition toward delivery', () => {
      const status = codeOf(join(SRC, 'lib', 'campaigns', 'status.ts'));

      // Every target reachable from any state, as the mirror declares them.
      const reachable = new Set(
        [...status.matchAll(/^\s*\w+:\s*\[([^\]]*)\]/gm)].flatMap((m) =>
          (m[1] ?? '')
            .split(',')
            .map((value) => value.trim().replace(/^'|'$/g, ''))
            .filter((value) => value.length > 0),
        ),
      );

      for (const forbidden of ['queued', 'sending', 'paused', 'completed', 'failed']) {
        expect([...reachable], `${forbidden} must have no inbound transition`).not.toContain(
          forbidden,
        );
      }
    });

    it('the database refuses those transitions too, for every role', () => {
      const sql = allMigrations();
      const start = sql.indexOf('create or replace function app.campaign_transition_allowed');
      expect(start).toBeGreaterThan(0);

      const body = sql.slice(start, sql.indexOf('$fn$;', start));
      // The function names only the states P4 can honestly reach as targets.
      for (const forbidden of ['queued', 'sending', 'paused', 'completed', 'failed']) {
        expect(body, `campaign_transition_allowed must not permit ${forbidden}`).not.toContain(
          `'${forbidden}'`,
        );
      }

      // And a trigger applies it to every write, not only to policied roles.
      expect(sql).toMatch(/create trigger trg_campaigns_guard/);
      expect(sql).toMatch(/execute function app\.guard_campaign_write/);
    });

    it('no campaign module requests a transition to a sending status', () => {
      // Scoped to the campaign modules: the import engine has its own state
      // machine whose `completed` and `failed` are about parsing a spreadsheet,
      // and it is proven separately in tests/import-lifecycle.test.ts.
      const offenders: string[] = [];
      for (const file of [...p4Files(), ...FILES.filter((f) => /\(app\)/.test(rel(f)))]) {
        const content = codeOf(file);
        for (const status of ['queued', 'sending', 'paused', 'completed', 'failed']) {
          // A transition *request*. The status vocabulary itself is allowed to
          // name these — the enum in the database does.
          const re = new RegExp(`transition\\([^)]*['"\`]${status}['"\`]`);
          if (re.test(content)) offenders.push(`${rel(file)}: ${status}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('the campaign and template tables carry no column that could address a message', () => {
      const sql = allMigrations();
      const start = sql.indexOf('create table templates');
      // Comments stripped — both the `--` kind and `COMMENT ON`, which is also
      // prose. Migration 0009 explains at length that these tables carry no
      // recipient, and this check is about the columns, not the explanation.
      const p4Sql = sql
        .slice(start, sql.indexOf('-- The state machine'))
        .replace(/^\s*--.*$/gm, '')
        // Ends at the closing quote, not the first `;` — the comment text
        // itself contains semicolons.
        .replace(/comment on [\s\S]*?';/gi, '');
      expect(p4Sql.length).toBeGreaterThan(1000);

      for (const forbidden of [
        'recipient',
        'to_email',
        'to_address',
        'message_id',
        'provider_message_id',
        'smtp',
        'mime',
      ]) {
        expect(p4Sql.toLowerCase(), `P4 tables must not carry ${forbidden}`).not.toContain(forbidden);
      }
    });

    it('the delivery counters exist but nothing writes them', () => {
      // Declared so P5 adds a worker rather than a migration under live data.
      // Until then they stay at zero, so no code path may assign one.
      const offenders: string[] = [];
      for (const file of FILES) {
        const content = codeOf(file);
        for (const counter of ['n_sent', 'n_delivered', 'n_bounced', 'n_complained', 'n_total']) {
          // A *value* assigned to the counter. Declaring its type (`n_sent:
          // number`) is how the record shape is described and writes nothing.
          if (new RegExp(`\\b${counter}\\s*:\\s*(?!number\\b)[^,}\\s]`).test(content)) {
            offenders.push(`${rel(file)}: ${counter}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('no unsubscribe endpoint, token or header exists', () => {
      // P6 builds this. A link that looks like an unsubscribe and does nothing
      // is worse than not having one, so nothing here may resemble one.
      const offenders = FILES.filter((f) =>
        /\bunsubscribeUrl\b|\bunsubscribeToken\b|\bsignUnsubscribe\b|List-Unsubscribe/i.test(
          codeOf(f),
        ),
      ).map(rel);
      expect(offenders).toEqual([]);
    });

    it('the preflight states the absence rather than hiding it', () => {
      const preflight = readFileSync(join(SRC, 'lib/campaigns/preflight.ts'), 'utf8');
      expect(preflight).toMatch(/UNSUBSCRIBE_MECHANISM_AVAILABLE = false/);
      expect(preflight).toMatch(/sending_not_available/);
    });

    it('no scheduler, cron entry point or promotion sweep exists', () => {
      const sql = allMigrations();
      expect(sql).not.toMatch(/cron\.schedule/i);
      expect(sql).not.toMatch(/create\s+extension[^;]*pg_cron/i);

      // A campaign becoming due is not an event that anything observes.
      const offenders = FILES.filter((f) =>
        /promoteDueCampaigns|dueCampaigns|campaignSweep|processScheduled/.test(codeOf(f)),
      ).map(rel);
      expect(offenders).toEqual([]);
    });
  });

  it('the eligibility authority exists before any send path is built', () => {
    // P5 will have one authority to call rather than a decision to reinvent.
    expect(existsSync(join(SRC, 'lib', 'eligibility', 'index.ts'))).toBe(true);
  });
});
