/**
 * Typed application errors.
 *
 * Two audiences, kept strictly apart:
 *   - `userMessage` is shown to a person. It says what went wrong and what to do.
 *   - `cause` is logged. It never crosses the wire.
 *
 * A response carries a `correlationId` so a support conversation can be tied to
 * a server log line without exposing anything about the failure itself.
 */

import type { z } from 'zod';

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly httpStatus: number;
  override readonly cause: unknown;

  constructor(args: {
    code: ErrorCode;
    userMessage: string;
    httpStatus: number;
    cause?: unknown;
  }) {
    super(args.userMessage);
    this.name = 'AppError';
    this.code = args.code;
    this.userMessage = args.userMessage;
    this.httpStatus = args.httpStatus;
    this.cause = args.cause;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(cause?: unknown) {
    super({
      code: 'UNAUTHENTICATED',
      userMessage: 'Sign in to continue.',
      httpStatus: 401,
      cause,
    });
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Deliberately identical in wording and status whether the resource is absent or
 * merely inaccessible. Distinguishing the two lets an attacker enumerate which
 * workspaces and records exist.
 */
export class ForbiddenError extends AppError {
  constructor(cause?: unknown) {
    super({
      code: 'FORBIDDEN',
      userMessage: 'You do not have access to this workspace.',
      httpStatus: 403,
      cause,
    });
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends AppError {
  constructor(userMessage: string, cause?: unknown) {
    super({ code: 'VALIDATION_FAILED', userMessage, httpStatus: 400, cause });
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(userMessage: string, cause?: unknown) {
    super({ code: 'CONFLICT', userMessage, httpStatus: 409, cause });
    this.name = 'ConflictError';
  }
}

export class RateLimitedError extends AppError {
  constructor(userMessage = 'Too many requests. Wait a moment and try again.', cause?: unknown) {
    super({ code: 'RATE_LIMITED', userMessage, httpStatus: 429, cause });
    this.name = 'RateLimitedError';
  }
}

export class InternalError extends AppError {
  constructor(cause?: unknown) {
    super({
      code: 'INTERNAL',
      userMessage: 'Something went wrong on our side. Try again shortly.',
      httpStatus: 500,
      cause,
    });
    this.name = 'InternalError';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Parses user input, throwing a `ValidationError` that carries the schema's own
 * message for the first problem.
 *
 * `schema.parse()` throws a raw ZodError, which is not an AppError: every action
 * wrapper and route turned it into "Something went wrong on our side" (or a 500)
 * and logged a user's typo as a server fault. The schemas' messages ("Give the
 * list a name.") were written to be shown — this is what shows them.
 */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ValidationError(result.error.issues[0]?.message ?? 'That input is not valid.', result.error);
}

export interface SafeErrorBody {
  error: { code: ErrorCode; message: string; correlationId: string };
}

/**
 * Converts any thrown value into a response body safe to send to a client.
 *
 * An unrecognised error becomes a generic 500. Provider messages, SQL text,
 * constraint names and stack traces never reach the client — a constraint name
 * alone can disclose schema structure.
 */
export function toSafeErrorBody(err: unknown, correlationId: string): {
  status: number;
  body: SafeErrorBody;
} {
  if (isAppError(err)) {
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, message: err.userMessage, correlationId } },
    };
  }
  const internal = new InternalError(err);
  return {
    status: internal.httpStatus,
    body: { error: { code: internal.code, message: internal.userMessage, correlationId } },
  };
}
