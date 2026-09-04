/**
 * The template snapshot.
 *
 * ARCHITECTURE §3.7: when a campaign is finalised, the template's content is
 * frozen into `campaigns.template_snapshot`. Editing the template afterwards
 * must not change what the campaign holds.
 *
 * ── Why this matters more than it looks ──────────────────────────────────
 *
 * Without a snapshot, "what did this campaign say?" has no answer. The template
 * it points at is whatever the template is *now*, which is not what was
 * reviewed, not what preflight approved, and — once P5 sends — not what the
 * first half of the list received. A campaign that cannot be reproduced cannot
 * be audited, and an audit log that references mutable content is a log of
 * pointers rather than facts.
 *
 * The freeze is enforced in three places, and only the third is a guarantee:
 *
 *   1. Here: the snapshot is built once, from the template as it is at that
 *      moment, and the service never rebuilds it for a campaign that is past
 *      draft.
 *   2. The column grant: `template_snapshot` is outside the authenticated
 *      UPDATE grant, so no browser session can write it at all.
 *   3. The trigger in migration 0009: the snapshot of a campaign that is not
 *      (or is not becoming) editable cannot be changed by any role.
 *
 * Deliberately free of `server-only`: the shape is read by the preview and the
 * review step, which run in both contexts.
 */

import { z } from 'zod';
import type { TemplateRecord } from '@/lib/templates/ports';
import type { RenderableTemplate } from '@/lib/templates/render';

/**
 * The frozen copy.
 *
 * `template_id` and `version` are recorded alongside the content so a snapshot
 * can be traced back to what it came from — which is a different question from
 * what it contains, and both need answering.
 */
export const templateSnapshotSchema = z.object({
  template_id: z.uuid(),
  version: z.number().int().min(1),
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(200),
  preview_text: z.string().max(200).nullable(),
  html: z.string().min(1),
  text: z.string().min(1),
  variables: z.array(z.string()).max(64),
  frozen_at: z.string(),
});

export type TemplateSnapshot = z.infer<typeof templateSnapshotSchema>;

/** Builds the frozen copy from a template as it is right now. */
export function buildTemplateSnapshot(template: TemplateRecord, now: Date = new Date()): TemplateSnapshot {
  return {
    template_id: template.id,
    version: template.version,
    name: template.name,
    subject: template.subject,
    preview_text: template.preview_text,
    html: template.html,
    text: template.text,
    variables: [...template.variables],
    frozen_at: now.toISOString(),
  };
}

/**
 * Reads a snapshot back out of jsonb.
 *
 * Returns null rather than throwing on a shape that does not parse: the column
 * is nullable and the campaign detail page must still render for a campaign
 * whose snapshot is absent or, in some future migration, older than this schema.
 */
export function parseTemplateSnapshot(value: unknown): TemplateSnapshot | null {
  if (value === null || value === undefined) return null;
  const parsed = templateSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Adapts either a snapshot or a live template to the renderer's input. */
export function renderableFromSnapshot(snapshot: TemplateSnapshot): RenderableTemplate {
  return {
    subject: snapshot.subject,
    previewText: snapshot.preview_text,
    html: snapshot.html,
    text: snapshot.text,
  };
}

export function renderableFromTemplate(template: TemplateRecord): RenderableTemplate {
  return {
    subject: template.subject,
    previewText: template.preview_text,
    html: template.html,
    text: template.text,
  };
}

/**
 * True when the live template has moved on from what the campaign froze.
 *
 * Not an error — a frozen campaign is *supposed* to differ from an edited
 * template — but worth saying out loud on the campaign page, because the
 * alternative is someone editing a template and wondering why the campaign did
 * not change.
 */
export function snapshotIsStale(snapshot: TemplateSnapshot, template: TemplateRecord): boolean {
  return snapshot.template_id === template.id && snapshot.version !== template.version;
}
