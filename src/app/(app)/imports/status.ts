import type { ImportStatus, RowBucket } from '@/lib/imports/constants';

/**
 * Display vocabulary for the import state machine.
 *
 * Kept out of the page components so the list and the detail view cannot drift
 * into describing the same status differently, and out of the `'use server'`
 * action module, which may only export async functions.
 */

export const STATUS_LABEL: Record<ImportStatus, string> = {
  // Both mean "the file is here, the columns haven't been confirmed": say what
  // the person needs to do rather than naming an internal step.
  uploaded: 'Needs columns matched',
  mapping: 'Needs columns matched',
  processing: 'Importing',
  completed: 'Complete',
  failed: 'Failed',
};

export const STATUS_TONE: Record<ImportStatus, 'neutral' | 'positive' | 'warning' | 'danger' | 'info'> = {
  uploaded: 'neutral',
  mapping: 'warning',
  processing: 'info',
  completed: 'positive',
  failed: 'danger',
};

/** Row outcomes, in words a non-technical person reads without a glossary. */
export const BUCKET_TITLE: Record<RowBucket, string> = {
  valid: 'Added',
  invalid: 'Invalid email address',
  duplicate: 'Already in your contacts',
  suppressed: 'Unsubscribed or blocked',
  rejected: 'Couldn’t be read',
};

export const BUCKET_EXPLANATION = {
  valid: 'New contacts created',
  invalid: 'The email address wasn’t usable',
  duplicate: 'Already in this file or in your contacts',
  suppressed: 'Imported, but won’t receive emails',
  rejected: 'The row couldn’t be used at all',
} as const;
