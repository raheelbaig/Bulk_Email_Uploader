// Read-only verification around applying migration 0017 on the production project.
//
//   node scripts/ops/verify-0017.mjs pre  <snapshot.json>   immediately before the migration
//   node scripts/ops/verify-0017.mjs post <snapshot.json>   immediately after it
//
// Run from the repository root. DATABASE_URL is read from the environment, then
// from .env.local (as scripts/migrate.mjs does). Everything happens inside a
// READ ONLY transaction (the server rejects any write). Only the project ref and
// check results are printed — never the URL or credentials. 'pre' writes the
// snapshot (keep it outside the repository: it holds table names and counts);
// 'post' compares every table count against it. Exit 0 = all pass.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecks, snapshot } from './checks-0017.mjs';

const EXPECTED_REF = 'okthffhjecrylqvlsoxj';

const [phase, snapPath] = process.argv.slice(2);
if (!['pre', 'post'].includes(phase) || !snapPath) {
  console.error('usage: verify-0017.mjs pre|post <snapshot.json>');
  process.exit(2);
}
if (phase === 'pre' && existsSync(snapPath)) {
  console.error(`refusing: ${snapPath} already exists (a pre snapshot is never overwritten)`);
  process.exit(2);
}
if (phase === 'post' && !existsSync(snapPath)) {
  console.error(`refusing: ${snapPath} does not exist (run 'pre' first)`);
  process.exit(2);
}

const cwd = process.cwd();
const lib = await import(pathToFileURL(join(cwd, 'scripts', 'migrate-lib.mjs')).href);
lib.loadEnvLocal(join(cwd, '.env.local'));
const target = lib.describeTarget(process.env.DATABASE_URL ?? '');
if (target.projectRef !== EXPECTED_REF) {
  console.error(`refusing: DATABASE_URL is not project ${EXPECTED_REF} (got ${target.projectRef ?? target.host ?? 'unset'})`);
  process.exit(2);
}
const dir = join(cwd, 'supabase', 'migrations');
const repo = {
  files: readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => ({ filename, body: readFileSync(join(dir, filename), 'utf8') })),
};

const postgres = createRequire(join(cwd, 'package.json'))('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 20, onnotice: () => {} });
let results;
try {
  await sql.begin('read only', async (tx) => {
    const ro = (await tx`show transaction_read_only`)[0].transaction_read_only;
    if (ro !== 'on') throw new Error('transaction is not read-only');
    const q = (text, params = []) => tx.unsafe(text, params);
    const snap = phase === 'post' ? JSON.parse(readFileSync(snapPath, 'utf8')) : null;
    results = await runChecks(q, { phase, snap, repo, lib, env: process.env });
    if (phase === 'pre') {
      writeFileSync(snapPath, JSON.stringify({ takenAt: new Date().toISOString(), ...(await snapshot(q)) }, null, 2));
    }
  });
} finally {
  await sql.end();
}

console.log(`[verify-0017] project=${EXPECTED_REF} phase=${phase} read_only=on`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}${r.detail ? `  — ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`[verify-0017] ${results.length - failed}/${results.length} passed${phase === 'pre' ? `; snapshot -> ${snapPath}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
