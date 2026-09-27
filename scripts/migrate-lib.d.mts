export function normalizeMigration(body: string): string;
export function fingerprint(body: string): string;
export function matchesRecorded(body: string, recorded: string): boolean;
export function describeTarget(url: string): {
  host: string | null;
  port: string | null;
  database: string | null;
  local: boolean;
  projectRef: string | null;
};
export function supabaseProjectRef(url: URL): string | null;
export interface MigrateArgs {
  dryRun: boolean;
  yesProduction: boolean;
  confirmProduction: boolean;
  projectRef: string | null;
  unknown: string[];
}
export function parseArgs(argv: string[]): MigrateArgs;
export function applyRefusal(target: ReturnType<typeof describeTarget>, args: MigrateArgs): string | null;
export function loadEnvLocal(path: string): boolean;
export const MIGRATION_LOCK_KEY: number;
export const TRACKING_TABLE_SQL: string;
