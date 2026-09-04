/**
 * Data access for templates.
 *
 * Same pattern, and the same reason, as `lib/sender/ports.ts`: the decisions —
 * what is a duplicate name, what may be deleted, what a save actually stores —
 * belong to the service, so they are identical wherever they run, and only the
 * data access varies.
 *
 * Every implementation is workspace-scoped by construction: built from a
 * workspace id, never handed one per call. There is therefore no method here
 * that *could* read or write across tenants.
 *
 * Deliberately free of `server-only`: types only, and the test suite implements
 * them against a real migrated database so migration 0009's constraints are live
 * in the service tests.
 */

import type { Cursor, Page, PageDirection } from '@/lib/pagination';

export interface TemplateRecord {
  id: string;
  workspace_id: string;
  name: string;
  subject: string;
  preview_text: string | null;
  html: string;
  text: string;
  variables: string[];
  version: number;
  created_at: string;
  updated_at: string | null;
}

/** What a save writes. Already validated, sanitised and variable-checked. */
export interface TemplateWrite {
  name: string;
  subject: string;
  previewText: string | null;
  html: string;
  text: string;
  variables: string[];
}

/** The outcome of a delete the schema may refuse. */
export type TemplateDeleteOutcome = 'deleted' | 'missing' | 'in_use';

export interface TemplateListOptions {
  limit?: number | undefined;
  cursor?: Cursor | undefined;
  direction?: PageDirection | undefined;
}

export interface TemplateRepository {
  readonly workspaceId: string;

  list(options?: TemplateListOptions): Promise<Page<TemplateRecord>>;
  /** Every template, for the campaign builder's picker. Bounded by `limit`. */
  listAll(limit?: number): Promise<TemplateRecord[]>;
  get(templateId: string): Promise<TemplateRecord | null>;

  insert(input: TemplateWrite): Promise<TemplateRecord>;
  /** Null when the row does not exist in this workspace. */
  update(templateId: string, input: TemplateWrite): Promise<TemplateRecord | null>;

  /**
   * Refused by the schema while a campaign still references the template.
   *
   * `fk_campaigns_template` is ON DELETE RESTRICT (migration 0009), so a
   * scheduled campaign can never lose the row its snapshot was taken from — the
   * database refuses the delete rather than the application remembering to.
   */
  remove(templateId: string): Promise<TemplateDeleteOutcome>;

  /** How many campaigns reference this template. For the "in use" message. */
  countCampaignsUsing(templateId: string): Promise<number>;
}
