/**
 * Shared shape for server-action form results.
 *
 * Lives outside the `'use server'` module because such a module may only export
 * async functions — a constant or a class exported alongside the actions is a
 * build error, not a lint warning.
 */
export interface FormState {
  message: string | null;
  ok: boolean;
}

export const IDLE: FormState = { message: null, ok: false };
