import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request correlation context.
 *
 * Carried implicitly through AsyncLocalStorage so that every log line in a
 * request is joinable without threading a context object through every call
 * site. The identifiers here are exactly those the blueprint calls for (§24.4);
 * campaign/job/message ids join later as those phases land.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  workspaceId?: string;
  route?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): string {
  return randomUUID();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attaches identifiers to the active context.
 *
 * Mutates in place: callers deeper in the request (auth resolution, workspace
 * resolution) enrich the same context the top-level handler created, so log
 * lines emitted before and after enrichment still share a requestId.
 */
export function enrichContext(patch: Partial<Omit<RequestContext, 'requestId'>>): void {
  const ctx = storage.getStore();
  if (ctx === undefined) return;
  if (patch.userId !== undefined) ctx.userId = patch.userId;
  if (patch.workspaceId !== undefined) ctx.workspaceId = patch.workspaceId;
  if (patch.route !== undefined) ctx.route = patch.route;
}

/** The correlation id to hand back to a client, minting one if none is active. */
export function correlationId(): string {
  return storage.getStore()?.requestId ?? newRequestId();
}
