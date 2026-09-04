#!/usr/bin/env node
/**
 * Client bundle secret scan.
 *
 * `server-only` makes leaking a secret a build error in the common case. This is
 * the backstop for the uncommon ones: a value inlined through an unexpected
 * path, a secret copied into a NEXT_PUBLIC_ variable, a hard-coded key.
 *
 * Scans everything a browser can fetch: .next/static.
 *
 * Exit 0 = clean, 1 = a secret was found, 2 = could not run.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const BUNDLE_DIR = join(process.cwd(), '.next', 'static');
const SCANNED_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.css', '.map', '.txt', '.html']);

/**
 * Server-only variables whose *values* must never appear in a client asset.
 * Checking the literal value catches leaks no pattern would, because it does not
 * depend on guessing the credential's shape.
 */
const SECRET_ENV_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  // P3. Present only under an assumed role, and the shortest-lived of the three,
  // which makes it the one most likely to be treated as harmless.
  'AWS_SESSION_TOKEN',
  'WORKER_HMAC_SECRET',
  'UNSUBSCRIBE_SECRET_V1',
  'DATABASE_URL',
];

/** Shape-based detection, for secrets not present in this process's env. */
const PATTERNS = [
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: 'service_role JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*(?:c2VydmljZV9yb2xl|InNlcnZpY2Vfcm9sZSI)/ },
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'server-only env name referenced in client code', re: /\bSUPABASE_SERVICE_ROLE_KEY\b/ },
  { name: 'postgres connection string', re: /\bpostgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@/ },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SCANNED_EXT.has(extname(entry))) out.push(full);
  }
  return out;
}

function main() {
  if (!existsSync(BUNDLE_DIR)) {
    console.error(`[scan] ${BUNDLE_DIR} not found. Run \`pnpm build\` first.`);
    process.exit(2);
  }

  // Only values long enough to be real secrets; a short placeholder in a dev
  // env would otherwise match half the bundle.
  const secretValues = SECRET_ENV_VARS.map((name) => [name, process.env[name]])
    .filter(([, value]) => typeof value === 'string' && value.length >= 16);

  const files = walk(BUNDLE_DIR);
  const findings = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');

    for (const [name, value] of secretValues) {
      if (content.includes(value)) {
        findings.push({ file, detail: `value of ${name} present in client asset` });
      }
    }
    for (const { name, re } of PATTERNS) {
      const match = re.exec(content);
      if (match !== null) {
        findings.push({ file, detail: `${name} (matched ${JSON.stringify(match[0].slice(0, 24))}…)` });
      }
    }
  }

  console.log(`[scan] scanned ${files.length} client assets under .next/static`);
  console.log(`[scan] checked ${secretValues.length} secret value(s) from the environment`);

  if (findings.length > 0) {
    console.error(`\n[scan] FAILED — ${findings.length} finding(s):\n`);
    for (const f of findings) console.error(`  ${f.file}\n    ${f.detail}`);
    console.error('\nA secret reachable from the browser is a full compromise. Do not ship this build.');
    process.exit(1);
  }

  console.log('[scan] clean — no secrets found in the client bundle');
}

main();
