export function normalizeMigration(body: string): string;
export function fingerprint(body: string): string;
export function matchesRecorded(body: string, recorded: string): boolean;
export function describeTarget(url: string): {
  host: string | null;
  port: string | null;
  database: string | null;
  local: boolean;
};
export function parseArgs(argv: string[]): { dryRun: boolean; yesProduction: boolean; unknown: string[] };
export function loadEnvLocal(path: string): boolean;
export const MIGRATION_LOCK_KEY: number;
export const TRACKING_TABLE_SQL: string;
