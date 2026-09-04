import { currentContext } from './context';
import { redact } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = process.env['LOG_LEVEL'];
  const level: LogLevel =
    raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
  return ORDER[level];
}

export interface LogFields {
  [key: string]: unknown;
}

/**
 * Structured single-line JSON, which is what log aggregators want and what a
 * human can still read with `jq`. Correlation identifiers are pulled from the
 * ambient request context rather than passed in, so a caller cannot forget them.
 *
 * Every field passes through `redact` — including the ones this module adds — so
 * there is no path that writes an unredacted value.
 */
function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (ORDER[level] < threshold()) return;

  const ctx = currentContext();
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(ctx?.requestId !== undefined ? { requestId: ctx.requestId } : {}),
    ...(ctx?.userId !== undefined ? { userId: ctx.userId } : {}),
    ...(ctx?.workspaceId !== undefined ? { workspaceId: ctx.workspaceId } : {}),
    ...(ctx?.route !== undefined ? { route: ctx.route } : {}),
    ...(redact(fields) as LogFields),
  };

  const serialized = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};

/** Exposed for tests: formats a line without writing it. */
export function formatForTest(level: LogLevel, message: string, fields: LogFields = {}): string {
  const ctx = currentContext();
  return JSON.stringify({
    level,
    msg: message,
    ...(ctx?.requestId !== undefined ? { requestId: ctx.requestId } : {}),
    ...(redact(fields) as LogFields),
  });
}
