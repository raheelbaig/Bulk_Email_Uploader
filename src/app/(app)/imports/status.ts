import type { ImportStatus } from '@/lib/imports/constants';

/**
 * Display vocabulary for the import state machine.
 *
 * Kept out of the page components so the list and the detail view cannot drift
 * into describing the same status differently, and out of the `'use server'`
 * action module, which may only export async functions.
 */

export const STATUS_LABEL: Record<ImportStatus, string> = {
  uploaded: 'Uploaded',
  mapping: 'Awaiting confirmation',
  processing: 'Importing',
  completed: 'Complete',
  failed: 'Failed',
};

export const STATUS_TONE: Record<ImportStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  uploaded: 'neutral',
  mapping: 'warning',
  processing: 'warning',
  completed: 'positive',
  failed: 'danger',
};

export const BUCKET_EXPLANATION = {
  valid: 'New contacts created',
  invalid: 'Email address was not usable',
  duplicate: 'Already present, in this file or in your contacts',
  suppressed: 'On your suppression list — imported, but not mailable',
  rejected: 'Row could not be used at all',
} as const;
